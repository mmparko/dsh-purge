import path from "node:path";
import fs from "node:fs";
import { supportedNode, MIN_NODE } from "./runtime-check.js";

/**
 * 体检：回答"现在这套东西到底还成不成立"。
 * 只做只读判断，不修复；修复交给 --apply。
 */

function lstatSafe(fp) {
  try { return fs.lstatSync(fp); } catch { return null; }
}

function realOrSelf(fp) {
  try { return fs.realpathSync.native(fp); } catch { return path.normalize(fp); }
}

/** junction / symlink 的目标；普通目录返回 null。 */
export function linkTarget(fp) {
  const st = lstatSafe(fp);
  if (!st || !st.isSymbolicLink()) return null;
  try { return fs.realpathSync.native(fp); } catch { return "?"; }
}

export function baselinePath(dshHome) {
  return path.join(dshHome, "dsh-purge", "baseline.json");
}

/* ------------------------------------------------------- 宿主版本门禁（上游 #188）
 * 补丁全靠字面量匹配官方源码，宿主一升级就可能整段失配。这里把「宿主到底是哪个版本、
 * 这套 pattern 声明适配哪个版本」变成可比较的事实，让 --doctor / 状态页直接告警。
 */

/** package.json 里声明的适配版本（唯一真值来源）。 */
export const HOST_TARGET = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.dshTarget === "string" ? pkg.dshTarget : "";
  } catch {
    return "";
  }
})();

/** 本仓库实际支持的一整组宿主版本（这个 fork 同时覆盖 0.2.1-rc.2 / rc.1 / 0.2.0-rc.2）。 */
export const HOST_TARGETS = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (Array.isArray(pkg.dshTargets) && pkg.dshTargets.length) return pkg.dshTargets.filter((v) => typeof v === "string");
  } catch {
    /* 退回单值 */
  }
  return HOST_TARGET ? [HOST_TARGET] : [];
})();

/** "0.2.1-rc.2" → 可比较结构；解析不了返回 null。 */
export function parseHostVersion(raw) {
  const m = String(raw ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** 这份 package.json 是不是官方宿主自己的？（别把本插件当成宿主） */
function looksLikeHostPackage(pkg) {
  if (!pkg || typeof pkg.version !== "string" || !pkg.version) return false;
  const name = String(pkg.name || "");
  if (!name) return false;
  if (/purge/i.test(name)) return false;
  return /dsh|deepseek/i.test(name);
}

/** 读宿主真实版本：npm 布局是 <aiBase>/dsh/package.json，桌面解包布局同理。 */
export function readHostVersion(aiBase) {
  if (!aiBase) return null;
  const candidates = [
    path.join(aiBase, "dsh", "package.json"),
    path.resolve(aiBase, "..", "..", "package.json"),
  ];
  for (const fp of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (looksLikeHostPackage(pkg)) {
        return { version: pkg.version, name: String(pkg.name || ""), path: fp };
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/** 宿主版本是否在本仓库声明的适配范围内。读不到就不下结论（返回 null）。 */
export function hostSupport(aiBase, targets = HOST_TARGETS) {
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  if (!list.length) return null;
  const host = readHostVersion(aiBase);
  if (!host) return null;
  const want = parseHostVersion(host.version);
  const supported = list.some((target) => {
    const b = parseHostVersion(target);
    return want && b ? JSON.stringify(want) === JSON.stringify(b) : host.version === target;
  });
  return { host, target: list.join(" / "), supported };
}

export function readBaseline(dshHome) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(dshHome), "utf8"));
  } catch {
    return null;
  }
}

export function writeBaseline(dshHome, data) {
  const fp = baselinePath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  return fp;
}

/**
 * @param {{state:object, repo?:string, linkPaths?:string[]}} input
 * @returns {{ok:boolean, rows:Array<{id:string,ok:boolean,detail:string}>}}
 */
export function runChecks(input = {}) {
  const state = input.state || {};
  const rows = [];
  const add = (id, ok, detail) => rows.push({ id, ok, detail });
  add("node", supportedNode(), "Node " + process.versions.node + "; required >= " + MIN_NODE);
  for (const row of input.runtime || []) if (row.id !== "node") rows.push(row);

  const base = state.ai_base;
  let hostExists = false;
  try { hostExists = Boolean(base && fs.statSync(base).isDirectory()); } catch { /* Missing host. */ }
  add("host", hostExists, base ? `Primary host: ${base}` : "Host @deepseek-ai not located (run --apply or provide --base)");

  const support = hostExists ? hostSupport(base) : null;
  if (support) {
    add(
      "host_version",
      support.supported,
      support.supported
        ? `Host ${support.host.version} (declared target ${support.target})`
        : `Host ${support.host.version} does not match declared target ${support.target}: patches may mismatch, await plugin update before applying`,
    );
  }

  const applicable = Math.max(0, (state.patches_total || 0));
  const applied = state.patches_applied || 0;
  const pending = state.patches_pending || 0;
  const baseline = input.baseline || null;
  if (baseline && typeof baseline.applied === "number") {
    add(
      "patches",
      hostExists && state.patches_active === true && applied >= baseline.applied && pending === 0,
      `Patched ${applied} (baseline ${baseline.applied}, ${baseline.at || "?"}), pending ${pending}`,
    );
  } else {
    add("patches", hostExists && state.patches_active === true && pending === 0 && applied > 0, `Patched ${applied}/${applicable}, pending ${pending} (no baseline)`);
  }
  const pathKey = (fp) => {
    const value = path.resolve(realOrSelf(fp));
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  if (baseline?.ai_base && base) {
    add("baseline", pathKey(baseline.ai_base) === pathKey(base), "Baseline must belong to the selected host");
  }

  add("backup", state.has_backup === true, state.has_backup ? "Patch backup present (revertable via --revert)" : "No patch backup found, rollback will fail");

  const shimOk = [state.shim_cmd, state.shim_ps1, state.shim_bin]
    .some((value) => ["patched", "original", "injected", "n/a"].includes(value));
  add("shim", shimOk, `dsh.cmd=${state.shim_cmd || "missing"}`);

  add("asar", state.asar_still_sealed !== true, state.asar_still_sealed ? "Desktop still loads app.asar; complete Apply and a full restart" : "No sealed startup archive");
  add("hooks", true, `hooksDenyBypass=${state.hooks_deny_bypass === false ? "off" : "on"}`);

  const links = input.linkPaths || [];
  if (links.length) {
    for (const lp of links) {
      const target = linkTarget(lp);
      const show = !lstatSafe(lp) ? "missing path" : target ? `→ ${target}` : "physical directory (not a symlink)";
      const parts = path.normalize(lp).split(path.sep).filter(Boolean);
      const id = `link:${parts.slice(-2).join("/")}`;
      let actual = "";
      try { if (fs.statSync(lp).isDirectory()) actual = fs.realpathSync.native(lp); } catch { /* Missing or broken link. */ }
      const ok = Boolean(actual) && (!input.repo || pathKey(actual) === pathKey(input.repo));
      add(id, ok, `${lp} ${show}${ok ? "" : ` (expected ${realOrSelf(input.repo)})`}`);
    }
  }

  return { ok: rows.every((r) => r.ok), rows };
}

export default function doctorModule() {
  return {
    runChecks,
    linkTarget,
    readBaseline,
    writeBaseline,
    baselinePath,
    HOST_TARGET,
    parseHostVersion,
    readHostVersion,
    hostSupport,
  };
}
