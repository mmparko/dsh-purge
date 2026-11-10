import { spawnSync } from "node:child_process";
import { assertRuntime } from "../lib/runtime-check.js";
assertRuntime();
const checks = [
  "check-40-and-hostfs.mjs", "check-desktop-activation.mjs", "check-status-doctor.mjs",
  "check-evidence-rewind.mjs", "check-community-update.mjs", "check-update-transactions.mjs",
  "check-upstream-ports.mjs", "check-preset-plugins.mjs",
];
if (process.platform === "win32") checks.push("test-official-update-rollback.mjs");
for (const file of checks) {
  const result = spawnSync(process.execPath, ["scripts/" + file], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
