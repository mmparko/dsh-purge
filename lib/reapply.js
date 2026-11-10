import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";
import { bootVerificationPending } from "./operation-boot.js";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function installedRevPath() {
  return path.join(core.findDshHome(), "dsh-purge", "installed-rev");
}

function installedRev() {
  try {
    return fs.readFileSync(installedRevPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function appliedStampPath() {
  return path.join(core.findDshHome(), "dsh-purge", "applied.json");
}

function settleGuardPath() {
  return path.join(core.findDshHome(), "dsh-purge", "settle-restart.guard");
}

function restartDismissPath() {
  return path.join(core.findDshHome(), "dsh-purge", "restart-dismissed.json");
}

/** 当前密封归档的身份（大小 + mtime）。官方更新换了包，这个值就变。 */
function sealedAsarIdentity() {
  try {
    const handoff = core.sealedAsarHandoff();
    if (!handoff?.asar) return "";
    const st = fs.statSync(handoff.asar);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

/**
 * #8：用户点了「稍后」之后，同一份归档 + 同一插件版本内不再反复弹「需要重启」。
 * 面板每次轮询 status 都会读到 boot_full_quit，光靠组件内 ref 抑制不住重开设置页。
 */
export function restartDismissed() {
  const current = sealedAsarIdentity();
  if (!current) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(restartDismissPath(), "utf8"));
    if (String(raw.version || "") !== pluginVersion()) return false;
    return String(raw.asar || "") === current;
  } catch {
    return false;
  }
}

export function dismissRestart() {
  const asar = sealedAsarIdentity();
  if (!asar) return false;
  const fp = restartDismissPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    asar,
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  return true;
}

/** 用户重新点了「应用」：这次该重新问一次。 */
export function clearRestartDismissed() {
  try {
    fs.rmSync(restartDismissPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readAppliedStamp() {
  try {
    const raw = JSON.parse(fs.readFileSync(appliedStampPath(), "utf8"));
    return {
      version: String(raw.version || ""),
      sha: String(raw.sha || ""),
    };
  } catch {
    return null;
  }
}

function sameRev(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function isApplyPlaceholder(sha) {
  const text = String(sha || "");
  return text.startsWith("apply:") || text === "applied";
}

function applyPlaceholderVersion(sha) {
  const m = String(sha || "").trim().match(/^apply:(.+)$/);
  return m ? m[1] : "";
}

function refreshStaleApplyPlaceholder(sha) {
  const ver = pluginVersion();
  const oldVer = applyPlaceholderVersion(sha);
  if (oldVer && ver && oldVer !== ver) return `apply:${ver}`;
  return String(sha || "").trim();
}

/** 手动应用未必写过 installed-rev；空 sha 会让 settle 永远判未对齐并无限重启。 */
export function resolveApplySha(explicit) {
  const wanted = String(explicit == null ? "" : explicit).trim();
  if (wanted) return refreshStaleApplyPlaceholder(wanted) || wanted;
  const rev = installedRev();
  if (rev) return refreshStaleApplyPlaceholder(rev) || rev;
  const ver = pluginVersion();
  return ver ? `apply:${ver}` : "applied";
}

function writeInstalledRev(sha) {
  if (bootVerificationPending(core.findDshHome())) return;
  const value = String(sha || "").trim();
  if (!value) return;
  const fp = installedRevPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${value}\n`, "utf8");
}

function writeAppliedStamp(sha) {
  if (bootVerificationPending(core.findDshHome())) return;
  const fp = appliedStampPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    sha: String(sha || "").trim(),
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

/** 当前插件版本和已写入补丁的版本一致时，启动不必再还原重打。 */
export function stampMatches(stamp, version, rev) {
  if (!stamp || !stamp.version || stamp.version !== version) return false;
  // sha 为空表示 stamp 不完整（曾误写空串），不能当作已对齐（#56）。
  if (!stamp.sha) return false;
  const current = String(rev || "").trim();
  if (!current) return true;
  // 手动应用占位戳与后续 git rev 并存时，只认 version，避免再空转重启。
  if (isApplyPlaceholder(stamp.sha) || isApplyPlaceholder(current)) return true;
  if (!sameRev(current, stamp.sha)) return false;
  return true;
}

/**
 * stamp 对上了，但宿主被官方更新打回 sealed / 清洗标记没了时仍算未对齐（#57）。
 * 找不到插件根（web 启动早期、纯 CLI）不等于补丁丢失，否则会无限重打+重启（#59）。
 */
export function hostStillHasAppliedPatches() {
  try {
    if (core.desktopAsarStillSealed()) return false;
  } catch {
    /* 非桌面面 */
  }
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return true;
    return core.hostCleanMarkersPresent(aiBase);
  } catch {
    return true;
  }
}

/** 空 sha 只有在「不是密封、也不是明确缺标记」时才允许就地补戳。 */
export function canHealEmptyStamp({ sealed = false, hasAiBase = false, markersPresent = false } = {}) {
  if (sealed) return false;
  if (hasAiBase && !markersPresent) return false;
  return true;
}

export function patchesMatchInstall() {
  if (!stampMatches(readAppliedStamp(), pluginVersion(), installedRev())) return false;
  return hostStillHasAppliedPatches();
}

/**
 * 逐补丁实检:patchStatus 里出现 "pending" 才算真的有活要干。
 * hostCleanMarkersPresent 只看任一清洗 marker 存在,无法发现 DSH 自升级后
 * agent-loop 这类文件被整体替换、#74/#87 marker 全不见的漂移。
 */
export async function hostPatchesStillPending() {
  try {
    const aiBase = core.findAiBase();
    if (!aiBase) return false;
    const status = await core.patchStatus(aiBase);
    return Object.values(status).some((row) => row === "pending");
  } catch {
    return false;
  }
}

/** fast path 过了也要再做一次逐补丁 pending 实检,避免 DSH 升级 marker 漂移时永不重打。 */
export async function patchesMatchInstallStrict() {
  if (!patchesMatchInstall()) return false;
  if (await hostPatchesStillPending()) return false;
  return true;
}

/**
 * 宿主上的清洗还在，只是版本戳旧了。启动时不能因此 revertAll，
 * 否则用户点应用并重启后，页面会回到「要重新清洗」。
 */
export async function hostCleanEnoughToKeep() {
  let aiBase = "";
  try {
    if (core.desktopAsarStillSealed()) return false;
    aiBase = core.findAiBase() || "";
  } catch {
    return false;
  }
  if (!aiBase || !core.hostCleanMarkersPresent(aiBase)) return false;
  const status = await core.patchStatus(aiBase);
  return !Object.values(status).some((row) => row === "pending");
}

/** 有 applied 戳但宿主已回到密封 asar / 清洗标记没了：面板提示「补丁已丢失」（#57）。找不到根不算丢失。 */
export function patchesLostAfterHostReset() {
  const stamp = readAppliedStamp();
  if (!stamp?.version || !stamp?.sha) return false;
  try {
    if (core.desktopAsarStillSealed()) return true;
  } catch {
    /* 非桌面面 */
  }
  try {
    const aiBase = core.findAiBase();
    if (aiBase && !core.hostCleanMarkersPresent(aiBase)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 手动「应用」成功后也要打戳，否则重启后 settle 会以为补丁未对齐再要求重启。 */
export function markPatchesApplied(sha) {
  const resolved = resolveApplySha(sha);
  const current = installedRev();
  // 已有更新通道写入的 git rev 时沿用；否则用 resolve 结果（含 apply:version 占位）。
  const finalSha = current && !isApplyPlaceholder(current) ? current : resolved;
  writeInstalledRev(finalSha);
  writeAppliedStamp(finalSha);
  return finalSha;
}

/**
 * #59/#60：空 sha 或缺失 installed-rev 会让 settle 每次启动都 reapply+restart。
 * 版本已对齐时先补非空戳 / 种子 rev，打断自重启；真正缺补丁再由后续逻辑重打。
 */
export function healEmptyAppliedStamp() {
  const stamp = readAppliedStamp();
  const version = pluginVersion();
  if (!stamp || stamp.version !== version) return false;
  if (stamp.sha) {
    if (!installedRev()) writeInstalledRev(stamp.sha);
    return false;
  }
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* ignore */ }
  let hasAiBase = false;
  let markersPresent = false;
  try {
    const aiBase = core.findAiBase();
    hasAiBase = Boolean(aiBase);
    markersPresent = Boolean(aiBase && core.hostCleanMarkersPresent(aiBase));
  } catch {
    /* 根还没定位 */
  }
  // 密封或明确没打上清洗标记：不能补戳装成已对齐，否则 #57 不再自愈。
  if (!canHealEmptyStamp({ sealed, hasAiBase, markersPresent })) return false;
  markPatchesApplied();
  return true;
}

/** 安装后还没有 installed-rev 时先落盘占位（tarball / 手动应用常见）。 */
export function ensureInstalledRevSeed() {
  const current = installedRev();
  if (current) {
    const next = refreshStaleApplyPlaceholder(current);
    if (next && next !== current) {
      writeInstalledRev(next);
      return next;
    }
    return current;
  }
  const stamp = readAppliedStamp();
  if (stamp?.sha) {
    writeInstalledRev(stamp.sha);
    return stamp.sha;
  }
  const sha = resolveApplySha();
  writeInstalledRev(sha);
  return sha;
}

/** settle 刚重启过则冷却，防止「重打→重启→再重打」打成死循环。 */
export function shouldSkipSettleRestart(windowMs = 180000) {
  try {
    const raw = JSON.parse(fs.readFileSync(settleGuardPath(), "utf8"));
    if (String(raw.version || "") !== pluginVersion()) return false;
    const at = Date.parse(String(raw.at || "")) || 0;
    return at > 0 && Date.now() - at < windowMs;
  } catch {
    return false;
  }
}

export function markSettleRestart() {
  if (bootVerificationPending(core.findDshHome())) return;
  const fp = settleGuardPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify({
    version: pluginVersion(),
    at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

/**
 * 先把宿主文件从备份还原，再按当前这份插件的补丁重写。
 * 低版本带着自己的补丁列表，高版本带着自己的；回退到哪一版就打哪一版。
 */
export async function reapplyInstalled(options = {}) {
  core.applyRuntimeEnv();
  let aiBase = null;
  let handoff = null;
  let freshExtract = null;
  try {
    const state = await core.gatherState();
    aiBase = state.ai_base;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const sealed = core.sealedAsarHandoff();
  if (!aiBase || sealed) {
    try {
      const opened = await core.openSealedDesktopHost({
        upgrade: options.upgrade === true,
        forApply: true,
      });
      if (opened.aiBase) aiBase = opened.aiBase;
      if (opened.swapAsar) handoff = opened;
      if (opened.extracted) freshExtract = opened;
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  } else {
    core.rememberUnpackedArchive();
  }
  if (!aiBase) return { ok: false, error: core.missingAiBaseMessage() };
  // 刚解开的是官方原件。已经在用的目录仍先还原再按这一版重打。
  const preserveClientBundles = options.preserveClientBundles !== false;
  // DSH 自升级会把宿主文件整个换成新版,但旁边老 bak 不变。此时直接 revertAll 会把当前新版
  // 写回成旧版 → 新旧混码直接崩。先把"原文无 dsh-purge marker 却和 bak 字节不同"的 bak
  // 刷到 current,再 revertAll 就不会毁掉新宿主,下面 applyPatches 把 marker 补回来。
  if (!freshExtract) {
    try {
      const refreshed = core.refreshStaleBaksForUpgrade(aiBase);
      if (refreshed.length) {
        console.warn(`[dsh-purge] refreshed ${refreshed.length} stale bak(s) before revert:`, refreshed);
      }
    } catch (e) {
      console.warn("[dsh-purge] refresh stale bak failed:", String(e && e.message ? e.message : e));
    }
  }
  const reverted = freshExtract ? { reverted: [] } : await core.revertAll(aiBase, { preserveClientBundles });
  if (!freshExtract) await core.revertAllShims();
  let multi = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles, forApply: true });
  let summary = core.summarizeApplyReport(multi.report);
  /* 1.2.0 现场（1.1.80→1.2.0 回滚）：宿主刚重启时 #43 的 minimal.patch.yml 撞了一次
     瞬时 EPERM，整批被判失败、更新回滚。这里对失败项再打一轮（有界：一次），
     原子写本身也有退避重试；两轮都不过才认失败。 */
  if (summary.failed.length > 0) {
    const failedIds = new Set(summary.failed.map((row) => row.patch_id ?? row.id).filter((id) => id !== undefined));
    const retryPatches = core.ALL_PATCHES.filter((patch) => failedIds.has(patch.id));
    if (retryPatches.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const retry = await core.applyPatchesAllHosts(retryPatches, { preserveClientBundles, forApply: true });
      const merged = new Map();
      for (const row of multi.report) merged.set(String(row.patch_id ?? row.id), row);
      for (const row of retry.report) merged.set(String(row.patch_id ?? row.id), row);
      multi = {
        ...multi,
        report: [...merged.values()],
        hosts: retry.hosts && retry.hosts.length ? retry.hosts : multi.hosts,
      };
      summary = core.summarizeApplyReport(multi.report);
      console.warn(
        "[dsh-purge] retried failed patches:",
        [...failedIds].join(","),
        "remaining:",
        summary.failed.length,
      );
    }
  }
  await core.patchAllShims();
  const flash = core.silenceCmdFlash(multi.hosts[0]?.aiBase || aiBase);
  const clean =
    summary.failed.length === 0 &&
    (core.allPatchHostsWritten(multi.hosts) || core.hostCleanMarkersPresent(aiBase));
  if (clean && flash.ok !== true) {
    console.warn("[dsh-purge] cmd flash patch did not apply cleanly; clean flow continues, UI shows cmdFlashOk=false");
  }
  if (!clean && freshExtract) {
    const restored = core.restoreSealedExtract(freshExtract.appDir, freshExtract.prev);
    return {
      ok: false,
      error: restored ? "清洗没有完成，已放回上一份解开目录" : "清洗没有完成",
      restored,
      version: pluginVersion(),
      reverted: 0,
      applied: summary.applied || 0,
      failed: summary.failed.length,
      renamed: false,
      needsFullQuit: false,
      cmdFlashOk: flash.ok === true,
    };
  }
  if (clean) {
    if (!process.env.DSH_PURGE_JOURNAL) markPatchesApplied(installedRev() || undefined);
    if (freshExtract?.archive) core.writeUnpackedAsarStamp(freshExtract.archive);
    try {
      const seed = core.seedPromptInjectAtBoot(core.findDshHome());
      if (seed && seed.action === "error") {
        console.warn("[dsh-purge] seed prompt-inject failed:", seed.reason);
      }
    } catch (e) {
      console.warn("[dsh-purge] seed prompt-inject exception:", String(e && e.message ? e.message : e));
    }
  }
  let renamed = false;
  if (clean && handoff?.asar && options.scheduleSwap !== false) {
    const swapped = core.scheduleSealedDesktopRestart(handoff);
    renamed = Boolean(swapped?.renamed);
  }
  const pending = Boolean(handoff?.asar && !renamed && options.scheduleSwap !== false);
  // 只有真的挪开了 app.asar，当前进程才还在旧包上，需要再开一次。
  // 官方端已经在 resources/app 里跑时，不能仅因 ELECTRON_RUN_AS_NODE 再弹「需要重启」，
  // 否则每次打开面板都会再要一次重启。
  return {
    ok: clean,
    error: clean ? "" : "清洗没有完成",
    version: pluginVersion(),
    reverted: reverted.reverted?.length || 0,
    applied: summary.applied || 0,
    failed: summary.failed.length,
    renamed,
    needsFullQuit: renamed || pending,
    cmdFlashOk: flash.ok === true,
  };
}
