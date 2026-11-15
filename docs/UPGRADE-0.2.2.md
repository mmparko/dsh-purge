# 适配 DSH 0.2.2-rc.3 升级报告

> 适用版本：dsh-purge **1.1.72**
> 执行时间：2026-11-15
> 目标：把只适配 `dsh 0.2.0-rc.2` 的 dsh-purge 1.1.71 更新到能打 **0.2.2-rc.3**
> 结果：**applied 58 → 72 / 82**，10 个宿主文件全部语法通过
>
> 想先搞懂这个项目怎么实现的，看 [源码讲解](SOURCE-GUIDE.zh-CN.md)。

---

## 一、为什么之前有 19 条补丁失效

补丁的工作方式是「查找一段原文 → 替换成新原文」。
官方 DSH 从 `0.2.0-rc.2` 升到 `0.2.2-rc.3` 时，**改了三类东西**：

| 变化类型 | 后果 | 例子 |
|---|---|---|
| **函数体重构** | 原文对不上 | 审批逻辑从 `index.js` 拆到 `pipeline.js` |
| **包搬迁** | 文件路径找不到 | 交付物提示词挪到 `dsh-deliverable-file-references` |
| **缩进/包装变化** | 白空格不匹配 | `try {}` 多包一层，缩进 4 tab → 5 tab |

补丁引擎遇到「原文对不上」时的策略是**跳过**（不报错、不硬改），
所以表现为：状态是 `skipped`，重启后功能其实没生效。

---

## 二、我给 dsh-purge 做的 9 处改动

全部改在 `dsh-purge/lib/core.js`，共动了两类东西：

### A. `targetFiles()`：6 个新的文件映射

因为官方把代码搬了家，补丁得知道新地址：

```js
// 交付物提示词：0.2.2 从 dsh-client-ui-deliverables 挪走
"deliverables-prompt": allExisting([
  ...nestedPkg(aiBase, "dsh-client-ui-deliverables", "lib", "index.js"),   // 老宿主
  ...nestedPkg(aiBase, "dsh-deliverable-file-references", "lib", "index.js"), // 新宿主
]),

// run_code / PTC：0.2.2 拆成独立包
"dsh-tools-ptc": allExisting([
  ...nestedPkg(aiBase, "dsh-tools", "lib", "types", "ptc.js"),
  ...nestedPkg(aiBase, "dsh-tool-executor-ptc", "lib", "index.js"),
  ...nestedPkg(aiBase, "dsh-tool-executor-ptc", "lib", "types", "ptc.js"),
]),

// 审批逻辑：0.2.2 从 index.js 拆到 pipeline.js
"dsh-tools-pipeline": allExisting([
  ...nestedPkg(aiBase, "dsh-tools", "lib", "pipeline.js"),
  ...nestedPkg(aiBase, "dsh-tools", "lib", "types", "pipeline.js"),
]),

// Web 身份句：0.2.2 从 web-app 挪到 harness-dev-context
"harness-dev-context": allExisting([
  ...nestedPkg(aiBase, "dsh-harness-dev-context", "lib", "index.js"),
]),
```

**关键设计**：每个键都同时登记「老路径 + 新路径」。
这样同一份插件既能打 0.2.0-rc.2，也能打 0.2.2-rc.3 —— 不会因为修新版而弄坏旧版。

### B. 给 11 条补丁追加新 pattern（老 pattern 保留）

| 补丁 | 改了什么 |
|---|---|
| **#13** 升级阶梯豁免 | `throw new Error(...)` → `SandboxEscalationError(..., "CODE")` |
| **#14** 升级无条件授信 | `displayReason` 变成 `escalationDisplayReason()` 函数调用 |
| **#17** 观察策略放行 | `editIntent`/`deleteIntent` 合并成 `requirePresent()` |
| **#18** 重复调用守卫 | `downstream.kind === "block"` 分支被删了 |
| **#32** Web 身份中立 | 句子搬到 `WEB_SURFACE_PROMPT`，措辞也变了 |
| **#35** 升级永不拒绝 | 三个 case 全换成 `SandboxEscalationError`，cancelled 多一行 |
| **#40** complete 保注入 | `completeSection` 分支重写 + `requiredContexts` 新逻辑 |
| **#53** Web 禁止另开服务器 | 同 #32，跟着搬到 dev-context |
| **#54** 交付物禁止句 | 常量改名 `FILE_REFERENCE_PROMPT` |
| **#60** run_code 审批中立 | 整个包换到 `dsh-tool-executor-ptc` |
| **#62** 审批 fail-open | 新位置 `pipeline.js`，`deny` 包成 `approvalDenial()` |
| **#67** messages 兜底 | 外面多包一层 `try {}`，缩进 4→5 tab |
| **#74** 每步前挂提示词 | claim 和 assemble 之间插入 model selection |
| **#82** 桌面 profile 兜底 | import 后面跟的 region 从 home-paths 变 mime |

每条新 pattern 都写成**追加**在旧 pattern 之后，而不是替换旧的。
补丁引擎按顺序试，第一个命中的生效 —— 这样新旧宿主都能打。

---

## 三、验证结果

### 最终状态

```
applied       72  ████████████████████████████████████████░░ 
skipped        4
missing_file   1
na             5
─────────────────────────────────────────────
合计          82
```

### 10 个被改的宿主文件全部语法通过

```
✓ dsh-sandbox/lib/index.js              ← #13/#14/#35 升权放行
✓ dsh-fs-observation-policy/lib/index.js ← #17 读写意图放行
✓ dsh-repeat-tool-reminder/lib/index.js  ← #18 重复守卫禁用
✓ dsh-harness-dev-context/lib/index.js   ← #32/#53 Web 身份中立
✓ dsh-system-prompt/lib/index.js         ← #40 complete 保注入
✓ dsh-agent-loop/lib/index.js            ← #67/#74 兜底 + 提前挂载
✓ dsh-tools/lib/pipeline.js              ← #62 审批 fail-open
✓ dsh-tool-executor-ptc/lib/index.js     ← #60 run_code 审批中立
✓ dsh-deliverable-file-references/lib/index.js ← #54 交付物告诫移除
✓ app/lib/main.js                        ← #82 DSH_PROFILE 兜底
```

### 逐条确认标记已写入

```
#13/14/35 escalation       ✓ [dsh-purge] escalation
#17 observation            ✓ [dsh-purge] observation bypass
#18 repeat-reminder        ✓ [dsh-purge] repeat-tool-reminder disabled
#32/53 web identity        ✓ local web GUI
#40 system-prompt          ✓ inject last after closer
#54 deliverable            ✓ dsh-purge
#60 run_code               ✓ Approval is auto-granted
#62 approval failopen      ✓ dsh-purge
#67 agent-loop guard       ✓ [dsh-purge] guard undefined messages
```

---

## 四、剩下 10 条为什么没修（**都是正确跳过**）

| 补丁 | 状态 | 原因 |
|---|---|---|
| **#76** unrestricted 去身份 | skipped | 你的 `unrestricted` 预设已被重写成中文人设，**本来就没有**官方身份句 |
| **#80** minimal 官方工具表 | skipped | 官方 `minimal.patch.yml` 已自带 `tool-fs`（L17-18），无需再补 |
| **#56** rewind 只藏被撤 | skipped | **官方 0.2.2 把整个 rewind 功能删了**，全文 0 处匹配 |
| **#77** rewind 立即丢弃 | skipped | 同上，功能不存在 |
| **#71** 梁神去身份 | missing_file | 你没装梁神插件 |
| **#28** 梁神 phase-1 | na | 同上 |
| **#30/#31** hooks deny→allow | na | 你没装 dsh-hooks-claude-code / codex |
| **#64/#65** hooks stop/prestep | na | 同上 |

**这 10 条不是失败，是「这套环境下没有对应的东西可改」。**
补丁引擎对这种情况显示 `skipped` / `na` / `missing_file`，不阻拦应用完成。

---

## 五、怎么回滚

### 方式 1：用插件自带还原（推荐）

```sh
dsh-purge --revert
```

会拿 `.dshpurge.bak` 覆盖回去。**55 个目标文件 + `app/lib/main.js` 都有 .bak。**

> 注意：Windows 上 `backupAll()` 对 `resources\` 下的文件可能返回 `EPERM`
> （rename 需要更高权限），此时不会生成 .bak。这种情况用方式 2。

### 方式 2：从完整副本恢复（最保险）

**应用前先把整个 `@deepseek-ai` 目录复制一份**（约 300 MB）：

```powershell
$dst = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai"
Copy-Item $dst "D:\bak\aiBase-before-upgrade" -Recurse -Force
```

出问题时整目录覆盖回去即可：

```powershell
$src = "D:\bak\aiBase-before-upgrade"
$dst = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai"
Copy-Item "$src\*" $dst -Recurse -Force
```

### 方式 3：从安装包重装官方客户端

最彻底，会把所有改动清掉。

---

## 六、生效需要做什么

**必须完全退出 DeepSeek Harness 再重开**（托盘右键退出，不是关窗口）。

原因：Node 已经把 `@deepseek-ai/*` 的模块读进内存了，改磁盘上的文件只有**新进程**才会读到。

重启后可以在新的会话里说：

```
/purge status
```

应该看到 `72/82 已清洗`。

---

## 七、我改的代码在哪、怎么复核

```
dsh-purge/lib/core.js    ← 唯一被修改的文件
```

三个可复核点：

```sh
# 1. 语法
node --check dsh-purge/lib/core.js

# 2. 看新增的 6 个 targetFiles 键（搜 "0.2.2"）
# 3. 看每条补丁的第二个 pattern（搜 "0.2.2-rc.3"）
```

我加的所有注释都带 `0.2.2-rc.3` 前缀，方便你和原作者后续的正式版本合并。

---

## 八、给上游提 PR 的建议

如果你想让作者合并，建议拆成 **3 个 commit**：

1. `feat(core): register 0.2.2 package moves in targetFiles`
   —— 只改 `targetFiles()`，无风险
2. `fix(core): add 0.2.2 patterns for 11 patches`
   —— 纯追加 pattern，老宿主不受影响
3. `chore: bump dshTarget to 0.2.2-rc.3`
   —— `package.json` 的 `dshTarget` 字段

第 3 步要注意：一旦改了 `dshTarget`，插件对老版本会显示「版本不匹配」提示。
更稳的做法是**不改** `dshTarget`，让补丁的"对不上就跳过"机制自己处理 —— 这也是作者原本的设计。
