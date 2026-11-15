/**
 * 用宿主真实的 renderPrompt 验证提示词改写结果，防止再出现
 * `unknown prompt variable "{{cwd}}"` 这类「语法对、渲染炸」的问题。
 *
 * 用法：node scripts/verify-prompt.mjs
 * 依赖：本机已安装 DSH（自动探测 @deepseek-ai 根），否则跳过并返回 0。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function findAiBase() {
  const cands = [];
  if (process.env.DSH_BASE) cands.push(process.env.DSH_BASE);
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  // profile node_modules 里能找到宿主包
  for (const p of ["desktop", "web", "headless"]) {
    cands.push(path.join(home, "profiles", p, "node_modules", "@deepseek-ai"));
  }
  const local = process.env.LOCALAPPDATA || "";
  if (local) {
    cands.push(path.join(local, "Programs", "DeepSeek Harness", "resources", "app", "dsh", "node_modules", "@deepseek-ai"));
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(path.join(c, "dsh-system-prompt", "lib", "index.js"))) return c;
    } catch { /* 试下一个 */ }
  }
  return "";
}

const aiBase = findAiBase();
if (!aiBase) {
  console.log("[verify-prompt] 未找到已安装的 @deepseek-ai，跳过（不算失败）");
  process.exit(0);
}

const sysPromptEntry = path.join(aiBase, "dsh-system-prompt", "lib", "index.js");
const identityEntry = path.join(root, "lib", "identity.js");

const { renderPrompt } = await import(pathToFileURL(sysPromptEntry).href);
const { rewritePromptAssembly, cwdSuffixFor } = await import(pathToFileURL(identityEntry).href);

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    if (r.ok) { pass += 1; console.log("  ✓ " + name + (r.note ? "  → " + r.note : "")); }
    else { fail += 1; console.log("  ✗ " + name + "  → " + r.note); }
  } catch (e) {
    fail += 1;
    console.log("  ✗ " + name + "  → 抛出: " + (e && e.message ? e.message : e));
  }
};

const mk = (suffixText, variables) => ({
  sections: [
    { name: "deployment:persona", text: "You are helpful.", order: 0 },
    { name: "deployment:persona-suffix", text: suffixText, order: 10200 },
  ],
  contexts: [],
  tools: [],
  variables,
});
const suffixOf = (out) => (out.sections || []).find((s) => s.name === "deployment:persona-suffix");

console.log("[verify-prompt] 宿主: " + aiBase);

check("本机无 cwd 变量时不注入 {{cwd}}", () => {
  const out = rewritePromptAssembly(mk("", { provider: "p", model: "m" }), "", {});
  renderPrompt(out);
  return { ok: !String(suffixOf(out)?.text || "").includes("{{cwd}}") };
});

check("后缀为空时补成空字符串", () => {
  const out = rewritePromptAssembly(mk("", { provider: "p", model: "m" }), "", {});
  renderPrompt(out);
  return { ok: suffixOf(out)?.text === "" };
});

check("宿主有 cwd 时正常输出工作目录", () => {
  const out = rewritePromptAssembly(mk("", { provider: "p", model: "m", cwd: "C:\\work" }), "", {});
  return { ok: String(renderPrompt(out)).includes("C:\\work") };
});

check("cwd 注册但值为 undefined 时不注入", () => {
  const out = rewritePromptAssembly(mk("", { provider: "p", model: "m", cwd: undefined }), "", {});
  renderPrompt(out);
  return { ok: !String(suffixOf(out)?.text || "").includes("{{cwd}}") };
});

check("bundle 写死 {{cwd}} 且宿主无 cwd 时清空", () => {
  const out = rewritePromptAssembly(mk("Your working directory is {{cwd}}.", { provider: "p", model: "m" }), "", {});
  renderPrompt(out);
  return { ok: !String(suffixOf(out)?.text || "").includes("{{cwd}}") };
});

check("用户自定义后缀原样保留", () => {
  const out = rewritePromptAssembly(mk("总是用中文回答。", { provider: "p", model: "m" }), "", {});
  renderPrompt(out);
  return { ok: suffixOf(out)?.text === "总是用中文回答。" };
});

check("无 suffix 段且无 cwd 时不补建空段", () => {
  const out = rewritePromptAssembly(
    { sections: [{ name: "deployment:persona", text: "x", order: 0 }], contexts: [], tools: [], variables: { provider: "p", model: "m" } },
    "",
    {},
  );
  renderPrompt(out);
  const s = suffixOf(out);
  return { ok: s === undefined || !String(s.text || "").includes("{{cwd}}") };
});

check("cwdSuffixFor 三态", () => {
  const a = cwdSuffixFor({ provider: "p" });
  const b = cwdSuffixFor({ provider: "p", cwd: undefined });
  const c = cwdSuffixFor({ provider: "p", cwd: "C:\\x" });
  return { ok: a === "" && b === "" && c.includes("{{cwd}}") };
});

console.log(`\n[verify-prompt] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
