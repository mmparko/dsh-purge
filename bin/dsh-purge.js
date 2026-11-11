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
  const out = ["", `  Hosts (${hosts.length})`];
  for (const h of hosts) {
    const flags = [];
    if (h.is_primary) flags.push("primary");
    if (h.running_app) flags.push("running desktop app");
    if (h.desktop_install) flags.push("desktop");
    out.push(`    · ${h.ai_base}`);
    out.push(
      `      ${h.applied}/${h.total} patched, ${h.pending} pending, ${h.na} not applicable, ${h.skipped} skipped` +
        (flags.length ? `  [${flags.join(", ")}]` : "") +
        (h.has_backup ? "  backup=yes" : ""),
    );
  }
  return out.join("\n");
}

function printStatus(state) {
  const out = [];
  out.push("dsh-purge Status");
  out.push("  Surface       " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  out.push("  Activation    " + (state.patches_active ? "active"
    : state.activation_pending ? "restart required (sealed desktop)" : "not fully applied"));
  if (state.desktop_install) out.push("  Desktop Path  " + state.desktop_install);
  if (state.ai_base) {
    out.push("  Package Root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  Package Root  " + core.missingAiBaseMessage());
  }
  out.push(`  Shim Dir       ${state.shim_dir || "not found"}`);
  out.push(`  Backup         ${state.has_backup ? "yes" : "no"}`);
  out.push(`  Inject File    ${state.override_path}`);
  out.push(`  Inject Status  ${state.override_status}`);
  out.push("");
  out.push(`  Patches ${state.patches_applied}/${state.patches_total ?? core.ALL_PATCHES.length} patched, ${state.patches_pending} pending, ${state.patches_na} not applicable, ${state.patches_skipped} skipped`);
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
    console.log(`dsh-purge Usage:
  dsh-purge --status            Show status (includes multi-host inventory)
  dsh-purge --status --base DIR  Report only specified @deepseek-ai directory
  dsh-purge --status --json      Read-only JSON status
  dsh-purge --doctor            Read-only health checks; exit 1 on failure
  dsh-purge --doctor --json      JSON health checks, with state and check rows
  dsh-purge --doctor --repo DIR  Verify installed packages resolve to this checkout
  dsh-purge --doctor --save-baseline  Save a healthy host baseline
  dsh-purge --surface desktop   Force desktop surface resolution (default: auto)
  dsh-purge --apply             Apply all patches (prompts + code + shim + override)
  dsh-purge --revert            Rollback and restore backups
  dsh-purge --uninstall         Uninstall plugin (restores original first)
  dsh-purge --edit              Edit prompt-inject.md
  dsh-purge --help              Show help`);
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
      console.log("  fix: Point DSH_BASE to the @deepseek-ai directory containing dsh-agent-instructions/lib");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] Both prompt and rule sets are empty. Please configure a prompt first.");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  Host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ patched" : r.status === "already" ? "- up to date" : r.status === "missing_file" ? "⚠ missing file" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  Multi-host: ${hosts.length} @deepseek-ai installations patched`);
    }
    console.log(inject.source === "rule"
      ? "  - Using current ruleset, prompt file untouched"
      : "  - Using existing prompt file");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ Shim directory not located, skipped");
    }
    // 上游 1.1.87：有失败项就以 1 退出，脚本/CI 才感觉得到「这次没打全」。
    const failed = core.summarizeApplyReport(report).failed || [];
    if (failed.length > 0) {
      console.log(`  ✗ Finished with ${failed.length} failed patch(es)`);
      process.exit(1);
    }
    console.log("");
    console.log("All done. Restart DSH to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ Revert failed ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - No patch backup to revert");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("Revert complete. Restart DSH to take effect.");
    console.log("Note: prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  Patches detected and restored to original.");
    else console.log("  No applied patches detected, removing plugin files.");
    if (result.override?.removed) console.log(`  Deleted ${result.override.path}`);
    if (result.stripped?.length) console.log(`  Removed from profile: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  Uninstall aborted: restoration failed, plugin files preserved.");
      process.exit(1);
    }
    console.log("");
    console.log("Uninstall complete. Please restart DSH.");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ Created default injection file: ${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → Opened ${r.editor} to edit injection file: ${r.path}`);
    }
    console.log("  Restart DSH after editing to take effect.");
  } else {
    console.log("No patches applied by default. Run with --apply to apply purge.");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
