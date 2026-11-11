# FORK NOTES — Independent Red-Team Build (DSH 0.2.2-rc.1 / 0.2.1-rc.5 / rc.3 / rc.2 / rc.1 / 0.2.0-rc.2)

Upstream: <https://github.com/YuJunZhiXue/dsh-purge> (Apache-2.0, see `docs/upstream-dsh-purge-LICENSE`).
Build version: `dsh-purge 1.2.3`. **Version scheme diverged starting from 1.2.0**: releases no longer follow upstream's 1.1.x series; upstream is referenced selectively for host correctness patches.
Supported targets: **DSH 0.2.2-rc.1 / 0.2.1-rc.5 / rc.3 / rc.2 / rc.1 / 0.2.0-rc.2 (desktop / `resources/app`)**.
Contains no machine-specific artifacts (credentials, target engagements, and local configurations are excluded).

## Adapting DSH 0.2.2-rc.1 — Package Splits and Pattern Updates

In 0.2.2-rc.1: `dsh-agent-instructions` removed the `WORKSPACE_CONTEXT_INTRO` constant family, the PTC executor was moved into a standalone package, `serviceAsk` relocated from `dsh-tools/lib/index.js` to `lib/types/pipeline.js`, deliverable prompts moved from `dsh-client-ui-deliverables` to `dsh-deliverable-file-references`, and desktop bundle `#region` ordering changed.

Implementation (`lib/core.js`):
- Expanded target candidates:
  - `deliverables-prompt` += `dsh-deliverable-file-references/lib/index.js`
  - `dsh-tools-types` += `dsh-tools/lib/types/pipeline.js` (ordered before `index.js`, where `serviceAsk` resides)
  - `dsh-tools-ptc` += `dsh-tool-executor-ptc/lib/index.js` and `lib/types/ptc.js`
- Additional patterns appended (preserving backward compatibility for 0.2.1-rc.5):
  - #12 variant: `Approval prompts are enabled in this session: ...` (single and double quotes)
  - #14 variant: `displayReason: escalationDisplayReason(mode, justification),`
  - #67 guard block with 5-tab indentation
- Relaxed anchor pinning to single lines:
  - #74 anchors to `const claimed = this.inbox.claim(target, position.turn);`
  - #82 anchors to `import { REMOTE_STREAM_MUX_PATH, ... }`
- Verified: `PATTERN_MISS 0 / FILE_MISSING 0`; regression checks pass 100%.

## Adapting DSH 0.2.2-rc.1 (Part 2) — MoveFileExW Error 32

Official updater chain: `cmd.exe -> wscript.exe -> installer.exe`. Previously, neither set CWD, causing wscript's CWD to remain in the installation directory and holding a lock that triggered installer `MoveFileExW` error 32.

Fixes:
- `#45` handoff: `spawn("cmd.exe", [...], { cwd: process.env.TEMP })`
- `lib/official-update.wscript`: `sh.CurrentDirectory = fso.GetSpecialFolder(2).Path` placed after `log()` and before process termination; script maintains strict pure ASCII.
- `lib/desktop.js`: plugin's own wscript launch uses `cwd: os.tmpdir()`.

## Fix 1 — #40 COMPLETE_PROMPT_KEEP_INJECT Matching in rc.2

In rc.2, `SystemPrompt.assemble()` inserted `const requiredContexts = new Set(...)` before its completion block, causing earlier patterns to return `skipped` instead of `pending`, preventing injection markers from writing.

Fixes (`lib/core.js`):
- Added `COMPLETE_PROMPT_WATERFALL_INJECT_02` matching rc.2's `requiredContexts` shape while preserving waterfall injection semantics.
- Appended fallback pattern ensuring future structural changes retain the dsh-purge injection segment.

## Fix 2 — hostFs Methods (closeSync / readSync)

In `core.js`, `const fs = hostFs`; in `lib/extract-asar.js`, `HOST_SYNC` previously only had `openSync`, causing `fs.closeSync` to fail silently with TypeError and leaking file handles.

Fix: Added `closeSync`, `readSync`, `writeSync`, `fsyncSync`, `fstatSync`, and `accessSync` to `HOST_SYNC`.

## Fix 3 — Red Team Preset Registration in rc.2

In rc.2, `dsh-tool-subagent` deprecated `persona` and `toolFilter` keys, throwing errors if present and breaking red-team preset registration.

Fix: Removed `toolFilter` block, retaining `maxDepth: 1` as concurrency guard.

## Regression Tests

```bash
node scripts/check-40-and-hostfs.mjs
```

Covers #40 rc.2 shape matching, marker persistence, `requiredContexts` semantics, idempotency, fallback patterns, `hostFs` sync integrity, and backup rename safety.

## Upstream Diffs

```
lib/core.js                                            # Fix 1 + diagnostics (promptDropReport / hostsUnwritten)
lib/extract-asar.js                                    # Fix 2 + isolation directory checks
lib/official-update.wscript                            # Fix 4 (update handoff rollback)
lib/official-update.js                                 # Fix 4 (success criteria / path validation / cleanup)
lib/index.js                                           # Startup cleanup logging
presets/redteam/agent.cordis.yml                        # Fix 3
scripts/check-40-and-hostfs.mjs                        # Regression suite 1
scripts/test-official-update-rollback.mjs              # Regression suite 2 (update handoff / rollback)
```

## Fix 5 — Upstream 1.1.78–1.1.83 Backports

Backported selected fixes from upstream:
- Launcher symlink write-through and copied launcher healing; atomic write permissions (`0755`).
- `lib/skills.js`: Added `fs` import for symlink deletion guard.
- `lib/zip-extract.js`: Backslash directory separator normalization.
- `client.js`: Enforced button text visibility under custom host icon fonts.
- `lib/uninstall.js`: Cleaned `pkg.dsh.profile.bundles/plugins`.
- `lib/core.js`: Flexible anchor matching for patch #77.
- `lib/doctor.js`: Host version validation (`HOST_TARGETS`, `readHostVersion`, `hostSupport`).

## Fix 6 — Upstream 1.1.84–1.1.88 Backports

Host correctness and capability enhancements:
- 0-byte `.dshpurge.bak` safety: renamed to `.bad` and bypassed during rollback.
- fsync on atomic file writes to prevent 0-byte files on unexpected power loss.
- `applyReplacementsToText` supports `expect` match assertions.
- Concurrency reservation (n+1) in `redteam_agent_slot`.
- Electron main process termination safeguards during desktop package replacement.
- Sanitized newlines in report replay headers, cookies, and payloads to prevent header injection.

### Capability Modules
- **`lib/anchor.js`**: System prompt anchor injection at end of sections (`anchorMode: "auto" | "off"`).
- **`lib/subagent-control.js`**: Subagent approval policy control (`subagentControl: false` option).
- **`redteam/tools.js`**: Accelerated path for `require('@deepseek-ai/dsh-tools')` and desktop unpacked paths.

## Fix 7 — Transient File Locks During Update (1.2.1)

Atomic writes implement bounded exponential backoff retry for transient Windows file locks (`EPERM`, `EBUSY`, `EACCES`, `ENOTEMPTY`, `EEXIST`). Reapply runs a second pass for failed items with 400ms delay.

---

## Fix 4 — Update Handoff Junction Protection

Windows Shell `DeleteFolder` recurses across directory junctions, erasing original directory contents when deleting symlinks.

Fixes:
- `official-update.wscript`: Isolates failed replacements to `app.dshpurge-failed-<ts>` instead of recursive deletion.
- `official-update.js`: Validates stale directories via `isCleanableStaleDir()`, removing symlinks safely via Node `fs.rmSync`.
- Success validation: Verified by exit code 0 and presence of required resources rather than relying on timestamp/size diffs.

## Community Updater and Target Selection

- Version checks, package downloads, installed profile specs, and Git updates use `chmakorkrich/dsh-purge`. Git updates fetch the requested ref directly and retain the checkout's existing origin.
- Geographic and bank-domain target gates, own-server exception list UI, and associated APIs have been removed. Existing allowlist files are not modified.
- Windows update rollback and runtime/junction protections remain active.

Validation: `node scripts/check-community-update.mjs` exercises version metadata, Git updates with distinct origins, pinned tags, archive installs, and profile dependency URLs using temporary local repositories and mocked HTTP responses.

## Selected Upstream Evidence and Rewind Features

Source: YuJunZhiXue/dsh-purge 1.1.74, commit `5a9b8e14856138814a2139a0105481e1dcdaece4`.

- Import the evidence ledger, eight evidence/unknown tools, and the corresponding preset instructions.
- Import the upstream rewind implementation: step/turn boundaries, new-session fork/create, source archival, and cancellation/archive of the selected turn's subagents. Add the conversation client dependency required to select the new session.
- Keep this community build's updater, target-gate removal, knowledge base, bundled skills, and Windows rollback protections.
- Preserve upstream attribution in `NOTICE` and `docs/upstream-dsh-purge-LICENSE`; existing project license metadata is unchanged.

Validation: `node scripts/check-evidence-rewind.mjs` covers ten evidence/rewind groups with in-memory SQLite and a fixture session controller. Community update checks also verify preset and NOTICE delivery in archive installs.

## Desktop Activation Verification (1.1.74)

A patched resources/app directory is not proof that the running desktop has switched away from app.asar. Status exposes `patches_active` and `activation_pending`; the UI keeps the warning visible for a located extraction. Sealed hosts cannot be accepted by hostCleanEnoughToKeep. Apply replies report restart_required without claiming an unstarted restart or swap.

Regression: `node scripts/check-desktop-activation.mjs` (temporary files only; no live installation writes).

## Multi-Host CLI Status and Doctor

The original multi-host status and doctor implementation was contributed by [@Heaven-Heart](https://github.com/Heaven-Heart) in [PR #1](https://github.com/realMisakaMikoto/dsh-purge/pull/1). Both original authored commits are retained when merging this contribution.

Doctor is connected to the CLI, validating health/exit codes and baseline writes, propagating selected surface through all status checks, respecting explicit selection, identifying running installations, and handling copied/missing installations and relative symlinks.

Regression: `node scripts/check-status-doctor.mjs` (temporary host and CLI fixtures).

## Restart/Activation Loop and Stale Operations (1.2.2)

Fixes [issue #8](https://github.com/realMisakaMikoto/dsh-purge/issues/8):
- Asar swap verification requires `patches_active === true` based on "written + unsealed + nothing pending". Recovery keeps the moved archive once the new host reports a boot, and desktop activation wait is 180 s.
- Modal dismissal is persisted to `$DSH_HOME/dsh-purge/restart-dismissed.json`, keyed by plugin version + archive size/mtime, and cleared by a new Apply or a new archive.
- Reconciles stale operations where owner and supervisor are dead, avoiding lockouts.
- Display denominator excludes skipped rows (e.g. 67/67 with "skipped 2"), and first-time installations display "official client found, Apply to unpack".

Regression: `node scripts/check-desktop-activation.mjs` (6 groups: activation gate, boot proof, dismissal expiry, stale-operation reconciliation) plus `node scripts/check-update-transactions.mjs`.
