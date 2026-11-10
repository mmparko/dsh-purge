import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

// Keep unwrapped functions: the reapply child journals its filesystem writes.
const io = Object.fromEntries(Object.entries(fs).filter(([, value]) => typeof value === "function").map(([key, value]) => [key, value.bind(fs)]));
io.realpathSync = (fs.realpathSync.native || fs.realpathSync).bind(fs);
export const PAYLOAD_NAMES = ["lib", "bin", "docs", "presets", "skills", "scripts", "client.js", "cordis.patch.yml", "screenshots.json", "package.json", "README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "FORK-NOTES.md", "release-notes.md", ".github", ".gitignore", ".npmignore", ".dsh-purge-revision"];
const TERMINAL = new Set(["verified", "rolled_back", "failed"]);
export const digest = (data) => createHash("sha256").update(data).digest("hex");
const key = (value) => process.platform === "win32" ? value.toLowerCase() : value;
export function within(root, candidate) {
  const rel = path.relative(key(path.resolve(root)), key(path.resolve(candidate)));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
export function readJson(file) {
  try { return JSON.parse(io.readFileSync(file, "utf8")); } catch { return null; }
}
const renameWait = new Int32Array(new SharedArrayBuffer(4));
function renameJournal(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { io.renameSync(from, to); return; }
    catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 10) throw error;
      Atomics.wait(renameWait, 0, 0, 20 * (attempt + 1));
    }
  }
}
export function writeJson(file, data) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  io.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  const fd = io.openSync(tmp, "r+");
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  renameJournal(tmp, file);
}
function stat(file) {
  try { return io.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function realFile(file) {
  const absolute = path.resolve(file);
  const leaf = stat(absolute);
  if (leaf?.isSymbolicLink()) throw new Error("Refusing a file link: " + absolute);
  let parent = path.dirname(absolute);
  const tail = [path.basename(absolute)];
  while (!stat(parent)) { tail.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(io.realpathSync(parent), ...tail);
}
export function walkFiles(root, relative = "") {
  const full = path.join(root, relative);
  const info = stat(full);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error("Refusing a payload link: " + full);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new Error("Not a regular payload path: " + full);
  return io.readdirSync(full).sort().flatMap((name) => walkFiles(root, path.join(relative, name)));
}
function operationsRoot(home) { return path.join(home, "dsh-purge", "operations"); }
function journalFile(tx) { return path.join(tx.dir, "journal.json"); }
export function save(tx) { tx.updated_at = new Date().toISOString(); writeJson(journalFile(tx), tx); return tx; }
export function load(file) {
  const tx = readJson(file);
  if (!tx || tx.owner !== "dsh-purge-update-v1" || realFile(file) !== path.join(path.resolve(tx.dir), "journal.json")
    || path.basename(tx.dir) !== tx.id || !/^[0-9a-f-]{36}$/.test(tx.id)
    || path.resolve(path.dirname(tx.dir)) !== path.resolve(operationsRoot(tx.home))) throw new Error("Invalid transaction journal");
  if (io.realpathSync(tx.dir) !== path.resolve(tx.dir)) throw new Error("Linked transaction directory rejected");
  return tx;
}
export function latestOperation(home) {
  const pointer = readJson(path.join(operationsRoot(home), "active.json"));
  try { return pointer?.id ? load(path.join(operationsRoot(home), pointer.id, "journal.json")) : null; } catch { return null; }
}
export function publicOperation(tx) {
  if (!tx) return null;
  return { operation_id: tx.id, kind: tx.kind, phase: tx.phase, verified: tx.phase === "verified",
    rolled_back: tx.phase === "rolled_back", error: tx.error || "", warnings: tx.warnings || [], updated_at: tx.updated_at };
}
export function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }

/**
 * #8：worker / supervisor 被外部杀掉（或重启机器）会留下 preparing / stopping / waiting_boot
 * 这类非终态作业。之后 /dsh-purge/restart 会直接回 already:true，createTransaction 又会抛
 * "An unfinished operation requires recovery"，面板就永久停在「需要重启」。
 * 宿主进程还在跑 ⇒ 这次作业的进程已经没了：判失败并放锁，让下一次 Apply / 重启能开工。
 * awaiting_restart 交给 beginRestart 续跑；owner / supervisor 还活着说明作业在途，不动。
 */
export function reconcileStale(home) {
  const tx = latestOperation(home);
  if (!tx || TERMINAL.has(tx.phase) || tx.phase === "awaiting_restart") return tx;
  // alive(0) 在 Windows 上会落到「整个进程组」并返回 true，这里必须显式排除空 pid。
  const live = (pid) => Number(pid) > 0 && alive(pid);
  if (live(tx.owner_pid) || live(tx.supervisor_pid)) return tx;
  tx.error = `Worker exited during ${tx.phase}; reconciled by the running host`;
  tx.warnings = [...(tx.warnings || []), tx.error];
  phase(tx, "failed", { reconciled_at: new Date().toISOString() });
  try { releaseLocks(tx); } catch { /* Locks owned by another live pid stay. */ }
  return tx;
}
export function createTransaction(home, input = {}) {
  home = io.realpathSync(home);
  const operationRoot = operationsRoot(home);
  io.mkdirSync(operationRoot, { recursive: true });
  if (io.realpathSync(operationRoot) !== operationRoot) throw new Error("Linked operation root rejected");
  const globalLock = path.join(operationRoot, "active.lock");
  if (stat(globalLock)) {
    const owner = readJson(globalLock);
    if (!owner || alive(owner.pid)) throw new Error("Another update/restart operation is active");
    const old = owner.journal ? readJson(owner.journal) : null;
    if (old && (!TERMINAL.has(old.phase) || (old.phase === "failed" && old.host_stopped))) throw new Error("Interrupted operation requires recovery");
    if (stat(globalLock).isSymbolicLink()) throw new Error("Linked operation lock rejected");
    io.unlinkSync(globalLock);
  }
  const previous = latestOperation(home);
  if (previous && !TERMINAL.has(previous.phase)) throw new Error("An unfinished operation requires recovery: " + previous.id);
  const id = randomUUID();
  const dir = path.join(operationsRoot(home), id);
  io.mkdirSync(dir, { recursive: true });
  const tx = { owner: "dsh-purge-update-v1", id, home, dir, kind: input.kind || "update", phase: "preparing",
    created_at: new Date().toISOString(), owner_pid: process.pid, nonce: randomUUID(), files: [], locks: [globalLock], warnings: [], ...input };
  const fd = io.openSync(globalLock, "wx", 0o600);
  try { io.writeFileSync(fd, JSON.stringify({ id, pid: process.pid, journal: journalFile(tx) })); } finally { io.closeSync(fd); }
  save(tx);
  writeJson(path.join(operationsRoot(home), "active.json"), { id });
  return tx;
}
export function lockInstall(tx, root) {
  root = io.realpathSync(root);
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg?.name !== "dsh-purge" || /[\\/]resources[\\/](?:app(?:\.asar\.unpacked)?|runtime)(?:[\\/]|$)/i.test(root)) throw new Error("Unsafe plugin root: " + root);
  const file = path.join(path.dirname(root), ".dsh-purge-" + digest(key(root)).slice(0, 24) + ".lock");
  if (stat(file)) {
    const owner = readJson(file);
    if (!owner || alive(owner.pid)) throw new Error("Plugin installation is locked: " + root);
    const pending = owner.journal ? readJson(owner.journal) : null;
    if (pending && (!TERMINAL.has(pending.phase) || (pending.phase === "failed" && pending.host_stopped))) throw new Error("Recover the interrupted update before retrying: " + owner.journal);
    if (stat(file)?.isSymbolicLink()) throw new Error("Linked lock rejected");
    io.unlinkSync(file);
  }
  const fd = io.openSync(file, "wx", 0o600);
  try { io.writeFileSync(fd, JSON.stringify({ id: tx.id, pid: tx.owner_pid, journal: journalFile(tx) })); } finally { io.closeSync(fd); }
  tx.locks.push(file); save(tx);
  return root;
}
export function releaseLocks(tx) {
  for (const file of tx.locks || []) if (readJson(file)?.id === tx.id && !stat(file)?.isSymbolicLink()) io.unlinkSync(file);
}
export function phase(tx, value, extra = {}) { Object.assign(tx, extra, { phase: value }); return save(tx); }
export function capture(tx, target, category = "host") {
  const file = realFile(target);
  if (within(tx.dir, file)) return null;
  if (category === "plugin" && !(tx.destinations || []).some((root) => within(root, file) && within(root, path.resolve(target)))) {
    throw new Error("Plugin file escaped its verified installation: " + target);
  }
  let record = tx.files.find((item) => key(item.path) === key(file));
  if (record) return record;
  const info = stat(file);
  if (info && !info.isFile()) throw new Error("Only individual regular files can be backed up: " + file);
  const backup = path.join(tx.dir, "files", String(tx.files.length));
  record = { path: file, backup: path.relative(tx.dir, backup), existed: Boolean(info), category, mode: info?.mode, before: null, after: null };
  if (info) {
    const content = io.readFileSync(file);
    record.before = digest(content);
    io.mkdirSync(path.dirname(backup), { recursive: true });
    io.writeFileSync(backup, content, { mode: 0o600, flag: "wx" });
    const fd = io.openSync(backup, "r+");
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    if (digest(io.readFileSync(backup)) !== record.before) throw new Error("Backup verification failed");
  }
  tx.files.push(record); save(tx);
  return record;
}
export function replaceFile(tx, file, content, category = "plugin", mode) {
  const record = capture(tx, file, category);
  if (!record) throw new Error("Cannot replace transaction engine files");
  const current = stat(record.path);
  const currentHash = current ? digest(io.readFileSync(record.path)) : null;
  if (currentHash !== (record.deleted ? null : record.after ?? record.before)) throw new Error("File changed outside this transaction: " + record.path);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  record.after = digest(bytes); record.deleted = false; record.pending = true; save(tx);
  io.mkdirSync(path.dirname(record.path), { recursive: true });
  const temp = record.path + "." + tx.id + ".tmp";
  io.writeFileSync(temp, bytes, { mode: mode ?? record.mode ?? 0o644 });
  io.renameSync(temp, record.path);
  if (digest(io.readFileSync(record.path)) !== record.after) throw new Error("File verification failed: " + record.path);
  record.pending = false; save(tx);
}
export function removeFile(tx, file, category = "plugin") {
  const record = capture(tx, file, category);
  if (!record) throw new Error("Cannot remove transaction files");
  const info = stat(record.path);
  if ((info ? digest(io.readFileSync(record.path)) : null) !== (record.deleted ? null : record.after ?? record.before)) throw new Error("File changed outside this transaction: " + record.path);
  record.pending = true; record.after = null; record.deleted = true; save(tx);
  if (stat(record.path)) io.unlinkSync(record.path);
  record.pending = false; save(tx);
}
export function preparePayload(tx, source, destinations) {
  const pkg = readJson(path.join(source, "package.json"));
  if (pkg?.name !== "dsh-purge" || pkg.version !== tx.target.version) throw new Error("Downloaded package identity/version mismatch");
  const incoming = PAYLOAD_NAMES.flatMap((name) => walkFiles(source, name));
  for (const required of ["lib/index.js", "lib/reapply-cli.js", "bin/dsh-purge.js", "client.js", "presets/redteam/preset.yml", "scripts/redteam-setup.sh"]) {
    if (!incoming.includes(path.normalize(required))) throw new Error("Incomplete plugin payload: " + required);
  }
  tx.manifest = incoming.map((relative) => ({ relative, hash: digest(io.readFileSync(path.join(source, relative))), mode: stat(path.join(source, relative)).mode }));
  tx.destinations = [...new Set(destinations.map((root) => io.realpathSync(root)))];
  for (const root of tx.destinations) {
    lockInstall(tx, root);
    const old = PAYLOAD_NAMES.flatMap((name) => walkFiles(root, name));
    for (const relative of new Set([...old, ...incoming])) capture(tx, path.join(root, relative), "plugin");
  }
  tx.source = source; save(tx);
}
export function installPayload(tx) {
  phase(tx, "switching");
  for (const root of tx.destinations) {
    const wanted = new Set(tx.manifest.map((item) => path.join(root, item.relative)));
    for (const record of tx.files.filter((item) => item.category === "plugin" && within(root, item.path))) {
      if (!wanted.has(record.path)) removeFile(tx, record.path);
    }
    for (const entry of tx.manifest) {
      const content = io.readFileSync(path.join(tx.source, entry.relative));
      if (digest(content) !== entry.hash) throw new Error("Staged file changed: " + entry.relative);
      replaceFile(tx, path.join(root, entry.relative), content, "plugin", entry.mode);
    }
    replaceFile(tx, path.join(root, ".dsh-purge-revision"), tx.target.sha + "\n");
  }
}
export function restoreFiles(tx, options = {}) {
  if (!options.keepPhase) phase(tx, "restoring");
  const errors = [];
  const restored = (record) => {
    if (!options.resetAfter) return;
    record.after = record.before; record.deleted = !record.existed; record.pending = false; save(tx);
  };
  for (const record of [...tx.files].reverse().filter((item) => !options.category || item.category === options.category)) {
    try {
      if (realFile(record.path) !== record.path) throw new Error("Restore path changed");
      const current = stat(record.path);
      const hash = current?.isFile() ? digest(io.readFileSync(record.path)) : null;
      if (hash === record.before && (record.existed || !current)) { restored(record); continue; }
      if (!record.pending && hash !== record.after && !(record.deleted && !current)) throw new Error("Restore conflict");
      if (record.existed) {
        const backup = path.resolve(tx.dir, record.backup);
        if (!within(path.join(tx.dir, "files"), backup) || stat(backup)?.isSymbolicLink()) throw new Error("Invalid backup path");
        const bytes = io.readFileSync(backup);
        if (digest(bytes) !== record.before) throw new Error("Backup checksum mismatch");
        io.mkdirSync(path.dirname(record.path), { recursive: true });
        const temp = record.path + "." + tx.id + ".restore";
        io.writeFileSync(temp, bytes, { mode: record.mode });
        io.renameSync(temp, record.path);
      } else if (current) io.unlinkSync(record.path);
      restored(record);
    } catch (error) { errors.push(record.path + ": " + error.message); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
function removeOwnedTree(root, file) {
  if (!within(root, file)) throw new Error("Cleanup escaped its transaction");
  const info = stat(file);
  if (!info) return;
  if (realFile(file) !== path.resolve(file)) throw new Error("Cleanup path changed");
  if (info.isSymbolicLink()) throw new Error("Cleanup refuses directory/file links: " + file);
  if (info.isDirectory()) {
    for (const name of io.readdirSync(file)) removeOwnedTree(root, path.join(file, name));
    io.rmdirSync(file);
  } else if (info.isFile()) io.unlinkSync(file);
  else throw new Error("Cleanup refuses special files");
}
export function pruneBackups(home) {
  const root = operationsRoot(io.realpathSync(home));
  if (!stat(root)) return [];
  const warnings = [];
  const transactions = [];
  for (const name of io.readdirSync(root)) {
    if (!/^[0-9a-f-]{36}$/.test(name)) continue;
    try {
      const tx = load(path.join(root, name, "journal.json"));
      if (tx.kind !== "update" || tx.phase !== "verified") continue;
      const identities = [...new Set((tx.destinations || []).map((dest) => key(io.realpathSync(dest))))];
      if (!identities.length) continue;
      transactions.push({ tx, identities });
    } catch (error) { warnings.push(name + ": " + error.message); }
  }
  transactions.sort((a, b) => b.tx.created_at.localeCompare(a.tx.created_at));
  const retained = new Map();
  for (const { tx, identities } of transactions) {
    if (identities.some((identity) => (retained.get(identity) || 0) < 2)) {
      for (const identity of identities) {
        const count = (retained.get(identity) || 0) + 1;
        retained.set(identity, count);
        if (count > 2) warnings.push(tx.id + ": shared snapshot retained for another installation");
      }
      continue;
    }
    try {
      // Inspect the complete tree before removing any entry.
      walkFiles(tx.dir);
      removeOwnedTree(tx.dir, tx.dir);
    } catch (error) { warnings.push(tx.id + ": " + error.message); }
  }
  return warnings;
}
export function gitState(root) {
  const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    run("rev-parse", "--git-dir");
  } catch { return null; }
  if (run("status", "--porcelain", "--untracked-files=normal", "--", ".", ":!.dsh-purge-revision")) throw new Error("Local plugin edits exist; update stopped: " + root);
  return { root, sha: run("rev-parse", "HEAD") };
}
export function finishMetadata(tx) {
  for (const item of tx.metadata || []) replaceFile(tx, item.path, item.content, "metadata");
  for (const item of tx.git || []) {
    execFileSync("git", ["-C", item.root, "fetch", "--no-tags", "https://github.com/realMisakaMikoto/dsh-purge.git", tx.target.sha], { windowsHide: true, stdio: "pipe", timeout: 60000 });
    execFileSync("git", ["-C", item.root, "reset", "--soft", tx.target.sha], { windowsHide: true, stdio: "pipe" });
    execFileSync("git", ["-C", item.root, "read-tree", tx.target.sha], { windowsHide: true, stdio: "pipe" });
  }
}
export function adoptBootMarkers(tx) {
  // Legacy hosts seed these two updater-owned markers during startup.
  // Never adopt arbitrary profile/configuration changes.
  const markerRoot = path.join(tx.home, "dsh-purge");
  for (const record of tx.files.filter((item) => item.category === "metadata")) {
    const name = path.basename(record.path);
    if (path.dirname(record.path) !== markerRoot || !["installed-rev", "applied.json"].includes(name)) continue;
    if (realFile(record.path) !== record.path || !stat(record.path)?.isFile()) continue;
    const content = io.readFileSync(record.path);
    const hash = digest(content);
    if (hash === (record.deleted ? null : record.after ?? record.before)) continue;
    const revisions = [tx.target.sha, "apply:" + tx.target.version].filter(Boolean);
    const raw = content.toString("utf8").trim();
    let recognized = name === "installed-rev" && revisions.includes(raw);
    if (name === "applied.json") {
      try {
        const value = JSON.parse(raw);
        const legacySha = Boolean(tx.previous?.sha && value.sha === tx.previous.sha);
        recognized = value.version === tx.target.version && (revisions.includes(value.sha) || legacySha) && Number.isFinite(Date.parse(value.at));
      } catch { /* An unrecognized marker remains a restore conflict. */ }
    }
    if (recognized) {
      record.after = hash; record.deleted = false; record.pending = false;
      (tx.adopted_boot_markers ||= []).push(record.path); save(tx);
    }
  }
}
export function restoreGit(tx) {
  for (const item of tx.git || []) {
    execFileSync("git", ["-C", item.root, "reset", "--soft", item.sha], { windowsHide: true, stdio: "pipe" });
    execFileSync("git", ["-C", item.root, "read-tree", item.sha], { windowsHide: true, stdio: "pipe" });
  }
}
