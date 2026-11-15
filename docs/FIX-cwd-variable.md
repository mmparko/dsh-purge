# 1.1.73 修复记录：`unknown prompt variable "{{cwd}}"`

> 严重级别：**致命**（升级后任何对话都无法发送）
> 影响版本：1.1.72（在 DSH 0.2.2-rc.3 上开箱即挂）
> 修复版本：1.1.73
> 日期：2026-11-15

---

## 一、现象

升级到 DSH 0.2.2-rc.3 并重启后，任何一轮对话直接失败：

```
处理失败
本轮运行失败unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
registered variables: provider, model
```

重启软件、换会话、换模型都无法绕过。

## 二、根因

### 2.1 宿主收紧了插值变量表

`@deepseek-ai/dsh-system-prompt/lib/index.js` 在渲染前逐个替换 `{{变量}}`，遇到未注册的变量直接抛错：

```js
if (!Object.hasOwn(variables, name)) {
  const known = Object.keys(variables);
  throw new Error(
    `unknown prompt variable "{{${name}}}" in ${kind} "${input.name}"; ` +
    `registered variables: ${known.length > 0 ? known.join(", ") : "(none)"}`
  );
}
```

0.2.2-rc.3 的变量表只有 `provider` 和 `model` —— **`cwd` 不再存在**。

### 2.2 插件无条件写回 `{{cwd}}`

`lib/identity.js` 的 `overlayOfficialIdentity()` 认为「后缀段为空 = 该补默认值」：

```js
// 修复前
if (!raw.trim() || looksLikeOfficialIdentity(raw) || isCwdOnlyText(raw)) {
  out.push({ ...section, text: CWD_ONLY_SUFFIX });   // CWD_ONLY_SUFFIX = "Your working directory is {{cwd}}."
}
```

而 profile 里的配置恰好是空的：

```yaml
- id: system-prompt
  config:
    personaSuffix: ""
```

于是：**空后缀 → 插件补 `{{cwd}}` → 宿主找不到 cwd 变量 → 抛错 → 请求发不出去。**

### 2.3 为什么 1.1.72 没测出来

1.1.72 的验证只检查了「补丁文件语法」和「标记是否写入」，
**没有用宿主的 `renderPrompt` 跑一次真实渲染**。语法正确不等于能渲染。

## 三、修复

只改 `lib/identity.js`，思路是**运行时探测，而不是假定**：

```js
/** 宿主没注册 cwd 变量时不能注入 {{cwd}}，否则渲染前直接抛 unknown prompt variable。 */
export function cwdSuffixFor(variables) {
  return variables && Object.hasOwn(variables, "cwd") && variables.cwd !== undefined
    ? CWD_ONLY_SUFFIX
    : "";
}
```

`variables.cwd !== undefined` 不能省：宿主对「已注册但值为 undefined」同样抛错。

配套改动：

| 位置 | 改动 |
|---|---|
| `overlayOfficialIdentity(sections)` | → `overlayOfficialIdentity(sections, variables)` |
| 已有后缀段的写入 | `CWD_ONLY_SUFFIX` → 动态 `cwdSuffix` |
| 补建后缀段的写入 | 同上，且条件改为 `if (!sawSuffix && cwdSuffix)` |
| 调用点（约 L977） | 透传 `assembled.variables` |

**为什么要加 `&& cwdSuffix`**：没有 cwd 时若仍然补建，会留下一个空文本的 section，
虽然不报错，但会让提示词多一截无意义内容。

## 四、验证

用宿主自己的 `renderPrompt`（不是模拟实现）跑 8 个场景：

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | 本机环境（只有 provider / model） | 不注入 `{{cwd}}`，渲染通过 | ✅ 后缀为 `""` |
| 2 | 后缀为空，走补默认值分支 | 补成空字符串 | ✅ |
| 3 | 宿主存在 `cwd` 变量 | 正常输出工作目录 | ✅ 含路径 |
| 4 | `cwd` 已注册但值为 `undefined` | 不注入，渲染通过 | ✅ |
| 5 | bundle 写死 `{{cwd}}` 且宿主无 cwd | 清空，渲染通过 | ✅ |
| 6 | 用户自定义后缀（如「用中文回答」） | 原样保留不覆盖 | ✅ |
| 7 | 无 suffix 段且无 cwd | 不补建空段 | ✅ 未补建 |
| 8 | `cwdSuffixFor` 三态输入 | `""` / `""` / 含 `{{cwd}}` | ✅ |

复现脚本（修复前会抛错）：

```js
import { renderPrompt } from '.../@deepseek-ai/dsh-system-prompt/lib/index.js';
import { rewritePromptAssembly } from '.../dsh-purge/lib/identity.js';

const assembled = {
  sections: [
    { name: 'deployment:persona', text: 'You are helpful.', order: 0 },
    { name: 'deployment:persona-suffix', text: '', order: 10200 },
  ],
  contexts: [], tools: [],
  variables: { provider: 'p', model: 'm' },   // 本机：无 cwd
};
renderPrompt(rewritePromptAssembly(assembled, '', {}));
```

## 五、一个容易误判的点

`escapeDshInterpolation()` 的放行白名单里仍有 `cwd`：

```js
const DSH_INTERPOLATE_ALLOWED = new Set(["cwd", "model", "provider"]);
```

看起来像第二个缺口，但**实际不会出问题**：注入正文所在的所有段都带 `interpolate: false`
（`identity.js` 里 4 处，含 `dsh-purge` 主段、capability 段、persona 段），
宿主不会解析它们的 `{{}}`。真正会走插值渲染的只有 `deployment:persona-suffix`，
也就是本次修掉的那一处。

## 六、教训

**改提示词相关代码，必须用宿主真实的 `renderPrompt` 验证一次。**
只做 `node --check` 只能证明语法对，证明不了能渲染。

建议把这段验证挂进 CI（`scripts/build-client.mjs` 旁边加一个 `scripts/verify-prompt.mjs`），
否则下次官方再动变量表，还会以同样方式翻车。
