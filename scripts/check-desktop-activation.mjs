import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-activation-"));
const install = path.join(temp, "DeepSeek Harness");
const aiBase = path.join(install, "resources/app/dsh/node_modules/@deepseek-ai");
const asar = path.join(install, "resources/app.asar");
const dshHome = path.join(install, ".dsh");
const keys = ["DSH_SURFACE", "DSH_DESKTOP_INSTALL", "DSH_HOME", "DSH_BASE"];
const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions/lib"), { recursive: true });
  fs.mkdirSync(path.join(aiBase, "dsh-system-prompt/lib"), { recursive: true });
  fs.mkdirSync(dshHome);
  fs.writeFileSync(path.join(install, "DeepSeek Harness.exe"), "fixture");
  fs.writeFileSync(asar, "sealed fixture");
  fs.writeFileSync(path.join(aiBase, "dsh-system-prompt/lib/index.js"),
    '// system-prompt/assemble\n// [dsh-purge] identity stripped\n// [dsh-purge] complete prompt keeps waterfall inject\n');
  process.env.DSH_SURFACE = "desktop";
  process.env.DSH_DESKTOP_INSTALL = install;
  process.env.DSH_HOME = dshHome;
  process.env.DSH_BASE = aiBase;
  const core = await import("../lib/core.js");
  const reapply = await import("../lib/reapply.js");
  const boot = await import("../lib/operation-boot.js");
  const transaction = await import("../lib/update-transaction.js");
  assert.equal(core.desktopAsarStillSealed(), true);
  assert.equal(core.hostCleanMarkersPresent(aiBase), true);
  assert.equal(await reapply.hostCleanEnoughToKeep(), false,
    "An already patched extraction cannot certify the sealed running host");
  console.log("PASS a sealed host cannot receive a false kept-patches success");

  const written = { ai_base: aiBase, host_written: true, asar_still_sealed: false, patches_total: 4, patches_ready: 4, patches_pending: 0 };
  assert.deepEqual(core.patchActivationStatus({ ...written, asar_still_sealed: true }), { patches_active: false, activation_pending: true });
  assert.deepEqual(core.patchActivationStatus(written), { patches_active: true, activation_pending: false });
  assert.equal(core.patchActivationStatus({ ...written, patches_pending: 1 }).patches_active, false);
  // #8: 未命中(pattern 对不上)不是「还有活」，不能把整台宿主挡在激活之外。
  assert.equal(core.patchActivationStatus({ ...written, patches_ready: 3 }).patches_active, true);
  assert.equal(core.patchActivationStatus({ ...written, patches_unmatched: 2 }).patches_active, true);
  assert.equal(core.patchActivationStatus({ ...written, host_written: false }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, ai_base: null }).patches_active, false);
  assert.equal(core.patchActivationStatus({ ...written, patches_total: 0, patches_ready: 0 }).patches_active, false);
  console.log("PASS activation needs an unsealed, located, written host with no pending work");

  const state = await core.gatherState();
  assert.equal(state.asar_still_sealed, true);
  assert.equal(state.patches_active, false);
  assert.equal(state.activation_pending, true);
  assert.equal(state.sealed_install, false, "the extracted host is located, so this is not a sealed-only install");
  console.log("PASS real status collection exposes the pending activation");

  // #8: 换包验收只看「宿主不再从密封归档启动」+「没有 pending」，不再要求全等 patches_active。
  const tx = {
    nonce: "n1", old_pid: 111, attempt_started: 1000, profile: "desktop", surface: "desktop",
    ai_base: aiBase, target: { version: "1.2.1", sha: "abc" }, previous: { version: "1.2.0", sha: "abc" },
  };
  const report = {
    nonce: "n1", pid: 222, started_at: 2000, version: "1.2.1", sha: "abc", profile: "desktop",
    surface: "desktop", ai_base: aiBase, patches_active: false, activation_pending: false, patches_pending: 0,
  };
  assert.equal(boot.bootMatches(tx, report), true, "unmatched patches must not block the asar swap");
  assert.equal(boot.bootMatches(tx, { ...report, activation_pending: true }), false);
  assert.equal(boot.bootMatches(tx, { ...report, patches_pending: 1 }), false);
  assert.equal(boot.bootMatches(tx, { ...report, version: "9.9.9" }), false);
  console.log("PASS boot verification stops re-sealing the archive when a patch cannot match");

  // 「稍后再说」落盘后不再重复弹；归档被官方更新换掉后自动失效。
  assert.equal(reapply.restartDismissed(), false);
  assert.equal(reapply.dismissRestart(), true);
  assert.equal(reapply.restartDismissed(), true);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(asar, later, later);
  assert.equal(reapply.restartDismissed(), false, "a new archive must ask again");
  assert.equal(reapply.dismissRestart(), true);
  assert.equal(reapply.clearRestartDismissed(), true);
  assert.equal(reapply.restartDismissed(), false);
  console.log("PASS restart dismissal persists and expires with the archive identity");

  // 死掉的作业必须能被宿主回收，否则 /restart 只会回 already、createTransaction 只会抛错。
  const home = fs.mkdtempSync(path.join(temp, "home-"));
  const stale = transaction.createTransaction(home, { kind: "apply", destinations: [home] });
  transaction.phase(stale, "waiting_boot", { owner_pid: 999999, supervisor_pid: null });
  const reconciled = transaction.reconcileStale(home);
  assert.equal(reconciled.phase, "failed");
  assert.match(reconciled.error, /reconciled/);
  assert.equal(fs.existsSync(path.join(home, "dsh-purge/operations/active.lock")), false,
    "the stale lock must be released");

  const live = transaction.createTransaction(home, { kind: "restart", destinations: [home] });
  transaction.phase(live, "waiting_boot", { owner_pid: process.pid, supervisor_pid: null });
  assert.equal(transaction.reconcileStale(home).phase, "waiting_boot", "a live owner is left alone");

  transaction.phase(live, "awaiting_restart", { owner_pid: 999999 });
  assert.equal(transaction.reconcileStale(home).phase, "awaiting_restart", "beginRestart resumes awaiting_restart");
  console.log("PASS stale operations are reconciled and live ones are left alone");

  console.log("ALL PASS");
} finally {
  for (const key of keys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
