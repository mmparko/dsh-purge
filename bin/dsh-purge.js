#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as doctor from "../lib/doctor.js";
import path from "node:path";
import { createRequire } from "node:module";
import { runtimeChecks } from "../lib/runtime-check.js";

const args = process.argv.slice(2);

function argValue(name) {
  const eq = args.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return "";
}

function printHosts(hosts) {
  if (!hosts || hosts.length <= 1) return;
  const out = ["", `  宿主清单 / hosts (${hosts.length})`];
  for (const h of hosts) {
    const flags = [];
    if (h.is_primary) flags.push("primary");
    if (h.running_app) flags.push("当前桌面应用 / running app");
    if (h.desktop_install) flags.push("desktop");
    out.push(`    · ${h.ai_base}`);
    out.push(
      `      ${h.applied}/${h.total} 已清洗, ${h.pending} 待清洗, ${h.na} 不适用, ${h.skipped} skipped` +
        (flags.length ? `  [${flags.join(", ")}]` : "") +
        (h.has_backup ? "  backup=yes" : ""),
    );
  }
  return out.join("\n");
}

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  out.push("  Activation    " + (state.patches_active ? "active"
    : state.activation_pending ? "restart required (sealed desktop)" : "not fully applied"));
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${state.patches_total ?? core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗, ${state.patches_na} 不适用, ${state.patches_skipped} 其他`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id] || "-";
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  const hosts = printHosts(state.hosts);
  if (hosts) out.push(hosts);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--doctor", "--edit", "--help"].includes(a));
  const wantBase = argValue("--base");
  const wantSurface = argValue("--surface");
  const wantRepo = argValue("--repo");
  const wantJson = args.includes("--json");
  const saveBaseline = args.includes("--save-baseline");

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status            显示状态（含多宿主清单）
  dsh-purge --status --base DIR  只报告指定 @deepseek-ai 目录
  dsh-purge --status --json      Read-only JSON status
  dsh-purge --doctor            Read-only health checks; exit 1 on failure
  dsh-purge --doctor --json      JSON health checks, with state and check rows
  dsh-purge --doctor --repo DIR  Verify installed packages resolve to this checkout
  dsh-purge --doctor --save-baseline  Save a healthy host baseline
  dsh-purge --surface desktop   强制按桌面宿主解析（默认自动判断）
  dsh-purge --apply             应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert            回滚还原
  dsh-purge --uninstall         卸载插件（已应用则先还原）
  dsh-purge --edit              编辑注入文件 prompt-inject.md
  dsh-purge --help              帮助`);
    return;
  }

  if (wantJson && mode && !["--status", "--doctor"].includes(mode)) {
    console.log(JSON.stringify({ ok: false, error: "--json is supported only for --status and --doctor" }));
    process.exitCode = 2;
    return;
  }
  for (const name of ["--base", "--surface", "--repo"]) {
    if (args.some((arg) => arg === name || arg.startsWith(name + "=")) && !argValue(name)) {
      throw new Error(`${name} requires a value`);
    }
  }
  if (wantSurface && !["web", "desktop"].includes(wantSurface)) throw new Error("--surface must be web or desktop");
  if (mode !== "--doctor" && (wantRepo || saveBaseline)) throw new Error("--repo and --save-baseline require --doctor");

  // Explicit caller choices must take precedence over automatic running-host selection.
  if (wantSurface) process.env.DSH_SURFACE = wantSurface;
  if (wantBase) process.env.DSH_BASE = wantBase;

  const state = await core.gatherState({ base: wantBase, surface: wantSurface, hosts: true, discover: true });

  if (mode === "--doctor") {
    const home = state.dsh_home;
    const linkPaths = [];
    if (wantRepo) {
      linkPaths.push(path.join(home, "plugins", "dsh-purge"));
      const profile = state.surface === "desktop" ? "desktop" : "web";
      const profileFile = path.join(home, "profiles", profile, "package.json");
      let installed = path.join(path.dirname(profileFile), "node_modules", "dsh-purge");
      try { installed = path.dirname(createRequire(profileFile).resolve("dsh-purge/package.json")); } catch { /* Report the missing installation. */ }
      linkPaths.push(installed);
    }
    const baseline = saveBaseline ? null : doctor.readBaseline(home);
    const result = doctor.runChecks({ state, repo: wantRepo, linkPaths, baseline, runtime: await runtimeChecks() });
    let baselineSaved = null;
    if (saveBaseline && result.ok) {
      baselineSaved = doctor.writeBaseline(home, { ai_base: state.ai_base, surface: state.surface, applied: state.patches_applied });
    }
    if (wantJson) console.log(JSON.stringify({ ...result, state, baseline_saved: baselineSaved }, null, 2));
    else {
      for (const row of result.rows) console.log(`${row.ok ? "[OK]" : "[FAIL]"} ${row.id}: ${row.detail}`);
      if (baselineSaved) console.log(`Baseline saved: ${baselineSaved}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (wantJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    // 上游 1.1.87：有失败项就以 1 退出，脚本/CI 才感觉得到「这次没打全」。
    const failed = core.summarizeApplyReport(report).failed || [];
    if (failed.length > 0) {
      console.log(`  ✗ 完成但仍有 ${failed.length} 个补丁失败 / finished with ${failed.length} failed patch(es)`);
      process.exit(1);
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
