# FORK NOTES — 独立红队构建（dsh 0.2.2-rc.1 / 0.2.1-rc.5 / rc.3 / rc.2 / rc.1 / 0.2.0-rc.2）

上游：<https://github.com/YuJunZhiXue/dsh-purge>（Apache-2.0，见 `docs/upstream-dsh-purge-LICENSE`）
本仓库版本：`dsh-purge 1.2.3`。**1.2.0 起版本号分家**：不再跟随上游的 1.1.x 号段，上游只作为
「宿主正确性」类修复的来源按需挑选（见下文「回灌」各节），不再是发布基线。
支持面：**DSH 0.2.2-rc.1 / 0.2.1-rc.5 / rc.3 / rc.2 / rc.1 / 0.2.0-rc.2（desktop / `resources/app`）**。
不带任何本机数据（`$DSH_HOME/redteam/config.json`、密钥、engagement 记录都不在仓库里）。

## 适配 0.2.2-rc.1 — 三个包被拆走、五个 pattern 换了形状

0.2.2-rc.1 不是小改：`dsh-agent-instructions` 删掉了 `WORKSPACE_CONTEXT_INTRO` 整组常量，
PTC 执行器拆成独立包，`serviceAsk` 从 `dsh-tools/lib/index.js` 搬到 `lib/types/pipeline.js`，
交付物提示词从 `dsh-client-ui-deliverables` 搬到 `dsh-deliverable-file-references`，
桌面壳 bundle 的 `#region` 顺序也变了。命中矩阵（85 补丁 × 67 键）先跑出 9 条 `PATTERN_MISS`，
逐条修完归零。

修法（`lib/core.js`）：

- `targetFiles` 扩候选：
  - `deliverables-prompt` += `dsh-deliverable-file-references/lib/index.js`；
  - `dsh-tools-types` += `dsh-tools/lib/types/pipeline.js`（排在 `index.js` 前，`serviceAsk` 在这里）；
  - `dsh-tools-ptc` += `dsh-tool-executor-ptc/lib/index.js` 与 `lib/types/ptc.js`。
- 新 pattern **追加**而不替换（老宿主继续用老 pattern，避免把 0.2.1-rc.5 的支持面砍掉）：
  - #12 新句子 `Approval prompts are enabled in this session: …`（单引号 + 双引号两套）；
  - #14 `displayReason: escalationDisplayReason(mode, justification),` 形状；
  - #67 守卫块 5 tab 缩进版。
- 两个 pattern 改成「只锚一行」，因为它们原来锚的内容跟官方构建顺序绑死了：
  - #74 只锚 `const claimed = this.inbox.claim(target, position.turn);`——0.2.2 在 claim 和
    `systemPrompt.assemble()` 之间插了 `model.current()` / `tools.resolve()`，锚两行必碎；
  - #82 只锚 `import { REMOTE_STREAM_MUX_PATH, … }` 一行——原来紧跟其后的
    `//#region ../../packages/util/home-paths/lib/index.js` 在 0.2.2 已挪到 1700 行开外。
- 无需改动：#24（0.2.2 官方 preset 已 `fetch: true`，marker 判已完成）、#2 / #3 / #50（marker 本身就是
  官方原句，0.2.2 原文已是它们想要的措辞，矩阵里显示 `MARKER_COLLISION`，不影响应用）。

验证：`tools/matrix.mjs` 在拆包出的影子宿主上跑 0.2.2-rc.1（`resources/app` 解包态 + `app.asar.unpacked`
overlay），`PATTERN_MISS 0 / FILE_MISSING 0`，0 条阻塞 `--apply`；每个（补丁 × 文件）检查点都用
`core.applyReplacementsToText()` 复算，113 点 0 不一致。`scripts/run-checks.mjs` 30 组 +
`scripts/check-update-transactions.mjs` 48 组全 PASS。

**顺带查出来的一件事**：`.dshpurge.bak` 里存的是**打完补丁的内容**（抽检
`dsh-agent-instructions/lib/index.js`、`dsh-user-approval/lib/types/index.js`，bak 与现状一致）。
所以 `--revert` 对这些文件是 no-op，不能当「官方原件」用；升级自愈靠的是重解 asar，不是 bak。

根因是 `refreshStaleBaksForUpgrade()` 用「原文件里有没有 `dsh-purge` 字串」判「是不是我们打的」，
而 #1 强引导、#4 persona 这类补丁的产物不含该字串 → 同一次会话里第二次 apply 时它会把 bak
覆盖成已打补丁的内容。已改成看「这条路径上还有没有补丁 pattern 没落地」。修完往返验证：
`reverted 43 → 53`，`revert 后与打补丁前不同的文件 10 → 0`。

## 适配 0.2.2-rc.1（二）— `MoveFileExW error 32`

官方更新助手链路是 `cmd.exe → wscript.exe → installer.exe`。前两级都没设 CWD，
于是 wscript 的 CWD 停在安装目录里——**这个"帮忙升级"的进程自己就是那个让安装器
`MoveFileExW` 报 error 32 的句柄持有者**，杀进程杀不掉它（它不在安装目录里，`occupied()`
按 EXE 路径筛不到它，也杀不得）。

修法：

- `#45` handoff：`spawn("cmd.exe", [...], { cwd: process.env.TEMP })`；
- `lib/official-update.wscript`：`sh.CurrentDirectory = fso.GetSpecialFolder(2).Path`
  放在 `log()` 之后、杀进程之前；脚本必须保持纯 ASCII（`#46` 会逐字符校验，非 ASCII 直接拒绝执行，
  所以注释也只能写英文）；
- `lib/desktop.js` 里插件自己的 wscript 拉起同样补 `cwd: os.tmpdir()`。

实测（`%TEMP%\cwd-diag`）：子进程 CWD 在目标目录 → `Rename-Item` 报
"The process cannot access the file because it is being used by another process."；
同一子进程 CWD 换到 `%TEMP%` → 同一 rename 成功。这就是 error 32 的最小复现与修复判据。

真机升级脚本 `tools/upgrade-live.ps1`（默认 dry-run）也按这个顺序做，并且**必须分离**：
杀安装目录进程用的是 `taskkill /F /T`，worker 若是本进程的子进程会连同父树一起被杀 ——
所以 `-Execute` 用 `Invoke-CimMethod Win32_Process Create`（父进程 = `WmiPrvSE.exe`）派生 worker，
`schtasks` 兜底。实测：内联跑的 worker 父进程是 `DeepSeek Harness.exe`（会被连带杀掉，判 `detached=False`），
WMI 派生的 worker 父进程是 `WmiPrvSE.exe`（判 `detached=True`）。

worker 在杀进程之前还会整树快照到 `%LOCALAPPDATA%\dsh-upgrade-backup\`，装坏了
`-Phase rollback -BackupPath "<快照>"` 用 `robocopy /MIR` 镜像回去。影子树实测：备份 1,512 MB / 19 s，
篡改 `main.js` 后回滚，sha256 精确还原（`restored=True`）。注意快照里有超 MAX_PATH 的路径，
`Remove-Item -Recurse` 删不干净，清快照用 `[System.IO.Directory]::Delete("\\?\<path>", $true)`。

装失败还会**自动**回滚：假安装器删掉 `resources\app`（22,110 文件）后 `exit /b 1`，
worker 判失败 → `/MIR` 镜像快照 → 拉起旧版，结果 `{"ok":true,"rolledBack":true,"exitCode":1}`，
文件数与原 sha256 全部还原。所以无人值守升级的最坏结果是「回到升级前」，不是「没客户端」。

## 修复 1 — `#40 COMPLETE_PROMPT_KEEP_INJECT` 命中不到 rc.2 的 complete 收尾块

rc.2 的 `SystemPrompt.assemble()` 在收尾块前多插了一行 `const requiredContexts = new Set(...)`，
`contexts` 分支也从 `[]` 变成 `filter(required)`。原来 7 个 pattern 全部 `matchesPattern=false`
→ `patchStatus` 返回 **`skipped`（不是 `pending`）** → `ensureHostClean()` 的 `needsApply` 直接跳过 apply
→ 标记 `[dsh-purge] complete prompt keeps waterfall inject` 永远写不上
→ `hostPromptKeepsInject()` 恒 false → `allPatchHostsWritten()` 恒 false
→ 重启门禁永久输出「清洗没有写进全部宿主，已取消重启」。

修法（`lib/core.js`）：

- 新增 `COMPLETE_PROMPT_WATERFALL_INJECT_02`，精确匹配 rc.2 的 `requiredContexts` 形状，保留原语义
  （`purge 段 + rest 尾 + complete 收尾`，`requiredContexts` 过滤逻辑原样保留）；
- 末尾追加**兜底 pattern**：任何未来形状只要还留着
  `sections: completeSection === void 0 ? transformed.sections : [completeSection],`
  就就地改成保留 dsh-purge inject 段 —— 这类「官方改形 → skipped → 永久取消重启」不会再复现；
- 两条都幂等（已 apply 的文件再跑 `applyReplacementsToText` 不再变化）。

## 修复 2 — `hostFs` 缺 `closeSync` / `readSync`（静默失效，不抛错）

`core.js` 里 `const fs = hostFs`，而 `lib/extract-asar.js` 的 `HOST_SYNC` 只有 `openSync`：

- `backupAll()` 的 `fs.closeSync(placeholderFd)` 抛 `TypeError`（被 `try/catch` 吞）→ 占位 fd 泄漏
  → 目标文件一直被本进程占着 → `rename(tmp, *.dshpurge.bak)` 每个文件 `EPERM`
  → 全量备份 **0 条**、`hasBackup()` 恒 false、`revert` 没有原件可回；
- `isTextShim()` 的 `fs.readSync` 每次抛错 → 一律判「非文本 shim」→ `dsh.ps1` / `dsh` 永不注入。

修法：`HOST_SYNC` 补 `closeSync / readSync / writeSync / fsyncSync / fstatSync / accessSync`。

## 修复 3 — 红队 preset 在 rc.2 注册即 broken（模式"消失"）

rc.2 的 `dsh-tool-subagent` 在 `apply()` 里硬弃用两个 config 键：

```js
for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field))
  throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins
  in an Agent Preset and select it with agentPreset (spawn only)`);
```

`presets/redteam/agent.cordis.yml` 的 `tool-subagent` 行还带着 `toolFilter.deny: [subagent_fork, workflow, ralph]`
→ `ctx.agentPresets.register()` 后 `phase: registered-broken`
→ 模式下拉过滤掉 broken preset → registry 回落 `standard` → `isRedteamSession()` false
→ 红队人格 / 角色段 / skills 全不挂（日志 `redteam=false`）。

修法：删掉 `toolFilter` 块，保留 `maxDepth: 1`（把递归预算收死）。
要把子会话的工具目录也收紧，0.2 的正解是另建一个不含 delegation 组的 leaf preset，
在该行写 `agentPreset: <leaf>`（只有 spawn provider 支持独立选 preset）。

## 回归测试

```bash
node scripts/check-40-and-hostfs.mjs
```

覆盖：`#40` rc.2 形状命中、标记写入、`requiredContexts` 语义保留、幂等、未知新形状走兜底、
`hostFs` 同步方法完整性、备份 `rename` 不再 `EPERM`。当前 18 项全 PASS。

## 与上游的差异面

```
lib/core.js                                            # 修复 1 + 诊断增强（promptDropReport / hostsUnwritten）
lib/extract-asar.js                                    # 修复 2 + 隔离目录清理校验
lib/official-update.wscript                            # 修复 4（更新交接回滚）
lib/official-update.js                                 # 修复 4（成功判定 / 路径校验 / 安全清理）
lib/index.js                                           # 启动时清理报告写日志
presets/redteam/agent.cordis.yml                        # 修复 3
scripts/check-40-and-hostfs.mjs                        # 回归测试 1
scripts/test-official-update-rollback.mjs              # 回归测试 2（更新交接 / 回滚）
```

`promptDropReport(aiBase)` 是新增的诊断导出：逐项返回 `identityMarked / injectMarked / identityLeft /
dropsInject / isPromptModule` 和 `reason`，门禁失败时会连宿主路径、`#40` 状态一起返回，
不再只丢一句「没写进全部宿主」。

## 修复 5 — 回灌上游 1.1.78–1.1.83 的可行部分（1.1.81 起）

上游从 1.1.75 起陆续修了一批「装完就坏 / 静默失效」的问题，但它是单宿主（0.2.1-rc.2）口径，
不能整段 cherry-pick。取的是与本 fork 结构对得上、且不会误伤多宿主的那几条：

| 上游 | 内容 | 落在本仓库 |
|---|---|---|
| 1.1.78 `#154/#155/#157` | 启动器软链写穿目标 + 已被写成 `bin.js` 拷贝的还原；原子写保 0755 | `lib/core.js`（`resolveShimWriteTarget` / `healCopiedLauncher` / `existingMode`+`restoreMode`，`patchShim` / `revertShim`） |
| 1.1.80 `#172` | `lib/skills.js` 补 `fs` 导入（否则 #54 软链自删守卫静默失效） | `lib/skills.js` 第 1 行 |
| 1.1.80 `#170` | ZIP 目录项认 `\` | `lib/zip-extract.js` |
| 1.1.80 `#169` | 宿主图标字体把按钮文字藏掉 | `client.js`（只强制可见性，颜色仍走本项目变量） |
| 1.1.78 `#108` | 卸载清 `pkg.dsh.profile.bundles/plugins` | `lib/uninstall.js` |
| 1.1.83 `#188` 通用部分 | `#77` 回退补丁锚点容错（rc.2 在中间插了一行） | `lib/core.js` `ALL_PATCHES` 的 `id: 77` |
| 1.1.83 `#188` 通用部分 | 宿主版本门禁 | `lib/doctor.js`（`HOST_TARGETS` / `readHostVersion` / `hostSupport`，`--doctor` 的 `host_version` 行；支持面读 `package.json` 的 `dshTargets`：rc.3 / rc.2 / rc.1 / 0.2.0-rc.2） |

**故意没取**：

- `#166 / #180 / #185`（pnpm `allowBuilds`）、`#162 / #191`（profile `cordis.patch.yml` 插入）——
  全在 `lib/profile-insert.js` + `postinstall` 里，本 fork 没有安装期注入那套，搬过来是死代码。
- `#174` DSH NEXT 识别 —— 本 fork 只覆盖到 0.2.1-rc.2。
- `#188` 里「`pattern_not_found` 也算阻断」—— 本 fork 同时支持 rc.2 / rc.1 / 0.2.0-rc.2，
  同一条必需补丁在某个 rc 上本来就不存在，照抄会让那批用户过不了重启门禁。

回归：`node scripts/check-upstream-ports.mjs`（13 项，含软链夹具、权限位、#77 两种形状、
zip 反斜杠目录项、宿主版本门禁；Windows 上跳过 POSIX 专属项）。已并入 `node scripts/run-checks.mjs`。

## 修复 6 — 回灌上游 1.1.84–1.1.88 的宿主正确性修复 + 锚点/子代理接管（1.2.0 起）

上游在 1.1.84→1.1.88 之间又发了一批「宿主被改坏 / 静默假绿」的修复。按「只收宿主正确性」
原则挑，逐条落到本 fork：

### A 类（宿主正确性）

| 上游 | 内容 | 落点 |
|---|---|---|
| 1.1.87 | 0 字节 `.dshpurge.bak` 不再当原版写回；改名 `.bad` 跳过，回滚/卸载时清残骸 | `core.js` `restoreFromBak` / `revertAll` |
| 1.1.87 | 备份/配置/状态/override 原子写补 fsync（断电不再留 0 字节文件） | `core.js` `atomicWriteSync` |
| 1.1.87 | `optional` 补丁命中数不符 → 软失败；`applyReplacementsToText` 支持 `expect` 契约 | `core.js` `applyReplacementsToText` / `isPatchResultSoftOk` |
| 1.1.87 | 插入型替换加 `insertProbe`，重复应用不二次插入 | `core.js`（settings legacy 两条） |
| 1.1.87 | CLI `--apply` 有失败项退出码 1 | `bin/dsh-purge.js` |
| 1.1.87 | asar 解包校验输出路径必须在 destDir 内（越界条目跳过告警） | `extract-asar.js` `extractAsar` |
| 1.1.87 | 红队路径校验对最近存在的祖先做 realpath（堵 symlink 逃逸） | `redteam/validate.js` `realish` |
| 1.1.87 | 更新检查只允许 https | `update.js` `requestBuffer` |
| 1.1.87 | 报告回放的头部/Cookie/请求体/模板填充去换行（防头注入） | `redteam/report-replay.js` |
| 1.1.87 | 子代理名额立即占用（n+1），占不到立即回退 | `redteam/tools.js` `redteam_agent_slot` |
| 1.1.86/1.1.87 | 换包先杀 Electron main（排除 `--type=`）、等待循环改 CIM 真实路径、挪包失败重拉原版并记日志、没定位到 exe 不杀进程 | `desktop.js` `ASAR_SWAP_PS1` / `scheduleRestart` |
| 1.1.88 | #36 扩到 bash/pwsh（rc.5 command 级 justification）+ marker 大小写都认 | `core.js` `id: 36` |
| 1.1.88 | #53 扩到 `harness-dev-context`（rc.3+ checkout 限制句）+ rc.5 注释标记 | `core.js` `id: 53` + `targetFiles."harness-dev-context"` |
| 1.1.84 | 新增 #89 沙箱策略去品牌、#90 skill-badge 描述去品牌、#91 宿主信号退出日志 | `core.js` + `targetFiles."skill-badge"` |

### B 类（能力，带开关）

- **`lib/anchor.js`（上游 1.1.84）**：system prompt 尾部锚点。`identity.js` 支持 `anchorText`，
  补到 sections 末尾（同名先滤再追加）；子会话另有一条 context 锚点排在宿主 delegation 之后。
  开关 `anchorMode: "auto" | "off"`，默认 `auto`。
- **`lib/subagent-control.js`（上游 1.1.84）**：子代理审批接管。宿主给子会话写死
  `approval/policy=never`，`dsh-user-approval.decide()` 在 waterfall 之前就 rejected；
  这里先把 policy 补成 `ask`（最多 4 次，append 失败退还名额），再在 `approval/request` 里对子会话放行一次。
  只作用于子会话，开关 `subagentControl: false`。
- **`redteam/tools.js` `loadDefineTool`**：补 `require('@deepseek-ai/dsh-tools')` 快路径、
  `process.resourcesPath` / `app.asar.unpacked` 等桌面端解析候选。

### 仍未回灌（A2 剩余，需逐条对 rc.5 源码核 pattern）

`#32`（web surface 的 rc.5 变体）、`#50`（跨会话引用话术）、`#57`（rc.5 developer role）、
`#62`（rc.5 approval fail-open）四条的多版本 pattern。本机 rc.5 上的当前表现：
`#32 skipped`、`#50/#57/#62 applied`、`#36/#53/#89/#90/#91 pending`（待下次 Apply）。
这四条补的是「同一个补丁在 rc.2 与 rc.5 上都能命中」，属补丁覆盖面而非新缺陷。

回归：`scripts/check-upstream-ports.mjs` 从 13 项扩到 27 项（新增 0 字节备份、`expect` 契约、
`insertProbe`、#36/#53/#89/#90/#91 形状、路径逃逸、回放去换行、换包脚本静态契约、
锚点位置与去重、子代理接管开关与放行、原子写完整性）。

## 修复 7 — 更新期瞬时文件占用不再拖垮整次更新（1.2.1）

**现场**：1.1.80 → 1.2.0 的第一次更新被回滚，`operations/52007216…/reapply.log` 里只有一条失败：

```
"failed":1, "failed_items":[{"patch_id":43,"name":"WEB_PRESET_IDENTITY_STRIP",
"status":"write_error:Error: EPERM: operation not permitted,
rename '…\\dsh-web-app\\presets\\minimal.patch.yml.<pid>.<ts>.tmp' -> '…\\minimal.patch.yml'"}]
```

宿主刚重启，`minimal.patch.yml` 被短暂占用；`#43` 是 `strictFiles`，于是一次瞬时 EPERM
被判成补丁失败 → 整次更新回滚。当天稍后再更新就 `verified` 了，说明是**瞬时锁**而非代码缺陷。

**修法**（两层，缺一层都还会复现）：

1. `lib/core.js`：原子写对 `EPERM / EBUSY / EACCES / ENOTEMPTY / EEXIST` 做有界退避重试
   （同步 40/80/120/160ms，异步同节奏），仍失败才抛。`atomicWriteSync` / `atomicWriteFile` /
   `atomicCopyFile` 三条路径全部接上。
2. `lib/reapply.js`：整批打完后对失败项**再打一轮**（有界一次，间隔 400ms），
   两轮都不过才判失败；日志记 `retried failed patches: <ids> remaining: <n>`。

**回归**：`check-upstream-ports.mjs` 新增两项（原子写退避重试的活体夹具、reapply 重试接线），
总数 28 → 30。


---

## 修复 4 — 更新交接失败回滚会穿过 junction 删掉真实 runtime

**缺陷（已复现）**：`lib/official-update.wscript` 的失败回滚分支里有

```js
fso.DeleteFolder(appDir, true);   // appDir = resources\app
```

WSH 的 `FileSystemObject.DeleteFolder` 递归删除会**穿过目录链接**。官方桌面安装把
`resources\app\runtime` 做成指向 `resources\runtime` 的 junction，于是这一删把真实 runtime
的内容一起抹掉，只留下空目录 —— 表现就是 office/SKILL.md 等运行资源丢失。
同一结构交给 Node 的 `fs.rmSync` 时只删链接本身，目标不受影响（两种行为都有回归用例固定）。

**修法**

1. `official-update.wscript`：回滚时不再删除重建出来的 `resources\app`，改为改名隔离到
   `app.dshpurge-failed-<ts>`；改名失败就记日志并保留现场，绝不递归删除。
   恢复旧 app 时优先用规范名 `app.dshpurge-prev`（升级前那一份），避免把并发 helper 重建的
   目录当成旧版本恢复。
2. `official-update.js`：新增 `isCleanableStaleDir()`，只允许清理「resources 的直接子项 + 名字匹配
   `app.dshpurge-(prev|failed)(-<ts>)?` + 本身不是链接」的目录；`clearStaleExtractedApps()` 改为
   `fs.rmSync` 并返回 `{removed, rejected, errors}`，被拒绝的条目原样保留。
3. `extract-asar.js`：`restoreExtractedDir()` 清隔离目录前复核同级路径、目录名与链接属性。
4. 成功判定：不再用「EXE/ASAR 大小或时间戳变了」当成功依据（安装器可能产出字节相同的文件，
   旧规则会因此触发第二次安装 + 假回滚）。现在只认「安装器退出码 0 + 必需资源存在」，
   大小变化仅作诊断字段；非零退出码不重试。
5. 交接日志新增 `decide` / `decide-final` / `isolated-app` / `restore-app-skipped` 等记录，
   含退出码、资源校验结论、隔离与恢复路径、最终决定；不写凭据或对话内容。

**回归**：`node scripts/test-official-update-rollback.mjs` — 34 项，7 个场景（正常更新、junction 回滚、
FSO 穿链复现与 Node 对照、大小不变判成功、非零退出码/资源不完整、隔离清理与重复执行、越界与顶层
链接拒绝、重命名失败保留现场），全部 PASS。全部夹具在临时目录内，fake exe / fake installer，
不碰真实安装目录。

## Community updater and target selection

- Version checks, package downloads, installed profile specs, and Git updates use `realMisakaMikoto/dsh-purge`. Git updates fetch the requested ref directly from this repository and retain the checkout's existing origin.
- Geographic and bank-domain target gates, the own-server exception list UI, and its API are removed. Existing allowlist files are not modified.
- The Windows update rollback and runtime/junction protections remain unchanged.

Validation: `node scripts/check-community-update.mjs` exercises version metadata, Git updates with a different origin, pinned tags, archive installs, and profile dependency URLs using temporary local repositories and mocked HTTP responses.

## Selected upstream evidence and rewind features

Source: YuJunZhiXue/dsh-purge 1.1.74, commit `5a9b8e14856138814a2139a0105481e1dcdaece4`.

- Import the evidence ledger, eight evidence/unknown tools, and the corresponding preset instructions.
- Import the upstream rewind implementation: step/turn boundaries, new-session fork/create, source archival, and cancellation/archive of the selected turn's subagents. Add the conversation client dependency required to select the new session.
- Keep this community build's updater, target-gate removal, knowledge base, bundled skills, and Windows rollback protections.
- Preserve upstream attribution in `NOTICE` and `docs/upstream-dsh-purge-LICENSE`; the existing project license metadata is unchanged.

Validation: `node scripts/check-evidence-rewind.mjs` covers ten evidence/rewind groups with in-memory SQLite and a fixture session controller. Community update checks also verify preset and NOTICE delivery in archive installs.

## Desktop activation verification (1.1.74)

A patched resources/app directory is not proof that the running desktop has switched away from app.asar. Status now exposes patches_active and activation_pending; the UI keeps the warning visible for a located extraction. Sealed hosts cannot be accepted by hostCleanEnoughToKeep. Apply replies report restart_required without claiming an unstarted restart or swap.

Regression: node scripts/check-desktop-activation.mjs (temporary files only; no live installation writes).

## Multi-host CLI status and doctor

The original multi-host status and doctor implementation was contributed by [@Heaven-Heart](https://github.com/Heaven-Heart) in [PR #1](https://github.com/realMisakaMikoto/dsh-purge/pull/1). Both original authored commits are retained when merging this contribution.

Maintainer follow-up connects doctor to the CLI, validates health/exit codes and baseline writes, propagates the selected surface through all status checks, respects explicit selection, identifies only running installations, and handles copied/missing installations and relative symlinks. The 1.1.74 activation verification and prior runtime fixes remain in place.

Regression: `node scripts/check-status-doctor.mjs` (temporary host and CLI fixtures); the Release checks run it alongside the desktop activation regression.

## Restart/activation loop and stale operations (1.2.2)

Fixes [issue #8](https://github.com/realMisakaMikoto/dsh-purge/issues/8). Three defects stacked into
"Apply → restart → the panel still demands a restart":

- The asar swap was verified through `bootMatches()`, which required `patches_active === true`. That flag was an
  all-or-nothing `patches_ready === patches_total`, so one `strictFiles` patch whose anchor is absent on the new
  host (`unmatched`, e.g. #43 / #70 / #71) made every swap unverifiable; after 120 s the recovery path restored
  `app.asar` and the host was sealed again. Activation now means "written + unsealed + nothing pending",
  `unmatched` rides along as `patches_unmatched`, recovery keeps the moved archive once the new host reported a
  boot, and the desktop activation wait is 180 s.
- `boot_full_quit` was derived from "`app.asar` still exists", and a plain quit-and-reopen never moves the
  archive, so the modal returned on every status poll (mount + 5 s timer) and only stayed suppressed until the
  settings pane unmounted. "Later" is now persisted to `$DSH_HOME/dsh-purge/restart-dismissed.json`, keyed by
  plugin version + archive size/mtime, and cleared by a new Apply or a new archive.
- A killed worker left a non-terminal journal, which made `/dsh-purge/restart` answer `already: true` and
  `createTransaction()` throw `An unfinished operation requires recovery`. `reconcileStale()` reclaims operations
  whose owner and supervisor are both dead (mark `failed`, release locks), and the client polls `phase` instead of
  trusting `already`.

The panel denominator no longer counts `skipped` rows (67/69 → 67/67 with "skipped 2"), and a sealed-only first
install reports `sealed_install`, so the pane says "official client found, Apply to unpack" instead of the red
"host not located yet".

Regression: `node scripts/check-desktop-activation.mjs` (6 groups: activation gate, boot proof, dismissal
expiry, stale-operation reconciliation) plus the updated boot-proof case in
`node scripts/check-update-transactions.mjs`.
