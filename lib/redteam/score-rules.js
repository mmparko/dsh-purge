/**
 * 计分规则：判定口径 + 默认得分点（零依赖，只用 node: 内置模块）。
 *
 * 从 core.js 抽出来的模块，也是本项目**最该单独读的一份代码**：
 * 面板 / 报告 / 攻击链三处总分必须一致，靠的就是这里的 applyScoreCaps 与
 * evaluateScoreBoard 是**唯一实现** —— 三处各写一遍必然漂移成不同口径。
 *
 * 分工：
 *   · applyScoreCaps       —— 给定命中行，标出哪条计分、哪条被封顶/超上限；
 *   · evaluateScoreBoard   —— 把"读元数据 + 调 applyScoreCaps + 回填标记"包成一个入口；
 *   · DEFAULT_SCORE_POINTS —— 规则文档展开后的得分点定义（src/rule/cap/dedup_scope）。
 */

/* targetHasIpv6Host 要判定 IPv6 字面量：复用 ip-utils 的同一份实现，避免两套正则漂移 */
import { isIpv6 } from './ip-utils.js'

/* ------------------------------------------------------------------ 判定规则 */

/* ------------------------------------------------------------------ 判定规则 */

/**
 * 什么算"真隧道"（算边界突破/内网突破的凭证）：**必须跨越了靶标边界**，
 * 即通道的一端在目标侧。三种情况：
 *   · target-outbound：目标主动连出到我的服务器（反弹 shell 落地、目标上跑 frp/Stowaway 客户端）
 *   · target-http：经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg、自研 HTTP 隧道）
 *   · target-agent：经目标上已控进程/会话转发的隧道（SSH -R 由目标发起等）
 * 不算的：self-only —— 只在自己 VPS / 自建服务器上开的代理或服务端，没碰到目标。
 */
const TUNNEL_ENTRY_KINDS = {
  'target-outbound': 'Target outbound connection (reverse shell / frp client on target)',
  'target-http': 'Via target WebShell / HTTP tunnel (suo5 / Neo-ReGeorg)',
  'target-agent': 'Via target controlled process/agent (SSH -R etc.)',
  'self-only': 'VPS / Self-hosted server only (not a boundary breach)',
}
export { TUNNEL_ENTRY_KINDS }

/** 这条隧道算不算"跨越了靶标边界"。未声明（老数据/没填）返回 null，界面按"待确认"显示。 */
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * 账号/权限类得分点：**自己注册、自己创建的账号不算拿到权限**（演练得分针对"拿到别人已有的"）。
 * 这些得分点命中时会要求声明 self_created，避免把自助注册当成战果。
 */
const ACCOUNT_POINT_CODES = ['web-account-user', 'web-account-admin', 'server-shell', 'db-access', 'internal-pivot', 'core-system']
export { ACCOUNT_POINT_CODES }

/**
 * 按「服务」封顶的得分点：**同一个资产的同一个端口只算一次分**。
 *
 *   · 账号类（web-account-user / web-account-admin）——拿到最高权限账号即该服务拿满：
 *     普通账号 10 分、管理员 20 分，同一服务上再刷几个账号都不再累加
 *     （两种账号算**同一类**：先拿普通账号、后拿管理员，只有管理员那条计分，总分按最高那条算）。
 *   · 数据库类（db-access）——同口径：一个库权限拿满，同服务再刷第二个库账号不重复计分。
 *
 * 其它得分点（webshell/rce/sensitive-data/boundary/…）仍然不设上限，按命中次数累加。
 */
const SERVICE_CAPPED_POINT_CODES = ['web-account-user', 'web-account-admin', 'db-access']
export { SERVICE_CAPPED_POINT_CODES }

/**
 * 从 target 里解析端口：`http://h:8080/x`、`10.0.0.5:6379`、`10.0.0.5:22`。
 * 没有端口或解析不出返回 null（**不要编造 80/443**，否则会把不同服务并成一个）。
 */
export function parseTargetPort(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** 库列的 port 值（老库可能是 null/0/空串）。 */
function normalizePort(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 从 target 里取「服务标识」：host[:port]。
 *   · 端口取显式写的那个；没写就按协议推默认端口（http→80、https→443、其它→不推断），
 *     这样 `http://h/x` 与 `http://h:80/y` 会归到同一个服务；
 *   · 路径/参数/查询串一律丢掉（`http://h:8080/a/b?c=1` → `h:8080`）。
 * 解析不出 host 时返回 null。
 */
function targetAuthority(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  /* 没写端口时按协议补默认端口：避免同一个服务的两种写法被算成两个服务而被重复计分 */
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * 「服务」键：得分封顶的粒度 = 同一个资产的同一个端口。
 *   · target 能解析出 host[:port] → 就用它（`t10.20.30.40:3306`）——
 *     同一个服务可能由不同的人记分，有的带 asset_id、有的只写 target，
 *     以目标为准才能把它们归到一起；
 *   · target 解析不出（缺失/只写了名字）→ 退到资产：有端口用 `a<id>:<port>`，
 *     没端口记 `a<id>:0`（该资产的未知端口）；
 *   · 两样都没有 → null（拿不到服务信息，这条不参与封顶）。
 */
export function scoreServiceKey(hit = {}) {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  if (assetId === null) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/** 「服务」的可读标签，给告警/报告用（如 `10.1.2.3:8080`）。 */
export function serviceLabel(hit = {}, assetIp) {
  const ip = assetIp || hit.asset_ip || ''
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target)
  if (ip !== '') return port === null ? ip : ip + ':' + port
  /* 没有资产 id 时用 target 的 host[:port]（去掉路径与参数，别把整条 URL 当服务名）；
     端口来自库列而 target 里没写时补上，便于一眼看出是哪个服务。 */
  const authority = targetAuthority(hit.target)
  if (authority === null) return hit.target ? String(hit.target) : '(Unlabeled service)'
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ':' + port
  return authority
}

/**
 * 得分封顶与去重的**唯一实现**（数据驱动，v0.11.0 起）。
 *
 * 判定字段来自得分点本身（`score_point.rule / cap / dedup_scope`），不再靠代码里的硬编码名单：
 *   · `dedup_scope = service` —— 同一（资产, 端口）只算分值最高的一条；
 *   · `dedup_scope = system`  —— 同一（资产, 端口, 系统名）只算最高权限一条，
 *     用于"同一个系统只计算一次最高权限分"（邮箱/OA/集权系统等）；
 *   · `dedup_scope = target`  —— 整个目标只算一次（突破网络边界、IPv6 加成）；
 *   · `dedup_scope = none`    —— 不去重，按台/卡/节点数累加（算力卡等）。
 * 之后按 `rule` 分组累计，超过该规则 `cap` 的部分标 `capped`（cap = 0 表示不设上限）。
 *
 * `self_created = 1`（自己注册/自建的账号）本来就不计分，既不参与竞争也不占位。
 *
 * @param {Array} rows - 命中行（需带 code / points / asset_id / port / target / recorded_at；
 *                       可选 system_key 供 system 口径使用）
 * @param {Map|Object|null} pointsByCode - code → `{rule, cap, dedup_scope, points}`；
 *                       省略时退化为"每个 code 自成一组、只去重不封顶"（兼容旧调用）
 * @returns {{capped:number, items:Array, caps:Map}} 打过标记的行 + 被封顶条数 + 各规则上限用量
 */
export function applyScoreCaps(rows = [], pointsByCode = null, nameByAsset = null) {
  const metaOf = (r) => {
    const m = pointsByCode === null || pointsByCode === undefined
      ? undefined
      : (typeof pointsByCode.get === 'function' ? pointsByCode.get(r.code) : pointsByCode[r.code])
    const rule = m && m.rule !== null && m.rule !== undefined ? Number(m.rule) : null
    const legacyScope = legacyCapGroup(r.code)
    return {
      group: rule === null ? 'code:' + String(r.code || '') : 'rule:' + rule,
      cap: m && Number(m.cap) > 0 ? Number(m.cap) : 0,
      scope: (m && m.dedup_scope) || legacyScope || 'none',
      rule,
    }
  }
  const flagged = (rows || []).map((r) => {
    const m = metaOf(r)
    return {
      ...r, capped: false, capped_by_id: null, capped_reason_kind: null,
      service_key: null, cap_group: m.group, dedup_scope: m.scope, rule: m.rule, rule_cap: m.cap,
    }
  })

  /* ① 计分口径去重：同一口径键内只保留分值最高的一条（同分取更早记的） */
  const buckets = new Map()
  for (const r of flagged) {
    if (Number(r.self_created) === 1) continue
    const scope = r.dedup_scope
    if (scope === 'none' || scope === null || scope === undefined) continue
    let key
    if (scope === 'target') key = 'target'
    else if (scope === 'system') key = 'sys:' + String(systemKeyOf(r, nameByAsset) || '')
    else {
      /* `service` 口径必须有真正的服务键（`t<host[:port]>` / `a<id>:<port>`）。
         拿不到服务信息时**不参与去重**，而不是退回"每条自成一键" —— 后者会让
         `svc:#hit7` 这种键把同一口径的命中全部互相顶掉：实测 62 条无 target 的
         terminal-access 命中里 61 条被判 dedup 不计分、只留 1 条，等于静默吃掉成果。
         宁可少封顶也不能错封：认不出服务就各算各的。 */
      const svc = scoreServiceKey(r)
      if (svc === null || svc === undefined || String(svc) === '') continue
      key = 'svc:' + String(svc)
    }
    if (key === '' || key === 'svc:null' || key === 'sys:null') continue
    const k = r.cap_group + '|' + key
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }
  let capped = 0
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const best = pickBestHit(list)
    for (const r of list) {
      if (r === best) continue
      r.capped = true
      r.capped_by_id = best.id
      r.capped_by_points = Number(best.points) || 0
      r.capped_by_evidence = best.evidence || null
      r.capped_reason_kind = 'dedup'
      capped += 1
    }
  }

  /* ② 规则上限：同一 rule 的计分命中累计不得超过 cap（按分值从高到低累计，超出的标 capped） */
  const caps = new Map()
  const byRule = new Map()
  for (const r of flagged) {
    if (r.capped === true || Number(r.self_created) === 1) continue
    if (r.rule_cap <= 0) continue
    if (!byRule.has(r.cap_group)) byRule.set(r.cap_group, [])
    byRule.get(r.cap_group).push(r)
  }
  for (const [group, list] of byRule.entries()) {
    const cap = list[0].rule_cap
    const ordered = [...list].sort((a, b) => {
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pb !== pa) return pb - pa
      return Number(a.id) - Number(b.id)
    })
    let used = 0; let nCapped = 0
    for (const r of ordered) {
      const pts = Number(r.points) || 0
      if (used + pts > cap) {
        r.capped = true
        r.capped_reason_kind = 'cap'
        r.capped_by_points = null
        nCapped += 1
        capped += 1
      } else {
        used += pts
      }
    }
    caps.set(group, { rule: list[0].rule, cap, used, capped: nCapped })
  }
  return { capped, items: flagged, caps }
}

/**
 * 参与 `system` 口径去重的"系统键"。
 *
 * 规则原文是"同一个系统只计算一次最高权限分"（邮箱、OA、集权系统等）。
 * 判定顺序：
 *   ① 命中自带的 `system_key`（调用方显式指定，最准）；
 *   ② 资产的 `primary_name`（系统名/域名的首选名）；资产名往往是同一套系统，最接近"同一个系统"；
 *   ③ 退回服务键（资产:端口）。
 * 三条都拿不到返回 null —— 此时**不参与该口径去重**，宁可不封顶也不要错封。
 */
function systemKeyOf(hit = {}, nameByAsset = null) {
  const svc = scoreServiceKey(hit)
  const svcText = svc === null || svc === undefined ? '' : String(svc)

  /* ① 调用方显式给的 system_key：**只有它带上服务键前缀（t<host[:port]> / a<id>:<port>）才采信**。
     调用方（listScorePoints / scoreReport / scoreChain）会预造 `资产名|端口` 这种键，
     资产还没有名字时会退化成 `"|8080"` —— 若直接采信，10.7.7.7:8080 与 10.7.7.8:8080
     会被并成"同一个系统"，把另一台主机的成果白白封顶。
     不能采信时**继续往下走**，用服务键兜底，而不是丢掉整个 system 口径。 */
  const explicit = String(hit.system_key || '').trim()
  if (explicit !== '' && (svcText === '' || explicit.includes(svcText))) {
    /* 没有服务键可校验时，要求"名字段非空"（避免只认端口的野键把所有服务并在一起） */
    const head = explicit.split('|')[0]
    if (svcText !== '' || String(head).trim() !== '') return explicit
  }

  /* ② 资产名（系统名/域名首选名）+ 服务键 —— **这是 system 口径的主力路径**。
     规则原文是"同一个系统只计算一次最高权限分"，覆盖面是"同一系统 + 同一端口"：
     同一套系统跑在多台主机、多个端口时是不同实例，各自算一次最高权限。
     ⚠️ 真的需要"跨主机、跨端口只算一次"时，应显式给 system_key 并用同一个值
     （见上 ①）——但那时请自己确认这些命中确实是同一个系统实例。 */
  const id = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  const nameOf = (assetId) => {
    if (assetId === null || nameByAsset === null || nameByAsset === undefined) return null
    const raw = typeof nameByAsset.get === 'function' ? nameByAsset.get(assetId) : nameByAsset[assetId]
    const text = raw === null || raw === undefined ? '' : String(raw).trim()
    return text === '' ? null : text
  }
  const name = nameOf(id)
  if (name !== null) return name + '|' + svcText

  /* ③ 退到服务键：同（资产, 端口）只算一次最高权限 —— 与 service 口径等效，
     这是"同一主机上的系统权限、应用权限、数据库权限按最高权限只得一次分"（G1）的兜底。 */
  if (svcText !== '') return svcText

  /* ④ 三条都拿不到（没有 asset_id、没有系统名、target 也解析不出 host）：
     退回**本条命中自己的 id** —— 即"互不相同"，各算各的。
     宁可少封顶也不能错封：把两条无从区分的命中判成"同一个系统"会白白吃掉用户的成果。
     ⚠️ 这里**不能**用 Math.random()：同一个 hit 在两次调用（面板 / 报告 / 攻击链）里
     会拿到不同的键，计分口径就不稳定了。 */
  return '#hit' + String(hit.id ?? '0')
}

/** 从一组同口径命中里挑"计分的那一条"：分值最高，同分取更早记的（id 小的）。 */
function pickBestHit(list) {
  return list.reduce((a, b) => {
    const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
    if (pb !== pa) return pb > pa ? b : a
    return Number(b.id) < Number(a.id) ? b : a
  }, list[0])
}

/** 旧口径分组（兼容 v0.10 及以前：账号类与数据库类按"同资产同端口"封顶）。 */
function legacyCapGroup(code) {
  const c = String(code || '').trim()
  if (c === 'web-account-user' || c === 'web-account-admin') return 'service'
  return SERVICE_CAPPED_POINT_CODES.includes(c) ? 'service' : null
}


/**
 * 读取得分点元数据（code → `{ rule, cap, dedup_scope, points, enabled, builtin, src }`）。
 * 面板 / 报告 / 攻击链三处共用，避免"同一份规则三处各读一遍、字段各漏一个"。
 * @param db - 靶标库句柄。
 */
function loadScoreMeta(db) {
  return new Map(db.prepare('SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point')
    .all()
    .map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
}

/**
 * 资产 id → 系统名（primary_name），`system` 口径要用它把"同一套系统"归到一起。
 * @param db - 靶标库句柄。
 */
function loadAssetNames(db) {
  return new Map(db.prepare('SELECT id, primary_name FROM asset').all()
    .filter((a) => a.primary_name).map((a) => [Number(a.id), a.primary_name]))
}

/**
 * 本条命中的**实际分值** = 档位分值 × 倍率。
 *   · 档位分值：命中自带优先（合并版同一条含多档），缺省回落到得分点默认分值；
 *   · 倍率：G5 数据规模翻倍（超 1 亿条 / 10TB，或控制知识库相关系统）×2、
 *     G6 IPv6 成果 ×3。倍率作用在**权限分**上，所以乘在分值里、随上限一起被 cap 约束
 *     （文档要求"上限仍按对应系统类型的原上限计算，不因倍数突破上限"）。
 */
function hitPointsOf(hit = {}, metaByCode = null) {
  let base = 0
  if (hit.points !== null && hit.points !== undefined && hit.points !== '') {
    base = Number(hit.points) || 0
  } else {
    const code = hit.code === null || hit.code === undefined ? null : String(hit.code)
    if (code !== null && metaByCode !== null && metaByCode !== undefined) {
      const meta = typeof metaByCode.get === 'function' ? metaByCode.get(code) : metaByCode[code]
      if (meta !== undefined && meta !== null) base = Number(meta.points) || 0
    }
  }
  const mult = Number(hit.multiplier)
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1))
}

/**
 * 这个 target 的主机部分是 IPv6 字面量吗（http://[2001:db8::1]:8080/x、2001:db8::1、[::1]:22）。
 *
 * 不能用一条粗糙的字符类正则代替：IPv6 里混着十六进制字母（a-f），
 * 写成 /^\[[0-9a-f:]+\]/ 这类"只看冒号和十六进制"的写法会把带字母的地址漏判
 * （实测 2001:db8::1 里的 db8 就被漏掉，G6 的 ×3 完全不生效）。
 * 所以把主机部分交给 isIpv6() 判定 —— 与 cidrOf / scopeOfIp 用同一份实现。
 */
function targetHasIpv6Host(target) {
  const text = String(target || "").trim()
  if (text === "") return false
  const bracket = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\])/i.exec(text)
  if (bracket !== null) return isIpv6(bracket[1].replace(/^\[|\]$/g, ""))
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(text)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(text) || [])[1]
  if (!authority) return false
  /* 裸写 IPv6 想带端口必须加方括号，所以这里去掉方括号后再尝试剥端口 */
  const host = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "")
  return isIpv6(host)
}

/**
 * 把 G5 / G6 的倍率规则算成倍率值（只对权限分生效，且不突破原上限 —— 由 cap 兜住）。
 *   · `ip_version === 6` 或 target 是 IPv6 字面量 → ×3（G6）；
 *   · `data_scale === "large"` → ×2（G5：超 1 亿条 或 10TB）；
 *   · `data_scale === "knowledge-base"` → ×2（G5：控制知识库相关系统）；
 *   · 两者都命中 → 相乘。文档没写禁止叠加，取对演练方有利的解释并**如实标注原因**。
 * @param hit - 命中参数（ip_version / data_scale / target）。
 * @returns `{ multiplier, reasons }`
 */
function scoreMultiplierOf(hit = {}) {
  const reasons = []
  let multiplier = 1
  const target = String(hit.target || "")
  const ipv6 = Number(hit.ip_version) === 6 || targetHasIpv6Host(target)
    /* 裸写 IPv6 兜底的正则必须含 ≥2 个冒号：dc01:389 / ad01:8080 这类内网主机名:端口
       只有一个冒号，旧正则会把它们误判成 IPv6 让成果静默 ×3 */
    || /(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i.test(target)
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 achievement ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 Data scale > 100M records / 10TB ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 Control LLM / Knowledge base systems ×2") }
  return { multiplier, reasons }
}

/**
 * **统一的计分评估**：面板 / 报告 / 攻击链都调这一个函数算出"哪条计分、哪条被封顶"。
 *
 * 输入为一组"命中行"，输出它们的计分标记。调用方只需保证每行带
 * `{ id, code, points, asset_id, port, target, self_created }` 与**本条命中的实际分值**
 * （`points` 字段；不要传得分点默认值 —— 合并版里同一条含多档，传默认值会把哪条计分判反）。
 *
 * @param db - 靶标库句柄。
 * @param rows - 命中行数组。
 * @param options - `{ meta?, names?, enabledOnly? }`：可复用已读好的元数据；`enabledOnly` 为 true
 *                  时"停用得分点"的命中直接标为不计分（报告与面板口径必须一致）。
 * @returns `{ byId, items, caps, meta, names, disabledIds }`
 */
function evaluateScoreBoard(db, rows = [], options = {}) {
  const meta = options.meta || loadScoreMeta(db)
  const names = options.names || loadAssetNames(db)
  const prepared = (rows || []).map((h) => {
    const code = h.code === null || h.code === undefined ? null : String(h.code)
    const m = code === null ? undefined : meta.get(code)
    const nm = h.asset_id === null || h.asset_id === undefined ? null : names.get(Number(h.asset_id))
    return Object.assign({}, h, {
      code,
      /* points 必须是"本条命中的实际分值"（见上方说明） */
      points: hitPointsOf(h, meta),
      rule: m === undefined || m.rule === undefined ? null : m.rule,
      cap: m === undefined ? 0 : m.cap,
      dedup_scope: m === undefined ? 'service' : m.dedup_scope,
      cap_group: m === undefined || m.rule === null || m.rule === undefined ? 'code:' + String(code) : 'rule:' + m.rule,
      rule_cap: m === undefined ? 0 : m.cap,
      system_key: [nm || '', normalizePort(h.port) ?? parseTargetPort(h.target) ?? ''].join('|'),
    })
  })
  const evaluated = applyScoreCaps(prepared, meta, names)
  const byId = new Map(evaluated.items.map((x) => [x.id, x]))
  const disabledIds = new Set()
  if (options.enabledOnly === true) {
    for (const h of prepared) {
      const m = h.code === null ? undefined : meta.get(h.code)
      if (m !== undefined && Number(m.enabled) !== 1) disabledIds.add(h.id)
    }
  }
  return { byId, items: evaluated.items, caps: evaluated.caps, meta, names, disabledIds }
}

/**
 * 这条命中为什么不计分（告警 / 界面 / 报告共用一句话，避免三处口径写歪）。
 * @param hit - 命中行（带 code / target / port / rule / rule_cap / capped_reason_kind）
 * @param bestPoints - 去重时被哪条压住（该条的分值）
 */
export function scoreCapReasonText(hit = {}, bestPoints) {
  const label = serviceLabel(hit)
  if (hit.capped_reason_kind === 'cap') {
    return 'Item "' + label + '" not scored: '
      + (hit.rule === null || hit.rule === undefined ? '' : 'Rule ' + hit.rule + ' ')
      + '**cumulative score has reached the rule cap (' + (Number(hit.rule_cap) || 0) + ' pts)** — additional score exceeding the cap will not be accumulated. '
      + 'Focus efforts on other rules or assets instead.'
  }
  return 'Permissions on target "' + label + '" are already maximized (Deduplication policy: only the highest scoring item counts'
    + (bestPoints === undefined || bestPoints === null ? '' : ', +' + bestPoints + ' pts')
    + ') — this item is recorded for audit trail only; **pivot to other targets or rules**.'
}

/** 兼容旧名（v0.10 及以前叫 serviceCapReason）。 */
export const serviceCapReason = scoreCapReasonText


/**
 * 数据规模的**粗判门槛**：100 万条/行。
 * 用途已经从「大量敏感信息得分项」改成 G5 翻倍的量级自检 —— 见 addScoreHit 里的警告。
 * 文档里 G5 的正式门槛是「超 1 亿条 或 10TB」；这里用更低的一档做"有没有写量级"的粗筛，
 * 低于它会提示核对，但不阻断记分。
 */
export const SENSITIVE_DATA_MIN_ROWS = 1000000

/**
 * 从证据文本里解析数据量（行/条/记录数）。
 * 支持「120 万条」「1300万行」「1,200,000 条记录」「2.5万行」「1200000 records」。
 * **只认带量词（条/行/记录/records/rows）或中文量级（亿/万…）的写法**——
 * 裸数字不认，否则会把口令里的 `123456`、端口号当成数据量。
 * 解析不出来返回 null（由调用方提示补齐量级，不猜、不编数）。
 */
export function parseRowCount(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = {
    亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3,
    b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9,
    m: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
    k: 1e3, thousand: 1e3, thousands: 1e3,
  }
  const nums = []
  /* Matches: "1.2m records", "500k rows", "10,000 entries", "120万条" */
  const pattern = /(\d[\d,]*(?:\.\d+)?)\s*(billions?|millions?|thousands?|[bmk]|亿|千万|百万|十万|万|千)?\s*(records?|rows?|entries|items?|条|行|记录|数据)?/gi
  for (const m of text.matchAll(pattern)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const unitKey = (m[2] || '').toLowerCase()
    const mult = unitKey && units[unitKey] !== undefined ? units[unitKey] : 1
    const hasUnit = unitKey !== '' && units[unitKey] !== undefined
    const hasNoun = m[3] !== undefined && m[3] !== ''
    if (hasUnit || hasNoun) {
      nums.push(Math.round(base * mult))
    }
  }
  return nums.length === 0 ? null : Math.max(...nums)
}

/** 千分位展示，告警里读数更直观。 */
export function formatRows(n) {
  return Number(n).toLocaleString('en-US')
}


/* ------------------------------------------------------------------ 默认得分点 */

/**
 * 得分点 → 交付口径（怎么算拿到、拿什么自证、怎么复现）。
 *
 * 为什么单独一张表而不是塞进 `score_point.description`：
 * 描述是"规则文档的条款"（给智能体判档位用），这张表是"给验收人看的复现口径"，
 * 两者受众不同、详略也不同。报告与界面按 code 取这里的说明，
 * 规则文档更新时不必动这张表，反之亦然。
 *
 * 字段：
 *   · need   —— 判定标准：满足什么才算拿到这一项（给验收人对账用）
 *   · proof  —— 自证材料：该附什么证据（G7 的证明材料要求）
 *   · replay —— 复现入口：用哪条请求 / 哪条命令重放（"可复现"最直接的答案）
 *   · script —— 一线可直接照做的动作（尽量是可复制执行的）
 */
export const SCORE_CONFIRM = {
  'domain-control': {
    need: 'Target domain DNS records redirected to our control (NS/A record active), or domain admin console controlled',
    proof: 'Admin panel screenshot + dig/nslookup verification before and after change',
    replay: 'nslookup <domain> <our_NS>; or raw admin console HTTP request',
    script: 'dig NS <domain> @8.8.8.8\\ndig <domain> @<our_NS>',
  },
  'terminal-access': {
    need: 'Able to execute commands on terminal endpoint and receive output (not merely discovered)',
    proof: 'Command execution output (id / hostname) + proof of affiliation with target organization (G7)',
    replay: 'id execution in C2/remote session; or agent check-in log',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: 'Command execution on host with stdout/stderr returned (WebShell / Reverse Shell / C2)',
    proof: 'Command execution output (id / hostname) + WebShell connection details or session record',
    replay: 'Raw WebShell request (replayable); or reverse shell listener log',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: 'Successfully connected to database with credentials and executed query (unauth access also valid)',
    proof: 'Query output upon login (select user(), version()) + user privilege level',
    replay: "mysql -h <host> -P <port> -u <user> -p'<pass>' -e 'select user(),version()'",
    script: "mysql -h <host> -u <user> -p -e 'select user(),version(),current_user()'",
  },
  'web-app': {
    need: 'Logged in with existing target account (user or admin) and accessed protected endpoints',
    proof: 'Post-login page content/response + session Cookie or Token (proves authenticated session)',
    replay: 'Raw login request (with Cookie/Token) + authenticated request to protected page',
    script: 'curl -i -s -X POST <LOGIN_URL> -d "username=<u>&password=<p>" -c cookie.txt\\ncurl -s -b cookie.txt <PROTECTED_URL>',
  },
  'central-system': {
    need: 'Gained administrative access to centralized management systems (Bastion, AD/Domain, SSO, IAM, EDR console)',
    proof: 'Management console screenshot + demonstrable control over subordinate nodes (logged into 20% or 20 managed hosts)',
    replay: 'Raw login request + management action request and response (e.g. list managed hosts)',
    script: 'curl -s -b cookie.txt "<MGMT_LIST_API>"',
  },
  'bigdata-system': {
    need: 'Gained admin or user access to Big Data platforms (Hadoop, Spark, Elasticsearch, Kafka)',
    proof: 'Platform admin UI / API response + accessible data scale (records or volume)',
    replay: 'Raw API request (e.g. ES _cat/indices, YARN /ws/v1/cluster/apps)',
    script: 'curl -s "<PLATFORM_API>" | head -50',
  },
  netdev: {
    need: 'Logged into network appliances (firewall, router, switch, VPN, gateway) and obtained access',
    proof: 'Device management UI screenshot + routing table or connection table screenshot (G7 requirement)',
    replay: 'Device login request + routing table dump output',
    script: 'show ip route    # or display ip routing-table',
  },
  'netdev-redirect': {
    need: 'Altered network traffic flow via device (routing, policy, or DNS hijack active)',
    proof: 'Routing table / policy diff before and after change + traffic received on our controlled node',
    replay: 'Raw policy modification request + packet capture / access log on our listening node',
    script: 'tcpdump -ni any port <PORT> -c 10',
  },
  'netdev-implant': {
    need: 'Implanted persistent backdoor on device AND successfully completed downstream pivoting attacks',
    proof: 'Implant process / persistence proof + subsequent compromised achievements pivoted through this device',
    replay: 'Raw implantation command/request + downstream pivot access log',
    script: '',
  },
  iiot: {
    need: 'Obtained industrial IoT / ICS / SCADA management access or controlled connected field devices',
    proof: 'Admin panel screenshot + inventory and count of controlled devices',
    replay: 'Raw login request + device list API response',
    script: '',
  },
  'cloud-platform': {
    need: 'Cloud management platform admin access; or batch node compromise via AK/SK (>= 100 nodes for node points)',
    proof: 'Cloud console screenshot; for AK/SK, node list & count or admin proof (create node, modify IAM)',
    replay: 'Raw cloud API request (list instances, create user, etc.)',
    script: 'curl -s -H "Authorization: Bearer <token>" "<CLOUD_API_URL>"',
  },
  'iot-platform': {
    need: 'Obtained IoT management platform control or batch controlled connected endpoints',
    proof: 'Management UI screenshot + endpoint count',
    replay: 'Raw login request + endpoint list API response',
    script: '',
  },
  'iot-corenet': {
    need: 'Pivoted from IoT endpoint into core network and controlled critical production/business systems',
    proof: 'Pivot path documentation (endpoint -> core net -> target system) + compromise proof of critical system',
    replay: 'Lateral movement command from endpoint + login request on core network target',
    script: '',
  },
  secdev: {
    need: 'Obtained admin access to standalone security appliances (IPS, IDS, WAF, Audit devices)',
    proof: 'Appliance management UI screenshot + controllable security policy proof',
    replay: 'Raw login request + policy read API response',
    script: '',
  },
  'file-storage': {
    need: 'Obtained access to storage systems (FTP, NAS, Cloud Drive, Object Storage / S3)',
    proof: 'Directory listing screenshot + file inventory (data achievements scored separately under G2)',
    replay: 'Raw directory listing request (FTP LIST / S3 ListObjects / WebDAV PROPFIND)',
    script: 'curl -s "<STORAGE_API>" | head -50',
  },
  'ai-agent': {
    need: 'Controlled AI agents, skills, or LLM toolsets and successfully commanded them to execute actions',
    proof: 'Conversation / API call log + executed actions and results (score tier evaluated by control depth)',
    replay: 'Raw prompt injection / driver request + executed tool action stdout',
    script: '',
  },
  'model-compute': {
    need: 'Obtained system admin access to AI compute clusters or training data / knowledge base platforms',
    proof: 'Admin panel screenshot + demonstrated compute scheduling or read/write data access',
    replay: 'Platform login and scheduling / dataset API requests',
    script: '',
  },
  'model-data': {
    need: 'Obtained admin access to model data systems (capable of tampering training/inference or stealing weights)',
    proof: 'Admin console screenshot + readable/writable models and datasets inventory',
    replay: 'Raw API request (list models, export weights)',
    script: '',
  },
  'computepower-admin': {
    need: 'Obtained admin access to compute power infrastructure',
    proof: 'Management UI screenshot + schedulable resource proof',
    replay: 'Platform login and resource list API request',
    script: '',
  },
  'computepower-cards': {
    need: 'Acquired compute GPU / accelerator cards (10 pts/card) or card pooling platform control',
    proof: 'GPU inventory (count) + ability to submit jobs or monopolize GPU resources',
    replay: 'nvidia-smi stdout / platform GPU list API response',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: 'Established tunnel from target into internal network and accessed internal targets',
    proof: 'Tunnel registration (origin must be on target) + screenshot/stdout of internal access via tunnel (G7)',
    replay: 'Command accessing internal target via tunnel; tunnel creation command',
    script: 'curl --socks5-hostname 127.0.0.1:<PORT> http://<INTERNAL_IP>/ -i',
  },
  'boundary-strong': {
    need: 'Breached strong isolation (data diode / gap devices) and accessed strongly isolated intranet targets',
    proof: 'Gap device control screenshot + internal network access proof (G7)',
    replay: 'Command and response accessing internal target through gap proxy',
    script: '',
  },
  'boundary-physical': {
    need: 'Breached physically air-gapped network or core production network and accessed target systems',
    proof: 'Firewall/VPN/multi-NIC host/airgap control screenshot + internal access proof (G7)',
    replay: 'Command and output accessing core network target after boundary breach',
    script: '',
  },
  'boundary-supply': {
    need: 'Accessed defender intranet via supply chain maintenance channel or cloud service transit',
    proof: 'Supply chain / cloud control proof + access into defender intranet; specify breach scenario',
    replay: 'Command and response entering intranet from supply chain transit',
    script: '',
  },
}

/** 取某个得分点的交付口径；没有专门条目时返回 null（报告会退回只显示 evidence）。 */
export function scoreConfirmOf(code) {
  const key = String(code || '').trim()
  return SCORE_CONFIRM[key] === undefined ? null : SCORE_CONFIRM[key]
}

export const DEDUP_SCOPES = ['service', 'system', 'target', 'none']

/**
 * 一条得分点的完整定义（工厂函数，避免 22 个对象重复字段）。
 *
 * 两个编号各司其职，**不要混用**：
 *   · `src`  —— 《突破入侵类得分规则（合并版）》里的"原序号"（合并行写首个原序号），
 *               只用于与原表逐条对账，出现在文档与代码注释里；
 *   · `rule` —— 本实现内部的**上限分组键**（`applyScoreCaps` 按它累计 cap）。
 *               它必须**唯一**：历史上曾直接用原序号当分组键，导致 16/17 合并行与
 *               19 的两个子项共用同一个键 —— 一条命中会把另一条的上限吃掉，
 *               而且 `rule` 编号出现重复（两个 19）与空号（6/17/20/21），
 *               模型读到"规则 19 已达上限"时分不清是哪一条。
 *               现在统一为 1..N 连续唯一，与数组顺序一一对应。
 */
const sp = (src, rule, tier, code, name, category, points, cap, dedup_scope, description) => ({
  src, rule, tier, code, name, category, points, cap, dedup_scope, description,
})

/* ── 通用规则（G1–G8，横切全部条目；不单独计分，写进说明与提示词）────────────
   G1 权限取高只计一次 ｜ G2 数据成果另行计分 ｜ G3 上限针对单个防守单位 ｜
   G4 设备按台（个）计分 ｜ G5 数据规模翻倍 ｜ G6 IPv6 ×3（不突破原上限）｜
   G7 证明材料要求 ｜ G8 兜底：其他系统由专项组研判后给分。
   完整原文见 docs/得分规则-合并版.md。 */
export const SCORE_GENERAL_RULES = [
  { code: 'G1', name: 'Highest Privilege Only', detail: 'When multiple privileges are obtained on the same system, host, or database, only the highest privilege is scored once (e.g. obtaining both admin and user privileges only scores admin).' },
  { code: 'G2', name: 'Data Achievements Scored Separately', detail: 'Email data, business records, and data assets are scored separately based on data criticality and not conflated with privilege scores.' },
  { code: 'G3', name: 'Defending Organization Cap Scope', detail: 'All point caps apply to a single defending target organization and all its subordinate entities; points no longer accumulate once the cap is reached.' },
  { code: 'G4', name: 'Per-Unit Device/Terminal Scoring', detail: 'Printers, Wi-Fi routers 5 pts/host; PCs, tablets, phones, cameras, display boards 10 pts/host; cloud instances, containers, managed IoT endpoints 10 pts/host. Bulk control calculates by controlled nodes.' },
  { code: 'G5', name: 'Large Data Scale / Knowledge Multiplier', detail: 'Systems containing massive data (>100M records or 10TB) double score (2x); controlling LLM knowledge base systems doubles score (2x). Excludes standard system logs.' },
  { code: 'G6', name: 'IPv6 Multiplier', detail: 'Achievements obtained over IPv6 score 3x, but remain subject to the original rule cap.' },
  { code: 'G7', name: 'Evidence Requirements', detail: 'Boundary breaches require isolation device control screenshots and verified internal access proof; controlled terminals must prove target affiliation; network appliance control requires routing tables or connection logs.' },
  { code: 'G8', name: 'Discretionary Fallback Clause', detail: 'Other systems, servers, or devices without explicit rule points are evaluated and scored by the review panel.' },
]

/**
 * 默认得分点 —— **严格对齐《突破入侵类得分规则（合并版）》，共 25 项**
 * （一、获取权限 21 条 + 二、突破网络边界 4 条，共 8 个类别；其中"同一行的不同计费单位"拆为独立得分点，如算力基础设施的管理员权限与算力卡）。
 *
 * 与上一版的区别：不再按"同一规则内的权限档位"拆条 —— 一条 = 合并版里的一行
 * （`tier` 字段写清该条的档位/子项），只有**计费单位不同**的多档才保留子项
 * （如算力基础设施的"管理员权限"与"算力卡 10 分/卡"）。
 *
 * 字段含义：
 *   · src    合并版里的"原序号"（用于与原表逐条对账）；
 *   · group  界面分组：GENERAL = 控制一般系统，WEB = 控制 Web 应用系统，
 *            CENTRAL = 控制集权系统，BIGDATA = 控制大数据系统，
 *            NETINFRA = 控制网络基础设施，STORAGE = 文件存储类系统，
 *            MODEL = 控制模型相关系统，BOUNDARY = 突破网络边界；
 *   · points 单次分值（一条内多档时取该条的主档，说明里写清各档）；
 *   · cap    该条上限（0 = 不设上限）；dedup_scope 计分口径。
 */
export const SCORE_GROUPS = [
  { code: 'GENERAL', name: 'General Systems' },
  { code: 'WEB', name: 'Web Applications' },
  { code: 'CENTRAL', name: 'Centralized Systems' },
  { code: 'BIGDATA', name: 'Big Data Systems' },
  { code: 'NETINFRA', name: 'Network Infrastructure' },
  { code: 'STORAGE', name: 'File Storage Systems' },
  { code: 'MODEL', name: 'AI & Model Systems' },
  { code: 'BOUNDARY', name: 'Network Boundary Breach' },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ I. Privilege Acquisition (18 Items) ═════════════════════════════════ */

  /* 1 Domain Control */
  sp(1, 1, 'TLD 50 / SLD 20 pts each', 'domain-control', 'Domain Control Access', 'GENERAL', 50, 400, 'system',
    '**Top-Level Domain (TLD) 50 pts each, Second-Level Domain (SLD) 20 pts each**, scored by domain level; Cap: 400 pts (G3).\n'
    + 'State the domain name and type in evidence; adjust points to 20 for second-level domains.'),

  /* 2 Terminal / Endpoint Access */
  sp(2, 2, '5 / 10 pts/host', 'terminal-access', 'Terminal Access (Mobile, Tablet, PC, Printer, Camera, Wi-Fi Router)', 'GENERAL', 10, 600, 'system',
    '**Printers, Wi-Fi routers 5 pts/host; PC, Tablet, Phone, IP Camera, Electronic Display 10 pts/host** (G4), accumulated per host; Cap: 600 pts (G3).\n'
    + 'Controlled terminals must demonstrate affiliation with the target organization (G7); adjust points to 5 for 5-pt tier devices.\n'
    + 'Endpoints compromised via phishing are scored under this rule. Specify employee role in evidence (General Staff / IT Ops / Business Ops).'),

  /* 3 Server Host Access */
  sp(3, 3, 'User 10 / Admin 50 pts each', 'server-host', 'Server Host Access (including WebShell)', 'GENERAL', 50, 600, 'system',
    '**User privilege 10 pts each, Administrator/Root privilege 50 pts each**; Cap: 600 pts (G3).\n'
    + 'Only the highest privilege on the same host is scored once (G1) — user privileges do not accumulate after obtaining root/SYSTEM.\n'
    + 'Adjust single item score to 10 for user-level access.'),

  /* 4 Database Credentials */
  sp(4, 4, 'User 10 / Admin 50 / Unauth 10 pts each', 'db-credential', 'Database Credentials (including SQL Injection)', 'GENERAL', 50, 400, 'system',
    '**User privilege 10 pts each, Admin privilege 50 pts each; Redis, empty passwords, and unauthenticated access 10 pts each**; Cap: 400 pts (G3).\n'
    + 'Equivalent privileges on the same database are scored only once. Across OS, web app, and database on the same host, only the highest privilege is scored (G1).\n'
    + 'Data exfiltration is scored separately (G2); adjust points to 10 for user or unauthenticated access.'),

  /* 5 & 6 Email & Web Application Systems */
  sp(5, 5, 'Admin 100 / User 50 pts each', 'web-app', 'Email / OA & Business Production / Web Application Systems Access', 'WEB', 100, 2000, 'system',
    '**Admin privilege 100 pts each, User privilege 50 pts each; Only the highest privilege per system is scored once** (G1); Cap: 2000 pts (G3).\n'
    + 'Covers Web Application systems: Email systems, OA/ERP/finance/production systems, and general web applications.\n'
    + 'Specify the target site URL and user account level in evidence. Email data is scored separately (G2). Adjust single score to 50 for standard user access.'),

  /* 7 Centralized Management Systems */
  sp(7, 6, 'Admin 500 / User 50 pts each', 'central-system', 'Centralized Management Systems Access (Bastion, IAM, AD, SSO, EDR)', 'CENTRAL', 500, 4000, 'system',
    '**System Administrator 500 pts each, Standard User 50 pts each**; Highest privilege per system only (G1); Cap: 4000 pts (G3).\n'
    + 'Centralized systems include: Bastion hosts, centralized monitoring, IAM/SSO/4A, Active Directory Domain Controllers, SD-WAN controllers, and EDR/MDM consoles.\n'
    + '⚠️ Hosts and endpoints managed under centralized systems cross-reference General Systems scoring (10 pts/host, G4) — do NOT score managed endpoints as centralized systems at 500 pts.'),

  /* 8 Big Data Systems */
  sp(8, 7, 'Admin 1000 / User 100 pts each', 'bigdata-system', 'Big Data Systems Access (Hadoop, Spark, Kafka)', 'BIGDATA', 1000, 4000, 'system',
    '**Admin privilege 1000 pts, Standard User 100 pts each**; Highest privilege only (G1); Cap: 4000 pts (G3).\n'
    + 'Data exfiltration scored separately (G2). Systems with effective data under 500M records or 1TB are scored as general databases (Rule 4).'),

  /* 9 Network Appliances Access */
  sp(9, 8, 'User 100 / Admin 200 / Bonus 200-1000 pts', 'netdev', 'Network Appliances Access (Firewall, Router, Switch, VPN, Gateway)', 'NETINFRA', 200, 2000, 'service',
    '**Standard User 100 pts, Administrator 200 pts**; Cap: 2000 pts (G3). Routing table proof or connection screenshot required (G7).\n'
    + 'Additional actions on the same appliance qualify for bonus points:\n'
    + '· Traffic redirection or hijacking: +200 pts;\n'
    + '· Persistent implant and downstream pivoting: 1000 pts.'),

  /* 10 Industrial Internet Systems */
  sp(10, 9, 'Admin 200 / Device 10 pts each', 'iiot', 'Industrial Internet (IIoT / SCADA / ICS) Systems Access', 'NETINFRA', 200, 2000, 'system',
    '**Admin management console 200 pts; Connected industrial devices 10 pts each** (G4); Cap: 2000 pts (G3).\n'
    + 'Includes Connected Vehicles, Smart Manufacturing, Remote Diagnostics, and Intelligent Transportation. Use separate hit records (points=10) when accumulating device counts.'),

  /* 11 Cloud Management Platforms */
  sp(11, 10, 'Admin 500 / Node 10 pts each', 'cloud-platform', 'Cloud Management Platforms (IaaS/PaaS, Kubernetes, OpenShift)', 'NETINFRA', 500, 2000, 'system',
    '**Admin privilege 500 pts; Cloud instances and containers 10 pts each** (G4); Cap: 2000 pts (G3).\n'
    + 'Bulk control via AK/SK defaults to node scoring only unless full admin privileges (user management, instance creation) are proven.\n'
    + '⚠️ Deployments with fewer than 100 nodes are scored as general web apps without node points.'),

  /* 12 IoT Management Platform */
  sp(12, 11, 'Platform 200 / Endpoint 10 / Core Net +5000 pts', 'iot-platform', 'IoT Management Platform Access', 'NETINFRA', 200, 2000, 'system',
    '**IoT platform with control capabilities 200 pts; Connected endpoints 10 pts each** (G4); Cap: 2000 pts (G3).\n'
    + '**Pivoting from IoT endpoints to penetrate core network and control critical systems adds +5000 pts separately** (exempt from the 2000 pt cap).'),

  /* 13 Security Appliances */
  sp(13, 12, 'Admin 200 pts', 'secdev', 'Security Appliances Access (Non-centralized IPS, IDS, WAF, Audit Appliances)', 'NETINFRA', 200, 1000, 'service',
    '**Admin privilege 200 pts**; Cap: 1000 pts (G3). Applies to standalone non-centralized security devices (centralized security platforms use Rule 7).'),

  /* 14 File Storage Systems */
  sp(14, 13, 'Admin 50 / User 10 pts each', 'file-storage', 'File Storage Systems Access (FTP, Object Storage, Enterprise NAS, Cloud Drive)', 'STORAGE', 50, 500, 'system',
    '**Admin privilege 50 pts each; Standard User, empty system, or test data system 10 pts each**; Cap: 500 pts (G3).\n'
    + 'Includes FTP, Object Storage, Enterprise NAS, and Cloud Drives; Data exfiltration scored separately (G2).'),

  /* 15 AI Agents / Toolsets */
  sp(15, 14, '100-500 pts each', 'ai-agent', 'AI Agents, Skills, and LLM Toolsets (Capable of Executing Attacks)', 'MODEL', 100, 4000, 'service',
    '**100–500 pts each**, tiered range based on control depth; Cap: 4000 pts (G3).\n'
    + 'Includes AI agents, skills, and LLM automation tools. Specify control depth in evidence and adjust points accordingly.'),

  /* 16 & 17 AI Compute Platforms & Knowledge Base Systems */
  sp(16, 15, 'System Admin 500 pts each', 'model-compute', 'AI Compute Platform / Training Data & Knowledge Base Systems Access', 'MODEL', 500, 4000, 'system',
    '**System Administrator 500 pts each**; Cap: 4000 pts (G3).\n'
    + 'Includes AI compute scheduling platforms, training datasets, and knowledge bases.\n'
    + 'Systems with massive datasets (>100M records or 10TB) double score (2x); controlling knowledge base systems doubles score (2x) (G5).'),

  /* 18 Model-Related Data Systems */
  sp(18, 16, 'System Admin 500 pts each', 'model-data', 'Model-Related Data Systems Access', 'MODEL', 500, 4000, 'system',
    '**System Administrator 500 pts each**; Cap: 4000 pts (G3).\n'
    + 'Capable of disrupting model training/inference or extracting model weight files.\n'
    + 'Massive data systems (>100M records or 10TB) double score (2x) (G5).'),

  /* 19 Compute Infrastructure */
  sp(19, 17, 'Admin 500 pts each', 'computepower-admin', 'Compute Infrastructure · Administrator Access', 'MODEL', 500, 2000, 'system',
    '**Admin privilege 500 pts each**; Cap: 2000 pts (G3).\n'
    + 'Shares the Rule 19 cap of 2000 pts with Compute Card Resources.'),

  sp(19, 18, '10 pts / card', 'computepower-cards', 'Compute Infrastructure · GPU / Compute Card Pooling Resources', 'MODEL', 10, 2000, 'none',
    '**10 pts / card**, accumulated per GPU card (G4); Cap: 2000 pts, shared with Admin privilege.\n'
    + 'State the number of cards or platform name in evidence.'),

  /* ══ II. Network Boundary Breaches (4 Items) ══════════════════════════════ */

  sp(22, 19, '1000 pts', 'boundary-logical', 'Network Boundary Breach · Logically Isolated Intranet', 'BOUNDARY', 1000, 0, 'target',
    '**1000 pts**. Scored only once per boundary class for the entire target organization.\n'
    + 'Proof (G7): Firewall/router isolation control screenshot and verified intranet reachability proof.'),

  sp(23, 20, '10000 pts', 'boundary-strong', 'Network Boundary Breach · Strongly Isolated Business Intranet', 'BOUNDARY', 10000, 0, 'target',
    '**10000 pts**. Scored only once per boundary class for the entire target organization.\n'
    + 'Proof (G7): Data diode / physical gap device control screenshot and verified intranet reachability proof.'),

  sp(24, 21, '30000 pts', 'boundary-physical', 'Network Boundary Breach · Physically Air-gapped Core Production Network', 'BOUNDARY', 30000, 0, 'target',
    '**30000 pts**. Scored only once per boundary class for the entire target organization.\n'
    + 'Proof (G7): Control screenshots of airgap gateway / multi-homed firewall / VPN appliances and verified access to critical intranet.\n'
    + 'Applies to railway dispatch networks, banking core ledgers, power grid production zones, telecom signaling networks, etc.'),

  sp(25, 22, '1000 pts (max 3000)', 'boundary-supply', 'Network Boundary Breach · Supply Chain Maintenance Channel or Cloud Transit', 'BOUNDARY', 1000, 3000, 'service',
    'Scored under three scenarios:\n'
    + '· Access into the **same target intranet**: 1000 pts;\n'
    + '· Access via **one** supply chain vendor into **multiple** target intranets: 1000 pts per target organization;\n'
    + '· Access via **multiple** supply chain vendors into **one** target intranet across different network segments: 1000 pts each, up to 3000 pts max.\n'
    + 'Specify the scenario, vendor name, and network segment in evidence.'),

  /* ══ Bonus Score Additions ════════════════════════════════════════════════ */

  sp(9, 23, 'Redirection / Hijacking +200 pts', 'netdev-redirect', 'Network Appliance · Redirection or Traffic Hijacking', 'NETINFRA', 200, 2000, 'none',
    '**+200 pts additional bonus over base Network Appliance Access score**.\n'
    + 'Applies to active routing modifications, DNS hijacking, or business traffic redirection to our controlled nodes.\n'
    + 'Proof required (G7): Routing table, policy configuration diff, or traffic log screenshot.'),

  sp(9, 24, 'Implant + Downstream Attack 1000 pts', 'netdev-implant', 'Network Appliance · Persistent Implant & Downstream Pivoting', 'NETINFRA', 1000, 2000, 'none',
    '**+1000 pts additional bonus over base Network Appliance Access score**.\n'
    + 'Requires proof of both successful persistence implant AND downstream attack executed through the appliance.'),

  sp(12, 25, 'Core Net +5000 pts', 'iot-corenet', 'IoT Endpoint to Core Network Pivot with Critical System Compromise', 'NETINFRA', 5000, 5000, 'none',
    '**+5000 pts standalone bonus** (exempt from Rule 12 2000 pt cap).\n'
    + 'Applies to lateral pivot from IoT endpoint into core network with compromise of critical production systems.\n'
    + 'State endpoint origin, core network systems reached, and obtained privileges in evidence.'),
]

/* ------------------------------------------------------------------ 内部辅助的导出 */

/**
 * 下面这些原本是 core.js 里的模块级函数（不对外导出），拆出来之后 core.js 需要用到，
 * 所以显式导出。它们不属于"给别人用的 API"，改签名前先看 core.js 的用法。
 */
export {
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup,
  targetHasIpv6Host, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf,
}
