import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load, save, phase, installPayload, restoreFiles, restoreGit, finishMetadata, adoptBootMarkers, pruneBackups, releaseLocks, readJson, alive, digest } from "./update-transaction.js";
import { bootMatches } from "./operation-boot.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hidden = { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] };

export function desktopPids(exe, excluded = []) {
  if (process.platform === "win32") {
    const literal = Buffer.from(exe).toString("base64");
    const script = "$e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + literal + "')); @(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $e} | ForEach-Object {$_.ProcessId}) | ConvertTo-Json -Compress";
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], hidden).trim();
    const result = text ? JSON.parse(text) : [];
    return (Array.isArray(result) ? result : [result]).map(Number).filter((pid) => pid && pid !== process.pid && !excluded.includes(pid));
  }
  const rows = execFileSync("ps", ["-Ao", "pid=,command="], hidden).split("\n");
  const bundle = exe.includes(".app/") ? exe.slice(0, exe.indexOf(".app/") + 5) : "";
  return rows.flatMap((row) => {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid || excluded.includes(Number(match[1]))) return [];
    const command = match[2];
    if (command === exe || command.startsWith(exe + " ") || (bundle && command.startsWith(bundle + "/Contents/Frameworks/"))) return [Number(match[1])];
    return [];
  });
}
function kill(pid) {
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
  else { try { process.kill(pid, "SIGTERM"); } catch { /* Already gone. */ } }
}
export async function stopHost(tx) {
  const pids = () => tx.surface === "desktop" ? desktopPids(tx.restart.execPath, [tx.supervisor_pid]) : [tx.old_pid, tx.new_pid].filter((pid) => pid && alive(pid));
  for (const pid of pids()) kill(pid);
  for (let i = 0; i < 40; i++) {
    const remaining = pids();
    if (!remaining.length) return;
    if (i === 20) {
      for (const pid of remaining) {
        if (process.platform === "win32") kill(pid);
        else { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
      }
    }
    await sleep(250);
  }
  throw new Error("The selected host did not exit; no installation switch is safe");
}
export function startHost(tx, recovery = false) {
  phase(tx, recovery ? "waiting_recovery" : "waiting_boot", { attempt_started: Date.now() });
  const env = { ...process.env, DSH_HOME: tx.home, DSH_PROFILE: tx.profile, DSH_PURGE_OPERATION: tx.id, DSH_PURGE_BOOT_NONCE: tx.nonce };
  delete env.DSH_PURGE_JOURNAL;
  delete env.DSH_PURGE_RESTART;
  delete env.DSH_BASE;
  delete env.DSH_PERMISSION_MODE;
  if (tx.surface === "desktop") delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(tx.dir, recovery ? "recovery-start.log" : "start.log"), "a");
  try {
    const child = spawn(tx.restart.execPath, tx.restart.argv || [], {
      detached: true, stdio: ["ignore", log, log], cwd: tx.restart.cwd, env, windowsHide: true, shell: false,
    });
    child.on("error", (error) => { fs.appendFileSync(path.join(tx.dir, "launch-error.log"), error.message + "\n"); });
    child.unref();
    tx.new_pid = child.pid; save(tx);
  } finally { fs.closeSync(log); }
}
export function requestStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/dsh-purge/status", timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", (data) => { body += data; if (body.length > 1024 * 1024) req.destroy(); });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
function webUrl(tx, recovery) {
  try {
    const text = fs.readFileSync(path.join(tx.dir, recovery ? "recovery-start.log" : "start.log"), "utf8");
    const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
    if (!match) return null;
    const url = new URL(match[1].replace(/[),.;]+$/, ""));
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url : null;
  } catch { return null; }
}
function reopenWeb(tx, recovery) {
  if (tx.surface !== "web" || !tx.restart.openBrowser || tx.browser_attempt === String(recovery)) return;
  const url = webUrl(tx, recovery);
  if (!url) return;
  tx.browser_attempt = String(recovery); save(tx);
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const argv = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url.href] : [url.href];
  const child = spawn(command, argv, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.on("error", () => {}); child.unref();
}
async function legacyReport(tx) {
  let ports = [];
  if (tx.surface === "web") ports = [{ port: Number(webUrl(tx, tx.phase === "waiting_recovery")?.port) || tx.restart.port, pid: tx.new_pid }];
  else if (process.platform === "win32") {
    const pids = desktopPids(tx.restart.execPath);
    if (!pids.length) return null;
    const script = "@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -in @(" + pids.join(",") + ")} | Select-Object @{N='port';E={$_.LocalPort}},@{N='pid';E={$_.OwningProcess}}) | ConvertTo-Json -Compress";
    try {
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], hidden).trim();
      const rows = text ? JSON.parse(text) : [];
      ports = Array.isArray(rows) ? rows : [rows];
    } catch { return null; }
  }
  for (const item of ports) {
    if (!item.port || !item.pid || item.pid === tx.old_pid) continue;
    const status = await requestStatus(item.port);
    if (!status || path.resolve(status.dsh_home || ".") !== path.resolve(tx.home)) continue;
    let sha = "";
    try { sha = fs.readFileSync(path.join(tx.primary, ".dsh-purge-revision"), "utf8").trim(); } catch { /* Legacy backup. */ }
    return { ...status, version: status.plugin_version, sha, profile: status.profile || status.surface, pid: item.pid,
      started_at: Date.now(), nonce: tx.nonce };
  }
  return null;
}
export async function waitForBoot(tx, recovery = false, timeout = 120000) {
  // 冷启动一台机械盘上的 Electron 宿主经常超过 2 分钟；超时会被当成失败并回滚换包（#8）。
  const budget = tx.surface === "desktop" ? Math.max(timeout, 180000) : timeout;
  const until = Date.now() + budget;
  let lastLegacy = 0;
  while (Date.now() < until) {
    reopenWeb(tx, recovery);
    let report = readJson(path.join(tx.dir, "boot-report.json"));
    if (bootMatches(tx, report, recovery)) return report;
    // Old releases lack the journal reporter. Only probe ports owned by the new host.
    if (((recovery && !tx.previous.sha) || (!recovery && tx.legacy_target)) && Date.now() - lastLegacy > 5000) {
      lastLegacy = Date.now();
      report = await legacyReport(tx);
      if (bootMatches(tx, report, recovery)) return report;
    }
    await sleep(500);
  }
  throw new Error("Host activation was not verified within 120 seconds");
}
function moveAsar(tx) {
  const asar = tx.restart.asar;
  if (!asar || !fs.existsSync(asar)) return;
  if (fs.lstatSync(asar).isSymbolicLink() || !fs.statSync(asar).isFile()) throw new Error("Invalid ASAR file");
  tx.asar_move = { from: asar, to: asar + ".dshpurge-" + tx.id, hash: digest(fs.readFileSync(asar)) };
  save(tx);
  fs.renameSync(tx.asar_move.from, tx.asar_move.to);
}
function restoreAsar(tx) {
  const move = tx.asar_move;
  if (!move || !fs.existsSync(move.to)) return;
  if (fs.existsSync(move.from) || fs.lstatSync(move.to).isSymbolicLink() || digest(fs.readFileSync(move.to)) !== move.hash) throw new Error("ASAR restore conflict; files retained");
  fs.renameSync(move.to, move.from);
}
export async function runOperation(file, adapters = {}) {
  let tx = load(file);
  const stop = adapters.stop || stopHost;
  const start = adapters.start || startHost;
  const wait = adapters.wait || waitForBoot;
  tx.owner_pid = process.pid;
  tx.supervisor_pid = Number(process.env.DSH_PURGE_SUPERVISOR_PID) || null;
  save(tx);
  for (const lock of tx.locks || []) {
    const data = readJson(lock);
    if (data?.id !== tx.id) throw new Error("Update lock ownership lost");
    fs.writeFileSync(lock, JSON.stringify({ ...data, pid: process.pid }));
  }
  try {
    if (adapters.recover || process.argv.includes("--recover")) throw new Error("Recovering an interrupted operation");
    await stop(tx);
    tx.host_stopped = true; save(tx);
    if (tx.kind === "update") {
      installPayload(tx);
      phase(tx, "reapplying");
      if (adapters.reapply) await adapters.reapply(tx);
      else {
        const result = spawnSync(tx.node, ["--expose-internals", path.join(path.dirname(file), "engine", "reapply-transaction.js")], {
          cwd: tx.dir, env: { ...process.env, DSH_HOME: tx.home, DSH_PROFILE: tx.profile, DSH_SURFACE: tx.surface,
            DSH_PURGE_JOURNAL: file, DSH_PURGE_TARGET_REAPPLY: path.join(tx.primary, "lib", "reapply.js"),
            DSH_PURGE_TARGET_BASE: tx.ai_base, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
        });
        fs.writeFileSync(path.join(tx.dir, "reapply.log"), String(result.stdout || "") + String(result.stderr || ""));
        tx = load(file);
        const line = String(result.stdout || "").trim().split(/\r?\n/).findLast((item) => item.startsWith("{"));
        let parsed = null; try { parsed = JSON.parse(line); } catch { /* Failure below. */ }
        if (result.error || result.status !== 0 || parsed?.ok !== true) throw new Error(parsed?.error || result.error?.message || "Reapply failed; see reapply.log");
      }
      // Old releases may write stamps from their reapply implementation.
      restoreFiles(tx, { category: "metadata", keepPhase: true, resetAfter: true });
    }
    moveAsar(tx);
    await start(tx, false);
    await wait(tx, false);
    adoptBootMarkers(tx);
    if (tx.kind === "update") finishMetadata(tx);
    phase(tx, "verified");
    releaseLocks(tx);
    if (tx.kind === "update") {
      tx.warnings.push(...pruneBackups(tx.home)); save(tx);
    }
    return tx;
  } catch (error) {
    tx = load(file);
    tx.error = String(error.message || error); save(tx);
    if (!tx.host_stopped) {
      phase(tx, "failed"); releaseLocks(tx); return tx;
    }
    try {
      if (tx.recovery_attempted) throw new Error("Automatic recovery was already attempted");
      tx.recovery_attempted = true; save(tx);
      await stop(tx);
      adoptBootMarkers(tx);
      restoreFiles(tx);
      restoreGit(tx);
      // #8：新宿主已经启动并写过 boot report，说明 resources/app 这一份是能跑的。
      // 这时把换走的 app.asar 再挪回来只会让宿主重新变成密封包，面板于是反复要求重启。
      // 只有「宿主压根没起来」才回滚换包。
      const booted = Boolean(readJson(path.join(tx.dir, "boot-report.json")));
      if (!(booted && tx.asar_move)) restoreAsar(tx);
      await start(tx, true);
      await wait(tx, true);
      phase(tx, "rolled_back"); releaseLocks(tx);
    } catch (restoreError) {
      phase(tx, "failed", { error: tx.error + "\nRecovery stopped: " + String(restoreError.message || restoreError) });
      // Keep locks on an incomplete recovery. Explicit recovery uses this journal.
    }
    return tx;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runOperation(process.argv[2]);
    process.exitCode = result.phase === "verified" ? 0 : 1;
  } catch (error) { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; }
}
