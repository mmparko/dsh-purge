#!/usr/bin/env node
/**
 * 预设插件声明自检：`presets/**\/*.{yml,yaml}` 里每个 `@deepseek-ai/...` 插件，
 * 要么在当前宿主里能解析，要么显式 `disabled: true`。
 *
 * 为什么需要它：0.2.2 把 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 并进主包、
 * 删掉了 `exports["./list-agents"]`，而红队预设里那一条是 `disabled: false` → cordis 注册了
 * 却永远起不来 → 整个红队模式显示「加载失败 / never started」。上游以后还会再合并包，
 * 这条断言比人眼靠谱。
 *
 * 用法：
 *   node scripts/check-preset-plugins.mjs                 # 自动找宿主（桌面安装 / npm / DSH_BASE）
 *   node scripts/check-preset-plugins.mjs --host <安装目录>
 *   node scripts/check-preset-plugins.mjs --host none      # 跳过宿主检查，只做静态规则
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
    return acc;
  }, []),
);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const presetsDir = path.join(repoRoot, "presets");

function hostRoot() {
  if (args.host === "none") return "";
  if (args.host) {
    const dir = path.resolve(String(args.host));
    for (const cand of [
      path.join(dir, "resources", "app", "dsh", "node_modules"),
      path.join(dir, "node_modules"),
      dir,
    ]) {
      if (fs.existsSync(path.join(cand, "@deepseek-ai"))) return cand;
    }
    return "";
  }
  const cands = [];
  if (process.env.DSH_BASE) cands.push(path.dirname(process.env.DSH_BASE));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app", "dsh", "node_modules"));
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  return cands.find((c) => c && fs.existsSync(path.join(c, "@deepseek-ai"))) || "";
}

const root = hostRoot();

/** 与 lib/redteam/index.js 的 presetEntryAvailability 同一套判定。 */
function entryAvailability(spec) {
  if (!root || !spec) return null;
  const [scope, name, ...rest] = String(spec).split("/");
  const sub = rest.join("/");
  const pkgDir = path.join(root, scope, name);
  const pkgJson = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJson)) return false;
  if (!sub) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    if (pkg.exports && typeof pkg.exports === "object") {
      const entry = pkg.exports[`./${sub}`];
      if (entry === undefined) return false;
      const target = typeof entry === "string" ? entry : entry && (entry.default || entry.import || entry.require);
      return typeof target === "string" && fs.existsSync(path.join(pkgDir, target));
    }
  } catch {
    return null;
  }
  return fs.existsSync(path.join(pkgDir, `${sub}.js`));
}

/** 不引 yaml 依赖：按 `- id:` 切块，读块内的 name / disabled。 */
function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const idm = /^\s*-\s+id:\s*(\S+)/.exec(line);
    if (idm) {
      if (cur) entries.push(cur);
      cur = { id: idm[1], name: "", disabled: "" };
      continue;
    }
    if (!cur) continue;
    const nm = /^\s*name:\s*['"]?([^'"\s]+)['"]?/.exec(line);
    if (nm && !cur.name) cur.name = nm[1];
    const dm = /^\s*disabled:\s*(true|false)\b/.exec(line);
    if (dm) cur.disabled = dm[1];
  }
  if (cur) entries.push(cur);
  return entries;
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(yml|yaml)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

if (!fs.existsSync(presetsDir)) {
  console.log("SKIP 没有 presets 目录");
  process.exit(0);
}

const files = walk(presetsDir);
let checked = 0;
let skippedNoHost = 0;
const problems = [];

for (const file of files) {
  const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
  for (const entry of parseEntries(fs.readFileSync(file, "utf8"))) {
    if (!entry.name.startsWith("@deepseek-ai/")) continue;
    checked += 1;
    if (!root) { skippedNoHost += 1; continue; }
    const available = entryAvailability(entry.name);
    if (available === false && entry.disabled !== "true") {
      problems.push(`${rel}  ${entry.id || "(no id)"}  ${entry.name}  → 宿主里不存在，但没写 disabled: true`);
    }
  }
}

console.log(`预设文件 ${files.length} 个，@deepseek-ai 插件声明 ${checked} 条`);
if (!root) console.log("SKIP 没找到宿主（--host 可指定），只做了静态扫描");
else console.log(`宿主 node_modules: ${root}`);
if (skippedNoHost) console.log(`跳过宿主检查: ${skippedNoHost} 条`);

if (problems.length) {
  for (const p of problems) console.log("FAIL " + p);
  console.log(`\nFAIL ${problems.length}  FAIL`);
  process.exit(1);
}
console.log("PASS 全部声明都能解析，或已显式 disabled");
process.exit(0);
