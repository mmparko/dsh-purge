/**
 * RedTeam Agent Toolset (preset layer)
 *
 * Registers model-facing tools into `tools` without exposing external network services;
 * Resolves host-level `ctx.redteam` (process-level store instance published by dsh-redteam-store).
 *
 * Design conventions:
 *   - Writes must go through redteam_asset_add / redteam_asset_link; agents do not touch raw SQL;
 *   - Every finding carries provenance (passive|active) and tool name for credible attribution;
 *   - Target isolation per root session: parentSession inheritance prevents cross-contamination across sessions;
 *   - Concurrency hard limit: redteam_agent_slot enforces max 3 concurrent execution agents per target.
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* Unified skill availability check shared between console UI and tools */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'

/**
 * Resolves @deepseek-ai/dsh-tools dynamically from host/profile paths.
 */
function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* Fallback to raw path if unresolvable */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* Global npm argv is often .../bin/dsh; the package is in adjacent lib/node_modules. */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* Scan host if not in plugin dependencies */ }
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  try { considerBin(candidates, process.execPath) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const resources = process.resourcesPath || ''
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  const desktopRoots = [resources, exeDir ? join(exeDir, 'resources') : '', exeDir].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineTool = loadDefineTool()

/** Cordis plugin name. */
export const name = 'dsh-purge-redteam-tools'

/** Tool registry dependency; `redteam` store is resolved softly from host layer. */
export const inject = ['tools']

/** Root session ID -> engagementId binding (stable per session; rebound after restart). */
const bindings = new Map()

/** Concurrency gate: root session ID -> Map(child agent key -> reserved timestamp). */
const reservations = new Map()

/** FIFO cap: bound session ID cache to avoid unbounded growth. */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** Concurrency limit: read dynamically from settings.json -> REDTEAM_MAX_AGENTS -> defaults to 3. */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** Session resolution info for an execution call. */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/** Session ID (legacy compatibility). */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * Resolve root session ID by traversing parentSession upward.
 * Subagents inherit their parent's binding while isolating independent root sessions.
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* Parent session not in memory: parent ID serves as stable root key */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** Binding key and session chain. */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * Resolve target engagement for current execution (session isolation).
 *
 * Precedence: 1. explicit argument -> 2. current/parent session binding -> 3. active engagement pointer.
 * Throws if target is ambiguous to prevent cross-contamination across sessions.
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          'This session is not bound to a target engagement, and active engagement ' + active + ' is occupied by another session; '
          + 'to prevent session cross-contamination, please explicitly bind: redteam_engagement_open (create/open)'
          + ' or redteam_session_bind (bind to existing target).',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('Target engagement not bound: call redteam_engagement_open with target name first')
}

/** Session binding relations for redteam_session_info and UI. */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** Comma/whitespace separated string -> deduplicated array. */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** Compact asset structure for LLM context. */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* Discovered timestamp: when this asset was first recorded in the database */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** Role code hint written into tool descriptions. */
const ROLE_HINT = 'Role code: ' + ROLE_ORDER.map((r) => '`' + r + '` (' + ROLE_TITLES[r] + ')').join(', ')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** Live active concurrency from subagents registry. */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents registry unavailable (cannot verify active concurrency, falling back to reservations)' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: 'Failed to list child sessions: ' + (error && error.message ? error.message : String(error)) }
  }
}

/** Reservations not yet tracked by active subagents registry. */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* When no key specified, drop only the oldest reservation to avoid over-releasing */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * Agent role producing this record: explicit argument takes precedence; defaults to planner.
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** Shared agent parameter for write tools. */
const AGENT_PARAM = {
  type: 'string',
  description: '[Recommended] Agent role producing this record — ' + ROLE_HINT
    + '. Used in reports for attribution; defaults to planner (main session) if omitted.',
}

/**
 * Wrap tool execution to catch exceptions and return structured failure responses.
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* Distinguish parameter/lookup errors from runtime failures */
        const kind = /invalid|required|missing|not found|empty|非法|不能为空|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? 'Parameter or object identification issue: check parameter names and values (verify actual IDs with matching *_list / *_query tools), correct and retry.'
            : 'Tool execution failed, see error field for details; do not silently skip, inform user or commander of block points.',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('redteam store unavailable') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* Auto-release concurrency slot when child subagent completes */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* Fallback: drop oldest reservation by timestamp */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* Fallback to manual release if event listener unavailable */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: 'Open or create a red team target engagement (by organization name) and bind the **current session** to it (subagents inherit automatically). All subsequent asset tools default to this target. If the engagement already exists, its asset database is reused. Scoped to the current session without affecting other sessions.',
    parameters: {
      target: { type: 'string', required: true, description: 'Target organization name, e.g., "Example Tech Corp"' },
      scope: {
        type: 'array',
        description: 'Authorized scope CIDR list (optional: if omitted, proceed autonomously with publicly visible assets)',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false -- avoid mutating global active pointer during parallel sessions */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      const view = bindingViewOf(exec)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: 'Bound to current session (isolated: other sessions unaffected); subagents will inherit this target.'
          + (view.is_subagent ? ' Note: Current session is a subagent; typically no need to open, parent engagement is inherited.' : ''),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: 'Bind an **existing** target engagement to current session (for parallel sessions: each binds its own target without cross-contamination). Accepts target ID or organization name; omit to list candidates.',
    parameters: {
      engagement: { type: 'string', description: 'Target ID or organization name; omit to list candidates' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: 'Please provide engagement (target ID or organization name) to bind.',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: 'Target engagement not found: ' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: 'Current session bound to "' + hit.name + '"; subsequent tools and reports will operate on it.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: 'Inspect **which target engagement current session is bound to** (session ID, parent session, root session, binding chain). Run this before parallel execution to verify isolation.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: 'Session binding is an in-process state: rebind after dsh restart (via redteam_engagement_open / redteam_session_bind).',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '[MUST run before operations] Platform skills and resource preflight check: inspects required environment variables (e.g. FOFA_KEY), local binaries/tools (suo5 / fscan / gogo / frp / behinder / godzilla / nmap / nuclei...), and external VPS infrastructure. Returns available/broken list with remediation guidance. Directly request missing keys or VPS from user, or propose fallback options.',
    parameters: {
      include: { type: 'string', description: 'Only check these skills (comma-separated); omit to check all red team skills' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      const plat = platformSummary()
      const cfg = loadPlatformConfig()
      /* 环境变量的真实来源：进程环境 + $DSH_HOME/.env + 平台 config.json env */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = mergeConfigEnv({ ...process.env }, cfg)
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            /* Compatible with shell `export KEY=value` and inline comments */
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            let raw = m[2].trim()
            if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
            const value = raw.replace(/^["']|["']$/g, '').trim()
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* .env 读不到不影响主流程 */ }

      const toolkit = toolkitDirOf(cfg)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 忽略 */ }

      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const setupScript = redteamDir + '/setup.sh'
      const hasMarker = existsSync(markerFile)
      const hasSetupScript = existsSync(setupScript)
      const toolkitHint = 'This plugin does not download or install tools autonomously. For Windows or environments without setup.sh, configure tool paths, FOFA_KEY, and VPS under Environment Adaptation. If $DSH_HOME/redteam/setup.sh exists, ask the user to run --check; do not execute automated downloads via --yes.'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + (plat.runtime.windows ? '\\vps\\id_rsa' : '/vps/id_rsa'))
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''
      const hasVps = existsSync(vpsKey)
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY (Asset Mapping: configure in Environment Adaptation or $DSH_HOME/.env)')
      if (!hasVps) {
        missing.push(plat.runtime.windows
          ? 'VPS Private Key (Configure REDTEAM_VPS_KEY path and REDTEAM_VPS_HOST in Environment Adaptation)'
          : 'VPS Access: place private key at ' + vpsKey + ' and configure REDTEAM_VPS_HOST (see redteam-setup skill or Environment Adaptation)')
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '...' + fofaKey.slice(-4) : '(configured)'
      const runtimeHint = plat.runtime.windows
        ? 'Current OS: **Windows Adaptation**: Configure tool paths/search dirs, FOFA, and VPS in Environment Adaptation. Do not assume Kali or bash setup.sh exists. A dedicated VM is recommended.'
        : 'Running inside a dedicated Kali/Linux drill VM is recommended; avoid executing on daily workstations to isolate keys, payloads, and scanning egress.'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* 桌面端常无 skills inject：仍返回平台工具探测，避免整条 preflight 报废 */
        const toolMissing = (plat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        if (toolMissing.length) {
          missing.push('Unresolved tools (configure path or binDirs in Environment Adaptation): ' + toolMissing.slice(0, 12).join(', '))
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
            vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
            vps_host: vpsHost,
            env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          missing,
        }
        return JSON.stringify({
          ok: missing.length === 0 && toolMissing.length === 0,
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: 'Host skills service unavailable: skipped skill inspection, returning platform tool probes only.',
          next: plat.runtime.windows
            ? 'Open Environment Adaptation: 1. Fill binDirs or tool paths 2. Fill FOFA_KEY / VPS 3. Save and re-run preflight. Do not download tools autonomously.'
            : (hasSetupScript
              ? 'Ask user to run bash "$DSH_HOME/redteam/setup.sh" --check, or configure paths in Environment Adaptation.'
              : 'No setup.sh found on host (expected). Configure paths in Environment Adaptation or follow redteam-setup skill.'),
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: 'Failed to read skill directory: ' + (error && error.message ? error.message : String(error)), platform: plat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* include 时只体检点名的技能：否则 ok 被无关 broken 拖成 false，模型会误以为目标技能坏了 */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          needs_user: verdict.needs_user.map((n) => (n.startsWith('Environment variable')
            ? n + (plat.runtime.windows ? ' (configure in Environment Adaptation)' : ' (export in shell and restart dsh)')
            : n === 'VPS Address' || n === 'VPS Hostname'
              ? 'Reverse shell / payload delivery: ' + n + ' (placeholder in skill)'
              : n)),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => only.length === 0 || only.includes(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (plat.tools.items || []).filter((t) => !t.path)
      if (toolMissing.length) {
        missing.push('Unresolved local tools (configure paths in Environment Adaptation): ' + toolMissing.slice(0, 10).map((t) => t.id).join(', '))
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        missing,
      }
      let next
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next = 'Windows: Open Environment Adaptation to configure toolkit/binDirs/tools paths and FOFA/VPS, save and rerun redteam_preflight.'
      } else if (!hasMarker && !hasSetupScript) {
        next = 'First-time setup, no setup.sh script found at ' + setupScript + ' (normal). '
          + toolkitHint + ' Present onboarding.missing to user. If missing FOFA, fallback to crt.sh/passive DNS; if missing VPS, restrict to non-egress findings.'
      } else if (!hasMarker) {
        next = '**First-time run**: Ask user to execute `bash ' + setupScript + ' --check` or configure via Environment Adaptation. Do not download tools autonomously.'
      } else if (missing.length > 0) {
        next = 'Missing prerequisites: present onboarding.missing to user. Configure in Environment Adaptation or run setup script directly.'
      } else if (allBroken.length > 0) {
        next = 'Present broken needs_user items to user; describe fallbacks if unavailable.'
      } else {
        next = 'All prerequisites ready. Ready to begin engagement.'
      }

      const summary = summarizeSkills(checked)
      return JSON.stringify({
        /* include 模式：ok 只反映点名技能的体检结果；测绘 key/VPS 等 missing 与此无关，降为参考不拖 ok */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes, note: 'ok status covers requested skills only; onboarding.missing is reference context' } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: plat,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: 'Remediation steps must be executed by user (or via Environment Adaptation); do not download/install tools autonomously.' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: 'Only red team skills are checked here. Official skills in $DSH_HOME/skills are unaffected.',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '[Use before/after dispatching] Concurrency gate for execution subagents: **maximum 3 concurrent** running agents per target (configurable via REDTEAM_MAX_AGENTS). action=status to inspect active slots and running tasks; action=acquire to claim a slot before dispatch (fails if full; do not force retry); action=release to free a slot (auto-released when subagent terminates).',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status to inspect / acquire to reserve / release to free' },
      label: { type: 'string', description: 'Task label for acquire, e.g. "recon-c-segment"' },
      key: { type: 'string', description: 'Specific key to release (omitted drops oldest reservation)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: 'Session ID unavailable: cannot calculate concurrency (ensure tool call carries agent context).' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"刚占位还没出现在注册表"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? 'Slots full: wait for existing agents to report before dispatching new ones (sequential execution is safest).'
            : 'Remaining slots: ' + free + '. Dispatch sequentially by default; run parallel only when tasks are independent.',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: 'Concurrency full (max ' + cap + '): cannot dispatch new agents. Wait for running agents or release finished ones.',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        const afterUsed = Math.max(live.running, reservationList(owner).length)
        if (afterUsed > cap) {
          dropReservation(owner, key)
          return JSON.stringify(Object.assign({}, base, {
            ok: false,
            used: afterUsed - 1,
            free: Math.max(cap - (afterUsed - 1), 0),
            error: 'Concurrency limit reached (max ' + cap + '): slot was contested and rolled back. Await reports from running agents before dispatching.',
          }), null, 2)
        }
        const usedAfter = afterUsed
        return JSON.stringify(Object.assign(base, { slot: key, used: usedAfter, free: Math.max(cap - usedAfter, 0) }, {
          hint: 'Slot acquired (' + key + '). Subagent completion auto-releases slot; if dispatch fails, manually run redteam_agent_slot action=release key=' + key + ' to free it.',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, { ok: true, released: dropped, used: Math.max(used - (dropped ? 1 : 0), 0) }), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: 'Write an asset and its ports/services/fingerprints into database (idempotent upsert). Must specify provenance (passive or active) and tool name.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID; defaults to current bound target' },
      ip: { type: 'string', required: true, description: 'Asset IPv4/IPv6 address' },
      state: { type: 'string', description: 'live | dead | unknown (default: unknown)' },
      primary_name: { type: 'string', description: 'Primary domain or hostname' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: 'Discovery source: passive or active' },
      tool: { type: 'string', description: 'Data source or tool name, e.g. crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '[Optional] Discovery timestamp (ISO string). Recorded automatically on first entry if omitted.' },
      first_seen: { type: 'string', description: '[Optional] First seen timestamp reported by external source' },
      names: {
        type: 'array',
        description: 'Associated domains or certificate CNs',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn (default: domain)' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: 'Open ports with services and fingerprints',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp (default) | udp' },
            service: { type: 'string', description: 'Service name, e.g. http / mysql / ssh' },
            product: { type: 'string', description: 'Product name, e.g. nginx / apache' },
            version: { type: 'string', description: 'Version string, e.g. 1.24.0' },
            banner: { type: 'string', description: 'Raw banner snippet' },
            url: { type: 'string', description: 'Accessible Web service URL' },
            title: { type: 'string', description: 'Web page title' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'web-server | middleware | framework | cms | database | vpn' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: 'Detection basis, e.g. header / path / banner' },
                  confidence: { type: 'number', description: '0-1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 发现时间：不传则由服务端按"第一次入库的时刻"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: 'Asset discovery timestamp recorded as ' + (written && written.discovered_at ? written.discovered_at : '(unknown)')
          + '; re-collection updates last_seen without overwriting discovery time.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: 'Add a relationship edge in asset graph (for topology and lateral analysis). E.g. resolves / exposes / contains / trusts / shares_cert.',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: 'Query asset database. Supports filtering by CIDR, port, service, fingerprint, provenance, scope (internal/external), sort order, and keyword search (IP/domain/banner). Returns compact results.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      cidr: { type: 'string', description: 'CIDR segment, e.g. 192.168.1.0/24' },
      port: { type: 'number', description: 'Open port' },
      service: { type: 'string', description: 'Service or product name, e.g. nginx' },
      fingerprint: { type: 'string', description: 'Fingerprint keyword, e.g. Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: 'Filter by passive or active source' },
      q: { type: 'string', description: 'Full-text search query (space-separated for AND)' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: 'Scope: internal (private subnet) or external (Internet-facing)' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip'], description: 'Sort: priority (default) | todo | ports | ip' },
      limit: { type: 'number', description: 'Max items to return (default: 50, max: 200)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: 'Retrieve full details of a single asset: all ports, services, fingerprints, provenance timeline, and relationship edges.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', required: true, description: 'Asset ID (from redteam_asset_query)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: 'Asset mapping statistics overview: CIDRs, live assets, open ports, services, fingerprints, provenance breakdown, and segment details.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: 'Export asset graph (CIDR -> Asset -> Open Ports, including DNS resolution edges) for topology reasoning and lateral planning.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      cidr: { type: 'string', description: 'Filter subgraph by CIDR segment' },
      maxNodes: { type: 'number', description: 'Maximum nodes limit (default: 300)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Graph contains too many nodes (' + graph.nodes.length + ' > ' + maxNodes + '); specify cidr to narrow scope',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: 'Retrieve active system prompt for a red team role (view-only). When dispatching, do not copy entire text; write redteamRole: <code> on first line of subagent prompt.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: 'List red team roles and their responsibility titles (Reconnaissance / Vulnerability Scanning / Exploitation / Intranet Pivot).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: 'Record testing progress on an asset: tests executed (test, append), remaining attack surface (surface, replace), current test status, and WAF blocks. Call before testing (status=testing) and after testing/abandoning.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      asset_id: { type: 'number', description: 'Asset ID (preferred over IP)' },
      ip: { type: 'string', description: 'Asset IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: 'Status: untested / testing / tested / blocked / abandoned / no_surface' },
      test: { type: 'string', description: 'Tests conducted (appended to test log, e.g. "nmap full port + nuclei cve templates")' },
      notes: { type: 'string', description: 'Alias for test (compatibility)' },
      surface: { type: 'string', description: 'Remaining attack surface (overwrites, e.g. "SMB 445 untested; /api auth bypass untested")' },
      blocked: { type: 'boolean', description: 'Whether blocked by WAF/defense' },
      updated_by: { type: 'string', description: 'Updating role, e.g. recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== Vulnerability Assessment */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: 'Record a vulnerability finding (Vulnerability Assessment role). Idempotently updates on (asset_id, cve, target) when CVE is present. Must provide evidence (request/response, repro command, or file path).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: 'Asset ID (from redteam_asset_query)' },
      cve: { type: 'string', description: 'CVE / identifier' },
      title: { type: 'string', required: true, description: 'Vulnerability title' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: 'Affected target URL or endpoint' },
      source: { type: 'string', description: 'Discovery tool: nuclei / sqlmap / curl / manual...' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
      evidence: { type: 'string', description: 'Evidence: request/response excerpt, command, evidence file path' },
      found_by_agent: { type: 'string', description: 'Discovering role (default: vuln-scan)' },
      gained: { type: 'string', description: '[Important] Privileges/results achieved via this vuln, e.g. "Server privileges, Intranet tunnel", "Admin account", "DB access"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: 'Query vulnerability database: filter by severity, status, CVE, asset, CIDR segment, or keyword.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string', description: 'CVE identifier' },
      asset_id: { type: 'number', description: 'Asset ID' },
      cidr: { type: 'string', description: 'CIDR segment' },
      q: { type: 'string', description: 'Search keyword across title, CVE, target, evidence' },
      limit: { type: 'number', description: 'Max items (default: 50, max: 200)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: 'Update vulnerability status/severity/evidence (e.g. set confirmed after repro, exploited after exploitation, false-positive for FPs).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', required: true, description: 'Vulnerability ID' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string', description: 'Updated evidence' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
      gained: { type: 'string', description: 'Privileges or outcomes achieved via this vulnerability' },
      title: { type: 'string', description: 'Updated title' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== Exploitation & Intranet Pivot */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: 'Record a credential (Exploitation/Pivot role). Must store plaintext secret in secret_value for console reuse; secret_ref links to local evidence file.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: 'Associated host IP or domain' },
      username: { type: 'string', description: 'Account username' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string (default: password)' },
      secret_value: { type: 'string', description: '[Required] Plaintext secret value (password/hash/key/token)' },
      secret_ref: { type: 'string', description: 'Evidence reference path, e.g. runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: 'Privilege level, e.g. admin / user / db-read' },
      asset_id: { type: 'number', description: 'Asset ID' },
      source: { type: 'string', description: 'Origin: exploit / dump / config-leak...' },
      tool: { type: 'string', description: 'Tool used' },
      note: { type: 'string', description: 'Notes' },
      found_by_agent: { type: 'string', description: 'Agent role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: 'Register an evidence screenshot: copies image into target directory and associates with score point/hit (viewable in console and embedded in reports).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: 'Local image path (relative to engagement dir or absolute); mutually exclusive with data_base64' },
      data_base64: { type: 'string', description: 'Base64-encoded image data' },
      label: { type: 'string', description: 'Image caption, e.g. "DC atexec shell output: nt authority\\system"' },
      kind: { type: 'string', description: 'screenshot (default) | card (generated evidence card)' },
      point_code: { type: 'string', description: 'Associated score point code, e.g. G1-1' },
      hit_id: { type: 'number', description: 'Specific score_hit ID to associate with' },
      asset_id: { type: 'number', description: 'Asset ID' },
      target: { type: 'string', description: 'Target IP / URL associated with screenshot' },
      note: { type: 'string', description: 'Context note: what this screenshot proves' },
      source_ref: { type: 'string', description: 'Original source path or evidence file' },
      captured_at: { type: 'string', description: 'Capture timestamp (ISO); defaults to current time' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: 'List registered evidence screenshots (including score point, target, type, and stored path).',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: 'Delete an evidence screenshot (along with on-disk file).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', required: true, description: 'Screenshot ID (from redteam_shot_list)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: 'List harvested credentials (including plaintext secret_value) for reuse and lateral movement.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: 'Record an access session obtained (lateral movement starting point). E.g. method: vnc/rdp/ssh/webshell/db; privilege: admin/user/system.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      host: { type: 'string', required: true, description: 'Target host IP' },
      username: { type: 'string', description: 'Username used' },
      method: { type: 'string', required: true, description: 'Access method (vnc/rdp/ssh/webshell/db)' },
      privilege: { type: 'string', description: 'Privilege level (admin/root/user/system)' },
      asset_id: { type: 'number', description: 'Asset ID' },
      session_ref: { type: 'string', description: 'Session reference, e.g. runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string', description: 'Notes' },
      found_by_agent: { type: 'string', description: 'Agent role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: 'List obtained access sessions.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: 'Reset role system prompt to built-in default template. Omit role to reset all roles.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell & Intranet Tunnels: Session Reusability ---------- */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '[Review before/after decisions] Single-pane overview of all reusable entry points: online WebShells, available internal tunnels (listen address and reachable subnets), credentials, and access sessions.',
    parameters: { engagement: { type: 'string', description: 'Target engagement ID' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: 'When tunnel status=active, feed directly to scanners: -socks5 <listen> or --proxy socks5://<listen>; when webshell status=online, connect via client.'
          + ' Note: legit=false (entry_kind=self-only) does NOT count as boundary breach; legit=null indicates unconfirmed entry_kind, update via redteam_tunnel_update.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: 'Register an active WebShell. Encrypted behinder or godzilla shells are strongly preferred for console client integration. Duplicates on url+pass_key merge and refresh automatically.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'WebShell full URL' },
      shell_type: { type: 'string', description: 'godzilla | behinder | antsword | other' },
      pass_key: { type: 'string', description: 'Connection password / encryption key' },
      privilege: { type: 'string', description: 'Current privilege: www-data / root / system / iis' },
      secret_ref: { type: 'string', description: 'Evidence reference path, e.g. runs/ws-10.0.0.5.txt' },
      asset_id: { type: 'number', description: 'Asset ID' },
      note: { type: 'string', description: 'Notes' },
      found_by_agent: { type: 'string', description: 'Agent role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: 'List registered WebShells (including online status and last check timestamp).',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: 'Update WebShell status (deleted / offline / privilege changed) or add notes.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', required: true, description: 'WebShell ID' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string', description: 'Updated privilege level' },
      note: { type: 'string', description: 'Notes' },
      check_note: { type: 'string', description: 'Health check notes' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: 'Register an internal tunnel/proxy. Tunnels on attacker VPS without touching target side do NOT count as boundary breach (entry_kind=self-only). Specify target-side endpoint: target-outbound (reverse shell / frp client on target), target-http (suo5 / Neo-reGeorg over WebShell), or target-agent (compromised process proxy).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5 | socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: 'Local listen address host:port, e.g. 127.0.0.1:1080' },
      entry: { type: 'string', description: 'Entrypoint: WebShell URL / pivot host / command' },
      reach: { type: 'string', description: 'Reachable internal subnets, e.g. 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '[Important] Target-side endpoint: target-outbound | target-http | target-agent | self-only' },
      webshell_id: { type: 'number', description: 'Originating WebShell ID' },
      asset_id: { type: 'number', description: 'Asset ID' },
      command: { type: 'string', description: 'Command line used to establish tunnel' },
      pid: { type: 'string', description: 'Process PID' },
      note: { type: 'string', description: 'Notes' },
      found_by_agent: { type: 'string', description: 'Agent role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: 'List registered internal tunnels (including status, listen address, reachable subnets, entry_kind, and legitimacy).',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: 'Update tunnel status (closed / down / modified listen address) or declare entry_kind.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', required: true, description: 'Tunnel ID' },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string', description: 'Updated listen address' },
      reach: { type: 'string', description: 'Updated reachable subnets' },
      entry: { type: 'string', description: 'Entrypoint description' },
      entry_kind: { type: 'string', description: 'Target-side endpoint: target-outbound | target-http | target-agent | self-only' },
      note: { type: 'string', description: 'Notes' },
      check_note: { type: 'string', description: 'Check notes' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: 'Proactively probe reachability for all WebShells and tunnels via HTTP/TCP and update online/offline states in database.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      timeoutMs: { type: 'number', description: 'Single probe timeout in ms (default: 6000)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell online ${online}/${result.webshells.length}, tunnels active ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: 'Export attack graph: asset topology + vulnerability nodes + owned assets (meta.owned) for lateral movement and reporting.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      cidr: { type: 'string', description: 'Filter by CIDR segment' },
      maxNodes: { type: 'number', description: 'Max nodes limit (default: 400)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Graph contains too many nodes (' + graph.nodes.length + ' > ' + maxNodes + '); specify cidr to narrow scope',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== Domains & Web Assets */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: 'List Web assets (including accessible URLs and page titles). Review this prior to web assessment to prioritize API endpoints.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: 'Aggregate assets by domain: view associated IPs and assets per domain to map root domains, subdomains, and CIDR segments.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== Scoring Objectives */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: 'View scoring dashboard: all score points (name/category/points/achieved/evidence) and total score progress. Review before planning next operations.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* Grouped by 8 rule categories: shows progress and cap usage per category */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* Tier description (specify points parameter when recording multi-tier items) */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* Excluded hit count due to scope deduplication or reached cap (stop signal) */
          capped: p.capped,
          /* service_summary provides category summary; capped_reason provides per-hit justification */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: 'Record a scoring hit per Penetration Scoring Rules (25 score items, 8 categories, rules G1-G8). Prior to recording, check redteam_score_list for valid code and deduplication scope.\n\nEvidence must state concrete outcome: target asset + credentials/privilege/data count obtained. For multi-tier items, specify points. Self-created accounts must set self_created=true (excluded from score and report). Account scores require verified loginability.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      code: { type: 'string', description: 'Score point code (e.g. G1-1, G2-3); check redteam_score_list' },
      point_id: { type: 'number', description: 'Score point ID' },
      point_name: { type: 'string', description: 'Score point name' },
      points: { type: 'number', description: 'Override point value for multi-tier items (e.g. user=10, admin=50)' },
      target: { type: 'string', description: 'Target asset: URL / ip:port / hostname (include port for deduplication)' },
      asset_id: { type: 'number', description: 'Target asset ID in database' },
      port: { type: 'number', description: 'Port associated with hit (for service-level deduplication)' },
      vuln_id: { type: 'number', description: 'Vulnerability ID used to achieve hit' },
      step_id: { type: 'number', description: 'Associated attack chain step ID' },
      evidence: { type: 'string', required: true, description: '[Required] Concrete achievement, e.g. "Admin tomcat/pwd (verified login)", "DB root/pwd", "Exported 1.32M user records"' },
      self_created: { type: 'boolean', description: 'Whether this account/privilege was self-registered/self-created (true excludes from score and report)' },
      note: { type: 'string', description: 'Notes' },
      recorded_by: { type: 'string', description: 'Recording role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: 'Create or update custom score point (points / name / category / description / enabled). Provide ID to edit existing point, omit ID to create new.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      id: { type: 'number', description: 'Existing score point ID' },
      name: { type: 'string', required: true, description: 'Score point name' },
      code: { type: 'string', description: 'Unique code' },
      category: { type: 'string', description: 'Category: access | boundary | custom' },
      points: { type: 'number', description: 'Point value' },
      description: { type: 'string', description: 'Criteria description' },
      enabled: { type: 'boolean', description: 'Enable or disable' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: 'Assess asset exploitability: expected outcomes (account access / RCE / server privilege / db privilege / sensitive data / boundary breach), priority, and justification.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      asset_id: { type: 'number', description: 'Asset ID' },
      ip: { type: 'string', description: 'Asset IP' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high | medium | low' },
      potential: { type: 'string', description: 'Expected outcomes, e.g. "RCE, server privilege", "Database access"' },
      reason: { type: 'string', description: 'Assessment justification (Nday match, broken auth, weak password, etc.)' },
      assessed_by: { type: 'string', description: 'Assessing role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== Evidence, Attack Chain & Reports */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: 'Save raw HTTP evidence (request & response). Formatted as pasteable raw packets for Burp Suite / Yakit.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      vuln_id: { type: 'number', description: 'Associated vulnerability ID' },
      asset_id: { type: 'number', description: 'Asset ID' },
      label: { type: 'string', description: 'Evidence label, e.g. "BOLA unauthorized user list"' },
      method: { type: 'string', description: 'HTTP method: GET/POST/...' },
      url: { type: 'string', description: 'Target URL' },
      status: { type: 'number', description: 'HTTP response status code' },
      request: { type: 'string', required: true, description: 'Raw HTTP request packet (pasteable in Burp)' },
      response: { type: 'string', description: 'Raw HTTP response packet or key excerpt' },
      note: { type: 'string', description: 'Notes' },
      captured_by: { type: 'string', description: 'Capturing role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: 'Record an attack chain step. Details "how this step was achieved" in reproduction reports: record tool (exact command line), detail (rationale and clues), and result (actual output/echo).',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: 'Action type (legacy compatibility); use stage_code for operational phase' },
      title: { type: 'string', required: true, description: 'Brief step title, e.g. "Upload WebShell via template upload", "Establish socks5 via suo5"' },
      detail: { type: 'string', description: 'Rationale and leads, e.g. "Login version leak Coremail XT 5.0 -> CVE-2023-xxxx -> Template upload"' },
      tool: { type: 'string', description: '[Key for reproduction] Exact executed command, e.g. `nuclei -t CVE-xxxx.yaml -u http://x`, `suo5 -t http://x/s.jsp -l 1080`' },
      result: { type: 'string', description: '[Key for reproduction] Actual output/echo snippet, e.g. `uid=0(root) gid=0(root)`, "200 OK with 12k records"' },
      asset_id: { type: 'number', description: 'Asset ID' },
      vuln_id: { type: 'number', description: 'Vulnerability ID' },
      access_id: { type: 'number', description: 'Access session ID' },
      evidence_ref: { type: 'string', description: 'Evidence file reference, e.g. runs/session-vnc.md' },
      recorded_by: { type: 'string', description: 'Recording role' },
      point_code: { type: 'string', description: 'Score point code achieved in this step (auto-records score hit if evidence provided)' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: 'Operational stage: recon | internet | boundary | internal | target' },
      evidence: { type: 'string', description: 'Used with point_code: concrete achievement (target asset + credential/privilege/data count)' },
      self_created: { type: 'boolean', description: 'Used with point_code: whether account is self-created (excluded from score)' },
      target: { type: 'string', description: 'Used with point_code: target asset' },
      seq: { type: 'number', description: 'Sequence number (appended to end if omitted)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* Reminders for missing tool command or reproduction result */
      const hints = []
      if (!args.tool) hints.push('Step missing `tool` (command line): reproduction report will lack execution details; consider appending command.')
      if (!args.result) hints.push('Step missing `result` (echo output): reproduction report will lack execution verification evidence.')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: 'Retrieve complete attack chain (in sequential order) to debrief and verify chain closure (ingress -> privilege -> pivot).',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: 'Save an effective attack artifact (script / PoC / exploit / wordlist) into target folder for reuse and deliverables. Path: attack-files/<target>/<filename>. Evidence must demonstrate working outcome.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      target: { type: 'string', required: true, description: 'Target: IP, URL, or CIDR' },
      name: { type: 'string', required: true, description: 'Filename, e.g. cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: 'poc | exp | script | wordlist | other' },
      description: { type: 'string', description: 'Purpose description' },
      evidence: { type: 'string', required: true, description: 'Validation evidence: actual output/echo or vuln/evidence ID' },
      content: { type: 'string', description: 'File content (mutually exclusive with path)' },
      path: { type: 'string', description: 'Existing file path to copy into target folder' },
      asset_id: { type: 'number', description: 'Asset ID' },
      vuln_id: { type: 'number', description: 'Vulnerability ID' },
      created_by: { type: 'string', description: 'Authoring role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: 'List saved attack files (grouped by target folder). Review prior to engaging a target to avoid duplicating scripts.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      target: { type: 'string', description: 'Filter by specific target' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '[Deprecated: use redteam_score_report] View target-oriented findings reports (per IP/URL/CIDR): verified vulnerabilities, access, credentials, artifacts, attack chain.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: 'Filter report for a specific target only' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: 'Attack chain: five stages linked across attack surfaces — 1. Reconnaissance (External) -> 2. External Exploitation -> 3. Boundary Breach (Tunnel) -> 4. Intranet Pivot -> 5. Critical Target Control. Returns goals, scores, and active tunnels per stage.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* Excluded hit count due to service-level cap (highest entry per service) */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + ': ' + (x.items || []).join(', ')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? ' (internal)' : ' (external)') + ' contributed ' + a.points + ' pts'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] reach: ' + (t.reach || '—')),
        })),
        hint: 'Scoring stages are automatically derived; use stage_code (recon/internet/boundary/internal/target) when recording attack chain steps. Account and DB scores cap per service.',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: 'Attack reproduction score report: compiles verified scoring achievements with pasteable raw HTTP requests for Yakit/Burp. Use this for drill deliverables.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      limit: { type: 'number', description: 'Max items (default: 500)' },
      markdown: { type: 'boolean', description: 'true to return full Markdown report (default); false for summary' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '[Deprecated: use redteam_score_report] Generate Markdown findings report: includes verified/exploited medium+ vulnerabilities, attack chain, credentials, and remediation advice.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* ── Knowledge Base (PoC/Exploit): Globally Shared Across Engagements ── */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '[Step 1 before exploiting N-day/1-day] Search existing weapons across two layers: 1. Knowledge Base (generic PoCs/exploits shared across engagements, sorted by verified status and reuse count); 2. Local Nuclei Template Library. Fetch details via redteam_poc_get or run nuclei directly. Avoid writing redundant custom scripts.',
    parameters: {
      q: { type: 'string', description: 'Search query across component, CVE, vulnerability name, path' },
      cve: { type: 'string', description: 'CVE ID, e.g. CVE-2023-21839' },
      component: { type: 'string', description: 'Component or vendor name, e.g. Weblogic, Shiro, Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: 'Category: rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: 'Filter by source engagement ID or name' },
      asset_target: { type: 'string', description: 'Filter by asset target IP/domain/URL' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web | self | manual | nuclei-template' },
      verified: { type: 'boolean', description: 'true to only return verified entries' },
      templateLimit: { type: 'number', description: 'Max nuclei template results (default: 20)' },
      limit: { type: 'number', description: 'Max knowledge base results (default: 200)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原来这一小段里 templateStats() 被连着算了三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 归类概览：让智能体知道"哪类武器已经攒了多少"，缺哪类心里有数 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + ' (verified ' + c.verified + ')'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: hit
          ? 'Matched existing weapon: fetch knowledge base item via redteam_poc_get; run nuclei template via `nuclei -t <path>`. Record reuse with redteam_poc_use.'
          : 'No match in knowledge base or local templates: search web or craft script, verify on live target, and backfill into knowledge base via redteam_poc_add.',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: 'Retrieve full content of a knowledge base PoC/exploit (code + usage + verification log + disk path). Accepts id or unique code.',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry ID' },
      code: { type: 'string', description: 'Stable entry code (from redteam_poc_search)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: 'Entry not found in knowledge base (search via redteam_poc_search first)' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: 'Store a generic, reusable PoC/exploit into knowledge base (shared across drill engagements). Only persist genuinely effective, verified weapons. Specify category, source engagement, asset target, and verification notes.',
    parameters: {
      title: { type: 'string', required: true, description: 'Title: component + vulnerability/CVE, e.g. "Weblogic T3 Deserialization CVE-2023-21839"' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: 'Category: rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      cve: { type: 'string', description: 'CVE identifier' },
      component: { type: 'string', description: 'Component or vendor name' },
      versions: { type: 'string', description: 'Affected versions' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web | self | manual | nuclei-template' },
      source_url: { type: 'string', description: 'Source URL or reference link' },
      description: { type: 'string', description: 'Vulnerability summary and requirements' },
      usage: { type: 'string', description: 'Usage: complete CLI invocation example' },
      content: { type: 'string', description: 'Full source code or template text' },
      path: { type: 'string', description: 'Local file path to import' },
      filename: { type: 'string', description: 'Filename when written to disk' },
      verified: { type: 'boolean', description: 'true only if verified on live target' },
      verified_note: { type: 'string', description: 'Verification notes and echo output' },
      engagement: { type: 'string', description: 'Origin engagement ID or name' },
      asset_target: { type: 'string', description: 'Specific target where verified' },
      found_by_agent: { type: 'string', description: 'Discovering role' },
      tags: { type: 'string', description: 'Comma-separated tags' },
      created_by: { type: 'string', description: 'Authoring role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      /* engagement 这个参数名在本工具里表示"来源靶标"，不是"作用在哪个靶标"，
         所以不能走 resolveEngagement；只做名称补全，把 id 与中文名都记下来便于面板归类。 */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: 'Saved to knowledge base (category: ' + (r.poc.category || 'other') + ', created: ' + r.poc.created_at + '); '
          + 'discoverable via redteam_poc_search; total entries: ' + stats.total + '.', 
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: 'List knowledge base PoCs/exploits (filterable by kind/source/component/verified).',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: 'Update knowledge base entry: record verification findings (verified + verified_note), update versions, usage, content, or tags.',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry ID' },
      code: { type: 'string', description: 'Entry code' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: 'Shortcut: verified boolean' },
      verified_note: { type: 'string', description: 'Shortcut: verification note' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: 'Record reuse of a knowledge base weapon against a target. High-reuse items rank higher in recommendations.',
    parameters: {
      id: { type: 'number', description: 'Entry ID' },
      code: { type: 'string', description: 'Entry code' },
      used_on: { type: 'string', description: 'Target where used: engagement name / target IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== Asset Discovery Timeline */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: 'Asset discovery timeline: daily aggregates of discovered assets (internal vs external) and recent discoveries.',
    parameters: {
      engagement: { type: 'string', description: 'Target engagement ID' },
      limit: { type: 'number', description: 'Recent asset limit (default: 50)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: 'Discovery time = moment this asset first entered the database; re-collection only refreshes last_seen.',
      }, null, 2)
    },
  })))

  function ledgerOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('redteam store unavailable')
    return new EvidenceLedger(store.db(engagementId))
  }
  function unknownsOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('redteam store unavailable')
    return new UnknownRegistry(store.db(engagementId))
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_record',
    description: 'Record an engagement evidence item. Core discipline: confidence must be accurately reported — claimed (subagent oral report, unverified) / observed (personally verified) / derived (deduced from observed) / inferred (speculative, must be explicitly noted). ev_id is generated from content hash for tamper-evident verification.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true, description: 'Operation name, e.g. "nmap_scan", "webshell_established", "sql_injection_confirmed"' },
      parameters: { type: 'object', additionalProperties: true, description: 'Call parameters (JSON object, included in hash)' },
      result: { type: 'object', additionalProperties: true, required: true, description: 'Normalized result (JSON object, included in hash)' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred (default: observed)' },
      authority: { type: 'string', description: 'tool-output | database-record | screenshot | request-replay | subagent-report | operator-input (default: tool-output)' },
      limitations: { type: 'array', items: { type: 'string' }, description: 'Limitation notes, e.g. ["Only scanned Top 1000 ports"]' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: 'Supporting evidence IDs' },
      source_agent: { type: 'string', description: 'Originating subagent role (required when confidence=claimed)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).record({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence,
        authority: args.authority,
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        source_agent: args.source_agent,
        recorded_by: agentOf(args),
        engagement_id: id,
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_verify',
    description: 'Verify subagent report against the evidence ledger (hash-level verification). matched=false indicates discrepancies, exaggeration, or unrecorded state.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, required: true },
      confidence: { type: 'string' },
      authority: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).verify({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence ?? 'observed',
        authority: args.authority ?? 'tool-output',
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_upgrade',
    description: 'Upgrade claimed / inferred evidence to observed. Requires verified_result (personally verified output/data).',
    parameters: {
      engagement: { type: 'string' },
      claimed_ev_id: { type: 'string', required: true, description: 'Evidence ID to upgrade' },
      verified_result: { type: 'object', additionalProperties: true, description: 'Verified actual output/data' },
      verified_by: { type: 'string', description: 'Verifier identity, default: coordinator' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).upgrade({
        claimed_ev_id: args.claimed_ev_id,
        verified_result: args.verified_result,
        verified_by: args.verified_by ?? agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_list',
    description: 'List evidence ledger items, filterable by operation or confidence. Review un-upgraded claimed items before reporting.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = ledgerOf(id).list({
        operation: args.operation,
        confidence: args.confidence,
        engagement_id: id,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unverified_count',
    description: 'Count claimed/inferred records pending closed-loop verification. When returning >0, operational summaries must highlight unverified count.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const count = ledgerOf(id).countUnresolvedClaims(id)
      return JSON.stringify({
        ok: true, engagement: id, unverified_count: count,
        hint: count > 0 ? `${count} claimed/inferred records pending closed-loop verification; do not report as confirmed access` : 'All subagent reports verified and closed-loop',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_record',
    description: 'Record an unresolved operational question. Deduplicated by question + domain.',
    parameters: {
      engagement: { type: 'string' },
      question: { type: 'string', required: true, description: 'Unresolved operational question' },
      severity: { type: 'string', description: 'low | medium | high | critical (default: medium)' },
      domain: { type: 'string', description: 'Domain, e.g. internal-recon / boundary-break / lateral-movement' },
      recommended_probe: { type: 'string', description: 'Recommended verification probe or command' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: 'Supporting evidence IDs' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).record({
        question: args.question,
        severity: args.severity ?? 'medium',
        domain: args.domain ?? 'general',
        recommended_probe: args.recommended_probe,
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        engagement_id: id,
        recorded_by: agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_resolve',
    description: 'Mark an unresolved question as resolved / contradicted / withdrawn.',
    parameters: {
      engagement: { type: 'string' },
      unk_id: { type: 'string', required: true, description: 'Unknown question ID' },
      disposition: { type: 'string', required: true, description: 'resolved | contradicted | withdrawn' },
      resolution: { type: 'string', description: 'Resolution explanation' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).resolve(args.unk_id, args.disposition, args.resolution, agentOf(args))
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_list',
    description: 'List unresolved operational questions; review open questions before delegating tasks.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'open | investigating | blocked | contradicted | resolved' },
      severity: { type: 'string', description: 'Severity filter' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = unknownsOf(id).list({
        status: args.status ?? 'open',
        severity: args.severity,
        engagement_id: id,
        limit: args.limit ?? 50,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))
}
