/**
 * dsh-purge 演练台自举（host 半侧）
 *
 * 资产库、工具、预设、技能都在本插件目录内。本文件负责：
 *   1. 首次把 `presets/redteam` 落到 `$DSH_HOME/.agent-presets/redteam/`
 *   2. 随包技能落到 `$DSH_HOME/redteam/skills`，预设用 `dshHomePath` 指向它
 *   3. 已有用户预设时只修失效路径 / 旧包名，不整份覆盖
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPresetDefinition } from './preset-composition.js'

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam'

/** 与梁神一致：不硬依赖 agentPresets，就绪后软取并声明。 */
export const inject = []

/** 模式下拉里的预设 id（目录名 / registry id）。 */
const REDTEAM_PRESET_ID = 'redteam'

/** 插件根目录（lib/redteam → 上两级）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills', 'redteam'),
    setupScript: join(root, 'scripts', 'redteam-setup.sh'),
  }
}

/** 环境数据目录（与 store/tools 用的同一份约定）。 */
export function redteamDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * 把随包分发的环境安装脚本落到 `$DSH_HOME/redteam/setup.sh`。
 *
 * 市场包用户装完只有 node_modules，仓库不在盘上；预检若只说"从仓库取脚本"，
 * 用户拿不到脚本、首次引导就断了。所以脚本随包走，启动时落一份可执行的副本。
 * 语义：目标不存在 → 装；已存在但内容不同 → 覆盖（脚本无用户可改状态）；
 *       内容相同 → 不动（避免每次启动都写盘）。
 *
 * @returns `{ action: 'installed'|'updated'|'kept'|'missing', path }`
 */
export function installSetupScript() {
  const paths = packagePaths()
  const target = join(redteamDataDir(), 'setup.sh')
  if (!existsSync(paths.setupScript)) return { action: 'missing', path: target }
  let wanted
  try {
    wanted = readFileSync(paths.setupScript, 'utf8')
  } catch {
    return { action: 'missing', path: target }
  }
  try {
    mkdirSync(redteamDataDir(), { recursive: true })
    if (existsSync(target)) {
      let current
      try { current = readFileSync(target, 'utf8') } catch { current = '' }
      if (current === wanted) {
        /* 权限可能被外部改掉，这里顺手补回来（脚本要能直接 bash 执行） */
        try { chmodSync(target, 0o755) } catch { /* 忽略 */ }
        return { action: 'kept', path: target }
      }
      writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
      return { action: 'updated', path: target }
    }
    writeFileSync(target, wanted, { encoding: 'utf8', mode: 0o755 })
    return { action: 'installed', path: target }
  } catch (error) {
    return { action: 'missing', path: target, error: error && error.message ? error.message : String(error) }
  }
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 预设模板里技能目录的占位符（build.mjs 写进打包预设，落地时才替换）。
 * 扩展名等都不允许写成别的形式，否则替换会漏。
 */
const SKILLS_PLACEHOLDER = '{{REDTEAM_SKILLS_DIR}}'

/** customSkillDirs 里"像本包 skills/ 目录"的那一行（老的绝对路径 / 占位符都算）。 */
function isSkillsDirLine(line) {
  const text = line.trim().replace(/^-\s*/, '')
  if (text === SKILLS_PLACEHOLDER) return true
  return /[/\\](dsh-redteam-mode|redteam-bundle)[/\\]skills\/?$/.test(text)
    || /[/\\]vendor[/\\]redteam[/\\]skills\/?$/.test(text)
    || /[/\\]skills[/\\]redteam\/?$/.test(text)
}

/** 预设里随包技能那一行。加载时按当前 DSH_HOME 解析，不写本机绝对路径。 */
const BUNDLED_SKILLS_EXPR = "!!js dshHomePath('redteam/skills')"

/**
 * 把占位符或写死的本机路径改成 `dshHomePath('redteam/skills')`。
 *
 * 占位符留在 YAML 里会被解析成对象，整个预设挂不上。写死
 * `profiles/desktop/node_modules/...` 又只在这一台桌面安装上成立，
 * Web、另一台机器、换过安装位置都会指空。技能文件由 installBundledSkills
 * 放到 `$DSH_HOME/redteam/skills`。
 */
function renderSkillsDir(text) {
  if (text.includes(SKILLS_PLACEHOLDER)) {
    return { text: text.split(SKILLS_PLACEHOLDER).join(BUNDLED_SKILLS_EXPR), changed: true, reason: 'placeholder' }
  }
  let changed = false
  const out = text.split('\n').map((line) => {
    if (!isSkillsDirLine(line)) return line
    const indent = /^(\s*)/.exec(line)[1]
    const wanted = indent + '- ' + BUNDLED_SKILLS_EXPR
    if (line === wanted) return line
    changed = true
    return wanted
  }).join('\n')
  return { text: out, changed, reason: changed ? 'stale-path' : 'none' }
}

/**
 * 技能同步目标目录（第一个是主目标，其余是"顺手补一份"）。
 *
 * `$DSH_HOME` 有两个可能来源：插件进程的 `process.env.DSH_HOME || homedir()/.dsh`，
 * 与宿主 `dshHomePath()` 解析出的 home。换盘 / 换 profile / `HOME` 为空的机器上两者
 * 会分叉 —— 技能只落到一边，预设指向另一边时就是"装了却列不出来 / 显示不可用"。
 * 所以：主目标必写，另外那个候选 home 只要在本机真实存在就补一份（不凭空造 home）。
 */
function skillSyncTargets() {
  const homes = []
  const push = (p) => { if (p && !homes.includes(p)) homes.push(p) }
  push(process.env.DSH_HOME)
  push(join(homedir(), '.dsh'))
  const primary = join(redteamDataDir(), 'skills')
  const dirs = [primary]
  for (const home of homes) {
    if (!existsSync(home)) continue
    const dir = join(home, 'redteam', 'skills')
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * 把包内 `skills/redteam/*.md` 同步到 `$DSH_HOME/redteam/skills`（分叉时两个 home 都放一份）。
 * 同名文件按包内内容覆盖。用户自己的副本在 `$DSH_HOME/skills`，不在这里改。
 */
export function installBundledSkills() {
  const paths = packagePaths()
  const targets = skillSyncTargets()
  if (!existsSync(paths.skills)) return { action: 'missing', path: targets[0], copied: 0 }
  const files = readdirSync(paths.skills).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const target of targets) {
    mkdirSync(target, { recursive: true })
    for (const file of files) {
      const wanted = readFileSync(join(paths.skills, file))
      const dest = join(target, file)
      let same = false
      try { same = readFileSync(dest).equals(wanted) } catch { same = false }
      if (same) continue
      writeFileSync(dest, wanted)
      if (target === targets[0]) copied += 1
    }
  }
  return { action: copied > 0 ? 'updated' : 'kept', path: targets[0], copied, targets }
}

/**
 * 预设里的插件名在当前宿主上到底能不能解析。
 *
 * 0.2.2 把 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 并进了主包、删掉了
 * `exports["./list-agents"]`；而红队预设里这一条是 `disabled: false`，于是 cordis 注册了它却
 * 永远起不来，整个红队模式被判 broken（`… : never started`）。1.2.x 之前一直没暴露，是因为
 * 0.2.1 还有这个子路径。
 *
 * 只在**确定**解析不到时返回 false；宿主树找不到（密封 asar / 未知布局）返回 null，
 * 由调用方保持原样，避免误关 0.2.1 上还能用的条目。
 */
function presetEntryAvailability(spec) {
  if (!spec) return null
  const roots = hostNodeModulesRoots()
  if (!roots.length) return null
  const [scope, name, ...rest] = String(spec).split('/')
  if (!scope || !name) return null
  const sub = rest.join('/')
  for (const root of roots) {
    const pkgDir = join(root, scope, name)
    const pkgJson = join(pkgDir, 'package.json')
    if (!existsSync(pkgJson)) continue
    // 命中一个真实存在的宿主树，就以它为准确认到底有没有这个子路径。
    if (!sub) return true
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const exportsMap = pkg && pkg.exports
      if (exportsMap && typeof exportsMap === 'object') {
        const key = `./${sub}`
        const entry = exportsMap[key]
        if (entry === undefined) return false
        const target = typeof entry === 'string' ? entry : entry && (entry.default || entry.import || entry.require)
        if (typeof target !== 'string') return false
        return existsSync(join(pkgDir, target))
      }
    } catch {
      return null
    }
    // 老包没有 exports 字段：按文件猜测。
    return existsSync(join(pkgDir, `${sub}.js`))
      || existsSync(join(pkgDir, `${sub}.mjs`))
      || existsSync(join(pkgDir, sub, 'index.js'))
  }
  return null
}

/** 宿主 `node_modules` 候选根：密封安装或未知布局时返回空数组（= 不判断）。 */
function hostNodeModulesRoots() {
  const out = []
  const push = (p) => {
    if (!p) return
    const norm = String(p).replace(/[\\/]+$/, '')
    if (norm && !out.includes(norm)) out.push(norm)
  }
  // DSH_BASE 指向 …\node_modules\@deepseek-ai
  const envBase = process.env.DSH_BASE
  if (envBase) push(join(dirname(envBase)))
  // Electron 主进程：<install>/resources/app/dsh/node_modules
  if (process.resourcesPath) push(join(process.resourcesPath, 'app', 'dsh', 'node_modules'))
  // 桌面 exe：<install>/DeepSeek Harness.exe
  if (process.execPath && /DeepSeek[ -]Harness\.exe$/i.test(process.execPath)) {
    push(join(dirname(process.execPath), 'resources', 'app', 'dsh', 'node_modules'))
  }
  // npm 安装的 dsh web
  if (process.env.APPDATA) push(join(process.env.APPDATA, 'npm', 'node_modules'))
  return out.filter((root) => existsSync(root))
}

/** 旧组合会把整份预设标 broken（worker-thread 未装 / tools 硬依赖 redteam）。 */
function needsCompositionRepair(presetFile) {
  if (!existsSync(presetFile)) return true
  try {
    const text = readFileSync(presetFile, 'utf8')
    if (!text.includes('id: workflow-ptc')) return true
    if (/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'[\s\S]{0,80}?config:\s*\n\s*provider:\s*spawn/.test(text)
      && !/name:\s*'@deepseek-ai\/dsh-workflow-worker-thread'\s*\n\s*disabled:\s*true/.test(text)) {
      return true
    }
    return false
  } catch {
    return true
  }
}

/** 从独立红队包迁进 dsh-purge 后，预设里的工具行包名要跟着改。 */
function renderToolsPackage(text) {
  if (!text.includes('dsh-redteam-mode/tools')) {
    return { text, changed: false }
  }
  return {
    text: text.split('dsh-redteam-mode/tools').join('dsh-purge/redteam/tools'),
    changed: true,
  }
}

/**
 * 自愈：指挥职责标题 + 在 Agent Teams profile 下强制重新启用 classic subagent。
 * 不整份覆盖用户预设，只改会让派活失败的几处。
 */
function repairDelegation(text) {
  let next = String(text || "")
  let changed = false
  const disabledHere = []
  if (next.includes("## 你是谁、你不做什么")) {
    next = next.split("## 你是谁、你不做什么").join("## 指挥职责（硬约束）")
    changed = true
  }
  const mark = "**必须用原生 `subagent` 工具派活**"
  if (next.includes("## 指挥职责") && !next.includes(mark)) {
    const needle = "`redteam_session_info`。"
    const at = next.indexOf(needle)
    if (at >= 0) {
      next =
        next.slice(0, at + needle.length) +
        "\n      " + mark +
        "；不要改用 Agent Teams 的 `spawn_teammate`（红队角色稿 / 并发闸门 / 叶子约束都挂在 `subagent` 路径上）。" +
        next.slice(at + needle.length)
      changed = true
    }
  }
  for (const id of [
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent",
    "tool-subagent-fork",
  ]) {
    const idLine = `- id: ${id}`
    let from = 0
    while (from < next.length) {
      const at = next.indexOf(idLine, from)
      if (at < 0) break
      const endId = at + idLine.length
      const ch = next[endId] || "\n"
      // 避免 tool-subagent 误匹配 tool-subagent-control / fork / codex
      if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") {
        from = endId
        continue
      }
      const after = endId
      const rest = next.slice(after)
      const endRel = rest.search(/\n[ \t]*- id: /)
      const block = endRel < 0 ? rest : rest.slice(0, endRel)
      const nameMatch = /name:\s*['"]([^'"]+)['"]/.exec(block)
      const available = presetEntryAvailability(nameMatch ? nameMatch[1] : '')
      if (available === false) {
        // 这个包/子路径在当前宿主上不存在（0.2.2 删了 …/list-agents）：
        // 必须显式 disabled，否则整个预设 broken，模式下拉里直接消失。
        if (/disabled:\s*true/.test(block)) break
        if (/disabled:\s*false/.test(block)) {
          const patched = block.replace(/disabled:\s*false/, "disabled: true")
          next = next.slice(0, after) + patched + next.slice(after + block.length)
          changed = true
          disabledHere.push(id)
          break
        }
        const indentMatch = /\n([ \t]+)name:/.exec(block)
        const indent = indentMatch ? indentMatch[1] : "      "
        next = next.slice(0, after) + `\n${indent}disabled: true` + next.slice(after)
        changed = true
        disabledHere.push(id)
        break
      }
      if (/disabled:\s*false/.test(block)) break
      if (/disabled:\s*true/.test(block)) {
        const patched = block.replace(/disabled:\s*true/, "disabled: false")
        next = next.slice(0, after) + patched + next.slice(after + block.length)
        changed = true
        break
      }
      const indentMatch = /\n([ \t]+)name:/.exec(block)
      const indent = indentMatch ? indentMatch[1] : "      "
      next = next.slice(0, after) + `\n${indent}disabled: false` + next.slice(after)
      changed = true
      break
    }
  }
  return { text: next, changed, disabledHere }
}

/** 包内锚点门相对预设模板的标记，用来给已有用户预设补一行，不整份覆盖。 */
const ANCHOR_ROW_MARK = '- id: anchor-gate'
const ANCHOR_BLOCK_START = '# 锚点门'
const REDTEAM_TOOLS_MARK = '- id: redteam-tools'

function anchorBlockBounds(ymlText) {
  const start = ymlText.indexOf(ANCHOR_BLOCK_START)
  const end = ymlText.indexOf(REDTEAM_TOOLS_MARK)
  if (start === -1 || end === -1 || start >= end) return null
  return { start, end }
}

function readAnchorBlockFromTemplate() {
  let template = ''
  try {
    template = readFileSync(join(packagePaths().presetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    return null
  }
  const bounds = anchorBlockBounds(template)
  if (!bounds) return null
  return template.slice(bounds.start, bounds.end).trim()
}

/**
 * 锚点门脚本每次用包内副本覆盖（没有用户可改状态）。
 * YAML 里锚点配置块与包内模板不一致时也会替换（bootstrapMaxTokens 等），其余 preset 正文保留。
 * @returns {'inserted'|'updated'|'config-updated'|'kept'|'missing'}
 */
function syncAnchorGate(targetDir) {
  const src = join(packagePaths().presetDir, 'anchor-gate.mjs')
  const dest = join(targetDir, 'anchor-gate.mjs')
  if (!existsSync(src)) return 'missing'
  mkdirSync(targetDir, { recursive: true })
  const wanted = readFileSync(src, 'utf8')
  let current = ''
  try { current = readFileSync(dest, 'utf8') } catch { current = '' }
  let script = 'kept'
  if (current !== wanted) {
    writeFileSync(dest, wanted, 'utf8')
    script = 'updated'
  }
  const presetFile = join(targetDir, 'agent.cordis.yml')
  if (!existsSync(presetFile)) return script
  let text
  try { text = readFileSync(presetFile, 'utf8') } catch { return script }
  const templateBlock = readAnchorBlockFromTemplate()
  if (!templateBlock) return script
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const rendered = templateBlock.replace(/\r\n/g, '\n').replace(/\n/g, nl)

  if (text.includes(ANCHOR_ROW_MARK)) {
    const bounds = anchorBlockBounds(text)
    if (!bounds) return script
    const currentBlock = text.slice(bounds.start, bounds.end).trim()
    if (currentBlock === rendered.trim()) return script
    const next = text.slice(0, bounds.start) + rendered + nl + nl + text.slice(bounds.end)
    writeFileSync(presetFile, next, 'utf8')
    return script === 'updated' ? 'updated' : 'config-updated'
  }

  const at = text.indexOf(REDTEAM_TOOLS_MARK)
  const next = at === -1
    ? text.replace(/\s*$/, '') + nl + nl + rendered + nl
    : text.slice(0, at) + rendered + nl + nl + text.slice(at)
  writeFileSync(presetFile, next, 'utf8')
  return 'inserted'
}

/**
 * 把包内预设落地到用户 preset 根。
 *
 * 语义（v0.9.0 起）：
 *   · 目标不存在 → 完整安装（占位符替换成真实路径）；
 *   · 目标已存在 → **默认不覆盖用户内容，但会自愈**：只要里面还留着
 *     `{{REDTEAM_SKILLS_DIR}}` 或写死的本机技能路径，就改成 `dshHomePath('redteam/skills')`。
 *     锚点门脚本会更新，缺了那一行会补上。其余内容保留。
 *   · `force: true` 才用包内模板整体覆盖。
 *
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept'|'repaired', dir, skillsDir, skills, repaired? }`
 */
export function installPreset(options = {}) {
  const paths = packagePaths()
  const bundled = installBundledSkills()
  const target = join(userPresetRoot(), 'redteam')
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0
  const presetFile = join(target, 'agent.cordis.yml')

  if (existsSync(presetFile) && options.force !== true) {
    /* 自愈：占位符没替换 / 技能目录指向已失效的旧包路径 → 就地修好 */
    let text
    try {
      text = readFileSync(presetFile, 'utf8')
    } catch (error) {
      log(`读取 ${presetFile} 失败：${error && error.message ? error.message : String(error)}`)
      return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
    }
    const rendered = renderSkillsDir(text)
    const tools = renderToolsPackage(rendered.text)
    const delegation = repairDelegation(tools.text)
    const next = delegation.text
    if (rendered.changed || tools.changed || delegation.changed) {
      writeFileSync(presetFile, next.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
      log(
        (rendered.changed
          ? (rendered.reason === 'placeholder'
            ? '预设里还留着 ' + SKILLS_PLACEHOLDER + '（会导致整个预设挂载失败）'
            : '预设里的技能目录写成了本机绝对路径')
            + '，已改为 dshHomePath(\'redteam/skills\')'
          : '')
        + (tools.changed ? (rendered.changed ? '；' : '') + '工具包名已改为 dsh-purge/redteam/tools' : '')
        + (delegation.changed
          ? ((rendered.changed || tools.changed) ? '；' : '')
            + (delegation.disabledHere?.length
              ? `已关闭宿主里不存在的插件：${delegation.disabledHere.join(', ')}（否则整个预设 broken）`
              : '已修复指挥派活约束 / 重新启用 subagent')
          : ''),
      )
    }
    const anchor = syncAnchorGate(target)
    if (anchor === 'inserted') log('已把锚点门补进现有预设（其余内容保留）')
    else if (anchor === 'updated') log('已更新锚点门脚本')
    else if (anchor === 'config-updated') log('已同步锚点门配置（bootstrapMaxTokens / maxBootstrapSteps 等）')
    const repaired = [
      rendered.changed ? rendered.reason : null,
      tools.changed ? 'tools-package' : null,
      delegation.changed ? 'delegation' : null,
      anchor === 'inserted' ? 'anchor-gate' : null,
      anchor === 'updated' ? 'anchor-script' : null,
      anchor === 'config-updated' ? 'anchor-config' : null,
    ].filter(Boolean)
    if (repaired.length > 0) {
      return {
        action: 'repaired', dir: target, skillsDir: bundled.path, skills: skillCount,
        repaired: repaired.join('+'),
      }
    }
    log(`已存在用户自己的预设 ${target}，保留不动（要覆盖：REDTEAM_PRESET_REFRESH=1 启动一次）`)
    return { action: 'kept', dir: target, skillsDir: bundled.path, skills: skillCount }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
    const rendered = renderToolsPackage(renderSkillsDir(text).text).text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
    writeFileSync(join(target, file), rendered, 'utf8')
  }
  syncAnchorGate(target)
  log(`预设已安装到 ${target}（随包技能 ${skillCount} 个，目录 ${bundled.path}）`)
  return { action: 'installed', dir: target, skillsDir: bundled.path, skills: skillCount }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1'
        || needsCompositionRepair(join(userPresetRoot(), 'redteam', 'agent.cordis.yml')),
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
    })
  } catch (error) {
    ctx.logger?.error?.('redteam-mode: 预设安装失败：%s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: join(redteamDataDir(), 'skills'), skills: 0 }
  }
  let setupResult
  try {
    setupResult = installSetupScript()
  } catch (error) {
    setupResult = { action: 'missing', error: error && error.message ? error.message : String(error) }
  }
  if (setupResult.action === 'installed' || setupResult.action === 'updated') {
    ctx.logger?.info?.('redteam-mode: 环境安装脚本已就位 %s（%s）', setupResult.path, setupResult.action)
  }

  /*
   * Web 0.1.7+ 模式下拉只认 agent-preset registry.register()，
   * 扫磁盘 .agent-presets 不会出现在下拉里（梁神同款）。
   */
  const statusFile = join(redteamDataDir(), 'preset-declare.json')
  const writeStatus = (patch) => {
    try {
      mkdirSync(redteamDataDir(), { recursive: true })
      let prev = {}
      try { prev = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { /* first */ }
      writeFileSync(statusFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* ignore */ }
  }
  writeStatus({ ok: false, phase: 'apply-start', skillsDir: result.skillsDir, presetDir: result.dir })

  let releaseDeclared
  let closed = false
  const softRegistry = () => {
    try {
      if (ctx.agentPresets && typeof ctx.agentPresets.register === 'function') return ctx.agentPresets
    } catch { /* without inject */ }
    try {
      const reg = ctx.get('agentPresets')
      if (reg && typeof reg.register === 'function') return reg
    } catch { /* missing */ }
    return null
  }
  const undeclare = async () => {
    const dispose = releaseDeclared
    releaseDeclared = undefined
    if (!dispose) return
    try { await dispose() } catch (error) {
      ctx.logger?.warn?.('redteam-mode: undeclare failed: %s', error?.message || String(error))
    }
  }
  const buildDefinition = () => {
    const fromDisk = join(userPresetRoot(), 'redteam')
    if (!existsSync(join(fromDisk, 'agent.cordis.yml'))) {
      installPreset({ force: false, log: () => {} })
    }
    const readyDir = existsSync(join(userPresetRoot(), 'redteam', 'agent.cordis.yml'))
      ? join(userPresetRoot(), 'redteam')
      : paths.presetDir
    return readPresetDefinition(REDTEAM_PRESET_ID, readyDir)
  }
  const registerOnce = (registry) => {
    let definition
    try {
      definition = buildDefinition()
    } catch (error) {
      writeStatus({ ok: false, phase: 'read-failed', error: error?.message || String(error) })
      ctx.logger?.warn?.('redteam-mode: read preset failed: %s', error?.message || String(error))
      return
    }
    writeStatus({
      ok: false,
      phase: 'registering',
      id: definition.id,
      name: definition.name,
      plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
    })
    Promise.resolve()
      .then(async () => {
        await undeclare()
        releaseDeclared = await registry.register(definition)
        let broken = null
        try {
          const row = (await registry.list()).find((p) => p.id === REDTEAM_PRESET_ID)
          broken = row?.broken || null
        } catch { /* ignore */ }
        writeStatus({
          ok: !broken,
          phase: broken ? 'registered-broken' : 'registered',
          id: definition.id,
          name: definition.name,
          plugins: Array.isArray(definition.plugins) ? definition.plugins.length : -1,
          broken,
        })
        if (broken) ctx.logger?.warn?.('redteam-mode: declared but broken: %s', broken)
        else ctx.logger?.info?.('redteam-mode: declared for mode dropdown: %s', definition.name || REDTEAM_PRESET_ID)
      })
      .catch((error) => {
        writeStatus({ ok: false, phase: 'register-failed', error: error?.message || String(error) })
        ctx.logger?.warn?.('redteam-mode: register failed: %s', error?.message || String(error))
      })
  }

  ctx.effect(() => {
    let tries = 0
    const tick = () => {
      if (closed) return true
      tries += 1
      const registry = softRegistry()
      if (!registry) {
        writeStatus({ ok: false, phase: 'waiting-registry', tries })
        return false
      }
      registerOnce(registry)
      return true
    }
    let timer
    let stop
    if (!tick()) {
      timer = setInterval(() => {
        if (tick()) {
          clearInterval(timer)
          timer = undefined
          if (stop) clearTimeout(stop)
        }
      }, 400)
      if (typeof timer.unref === 'function') timer.unref()
      stop = setTimeout(() => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
          writeStatus({ ok: false, phase: 'timeout-waiting-registry', tries })
        }
      }, 45000)
      try { stop.unref?.() } catch { /* ignore */ }
    }
    return () => {
      closed = true
      if (timer) clearInterval(timer)
      if (stop) clearTimeout(stop)
      void undeclare()
    }
  }, 'dsh-purge-redteam: declare agent preset')

  ctx.provide('redteamMode', Object.freeze({ paths, preset: result, setup: setupResult }))
  ctx.logger?.info?.(
    'redteam-mode: 就绪（数据目录默认 $DSH_HOME/redteam；预设 %s；技能目录 %s）',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
