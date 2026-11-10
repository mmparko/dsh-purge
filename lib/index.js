import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsFor } from "./extract-asar.js";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as skills from "./skills.js";
import * as updater from "./update.js";
import { operationStatus, reportBoot, bootVerificationPending } from "./operation-boot.js";
import { assertRuntime } from "./runtime-check.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import {
  GLOBAL_PROMPT_ORDER,
  adaptInjectForMinimalPreset,
  isMnemonPluginMessage,
  isRedteamSession,
  installAssembleGuard,
  modePromptText,
  peelChatmlEnvelope,
  escapeDshInterpolation,
  rewritePromptAssembly,
} from "./identity.js";
import { capabilityProtocolText, CAPABILITY_SECTION } from "./capability-protocol.js";
import { registerAnchor, anchorTextFor, ANCHOR_SECTION } from "./anchor.js";
import { installSubagentControl } from "./subagent-control.js";
import { installSubagentRoleCapture, resolveSubagentRoleText } from "./redteam/role-section.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as uninstaller from "./uninstall.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import {
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  watchContextLife,
} from "./settle-policy.js";

export const name = "dsh-purge";

// 不要把 pluginPackages 写进 inject：Cordis 会对 map 里每一个 key 空等。
// 便携拷贝 / Hub 残装经常没有这项服务，一写进去就是 pending → 宿主退出码 1。
export const inject = ["systemPrompt", "tools"];

let bootFullQuit = false;

const DEFAULTS = {
  enabled: true,
  autoApplyOnStart: false,
  autoUpdateOnStart: false,
  autoRevertOnMissing: false,
  injectOnce: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
  // Codex 风格：教模型主动发现 skill / MCP；不改官方注册与工具面。
  capabilityProtocol: true,
  hooksDenyBypass: true,
  // "auto" | "off" —— off 立即关掉尾部锚点，不用改代码回滚（上游 1.1.84）。
  anchorMode: "auto",
  // false 立即回滚子代理审批接管（上游 1.1.84）。
  subagentControl: true,
};

const log = (config, ...args) => {
  if (config?.verbose) console.log("[dsh-purge]", ...args);
};

let webTreeReady = false;

function watchWebTreeReady(ctx) {
  // 必须挂在 connection 上再 await，与官方打印 URL 同一时刻。
  // apply() 里立刻 await 会在后续入口尚未入树时提前结束，session.list 仍是空的。
  // 入口复位：热重载 / disposed 后再 apply 会复用上一次 ready=true，第二次 inject 之前跑的
  // /status 把旧标志当准，这里强制重置。
  webTreeReady = false;
  const mark = () => {
    webTreeReady = true;
  };
  if (typeof ctx?.inject !== "function") {
    mark();
    return;
  }
  try {
    ctx.inject(["connection"], (host) => {
      const settled = host.get?.("loader")?.await?.();
      if (!settled || typeof settled.then !== "function") {
        mark();
        return;
      }
      settled.then(() => {
        if (host.get?.("webServer") !== undefined && host.get?.("connection") !== undefined) mark();
      }, mark);
    });
  } catch {
    mark();
  }
}

function fsExists(fp) {
  const list = Array.isArray(fp) ? fp : [fp];
  return list.some((p) => {
    if (!p || typeof p !== "string") return false;
    try {
      return fsFor(p).existsSync(p);
    } catch {
      return false;
    }
  });
}

function line(title, value, ok = null) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  return `${mark} ${title}: ${value}`;
}

function renderStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push(line("宿主 / surface", state.surface || hostctl.currentSurface()));
  out.push(line("DSH_HOME", state.dsh_home));
  out.push(line("Activation", state.patches_active ? "active"
    : state.activation_pending ? "restart required (sealed desktop)" : "not fully applied", state.patches_active));
  if (state.desktop_install) out.push(line("桌面安装 / desktop", state.desktop_install));
  if (state.ai_base) {
    out.push(line("插件根 / plugin root", state.ai_base));
    for (const [key, fp] of Object.entries(state.files)) {
      const list = Array.isArray(fp) ? fp : [fp];
      const shown = list.length <= 1 ? String(list[0] || "") : `${list[0]} (+${list.length - 1})`;
      out.push(`    ${fsExists(fp) ? "✓" : "✗"} ${key.padEnd(22)} ${shown}`);
    }
  } else {
    out.push(line("插件根 / plugin root", core.missingAiBaseMessage(), false));
  }
  out.push(line("shim 目录", state.shim_dir || "未定位 / not found", !!state.shim_dir));
  if (state.desktop_runtimes?.length) {
    out.push(line("Desktop runtime", `${state.desktop_runtimes.length} sealed (shim OK; bak external)`, true));
    for (const d of state.desktop_runtimes) out.push(`    · ${d}`);
  }
  out.push(line("备份 / backup", state.has_backup ? "有 / yes" : "无 / no", state.has_backup));
  out.push(line("注入文件 / inject", state.override_path));
  out.push(line("注入状态 / override", state.override_status));
  if (state.asar_still_sealed) {
    out.push(line("app.asar", "还在。补丁写在解开目录，当前进程读不到", false));
  }
  out.push("");
  const displayRows = Array.isArray(state.display_patches)
    ? state.display_patches
    : core.groupPatchesForDisplay(core.ALL_PATCHES, state.patch_status || {});
  const displayTally = core.tallyDisplayPatches(displayRows);
  out.push(`补丁 / patches: ${displayTally.applied}/${displayTally.total || 0} applied, ${displayTally.pending} pending`);
  for (const row of displayRows) {
    const s = row.status || "n/a";
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    const patch = core.ALL_PATCHES.find((item) => item.id === row.id);
    const label = patch ? patch.name : `patch-${row.id}`;
    const layer = patch ? `${patch.layer}/${patch.layer_en}` : row.layer || "";
    out.push(`  ${mark} [#${String(row.id).padEnd(2)}] ${label.padEnd(30)} ${layer} — ${s}`);
  }
  out.push("");
  out.push(`shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function injectAllowedNow(config) {
  return config.enabled !== false;
}

/** 提示词框自改 > prompt-inject.md > 加密默认（见 rules.resolveInjectText）。 */
// mtime 节流:400ms setInterval + 每 pre-step + 每 preset-selected + 每 readInjectFallback
// 的高频触发下,disk sync + 3 次 hashOverride + 2 次模块级赋值一轮能点 20 次。
// 短窗复用上次结果:home 没换 + 文件 mtime 没变 + 距上次 < 200ms,直接返回缓存。
let hungCache = { home: "", mtime: 0, at: 0, resolved: null };
const HUNG_CACHE_MS = 200;
function statInjectMtimeMs(home) {
  if (!home) return 0;
  try {
    return Math.floor(fs.statSync(core.findOverrideFile(home)).mtimeMs);
  } catch { return 0; }
}
function refreshHungOperator(dshHome = core.findDshHome()) {
  const home = core.pinDshHome() || dshHome || core.findDshHome();
  const now = Date.now();
  const mtimeBefore = statInjectMtimeMs(home);
  if (
    hungCache.resolved
    && hungCache.home === home
    && hungCache.mtime === mtimeBefore
    && now - hungCache.at < HUNG_CACHE_MS
  ) {
    return hungCache.resolved;
  }
  try { core.syncPromptInjectOnDiskSync(home); } catch { /* 同步失败仍按 resolve 走 */ }
  const resolved = rules.resolveInjectText(home);
  // 兜底顺序:resolved.text > 加密默认 > 永不空串(避免二轮 fallbackInject 为空走 purge[] 残留)。
  const fallback = core.normalizeOverride(core.defaultOverrideText()) || "";
  // 框、磁盘、加密槽保持原样。发给模型只整理 ChatML 单独成行，并补上缺失的闭合标签。
  const text = resolved.text || fallback;
  if (text) {
    core.hangOperatorPrompt(text);
    // 与点「保存」同一钉钉：不点保存，组装也要读到这一份全文。
    core.rememberCommittedOverride(home, text);
  }
  const out = { ...resolved, text: text || resolved.text };
  // 用 sync 之后的 mtime 存 cache,下次高频轮询(文件没被外部动)直接命中。
  hungCache = { home, mtime: statInjectMtimeMs(home), at: now, resolved: out };
  return out;
}

function installHungPromptGlobal() {
  // host 侧 inject 兜底:正常 cordis assemble 钩子 (rewriteLiveAssembly) 跟这条路径互斥,
  // 不会重复注入;插件首装 / 预设切换 / hung session / 新对话首轮钩子未就绪窗口,靠这里兜。
  // [v10 四重 fallback] 新对话首轮 refreshHungOperator 若因 cache 未就绪 / sync disk 失败 /
  // resolveInjectText 返空(极端情况)任一环节返空,host 这边读到的 inject 真空 → 模型自称
  // "我是 Claude"。四重兜底确保任何路径都不会把空串交给 host:
  //   1) refreshHungOperator — 完整路径(sync disk + resolve + pin)
  //   2) hungOperatorPrompt   — 上次挂上的内存钉子(进程生命周期)
  //   3) readPromptInjectFileSync — 直读磁盘 prompt-inject.md,绕过 sync/resolve
  //   4) defaultOverrideText — 加密槽解包,除非插件安装残缺否则非空
  const fn = () => {
    const norm = (s) => peelChatmlEnvelope(String(s || "").replace(/\r\n/g, "\n"));
    let home = "";
    try { home = core.findDshHome(); } catch { home = ""; }
    try {
      const text = norm(refreshHungOperator(home).text);
      if (text) { purgeLog("host.hungFn", { tier: "refresh", bytes: text.length }); return text; }
    } catch (e) { purgeLog("host.hungFn", { tier: "refresh", err: String(e?.message || e) }); }
    try {
      const hung = norm(core.hungOperatorPrompt());
      if (hung) { purgeLog("host.hungFn", { tier: "hung", bytes: hung.length }); return hung; }
    } catch (e) { purgeLog("host.hungFn", { tier: "hung", err: String(e?.message || e) }); }
    try {
      const disk = norm(core.readPromptInjectFileSync(home));
      if (disk) { purgeLog("host.hungFn", { tier: "disk", bytes: disk.length }); return disk; }
    } catch (e) { purgeLog("host.hungFn", { tier: "disk", err: String(e?.message || e) }); }
    try {
      const sealed = norm(core.defaultOverrideText());
      if (sealed) { purgeLog("host.hungFn", { tier: "sealed", bytes: sealed.length }); return sealed; }
    } catch (e) { purgeLog("host.hungFn", { tier: "sealed", err: String(e?.message || e) }); }
    purgeLog("host.hungFn", { tier: "empty", bytes: 0 });
    return "";
  };
  globalThis.__dshPurgeHungPrompt = fn;
  return fn;
}

// 一律全文。工具步裁 6000 / .hung-disabled 两分法会切掉 HARD OUTPUT，第二轮任务必拒。
function shouldInjectAssembly(context) {
  const decision = { mode: "full", taskKind: "general", lastRole: "full", isSubagent: false };
  try {
    decision.isSubagent = context?.agent?.session?.header?.origin === "subagent";
  } catch {}
  if (globalThis.__dshPurgeRetryPending) {
    globalThis.__dshPurgeRetryPending = false;
    decision.lastRole = "retry";
  }
  return decision;
}

function readSessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

// [方案2] 日志探针。写进内部文件,不污染 host stderr。Monitor 实时跟 tail -F。
const PURGE_INTERNAL_LOG = path.join(os.tmpdir(), "dsh-purge-desktop.log");
// 日志翻滚:每 ~1024 次写检查一次大小,>2MB 把当前文件 rename 成 .1 覆盖旧 .1,
// 新文件自动从头开始。长会话 / 热重载反复触发 assemble decision 不会把 tmp 吃爆。
const PURGE_INTERNAL_LOG_MAX = 2 << 20;
let _purgeLogWriteCount = 0;
function rotatePurgeInternalLog() {
  try {
    const st = fs.statSync(PURGE_INTERNAL_LOG);
    if (st.size > PURGE_INTERNAL_LOG_MAX) {
      try { fs.renameSync(PURGE_INTERNAL_LOG, `${PURGE_INTERNAL_LOG}.1`); } catch { /* 并发失败下次再试 */ }
    }
  } catch { /* 文件不存在 */ }
}
// 单行 ISO 时间戳 + 标签 + k=v... 格式。tail -F 跟 / grep 都好读。
// 值里空格会把 kv 切开,统一替换成 _ 保证 grep 稳定。
function purgeLog(tag, kv) {
  try {
    if ((++_purgeLogWriteCount & 0x3ff) === 0) rotatePurgeInternalLog();
    let line = `${new Date().toISOString()} [${tag}]`;
    if (kv) {
      for (const k of Object.keys(kv)) {
        const raw = kv[k];
        const v = raw === undefined || raw === null ? "" : String(raw).replace(/\s+/g, "_");
        line += ` ${k}=${v}`;
      }
    }
    fs.appendFileSync(PURGE_INTERNAL_LOG, line + "\n", "utf8");
  } catch {}
}
function logAssembleDecision(where, decision) {
  purgeLog(`assemble.${where}`, {
    mode: decision.mode,
    task: decision.taskKind,
    last: decision.lastRole,
    sub: decision.isSubagent,
  });
}

function injectSnapshot(dshHome = core.findDshHome()) {
  const resolved = rules.resolveInjectText(dshHome);
  return {
    injectSource: resolved.source,
    injectRuleId: resolved.ruleId,
    needPrompt: resolved.source === "none",
  };
}

/** 框里正在显示的字优先；框空则 resolveInjectText（含 prompt-inject.md）。 */
function injectSnapshotFromBox(dshHome, boxText) {
  if (typeof boxText === "string" && core.normalizeOverride(boxText)) {
    return { injectSource: "prompt", injectRuleId: null, needPrompt: false };
  }
  const resolved = rules.resolveInjectText(dshHome);
  if (resolved.text) {
    return { injectSource: resolved.source, injectRuleId: null, needPrompt: false };
  }
  return { injectSource: "none", injectRuleId: null, needPrompt: true };
}

const NEED_PROMPT_ERROR = "提示词和规则集都是空的，必须先添加提示词";

function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

async function ensureRestartReady() {
  return core.ensureHostClean();
}

/** 提示词服务自己的 ctx 多半没有 scope，段会进全局层。插件若挂在某个 scope 上，预设代理的父链看不到那一层。 */
function addPromptSection(ctx, section) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 代理未注入时点属性会抛 */ }
  push(ctx);
  const disposers = [];
  let registered = false;
  let lastError = null;
  for (const host of hosts) {
    try {
      const d = host.systemPrompt.section(section);
      registered = true;
      if (typeof d === "function") disposers.push(d);
    } catch (error) {
      const msg = String(error && error.message || error);
      if (msg.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError) throw lastError;
  // 让 ctx.effect 在 reload / dispose 时把 section 一并撤掉；host.systemPrompt.section
  // 当前多半不返回 disposer，这段只对返回 function 的实现生效，不改变旧行为。
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* 死 ctx */ }
  }
}

export function registerPromptSections(ctx, config) {
  addPromptSection(ctx, {
    name: "dsh-purge",
    order: GLOBAL_PROMPT_ORDER,
    interpolate: false,
    text: (context) => {
      if (!injectAllowedNow(config)) return "";
      // 标准、极简都注入同一份正文。极简只改工具句，不决定注不注入。
      return escapeDshInterpolation(
        peelChatmlEnvelope(adaptInjectForMinimalPreset(readInjectFallback(context), context)),
      );
    },
  });

  if (config.capabilityProtocol !== false) {
    addPromptSection(ctx, {
      name: CAPABILITY_SECTION,
      order: GLOBAL_PROMPT_ORDER + 1,
      interpolate: false,
      text: (context) => {
        if (!injectAllowedNow(config)) return "";
        const redteam = isRedteamSession(context);
        return capabilityProtocolText({
          redteam,
          redteamChild: redteam && context?.agent?.session?.header?.origin === "subagent",
          enabled: true,
        });
      },
    });
  }

  const postPrompt = typeof config.postPrompt === "string" ? config.postPrompt.trim() : "";
  if (!postPrompt) return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    // 旧版 throw 会把整个 apply 炸掉；postPrompt 只是附加段，降级 skip 不影响核心注入。
    console.warn(
      `[dsh-purge] postPromptOrder (${config.postPromptOrder}) 需要是 > ${GLOBAL_PROMPT_ORDER} 的有限数；跳过 postPrompt 段`,
    );
    return;
  }
  addPromptSection(ctx, {
    name: "dsh-purge:post",
    order: config.postPromptOrder,
    text: () => (injectAllowedNow(config) ? postPrompt : ""),
  });
}

function readInjectFallback(context) {
  let home = "";
  try { home = core.findDshHome(); } catch { home = ""; }
  const refreshed = refreshHungOperator(home);
  let text = refreshed.text || "";
  let source = text ? "refresh" : "none";
  if (!text) {
    const fallback = rules.ensureOperatorBody(home);
    if (fallback) { text = fallback; source = "ensure"; }
  }
  if (!text) {
    purgeLog("inject.read", { source: "empty", bytes: 0 });
    return "";
  }
  let redteam = false;
  try { redteam = isRedteamSession(context); } catch { redteam = false; }
  let subagent = false;
  try { subagent = context?.agent?.session?.header?.origin === "subagent"; } catch {}
  const out = modePromptText(text, redteam);
  purgeLog("inject.read", {
    source,
    srcTag: refreshed.source || "n/a",
    redteam,
    sub: subagent,
    rawBytes: text.length,
    outBytes: out.length,
  });
  return out;
}

function installMnemonMessageStrip(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeMnemonStrip) return;
  ctx.__dshPurgeMnemonStrip = true;
  const strip = config.stripMnemon !== false;
  const wrap = async (_payload, next) => {
    const decision = await next();
    if (!decision) return decision;
    // agent-loop 会读 decision.messages.length；缺数组时第二轮直接 gateway/internal 炸掉。
    const incoming = Array.isArray(decision.messages) ? decision.messages : [];
    const messages = strip ? incoming.filter((message) => !isMnemonPluginMessage(message)) : incoming;
    if (messages.length === incoming.length && Array.isArray(decision.messages)) return decision;
    return { ...decision, messages };
  };
  // 旧版 late() + queueMicrotask(late) + setTimeout(late, 1500) 三连都成功时，
  // 同一个 wrap 会在 agent/pre-step 瀑布上叠 3 层；中间插件返回的 decision 每轮被过滤 3 次。
  // 这里用 mounted 闸：第一次成功挂上就不再重试，拿回 disposer 走 ctx.effect 回收。
  let mounted = false;
  let dispose = null;
  const late = () => {
    if (mounted) return;
    try {
      const d = ctx.on("agent/pre-step", wrap, { global: true, prepend: true });
      mounted = true;
      if (typeof d === "function") dispose = d;
    } catch { /* 下一次重试 */ }
  };
  late();
  if (!mounted) queueMicrotask(late);
  let retryTimer = null;
  if (!mounted) {
    retryTimer = setTimeout(late, 1500);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }
  try {
    ctx.effect(() => () => {
      if (retryTimer) clearTimeout(retryTimer);
      try { dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 死 ctx 时无 effect，靠下一次 apply 覆盖 */ }
}

function rewriteLiveAssembly(config, assembled, context, decision = { mode: "full", taskKind: "general" }) {
  const enabled = config.enabled !== false;
  const redteam = enabled && isRedteamSession(context);
  const full = enabled ? readInjectFallback(context) : "";
  const dshHome = enabled ? core.findDshHome() : "";
  let cwd = "";
  try { cwd = String(context?.agent?.session?.header?.cwd || "").trim(); } catch { /* ignore */ }
  if (dshHome && cwd) {
    try { rules.writeLastCwd(dshHome, cwd); } catch { /* ignore */ }
  }
  const policy = enabled && dshHome ? rules.readWorkspacePolicy(dshHome) : "always";
  // 提示词框为空时才启用勾选的本地 cwd 规则兜底;避免跟 prompt-inject.md 叠加污染。
  let localInject = "";
  if (enabled && dshHome && !String(full || "").trim()) {
    try { localInject = rules.readSelectedCwdInject(dshHome, cwd); } catch { /* ignore */ }
  }
  const effectiveFull = String(full || "").trim() ? full : localInject;
  const inject = effectiveFull;
  const anchorText = enabled ? anchorTextFor(config) : "";
  const hasInject = Boolean(String(inject || "").trim());
  let dropWorkspaceBaseline = false;
  if (enabled) {
    if (policy === "strict") dropWorkspaceBaseline = true;
    else if (policy === "fallback") dropWorkspaceBaseline = hasInject;
    else dropWorkspaceBaseline = false;
  }
  const roleText = redteam ? resolveSubagentRoleText(context) : "";
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon !== false,
    dropPurgeAfterFold: false,
    capabilityProtocol: config.capabilityProtocol !== false,
    context,
    roleText,
    dropWorkspaceBaseline,
    anchorText,
  });
  // 真实判定：sections 里确实出现锚点段，才在日志/状态里报 anchorApplied。
  const anchorApplied = Boolean(anchorText) && (Array.isArray(rewritten?.sections) ? rewritten.sections : [])
    .some((section) => String(section?.name || "") === ANCHOR_SECTION);
  const closerFollow = closerFollowBytes(rewritten?.sections);
  purgeLog("assemble.rewrite", {
    enabled,
    redteam,
    mode: decision?.mode || "full",
    task: decision?.taskKind || "general",
    last: decision?.lastRole || "unknown",
    fullBytes: full.length,
    localBytes: localInject.length,
    injectBytes: inject.length,
    anchorApplied,
    roleBytes: roleText.length,
    cap: config.capabilityProtocol !== false,
    strip: config.stripMnemon !== false,
    policy,
    dropWorkspaceBaseline,
    injectHead: Array.isArray(rewritten?.sections) && rewritten.sections[0]?.name === "dsh-purge",
    chatml: Array.isArray(rewritten?.sections) && /<project_instructions>|<\|im_start\|>/i.test(String(rewritten.sections[0]?.text || "")),
    afterCloser: closerFollow,
    cwd,
  });
  return rewritten;
}

function closerFollowBytes(sections) {
  const closer = "</project_instructions>";
  const joined = (Array.isArray(sections) ? sections : [])
    .map((section) => (typeof section?.text === "string" ? section.text : ""))
    .filter(Boolean)
    .join("\n\n");
  const at = joined.lastIndexOf(closer);
  if (at < 0) return -1;
  return joined.length - (at + closer.length);
}

/** 注册表若已经按旧文件算过 rev，立刻 rebuilt，让页面拿到的地址和缓存一致（#63）。 */
function publishClientBundleRevs(ctx, packageNames) {
  if (!Array.isArray(packageNames) || packageNames.length === 0) return;
  let mods = null;
  try {
    mods = ctx?.get?.("clientModules", false);
  } catch {
    mods = null;
  }
  if (!mods || typeof mods.rebuilt !== "function") return;
  for (const id of packageNames) {
    try { mods.rebuilt(id); } catch { /* 这一包还没进注册表，下次快照会读到新文件 */ }
  }
}

/** Cordis 的 ctx 是 Proxy：未声明 inject 时点属性会抛 "cannot get property ... without inject"，所以两段都要包 try。 */
function permissionPresetsOf(ctx) {
  try {
    const direct = ctx?.permissionPresets;
    if (direct && typeof direct.set === "function") return direct;
  } catch {
    /* 未 inject 这项服务时，Cordis 代理会抛，不能让新会话的全开权限钉死失败。 */
  }
  try {
    const svc = ctx?.get?.("permissionPresets");
    if (svc && typeof svc.set === "function") return svc;
  } catch {
    /* 没有这项服务。 */
  }
  return null;
}

function shouldKeepFreshFullAccess(session, svc) {
  if (session?.header?.origin === "subagent") return false;
  const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
  const preset = state?.preset;
  if (preset === "danger-full-access" || preset === "auto" || preset === "custom") return false;
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const pins = Array.isArray(events) ? events.filter((event) => event?.type === "permission/preset") : [];
  if (pins.length > 1) return false;
  return preset == null || preset === "workspace-write" || preset === "read-only";
}

function upgradeFreshSessionAccess(ctx, session) {
  try {
    const svc = permissionPresetsOf(ctx);
    if (!svc || !shouldKeepFreshFullAccess(session, svc)) return;
    svc.set(session, "danger-full-access");
  } catch (error) {
    console.warn("[dsh-purge] full-access pin:", error instanceof Error ? error.message : String(error));
  }
}

/** 空会话界面按部署默认显示完全权限；建会话时若钉成 workspace-write，发消息后芯片会掉下去。 */
function installFreshFullAccess(ctx) {
  if (typeof ctx.on !== "function" || ctx.__dshPurgeFullPin) return;
  ctx.__dshPurgeFullPin = true;
  // ctx.effect:plugin dispose 时解绑 session/created,否则 handler 残留 + 热重载翻倍。
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => {
      queueMicrotask(() => upgradeFreshSessionAccess(ctx, session));
    }); } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeFullPin;
    };
  });
}

function installCwdCapture(ctx) {
  if (!ctx || ctx.__dshPurgeCwdCapture) return;
  if (typeof ctx.on !== "function") return;
  ctx.__dshPurgeCwdCapture = true;
  const home = core.findDshHome();
  let lastWritten = "";
  const flush = (session) => {
    try {
      const cwd = String(session?.header?.cwd || "").trim();
      if (!cwd || !home || cwd === lastWritten) return;
      rules.writeLastCwd(home, cwd);
      lastWritten = cwd;
    } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) flush(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    const disposers = [];
    try { disposers.push(ctx.on("session/created", flush)); } catch { /* ignore */ }
    try { disposers.push(ctx.on("session/event", (session) => flush(session))); } catch { /* ignore */ }
    return () => {
      for (const d of disposers) {
        try { if (typeof d === "function") d(); } catch { /* ignore */ }
      }
      delete ctx.__dshPurgeCwdCapture;
    };
  });
}

function installIdentityOverride(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  installSubagentRoleCapture(ctx);
  // installAssembleGuard 幂等:slot.rewrite 已挂的 prompt 对象只刷新 rewriteFn,
  // 不再 return 新 dispose。原实现每 400ms + 每 pre-step push 一个 noop closure 入 Set,
  // 2 小时 session 累积上万条。改为:只 track 首次真正挂上的 disposer。
  const wrapDisposers = new Set();
  const wrappedPrompts = new WeakSet();
  const trackDisposer = (d, prompt) => {
    if (typeof d !== "function") return d;
    if (prompt) {
      if (wrappedPrompts.has(prompt)) return d;
      wrappedPrompts.add(prompt);
    }
    wrapDisposers.add(d);
    return d;
  };
  const rewriteFn = (assembled, context) => {
    // [方案2] installAssembleGuard 走的也是这条路径,同样决策 full/anchor。
    const decision = shouldInjectAssembly(context);
    logAssembleDecision("rewriteFn", decision);
    return rewriteLiveAssembly(config, assembled, context, decision);
  };
  // interval 心跳每 400ms 调一次,正常稳态下所有参数不变 — 只在状态翻转或出错时写日志,
  // 避免每天上百万条 guard.wrap 把 7MB 日志刷爆、把真正事件淹没。
  let lastGuardSig = "";
  const wrapAssemble = (caller = "unknown") => {
    try {
      const prompt = ctx.systemPrompt;
      const d = installAssembleGuard(prompt, rewriteFn);
      const mounted = typeof d === "function";
      const tracked = trackDisposer(d, prompt);
      const sig = `${!!prompt}|${mounted}`;
      if (sig !== lastGuardSig) {
        purgeLog("guard.wrap", { caller, prompt: !!prompt, mounted });
        lastGuardSig = sig;
      }
      return tracked;
    } catch (e) {
      purgeLog("guard.wrap", { caller, err: String(e?.message || e) });
      lastGuardSig = "";
      return false;
    }
  };
  if (!ctx.__dshPurgeAssembleHook) {
    ctx.__dshPurgeAssembleHook = true;
    // cordis 不同版本的 waterfall 可能是 (assembly, context) 或 (assembly, context, next)：
    // 旧写法把 `next` 当函数直接取第 3 位，老宿主就拿到 context 当 next，await next() 立刻抛。
    // disposer 不进 wrapDisposers:ctx.effect cleanup 在 child scope 结束/预设切换都会触发,
    // 收集进去的话会被误解绑,之后再也挂不回来。cordis 真 dispose 时 listener 自己跟 ctx 释放。
    try {
      ctx.on("system-prompt/assemble", async (...args) => {
        const [assembly, context] = args;
        const next = args.length >= 3 ? args[args.length - 1] : null;
        // 入口即记录 — 看请求是否真的到达了我们的 handler;hasNext=false 时说明 cordis
        // 走的旧签名,下游 waterfall 全靠我们返回的 assembled。
        let eventsLen = 0;
        try { eventsLen = readSessionEvents(context?.agent?.session).length; } catch {}
        purgeLog("assemble.entry", {
          hasNext: typeof next === "function",
          sections: Array.isArray(assembly?.sections) ? assembly.sections.length : -1,
          events: eventsLen,
        });
        let assembled = assembly;
        if (typeof next === "function") {
          try {
            assembled = await next();
          } catch (err) {
            // 下游 waterfall 任一环节抛就会把整条 assemble 弄死,UI 卡住发不出去。
            // 吞掉改用上游装配兜底,inject 保底能挂上。
            try { console.warn("[dsh-purge] system-prompt/assemble waterfall rejected:", err?.message || err); } catch {}
            purgeLog("assemble.waterfall", { err: String(err?.message || err) });
            assembled = assembly;
          }
        }
        try {
          // [v10] 事件处理器开场主动 refresh:新对话首轮 hungCache 可能 null、
          // installAssembleGuard 可能还没包上 systemPrompt,这里强制把 pinned/磁盘读热,
          // 保证 readInjectFallback → refreshHungOperator 命中已 warm 的 cache 不走回空值路径。
          try { refreshHungOperator(core.findDshHome()); } catch { /* resolve 过程异常不阻塞 */ }
          const decision = shouldInjectAssembly(context);
          logAssembleDecision("event", decision);
          return rewriteLiveAssembly(config, assembled, context, decision);
        } catch (err) {
          try { console.warn("[dsh-purge] rewriteLiveAssembly failed:", err?.message || err); } catch {}
          purgeLog("assemble.rewriteFail", { err: String(err?.message || err) });
          return assembled;
        }
      }, { global: true, prepend: true });
    } catch { /* ctx.on 老版本签名异常,下次 apply 覆盖 */ }
  }
  // 切换预设会换掉 assemble。pre-step 瀑布在 assemble 之后才跑，第一次发送包不上。
  // 宿主在 assemble 之前调用这个函数，用的就是当前模式自己的 systemPrompt。
  const prepareAssemble = (loopCtx) => {
    try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
    // loopCtx 可能是宿主的 Proxy，访问 .systemPrompt 自身就会抛（代理层尚未注入服务）。
    let prompt = null;
    try { prompt = loopCtx && loopCtx.systemPrompt; } catch { prompt = null; }
    if (prompt) {
      try {
        trackDisposer(installAssembleGuard(prompt, rewriteFn), prompt);
      } catch { /* 这一层代理包不上时，下面再包插件自己的 */ }
    }
    try {
      const iso = (loopCtx && loopCtx.ctx) || loopCtx;
      if (iso && iso !== ctx) registerPromptSections(iso, config);
    } catch { /* 隔离层还没有 systemPrompt */ }
    wrapAssemble("prepareAssemble");
    return prompt || null;
  };
  globalThis.__dshPurgePrepareAssemble = prepareAssemble;
  const hungFn = installHungPromptGlobal();
  // complete:true 会在 waterfall 之后盖掉 sections；包住 assemble 返回值，每轮都补回注入。
  wrapAssemble("init");
  // guard 需要在每次 cordis 换 systemPrompt 代理时重挂（session 内切预设、subagent fork、
  // live-mount）。原本 20 秒后 clearInterval，之后换代理就包不上 → 第二轮 inject 走原生
  // assemble → 宿主按 token 预算裁剪 → 用户看到"只截取了部分"。installAssembleGuard 幂等
  // （wrappedPrompts WeakSet + 对象 identity 校验），400ms 持续跑到 ctx dispose 的 CPU 代价可忽略。
  // 400ms 回滚:2000ms 窗口 → 新对话第一次 assemble 可能跑在钩子挂上之前,inject 塌。
  // CPU 代价(幂等 wrap)相比"新对话失效"的用户感知,根本不值一提。
  const timer = setInterval(() => wrapAssemble("interval"), 400);
  if (typeof timer.unref === "function") timer.unref();
  // 下面三个 ctx.on 必须加 flag:installIdentityOverride 若被同一 ctx 二次 apply
  // (dispose 后重 mount / 热重载),listener 叠加会让 inject 跑 N 遍,也让 wrap 挂 N 层。
  if (!ctx.__dshPurgeSessionHook) {
    ctx.__dshPurgeSessionHook = true;
    try {
      ctx.on("session/created", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("sessionCreated");
      });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePresetHook) {
    ctx.__dshPurgePresetHook = true;
    try {
      ctx.on("agent-preset/selected", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("presetSelected");
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePreStepHook) {
    ctx.__dshPurgePreStepHook = true;
    try {
      ctx.on("agent/pre-step", (payload, next) => {
        wrapAssemble("preStep");
        return typeof next === "function" ? next() : payload;
      }, { global: true, prepend: true });
    } catch { /* ignore */ }
  }
  // 热重载/卸载时统一回收：轮询 timer、guard 代理层、暴露给 agent loop 的全局钩子，
  // 都在同一个 effect 里扫掉；避免下次 apply 再绑一层造成多次写入。
  try {
    ctx.effect(() => () => {
      clearInterval(timer);
      for (const d of wrapDisposers) {
        try { d(); } catch { /* ignore */ }
      }
      wrapDisposers.clear();
      // 清 flag,下次 apply 允许重新挂 listener;不然 ctx 复用时沉默无响应。
      delete ctx.__dshPurgeSessionHook;
      delete ctx.__dshPurgePresetHook;
      delete ctx.__dshPurgePreStepHook;
      // [v10] AssembleHook 也要清。原漏删,ctx 复用时新 apply 看到 flag=true 直接跳过
      // ctx.on("system-prompt/assemble", ...),cordis event listener 永远不装 → 新对话首轮
      // 完全依赖 400ms setInterval wrapAssemble 的 guard,时间窗没赶上就 inject 真空。
      delete ctx.__dshPurgeAssembleHook;
      // 新对话 / 热重载会先 dispose 再 apply。这里若删全局 hung，
      // 空窗里立刻发送 hang 读到空串，必须等下一次 apply 才恢复。
    });
  } catch { /* 无 effect 时靠 unref + 下次 apply 自覆盖 */ }
}

function shimNeedsPatch(state) {
  if (hostctl.currentSurface() === "desktop") return false;
  return (
    state.shim_cmd === "original" ||
    state.shim_ps1 === "original" ||
    state.shim_bin === "original"
  );
}

function currentSettleScope() {
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* 非桌面或还没定位安装目录 */ }
  return { surface: hostctl.currentSurface(), sealed };
}

async function settleInstalledPatches(config, ctx, life) {
  if (life && !life.alive) return "skip:inactive";
  try { core.rememberUnpackedArchive(); } catch { /* 没有官方安装目录时不必记归档 */ }
  try {
    reapply.ensureInstalledRevSeed();
  } catch (e) {
    log(config, "seed installed-rev failed:", String(e && e.message ? e.message : e));
  }
  try {
    if (reapply.healEmptyAppliedStamp()) log(config, "healed empty applied stamp");
  } catch (e) {
    log(config, "heal applied stamp failed:", String(e && e.message ? e.message : e));
  }

  if (config.autoApplyOnStart !== true) {
    try {
      if (await reapply.patchesMatchInstallStrict() || await reapply.hostCleanEnoughToKeep()) {
        reapply.markPatchesApplied();
        log(config, "boot: host files left untouched; stamp kept");
        return "boot:host-untouched";
      }
    } catch { /* 没戳也没关系，等用户点应用 */ }
    log(config, "boot: skip host writes (Apply once)");
    return "skip:boot-no-host-write";
  }

  const scope = currentSettleScope();
  if (!(await reapply.patchesMatchInstallStrict())) {
    if (!settleMayReapply(scope)) {
      log(config, "sealed desktop: skip startup reapply (wait for Apply)");
      return "skip:sealed-wait-apply";
    }
    if (await reapply.hostCleanEnoughToKeep()) {
      reapply.markPatchesApplied();
      log(config, "host already clean; kept patches and refreshed stamp");
      return "already-clean";
    }
    if (officialUpdate.upgradeMarkerExists(process.execPath)) {
      const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, upgrade: true });
      if (life && !life.alive) return "skip:inactive";
      if (!upgraded.ok) {
        log(config, "official upgrade reapply failed:", upgraded.error || "");
        return "reapply-failed";
      }
      officialUpdate.clearUpgradeMarker(process.execPath);
      // 隔离目录清理走 Node fs.rmSync + 路径校验；被拒绝的条目会被保留，这里留诊断记录。
      const staleCleanup = officialUpdate.clearStaleExtractedApps(process.execPath);
      if (staleCleanup.rejected.length > 0 || staleCleanup.errors.length > 0) {
        log(config, "stale app cleanup:", JSON.stringify({
          removed: staleCleanup.removed.length,
          rejected: staleCleanup.rejected,
          errors: staleCleanup.errors,
        }));
      }
      if (!settleMayRestart(currentSettleScope()) || reapply.shouldSkipSettleRestart()) {
        if (upgraded.needsFullQuit) bootFullQuit = true;
        log(config, "official upgrade reapplied; skip settle restart");
        return "reapplied-no-restart";
      }
      reapply.markSettleRestart();
      log(config, "official upgrade reapplied; restarting onto the new build");
      // ctx 可能在 reapply.reapplyInstalled 的 await 中被 dispose；重启前再查一次。
      if (life && !life.alive) return "skip:inactive";
      try {
        hostctl.scheduleRestart(null, ctx, { openBrowser: false });
      } catch (e) {
        log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
        return "restart-failed";
      }
      return "restarting";
    }

    // 启动自愈只写盘，不 swap asar / 不杀进程，避免官方 Host Fiber._reload 撞 INACTIVE_EFFECT。
    const result = await reapply.reapplyInstalled({ scheduleSwap: false });
    if (life && !life.alive) return "skip:inactive";
    if (!result.ok) {
      log(config, "reapply failed:", result.error || "");
      return "reapply-failed";
    }
    // reapply 成功后强制保证非空戳，避免 clean 路径漏写又空转（#59/#60）。
    try { reapply.markPatchesApplied(); } catch { /* ignore */ }
    if (result.needsFullQuit) {
      bootFullQuit = true;
      log(config, "reapply wrote patches; official host needs a full quit");
      return "full-quit";
    }
    if (!settleMayRestart(currentSettleScope())) {
      log(config, "reapply wrote patches; desktop settle does not restart");
      return "reapplied-no-restart";
    }
    if (reapply.shouldSkipSettleRestart()) {
      log(config, "reapply wrote patches; skip settle restart (cooldown)");
      return "reapplied-no-restart";
    }
    // 已对齐则不必再重启；只在 stamp/宿主仍不一致时重启一次。
    if (await reapply.patchesMatchInstallStrict()) {
      log(config, "reapply wrote patches; already aligned, no restart");
      return "reapplied";
    }
    reapply.markSettleRestart();
    log(config, "reapply wrote patches; restarting");
    // reapplyInstalled 自带 await；重启前再查一次 life，避免对 disposed ctx 发起 scheduleRestart。
    if (life && !life.alive) return "skip:inactive";
    try {
      // web：自愈重启不弹浏览器，关窗后不应再被反复拉起新窗口（#59/#61）。
      hostctl.scheduleRestart(null, ctx, { openBrowser: false });
    } catch (e) {
      log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }

  const applied = await autoApply(config);
  if (config.autoUpdateOnStart === true) {
    updater.autoUpdateIfNeeded()
      .then((r) => {
        // ctx 可能在 autoUpdate 等待网络的过程中被 dispose（热重载 / 卸载）。
        // 回调里再碰 ctx.scheduleRestart 会命中 INACTIVE_EFFECT。
        if (life && !life.alive) return;
        log(config, "auto-update:", JSON.stringify(r));
        if (r && r.needsFullQuit) bootFullQuit = true;
        if (r && r.restartAfter && settleMayRestart(currentSettleScope())) {
          if (life && !life.alive) return;
          try { hostctl.scheduleRestart(null, ctx, { openBrowser: false }); } catch (e) {
            console.warn("[dsh-purge] auto-update restart failed:", e);
          }
        }
      })
      .catch((e) => console.warn("[dsh-purge] auto-update error:", String(e)));
  }
  return applied;
}

async function autoApply(config) {
  try {
    core.applyRuntimeEnv();
    const sanitized = core.sanitizeDesktopCommandRuntimes();
    if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

    core.refreshHooksDenySettings();
    if (core.getHooksDenySettings().hooksDenyBypass === false) {
      const restored = await core.restoreHookDenyForBases(core.enumeratePatchAiBases());
      if (restored.failed.length) {
        log(config, "hooks-deny restore leftover:", restored.failed.join(","));
      }
    }

    const state = await core.gatherState();
    if (!state.ai_base) {
      log(config, "skip auto-apply: plugin root not found");
      return "skip:plugin_root_not_found";
    }
    try {
      const flash = core.silenceCmdFlash(state.ai_base);
      log(config, "cmd-flash:", JSON.stringify(flash));
      if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
    } catch (e) {
      log(config, "cmd-flash failed:", String(e));
    }

    if (state.patches_pending === 0) {
      if (config.autoApplyOnStart && shimNeedsPatch(state)) {
        await core.patchAllShims();
        core.silenceCmdFlash(state.ai_base);
        log(config, "auto-apply: patches clean, shim refreshed");
        return "already_clean:shim_patched";
      }
      log(config, "auto-apply: already clean");
      return "already_clean";
    }
    if (!config.autoApplyOnStart) {
      log(config, "auto-apply disabled");
      return "disabled";
    }
    const autoMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles: true });
    await core.patchAllShims();
    const report = autoMulti.report;
    const flash = core.silenceCmdFlash(autoMulti.hosts[0]?.aiBase || state.ai_base);
    const applied = report.filter((r) => r.status === "applied").length;
    log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
    return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
  } catch (e) {
    console.warn("[dsh-purge] auto-apply error:", String(e));
    return `error:${e}`;
  }
}

/** 应用之后的那一次重启。密封包退出再打开，不再干等用户自己退出。 */
function scheduleApplyRestart(shouldRestart, ctx = null) {
  if (!shouldRestart) return { restarting: false };
  if (core.desktopAsarStillSealed()) {
    // 透传 ctx 给核心层,让密封包重启也能走 PowerShell 立即 kill Electron + requestRestart
    // 双保险路径,不再弹"host stopped"崩溃对话框 (#64)。
    const planned = core.restartSealedDesktopIfNeeded({ ctx });
    return {
      ...(planned || {}),
      restarting: Boolean(planned && (planned.restarting || planned.asarSwap)),
    };
  }
  try {
    const planned = hostctl.scheduleRestart(null, ctx);
    if (planned && (planned.restarting === false || planned.clean === false)) return planned;
    return planned || { restarting: true };
  } catch (error) {
    return { restarting: false, error: String(error && error.message ? error.message : error) };
  }
}

async function handlePurgeCommand(rawInput, config, ctx = null) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "status").toLowerCase();

  switch (sub) {
    case "status":
    case "s": {
      const state = await core.gatherState();
      return { kind: "success", text: renderStatus(state) };
    }
    case "apply":
    case "a": {
      core.applyRuntimeEnv();
      core.clearDesktopLocateCache();
      const home = core.pinDshHome();
      const scrubbed = core.sanitizeDesktopCommandRuntimes();
      const state = await core.gatherState();
      if (home) state.dsh_home = home;
      let located;
      try {
        located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
      } catch (e) {
        return { kind: "error", text: String(e && e.message ? e.message : e) };
      }
      if (!located.aiBase) return { kind: "error", text: core.missingAiBaseMessage() };
      state.ai_base = located.aiBase;
      if (located.extracted && located.handoff?.archive) {
        core.writeUnpackedAsarStamp(located.handoff.archive);
      }
      const blocked = rejectIfNeedPrompt(state.dsh_home);
      if (blocked) return { kind: "error", text: blocked.error };
      const applyMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
        preserveClientBundles: false,
        forApply: true,
      });
      const report = applyMulti.report;
      const shimResult = await core.patchAllShims();
      const flash = core.silenceCmdFlash(applyMulti.hosts[0]?.aiBase || state.ai_base);
      const lines = [];
      for (const h of applyMulti.hosts) lines.push(`  宿主 / host → ${h.aiBase}`);
      lines.push(...report.map((r) => {
        const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
        return `  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`;
      }));
      lines.push("", "shim:");
      for (const [dir, st] of Object.entries(shimResult)) {
        lines.push(`  · ${dir} → ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
      if (scrubbed.length) {
        lines.push("", "Desktop in-bin .bak scrub:");
        for (const row of scrubbed) lines.push(`  ✓ ${row.dir} → ${row.cleaned.join(", ")}`);
      }
      lines.push("Desktop: host-commands 密封目录只清理不注入；bak 禁止写进 bin（issue #9）。");
      const summary = core.summarizeApplyReport(report);
      const hostWritten = core.allPatchHostsWritten(applyMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
      const hookDenyRestoreFailed = (applyMulti.hookDenyRestoreFailed || []).length > 0;
      const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !hookDenyRestoreFailed;
      const promptReady = summary.failed.length > 0 && summary.failed.every((item) => item.status === "pattern_not_found");
      const shouldRestart = applyShouldRestart({
        complete: complete || (promptReady && hostWritten),
        sealed: core.desktopAsarStillSealed(),
        appliedCount: summary.applied,
        promptReady: promptReady && hostWritten,
      });
      if (shouldRestart) reapply.markSettleRestart();
      try { core.seedPromptInjectAtBoot(state.dsh_home); } catch { /* 主目录尚未就绪 */ }
      try { refreshHungOperator(state.dsh_home); } catch { /* ignore */ }
      const planned = scheduleApplyRestart(shouldRestart, ctx);
      if (planned && planned.clean === false) {
        lines.push("", "清洗没有写进当前宿主，已取消重启。");
      } else if (planned && planned.restarting === false && planned.error) {
        lines.push("", String(planned.error));
      } else if (shouldRestart && planned && planned.restarting !== false) {
        lines.push("", "正在重启。");
      } else if (!complete) {
        lines.push("", "清洗没有完成，没有重启。");
      } else {
        lines.push("", "补丁已经在宿主里，不再重启。");
      }
      return { kind: "success", text: lines.join("\n") };
    }
    case "revert":
    case "r": {
      const state = await core.gatherState();
      const lines = [];
      if (state.ai_base) {
        const { reverted, errors } = await core.revertAll(state.ai_base);
        lines.push(...reverted.map((p) => `  ✓ 已还原 / Reverted ${p}`));
        for (const [p, e] of errors) lines.push(`  ⚠ 还原失败 ${p}: ${e}`);
        if (reverted.length === 0) lines.push("  - 没有补丁备份可还原 / no patch backup");
      }
      const shimRevert = await core.revertAllShims();
      for (const [dir, st] of Object.entries(shimRevert)) {
        lines.push(`  shim ${dir}: ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push("", "回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
      lines.push("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
      return { kind: "success", text: lines.join("\n") };
    }
    case "uninstall":
    case "remove": {
      const result = await uninstaller.uninstallPurge();
      const lines = [];
      if (result.applied) lines.push("已检测到补丁，已还原回原版。");
      else lines.push("未检测到已应用补丁，仍会清除插件文件。");
      if (result.patches) {
        lines.push(`  还原文件 ${result.patches.reverted?.length || 0} 个`);
      }
      if (result.override?.removed) lines.push(`  已删除 ${result.override.path}`);
      if (result.stripped?.length) lines.push(`  已从 profile 移除: ${result.stripped.join(", ")}`);
      if (result.errors?.length) {
        for (const e of result.errors) lines.push(`  ⚠ ${e}`);
      }
      lines.push("", "请重启 dsh。重启后插件不再加载。");
      return { kind: result.ok ? "success" : "error", text: lines.join("\n") };
    }
    case "edit":
    case "e": {
      const state = await core.gatherState();
      let r = core.editOverride(state.dsh_home);
      let created = false;
      if (!r.ok && r.needCreate) {
        await core.installOverride(state.dsh_home, true);
        r = core.editOverride(state.dsh_home);
        created = true;
      }
      // 旧实现：r.ok 为 false 时仍然返回 kind:"success"，用户看到"已打开"但进程根本没起来。
      if (!r.ok) {
        return { kind: "error", text: r.error || "打开编辑器失败" };
      }
      return {
        kind: "success",
        text: created
          ? `已创建默认注入文件并打开编辑器：${r.path}\n重启 dsh 生效。`
          : `已打开 ${r.editor} 编辑注入文件：${r.path}\n编辑完成后重启 dsh 生效。`,
      };
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "dsh-purge 命令：\n" +
          "  /purge status     显示状态\n" +
          "  /purge apply      应用全部清洗（提示词+代码+shim+override）\n" +
          "  /purge revert     回滚还原\n" +
          "  /purge uninstall  卸载插件（已应用则先还原）\n" +
          "  /purge edit       编辑注入文件 prompt-inject.md\n" +
          "  /purge help       显示帮助\n" +
          "规则集切换见 /rules（list | use <id> | create | delete | reset）\n" +
          "官方 Skill 安装见 /skills（list | import <路径> | create <id> [说明] | delete <id>）",
      };
  }
}

function renderRulesStatus(st) {
  const out = [];
  out.push("规则集 / Rule Sets");
  out.push(`  存储目录 / store  ${st.rules_dir}`);
  const targetLine = st.active
    ? `${st.agents_path} (${st.active_target})`
    : "(无激活)";
  out.push(`  目标文件 / target ${targetLine} — exists=${st.agents_exists}, synced=${st.agents_synced}`);
  out.push("");
  if (st.rules.length === 0) {
    out.push("  (暂无规则 / no rules — 用 /rules create <id> 或设置页新建)");
  }
  for (const r of st.rules) {
    const isActive = r.id === st.active;
    const label = r.name !== r.id ? `${r.name} (${r.id})` : r.id;
    out.push(`  ${isActive ? "▶" : "·"} ${label}${isActive ? " ★ 当前" : ""} [${r.target}] (${rules.formatSize(r.size)})`);
  }
  return out.join("\n");
}

async function handleRulesCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderRulesStatus(await rules.rulesStatus(dshHome)) };
    case "use":
    case "activate":
    case "u": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules use <id>" };
      try {
        const meta = await rules.activateRule(dshHome, id);
        refreshHungOperator(dshHome);
        return {
          kind: "success",
          text: `✓ 已激活规则 ${meta.name}（${id}）→ 写入 ${rules.targetPath(dshHome, meta.target)}，并注入 systemPrompt。新会话生效。`,
        };
      } catch (e) {
        return { kind: "error", text: `激活失败: ${e.message}` };
      }
    }
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules create <id> [别名] [AGENTS.md|CLAUDE.md]" };
      const name = args[2] || id;
      const target = args[3] || "AGENTS.md";
      if (!rules.validTarget(target)) {
        return { kind: "error", text: `无效目标: ${target}（只能是 AGENTS.md 或 CLAUDE.md）` };
      }
      try {
        await rules.saveRule(dshHome, id, "", { name, target });
        return {
          kind: "success",
          text: `✓ 已创建规则 ${name}（${id} → ${target}）。在设置页「规则设定」编辑内容后保存。`,
        };
      } catch (e) {
        return { kind: "error", text: `创建失败: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules delete <id>" };
      try {
        await rules.deleteRule(dshHome, id);
        refreshHungOperator(dshHome);
        return { kind: "success", text: `✓ 已删除规则 ${id}。` };
      } catch (e) {
        return { kind: "error", text: `删除失败: ${e.message}` };
      }
    }
    case "reset":
    case "restore":
    case "还原": {
      try {
        const r = await rules.resetToOriginal(dshHome);
        refreshHungOperator(dshHome);
        const lines = [];
        if (r.removed.length > 0) lines.push(`✓ 已删除插件写入的目标文件: ${r.removed.join(", ")}`);
        if (r.skipped.length > 0) {
          lines.push(`⚠ 跳过（文件内容与规则不一致，可能被手动修改）: ${r.skipped.join(", ")}`);
        }
        lines.push("已清空激活状态。规则库内容保留，随时可重新激活。现在回到出厂状态：无全局指令。");
        return { kind: "success", text: lines.join("\n") };
      } catch (e) {
        return { kind: "error", text: `还原失败: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "规则集命令：\n" +
          "  /rules list                         列出所有规则\n" +
          "  /rules use <id>                     激活规则（写入 AGENTS.md/CLAUDE.md，并注入 systemPrompt）\n" +
          "  /rules create <id> [别名] [目标]     新建规则\n" +
          "  /rules delete <id>                  删除规则\n" +
          "  /rules reset                        还原原始状态\n" +
          "  /rules help                         显示帮助",
      };
  }
}

function renderSkillsStatus(st) {
  const out = [];
  out.push("官方用户 Skill / $DSH_HOME/skills");
  out.push(`  ${st.skills_dir}`);
  out.push("  插件只安装目录。调用走官方：任务对上 description/whenToUse 时模型调 skill 工具；聊天输入 /名称 立即加载。");
  out.push("  正文里写「激活」不会触发。官方认 name、description、whenToUse、disable-model-invocation、user-invocable。");
  out.push("");
  if (!st.skills.length) {
    out.push("  (暂无用户 Skill — 用 /skills import <压缩包或文件夹> 或设置页导入)");
    return out.join("\n");
  }
  for (const item of st.skills) {
    const mark = item.valid ? "·" : "!";
    const desc = item.description || "(无说明)";
    const how = item.valid
      ? [
        item.userInvocable ? `/${item.id}` : "不可 /名称",
        item.modelInvocable ? "模型可调" : "模型不可调",
      ].join(" · ")
      : "";
    out.push(`  ${mark} ${item.id}  ${desc}  (${skills.formatSize(item.size)})`);
    if (how) out.push(`      ${how}`);
    if (!item.valid && item.error) out.push(`      ${item.error}`);
  }
  return out.join("\n");
}

async function handleSkillsCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderSkillsStatus(await skills.skillsStatus(dshHome)) };
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /skills create <id> [说明]" };
      if (!skills.validSkillName(id)) {
        return { kind: "error", text: "id 必须是 kebab-case，例如 code-review" };
      }
      const description = args.slice(2).join(" ").trim() || id;
      try {
        const saved = skills.toPublicSkill(dshHome, await skills.saveSkill(dshHome, id, "", description));
        return {
          kind: "success",
          text: `✓ 已写入官方目录 ${saved.path}\n新会话会进官方 Skill 目录；任务对上或输入 /${id} 时由官方加载。`,
        };
      } catch (e) {
        return { kind: "error", text: `安装失败: ${e.message}` };
      }
    }
    case "import":
    case "i": {
      const src = args.slice(1).join(" ").trim();
      if (!src) return { kind: "error", text: "用法: /skills import <压缩包或文件夹>" };
      try {
        const packed = await skills.importFromPath(dshHome, src);
        const names = packed.imported.map((item) => item.id).join(", ");
        return { kind: "success", text: `✓ 已导入到官方 $DSH_HOME/skills：${names}` };
      } catch (e) {
        return { kind: "error", text: `导入失败: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /skills delete <id>" };
      try {
        const removed = skills.toPublicSkill(dshHome, await skills.deleteSkill(dshHome, id));
        return {
          kind: "success",
          text: `✓ 已从官方目录删除 ${id}${removed.backup ? `\n备份：${removed.backup}` : ""}`,
        };
      } catch (e) {
        return { kind: "error", text: `删除失败: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "官方 Skill 安装：\n" +
          "  /skills list                 列出 $DSH_HOME/skills\n" +
          "  /skills create <id> [说明]   写入 <id>/SKILL.md\n" +
          "  /skills import <路径>        导入压缩包或文件夹到官方目录\n" +
          "  /skills delete <id>          删除该目录（官方会从目录拿掉）\n" +
          "  也可自己删 $DSH_HOME/skills/<id>\n" +
          "  调用：聊天输入 /<id>，或让模型按 description 调 skill 工具\n" +
          "  不注入 systemPrompt，不替代提示词",
      };
  }
}

export function apply(ctx, config) {
  assertRuntime();
  try { updater.recoverInterrupted(); } catch (error) { console.warn("[dsh-purge] recovery:", error.message); }
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) {
    purgeLog("boot", { enabled: false });
    return;
  }
  purgeLog("boot", {
    enabled: true,
    surface: hostctl.currentSurface(),
    stripMnemon: cfg.stripMnemon !== false,
    cap: cfg.capabilityProtocol !== false,
  });
  core.setHooksDenyConfigValue(cfg.hooksDenyBypass);
  core.refreshHooksDenySettings();
  /* 上游 1.1.84：尾部锚点 + 子代理审批接管。
     两个都带开关（anchorMode / subagentControl），disposer 交给 ctx.effect，
     reload / dispose 时一起撤掉，避免热重载叠加注册。 */
  try {
    if (typeof ctx?.effect === "function") {
      ctx.effect(() => {
        let disposeAnchor = () => {};
        let disposeControl = () => {};
        try { disposeAnchor = registerAnchor(ctx, cfg) || (() => {}); } catch (e) { purgeLog("anchor", { err: String(e?.message || e) }); }
        try { disposeControl = installSubagentControl(ctx, cfg) || (() => {}); } catch (e) { purgeLog("subagent-control", { err: String(e?.message || e) }); }
        return () => {
          try { disposeAnchor(); } catch { /* 已释放 */ }
          try { disposeControl(); } catch { /* 已释放 */ }
        };
      });
      purgeLog("anchor.install", { mode: cfg.anchorMode || "auto", subagentControl: cfg.subagentControl !== false });
    }
  } catch (e) {
    purgeLog("anchor.install", { err: String(e?.message || e) });
  }
  try {
    const home = core.pinDshHome() || core.findDshHome();
    purgeLog("home", { home: home || "(none)" });
    try {
      if (home) {
        const flag = path.join(home, ".hung-disabled");
        if (fs.existsSync(flag)) {
          fs.unlinkSync(flag);
          purgeLog("hung-disabled", { removed: flag });
        }
      }
    } catch (e) { purgeLog("hung-disabled", { err: String(e?.message || e) }); }
    installHungPromptGlobal();
    // Apply→cleanup→restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
    // 用户已经改过的文件不动；只有「没有」或「仍是空文件」时才补写。
    try {
      const seed = core.seedPromptInjectAtBoot(home);
      log(cfg, "seed prompt-inject:", seed?.action || "noop", seed?.reason || "");
    } catch (e) {
      console.warn("[dsh-purge] seed prompt-inject failed:", String(e && e.message ? e.message : e));
    }
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }
  // 启动不写宿主包。补丁 / bak / client.js / runtime 只在点「应用」时写一次。
  const life = watchContextLife(ctx);
  const bootTimer = setInterval(() => {
    if (!life.alive) return;
    const operation = process.env.DSH_PURGE_OPERATION ? operationStatus(core.findDshHome()) : null;
    if (!operation || ["verified", "rolled_back", "failed"].includes(operation.phase)) {
      clearInterval(bootTimer);
      return;
    }
    reportBoot(core.findDshHome(), updater.pluginRoot(), () => core.gatherState())
      .catch((error) => log(cfg, "boot verification:", error.message));
  }, 1500);
  bootTimer.unref?.();
  try { ctx.effect(() => () => clearInterval(bootTimer)); } catch { clearInterval(bootTimer); }
  if (!life.alive) {
    console.warn("[dsh-purge] skip apply: inactive context");
    return;
  }
  log(cfg, "plugin enabled");
  core.applyRuntimeEnv();
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }

  const settleTimer = setTimeout(() => {
    if (bootVerificationPending(core.findDshHome())) return;
    if (!life.alive) {
      log(cfg, "settle skipped: inactive context");
      return;
    }
    settleInstalledPatches(cfg, ctx, life)
      .then((r) => log(cfg, "settle:", r))
      .catch((e) => {
        if (isInactiveContextError(e)) {
          log(cfg, "settle skipped: inactive context");
          return;
        }
        console.warn("[dsh-purge] settle error:", String(e));
      });
    rules.ensureInitialState(core.findDshHome())
      .then((r) => log(cfg, "rules init:", JSON.stringify(r)))
      .catch((e) => console.warn("[dsh-purge] rules init error:", String(e)));
  }, settleDelayMs(hostctl.currentSurface()));
  try {
    ctx.effect(() => () => clearTimeout(settleTimer));
  } catch (e) {
    if (isInactiveContextError(e)) {
      clearTimeout(settleTimer);
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }

  try {
    applyHostHooks(ctx, cfg);
  } catch (e) {
    if (isInactiveContextError(e)) {
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }
}

function applyHostHooks(ctx, cfg) {
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录尚未就绪 */ }
  installIdentityOverride(ctx, cfg);
  installFreshFullAccess(ctx);
  installCwdCapture(ctx);
  installMnemonMessageStrip(ctx, cfg);
  registerPromptSections(ctx, cfg);

  // 本次 apply 作用域内的 continue-retry 状态；旧 ctx dispose 会把这些闭包一并带走。
  const continuePluginCfg = cfg;
  const savedContinueSettings = continueRetry.loadSettings(core.findDshHome());
  const continueRuntime = continueRetry.installContinueRetry(ctx, {
    getConfig: () => continueRetry.mergeConfig(continuePluginCfg, savedContinueSettings),
  });
  try {
    ctx.effect(() => () => {
      try { continueRuntime?.dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 无 effect 时靠 cordis scope 自己回收 */ }

  const commands = ctx.get?.("commands");
  if (commands) {
    commands.register({
      name: "purge",
      description: "dsh 指令权威性清洗（status/apply/revert/uninstall/edit/help）",
      input: { hint: "status | apply | revert | uninstall | edit | help" },
      handler: async (invocation) => handlePurgeCommand(invocation.rawInput ?? "", cfg, ctx),
    });
    commands.register({
      name: "rules",
      description: "规则集切换（写入 AGENTS.md/CLAUDE.md）: list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help",
      input: { hint: "list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help" },
      handler: async (invocation) => handleRulesCommand(invocation.rawInput ?? ""),
    });
    commands.register({
      name: "skills",
      description: "官方用户 Skill（$DSH_HOME/skills）：list | import <路径> | create <id> [说明] | delete <id> | help",
      input: { hint: "list | import <路径> | create <id> [说明] | delete <id> | help" },
      handler: async (invocation) => handleSkillsCommand(invocation.rawInput ?? ""),
    });
    commands.register({
      name: "rewind",
      description: "回退：子代理直接回退一次；主代理 /rewind once 或 /rewind round",
      input: { hint: "once | round" },
      handler: async (invocation) => {
        const sessionId = rewind.invocationSessionId(invocation);
        const arg = String(invocation.rawInput || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
        const info = await rewind.analyzeRewind(ctx, sessionId);
        if (info.ok && info.kind === "main" && arg !== "once" && arg !== "round") {
          return {
            kind: "success",
            text: "主代理请选择：/rewind once 回退一次，/rewind round 回退上一轮（含本轮子代理）。",
          };
        }
        const mode = arg === "round" ? "round" : "once";
        const result = await rewind.applyRewind(ctx, sessionId, mode);
        if (!result.ok) return { kind: "error", text: result.error };
        return {
          kind: "success",
          text: mode === "round"
            ? "已回退上一轮。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。"
            : "已回退一次。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。",
        };
      },
    });
  }

  if (ctx.tools) {
    ctx.tools.register({
      name: "purge_status",
      description: `查看 dsh 指令权威性清洗状态（${core.ALL_PATCHES.length} patch 清洗进度、shim 注入、override 文件）。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        return { text: renderStatus(state) };
      },
    });
    ctx.tools.register({
      name: "purge_apply",
      description: `应用 dsh 指令权威性清洗：${core.ALL_PATCHES.length} patch（提示词层+代码默认+引擎级审批/沙箱绕过）+ shim 注入 + override 文件。需重启 dsh 完全生效。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        core.applyRuntimeEnv();
        const scrubbed = core.sanitizeDesktopCommandRuntimes();
        const state = await core.gatherState();
        if (!state.ai_base) return { text: "ERROR: " + core.missingAiBaseMessage() };
        const blocked = rejectIfNeedPrompt(state.dsh_home);
        if (blocked) return { text: "ERROR: " + blocked.error };
        const toolMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
          preserveClientBundles: false,
          forApply: true,
        });
        await core.patchAllShims();
        const flash = core.silenceCmdFlash(toolMulti.hosts[0]?.aiBase || state.ai_base);
        const report = toolMulti.report;
        const applied = report.filter((r) => r.status === "applied").length;
        const already = report.filter((r) => r.status === "already").length;
        const scrubNote = scrubbed.length ? ` desktop_scrub=${scrubbed.length}` : "";
        return { text: `清洗完成 / applied=${applied}, already=${already}.${scrubNote} phase-1=${flash.phase1} 重启 dsh 生效.` };
      },
    });
    ctx.tools.register({
      name: "purge_revert",
      description: "回滚 dsh 指令权威性清洗到备份原件（保留 prompt-inject.md 用户文件）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        const lines = [];
        if (state.ai_base) {
          const { reverted, errors } = await core.revertAll(state.ai_base);
          lines.push(`reverted=${reverted.length}${errors.length ? ` errors=${errors.length}` : ""}`);
        }
        const shimRevert = await core.revertAllShims();
        lines.push(`shim_dirs=${Object.keys(shimRevert).length}`);
        return { text: `回滚完成 / ${lines.join(", ")}. 重启 dsh 恢复.` };
      },
    });
  }

  installWebServer(ctx, cfg);
}

function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function denyCrossOrigin(response) {
  response.writeHead(403, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, error: "cross-origin blocked" }));
}

function allowPluginRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  if (site === "cross-site") {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, "origin").trim();
  if (origin === "null") {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, "host").trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

function installWebServer(ctx, cfg) {
  // 桌面端内嵌 @deepseek-ai/dsh-web-app，设置页同样走 webServer（常见 43120），不是只给官方 dsh web。
  watchWebTreeReady(ctx);
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // 收集所有子路由的 unregister disposer；host.effect 的 cleanup 一把全撤。
      // 旧版本只注册不收，plugin reload 时上一轮的 handler 仍挂着，新的叠在之上。
      const routeDisposers = [];
      const trackRoute = (d) => {
        if (typeof d === "function") routeDisposers.push(d);
        return d;
      };
      const registerPluginRoute = (spec, label) => trackRoute(host.webServer.register({
        ...spec,
        handler: async (request, response) => {
          if (!allowPluginRequest(request, response)) return;
          return spec.handler(request, response);
        },
      }, label));
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            if (!webTreeReady) {
              sendJson(response, 503, { ok: false, ready: false });
              return;
            }
            const state = await core.gatherState();
            // 只在真的等着换包时才去读「稍后再说」标记，普通轮询不额外 stat 归档。
            const restartDismissed = state.activation_pending === true ? reapply.restartDismissed() : false;
            const patch_names = {};
            for (const p of core.ALL_PATCHES) patch_names[String(p.id)] = p.name;
            sendJson(response, 200, {
              ok: true,
              ready: true,
              surface: state.surface || hostctl.currentSurface(),
              ai_base: state.ai_base,
              desktop_install: state.desktop_install || "",
              desktop_exe: state.desktop_exe || "",
              asar_still_sealed: state.asar_still_sealed || false,
              sealed_install: state.sealed_install === true,
              patches_active: state.patches_active === true,
              activation_pending: state.activation_pending === true,
              missing_ai_base: state.ai_base ? "" : core.missingAiBaseMessage(),
              patches_applied: state.ai_base ? (state.display_applied ?? state.patches_applied) : 0,
              patches_pending: state.display_pending ?? state.patches_pending,
              patches_skipped: state.display_skipped ?? state.patches_skipped ?? 0,
              patches_unmatched: state.display_unmatched ?? state.patches_unmatched ?? 0,
              patches_ready: state.display_ready ?? state.patches_ready ?? 0,
              patches_na: state.patches_na || 0,
              patches_total: state.ai_base ? (state.display_total ?? state.patches_total ?? 0) : 0,
              patches_lost: reapply.patchesLostAfterHostReset(),
              patch_status: state.patch_status,
              patches: (state.display_patches || []).map((p) => ({
                id: p.id,
                ids: p.ids,
                layer: p.layer || "",
                status: p.status,
              })),
              patch_names,
              shim_cmd: state.shim_cmd,
              shim_ps1: state.shim_ps1,
              shim_bin: state.shim_bin,
              has_backup: state.has_backup,
              override_status: state.override_status,
              override_path: state.override_path,
              dsh_home: state.dsh_home,
              plugin_version: updater.localVersion(),
              plugin_revision: updater.installedRevision(),
              plugin_root: updater.pluginRoot(),
              process_id: process.pid,
              profile: process.env.DSH_PROFILE || state.surface,
              operation: operationStatus(core.findDshHome()),
              boot_full_quit: bootFullQuit || (state.activation_pending === true && !restartDismissed),
              restart_dismissed: restartDismissed,
              update: updater.lastUpdateResult(),
              ...updater.channelPublic(),
              hooks_deny_bypass: core.getHooksDenySettings().hooksDenyBypass,
              ...(await skills.skillsStatus(core.findDshHome()).catch(() => ({ skills: [] }))),
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: status");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/hooks-deny",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const settings = core.refreshHooksDenySettings();
              sendJson(response, 200, { ok: true, hooksDenyBypass: settings.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              if (typeof body?.hooksDenyBypass !== "boolean") {
                sendJson(response, 400, { ok: false, error: "hooksDenyBypass must be boolean" });
                return;
              }
              const saved = core.setHooksDenySettings({ hooksDenyBypass: body.hooksDenyBypass });
              sendJson(response, 200, { ok: true, hooksDenyBypass: saved.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: hooks-deny");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/last-user",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.readLastUserText(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: last user");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind/options",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.analyzeRewind(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: rewind options");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const url = new URL(request.url, "http://127.0.0.1");
              const sessionId = url.searchParams.get("sessionId");
              if (sessionId) {
                const draft = rewind.takeDraft(sessionId);
                sendJson(response, 200, { ok: true, ...(draft || {}) });
                return;
              }
              const pending = rewind.getPending();
              sendJson(response, 200, { ok: true, ...(pending || {}) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const sessionId = String(body?.sessionId || "").trim();
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "需要 sessionId" });
                return;
              }
              const mode = body?.mode === "round" ? "round" : "once";
              const result = await rewind.applyRewind(ctx, sessionId, mode);
              sendJson(response, result.ok ? 200 : 409, result);
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: rewind");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/update",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              sendJson(response, 200, await updater.checkUpdate());
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const result = await updater.handleUpdateOp(body || {});
              if (result && result.needsFullQuit) bootFullQuit = true;
              sendJson(response, 200, result);
              if (result && result.restartAfter) {
                try { hostctl.scheduleRestart(request, ctx); } catch (e) {
                  console.warn("[dsh-purge] update restart failed:", e);
                }
              }
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: update");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/apply",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const current = operationStatus(core.findDshHome());
            if (current && !["verified", "rolled_back", "failed", "awaiting_restart"].includes(current.phase)) {
              sendJson(response, 409, { ok: false, error: "Another update/restart operation is active", operation: current });
              return;
            }
            const body = await readJsonBody(request);
            const incoming = typeof body?.content === "string" ? body.content : null;
            core.applyRuntimeEnv();
            core.clearDesktopLocateCache();
            const home = core.pinDshHome();
            const scrubbed = core.sanitizeDesktopCommandRuntimes();
            const state = await core.gatherState();
            if (home) state.dsh_home = home;
            let located;
            try {
              located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
              return;
            }
            if (!located.aiBase) {
              sendJson(response, 500, { ok: false, error: core.missingAiBaseMessage() });
              return;
            }
            state.ai_base = located.aiBase;
            if (located.extracted) {
              const arch = located.handoff?.archive;
              if (arch) core.writeUnpackedAsarStamp(arch);
            }
            const handoff = located.handoff && located.handoff.swapAsar ? located.handoff : null;
            const blocked = rejectIfNeedPrompt(state.dsh_home, incoming === null ? undefined : incoming);
            if (blocked) {
              const ui = await core.readOverrideForUi(state.dsh_home);
              sendJson(response, 400, {
                ok: false,
                needPrompt: true,
                override_content: incoming || "",
                defaultContent: ui.defaultContent,
                ...blocked,
              });
              return;
            }
            try {
              await core.commitOverrideOnApply(state.dsh_home, incoming);
            } catch (e) {
              console.warn("[dsh-purge] apply override:", String(e && e.message ? e.message : e));
            }
            const httpMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
              preserveClientBundles: false,
              forApply: true,
            });
            const report = httpMulti.report;
            const shim = await core.patchAllShims();
            let cliRepair = null;
            try {
              cliRepair = core.repairOfficialCliAfterUnpack();
            } catch (e) {
              cliRepair = { ok: false, error: String(e && e.message ? e.message : e) };
            }
            const flash = core.silenceCmdFlash(httpMulti.hosts[0]?.aiBase || state.ai_base);
            const summary = core.summarizeApplyReport(report);
            const hostWritten =
              core.allPatchHostsWritten(httpMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
            const hookDenyRestoreFailed = (httpMulti.hookDenyRestoreFailed || []).length > 0;
            const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !hookDenyRestoreFailed;
            const sealedNow = core.desktopAsarStillSealed();
            const promptReady = summary.failed.length > 0 && summary.failed.every((item) => item.status === "pattern_not_found");
            if (flash.ok === true && (complete || promptReady) && hostWritten) {
              reapply.markPatchesApplied();
            }
            // 全部洗完且标记进宿主才弹重启；密封包重启时换走 asar。
            const shouldRestart = applyShouldRestart({
              complete: complete || (promptReady && hostWritten),
              sealed: sealedNow,
              appliedCount: summary.applied,
              promptReady: promptReady && hostWritten,
            });
            if (shouldRestart && handoff && sealedNow) bootFullQuit = true;
            else bootFullQuit = false;
            if (shouldRestart) {
              reapply.markSettleRestart();
              // 用户刚点了一次应用：这一次该重新问重启（#8）。
              reapply.clearRestartDismissed();
            }
            let promptInjectInstall = "skipped";
            if (hostWritten && flash.ok === true) {
              // Apply → cleanup → restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
              // 用户自改过的内容保留；仅当文件不存在或仍是插件旧默认时才写。
              try {
                const seed = core.seedPromptInjectAtBoot(state.dsh_home);
                promptInjectInstall = seed?.action || "noop";
              } catch (e) {
                promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
              }
            }
            const hung = refreshHungOperator(state.dsh_home);
            const operation = updater.recordApply(state, shouldRestart, complete);
            const override = await core.readOverrideForUi(state.dsh_home);
            sendJson(response, 200, {
              ok: true,
              complete,
              operation,
              verified: false,
              restarting: false,
              restart_after_apply: false,
              restart_required: shouldRestart,
              unpacked_asar: shouldRestart,
              needs_full_quit: shouldRestart,
              asar_still_sealed: sealedNow,
              asar_swap_started: false,
              applied: summary.applied,
              already: summary.already,
              failed: summary.failed.length,
              failed_items: summary.failed.map((r) => ({
                id: r.patch_id,
                name: r.name,
                status: r.status,
              })),
              report: report.map((r) => ({ id: r.patch_id, name: r.name, status: r.status })),
              override_content: hung.text || override.content,
              defaultContent: override.defaultContent,
              ...injectSnapshot(state.dsh_home),
              override_path: override.path,
              override_installed: promptInjectInstall,
              shim,
              desktop_scrubbed: scrubbed,
              cli_repair: cliRepair,
              cmd_flash: flash,
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: apply");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/revert",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const state = await core.gatherState();
            const result = {};
            if (state.ai_base) {
              const { reverted, errors } = await core.revertAll(state.ai_base);
              result.reverted = reverted.length;
              result.errors = errors.length;
            }
            result.shim = await core.revertAllShims();
            sendJson(response, 200, { ok: true, ...result, note: "重启 dsh 恢复; prompt-inject.md 保留" });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: revert");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/uninstall",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const result = await uninstaller.uninstallPurge();
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface: hostctl.currentSurface(),
              fullApp: hostctl.currentSurface() === "desktop",
              note: result.ok ? hostctl.restartNote() : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      }, "dsh-purge: uninstall");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/drill-grant",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, ...readDrillGrant(home) });
            return;
          }
          if (request.method === "POST") {
            sendJson(response, 200, { ok: true, ...writeDrillGrant(home) });
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: drill-grant");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/override",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const home = core.findDshHome();
              // 面板打开 override 面板时，确保默认加密提示词已 seed；用户自改保留。
              try { core.seedPromptInjectAtBoot(home); } catch { /* ignore */ }
              refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, { ok: true, ...ui, ...injectSnapshot(home) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const home = core.findDshHome();
              const blocked = rejectIfNeedPrompt(home, content);
              if (blocked) {
                sendJson(response, 400, {
                  ok: false,
                  content,
                  ...blocked,
                });
                return;
              }
              const saved = await core.saveOverrideContent(home, content);
              const hung = refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, {
                ok: true,
                content: hung.text,
                defaultContent: saved.defaultContent,
                customized: ui.customized,
                usingDefault: ui.usingDefault,
                path: ui.path,
                ...injectSnapshot(home),
              });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: override");
      trackRoute(installRulesHttp(host.webServer));
      trackRoute(installSkillsHttp(host.webServer));
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/restart",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            // 先清掉 worker 已经死掉的历史作业，否则下面会把 already 当成「正在重启」（#8）。
            const current = updater.reconcileOperation(core.findDshHome());
            if (current && !["verified", "rolled_back", "failed", "awaiting_restart"].includes(current.phase)) {
              sendJson(response, 200, {
                ok: true,
                restarting: true,
                already: true,
                verified: false,
                progress: current.phase,
                operation: current,
              });
              return;
            }
            const ready = await ensureRestartReady();
            if (!ready.ok) {
              bootFullQuit = false;
              sendJson(response, 200, {
                ok: false,
                error: ready.error || "清洗没有完成，已取消重启",
                restarting: false,
                pending: ready.pending || [],
              });
              return;
            }
            const state = await core.gatherState({ surface: hostctl.currentSurface() });
            const operation = await updater.beginRestart(state);
            bootFullQuit = false;
            sendJson(response, 200, { ok: true, surface: state.surface, fullApp: state.surface === "desktop",
              restarting: true, verified: false, operation, operation_id: operation.operation_id,
              asar_still_sealed: state.asar_still_sealed, note: "Restart scheduled; awaiting verified activation" });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: restart");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/restart-dismiss",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            // 「稍后再说」要落盘：面板每次轮询 status 都会重新读到 boot_full_quit，
            // 只靠内存 ref 抑制不住重开设置页（#8）。
            const dismissed = reapply.dismissRestart();
            bootFullQuit = false;
            sendJson(response, 200, { ok: true, dismissed, restart_dismissed: dismissed });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: restart-dismiss");
      return () => {
        for (let i = routeDisposers.length - 1; i >= 0; i -= 1) {
          try { routeDisposers[i](); } catch { /* ignore */ }
        }
        routeDisposers.length = 0;
      };
    }, "dsh-purge: http routes");
  });
}

function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(", ") });
  response.end();
  return true;
}

async function handleRulesOp(op, body, queryId, queryCwd) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  const cwdHint = typeof body?.cwd === "string" && body.cwd.trim()
    ? body.cwd.trim()
    : (typeof queryCwd === "string" && queryCwd.trim() ? queryCwd.trim() : "");
  if (cwdHint) {
    try { rules.writeLastCwd(dshHome, cwdHint); } catch { /* ignore */ }
  }
  if (op === "status") {
    return { ok: true, ...(await rules.rulesStatus(dshHome, cwdHint)) };
  }
  if (op === "scan-cwd" || op === "scan") {
    const effective = cwdHint || rules.readLastCwd(dshHome);
    const candidates = effective ? rules.scanCwdInstructions(effective) : [];
    const selections = rules.readCwdSelections(dshHome);
    return {
      ok: true,
      cwd: effective,
      candidates: candidates.map((item) => ({ ...item, selected: selections.includes(item.path) })),
      selections,
    };
  }
  if (op === "toggle-cwd") {
    const target = typeof body?.path === "string" ? body.path.trim() : "";
    if (!target) return { status: 400, ok: false, error: "path required" };
    const enabled = body?.enabled !== false;
    const next = await rules.toggleCwdSelection(dshHome, target, enabled);
    return { ok: true, selections: next };
  }
  if (op === "set-policy" || op === "workspace-policy") {
    const policy = typeof body?.policy === "string" ? body.policy.trim() : "";
    if (!rules.WORKSPACE_POLICIES.includes(policy)) {
      return { status: 400, ok: false, error: `invalid policy: ${policy}` };
    }
    const applied = await rules.writeWorkspacePolicy(dshHome, policy);
    return { ok: true, policy: applied, policies: [...rules.WORKSPACE_POLICIES] };
  }
  if (op === "read") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const content = await rules.readRule(dshHome, id);
    if (content === null) return { status: 404, ok: false, error: `rule not found: ${id}` };
    const meta = await rules.readRuleMeta(dshHome, id);
    return { ok: true, id, name: meta.name, target: meta.target, content };
  }
  if (op === "save") {
    const content = typeof body?.content === "string" ? body.content : null;
    if (!rules.validRuleId(id) || content === null) {
      return { status: 400, ok: false, error: "id and content (string) required" };
    }
    const target = typeof body?.target === "string" ? body.target : undefined;
    // 旧版本直接把 body.target 写进 rules.saveRule；非法目标会污染 agents_path 推导。
    if (target !== undefined && !rules.validTarget(target)) {
      return { status: 400, ok: false, error: `invalid target: ${target}（只能是 AGENTS.md 或 CLAUDE.md）` };
    }
    await rules.saveRule(dshHome, id, content, {
      name: typeof body?.name === "string" ? body.name : undefined,
      target,
    });
    refreshHungOperator(dshHome);
    return { ok: true, id, ...injectSnapshot(dshHome) };
  }
  if (op === "activate") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const meta = await rules.activateRule(dshHome, id);
    refreshHungOperator(dshHome);
    return {
      ok: true,
      id,
      name: meta.name,
      target: meta.target,
      agents_path: rules.targetPath(dshHome, meta.target),
      note: "已写入目标文件并注入 systemPrompt，新会话生效",
      ...injectSnapshot(dshHome),
    };
  }
  if (op === "delete") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    await rules.deleteRule(dshHome, id);
    refreshHungOperator(dshHome);
    return { ok: true, id };
  }
  if (op === "reset") {
    const r = await rules.resetToOriginal(dshHome);
    refreshHungOperator(dshHome);
    return { ok: true, ...r, note: "已还原出厂状态（无全局指令）；规则库保留" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function rulesHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = url.pathname.replace(/^\/dsh-purge\/rules\/?/, "").replace(/\/$/, "");
      let body = {};
      if (request.method === "POST") body = await readJsonBody(request);
      else if (methodNotAllowed(request, response, forcedOp ? ["GET", "POST"] : ["GET", "POST"])) return;
      const op = forcedOp || body.op || tail || "status";
      const result = await handleRulesOp(op, body, url.searchParams.get("id"), url.searchParams.get("cwd"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

async function handleSkillsOp(op, body, queryId) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  if (op === "status") {
    return { ok: true, ...(await skills.skillsStatus(dshHome)) };
  }
  if (op === "read") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const item = await skills.readSkill(dshHome, id);
    if (!item) return { status: 404, ok: false, error: `skill not found: ${id}` };
    return { ok: true, ...skills.toPublicSkill(dshHome, item) };
  }
  if (op === "save") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "id 必须是 kebab-case，例如 code-review" };
    const content = typeof body?.content === "string" ? body.content : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const saved = await skills.saveSkill(dshHome, id, content, description);
    return { ok: true, ...skills.toPublicSkill(dshHome, saved) };
  }
  if (op === "delete") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const removed = await skills.deleteSkill(dshHome, id);
    return { ok: true, ...skills.toPublicSkill(dshHome, removed) };
  }
  if (op === "import") {
    if (body?.path || body?.source || body?.folder) {
      return { status: 400, ok: false, error: "请在本机选择压缩包或文件夹导入" };
    }
    if (typeof body?.data === "string" && body.data.trim()) {
      const packed = await skills.importArchive(dshHome, Buffer.from(body.data, "base64"), body.name || "skill.zip");
      return { ok: true, ...packed };
    }
    if (Array.isArray(body?.files) && body.files.length) {
      const packed = await skills.importFileTree(dshHome, body.files, body.name || "");
      return { ok: true, ...packed };
    }
    return { status: 400, ok: false, error: "请选择压缩包或文件夹" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function skillsHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST, OPTIONS" });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = skillRouteTail(url.pathname);
      const body = request.method === "POST" ? await readJsonBody(request, 14 * 1024 * 1024) : {};
      const op = forcedOp
        || body.op
        || tail
        || url.searchParams.get("op")
        || (url.searchParams.get("id") ? "read" : "status");
      const result = await handleSkillsOp(op, body, url.searchParams.get("id"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

function skillRouteTail(pathname) {
  const match = String(pathname || "").match(/^\/dsh-purge\/skills?(?:\/(.*))?$/i);
  if (!match) return "";
  return String(match[1] || "").replace(/\/$/, "");
}

function installSkillsHttp(webServer) {
  // 旧版把 /dsh-purge/skills[/op] 和 /dsh-purge/skill[/op] 分别 exact 注册 10+ 条，再加 prefix 兜底；
  // handler 内部本来就按 tail 分发 op，exact 列表只是把路由表撑大，热重载还更难拆。
  // 用 2 条 prefix 覆盖全部，handler 的 forcedOp="" 让 body.op/tail/op 查询串继续生效。
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/skills", handler: skillsHttpHandler(""),
  }));
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/skill", handler: skillsHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function installRulesHttp(webServer) {
  // 同 skills：prefix 一条覆盖 /dsh-purge/rules[/op]；handler 按 tail 分发 op。
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/rules", handler: rulesHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function registerRoute(webServer, spec) {
  try {
    const handler = spec.handler;
    return webServer.register({
      ...spec,
      handler: async (request, response) => {
        if (!allowPluginRequest(request, response)) return;
        return handler(request, response);
      },
    });
  } catch (e) {
    console.warn("[dsh-purge] route", spec?.path, String(e && e.message ? e.message : e));
    return () => {};
  }
}

async function readJsonBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
