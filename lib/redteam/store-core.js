/**
 * RedTeam 资产库核心（无 Cordis 依赖）
 *
 * 这里只做三件事：靶标工作区（目录 + 元数据）、SQLite 事实库（schema/写入/查询）、
 * 提示词与技能库的文件读写。Cordis 插件壳在 ./index.js，命令行壳在 ../bin/cli.mjs；
 * 两者共用本模块，保证「界面看到的」「智能体查到的」「命令行验的」是同一份实现。
 */
import { assertRuntime } from '../runtime-check.js'
assertRuntime()
const { DatabaseSync } = await import('node:sqlite')
import { connect as tcpConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync,
  copyFileSync,
} from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'

/* ── 拆分出去的模块（对外 API 不变：下面把它们原样再导出一次）──────────────
   动机是"一个文件 5600 行、改表结构要翻过 500 行计分逻辑"：
   · ip-utils.js    IP / 网段 / slug / 时间戳等纯函数；
   · schema.js      两张表的 DDL 与两处增量迁移；
   · validate.js    写库前的校验与规范化（路径穿越、非法枚举）；
   · score-rules.js 计分口径与默认得分点（面板/报告/攻击链共用的唯一实现）。 */
import {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
} from './ip-utils.js'
import {
  buildHttpRequest, buildCurlCommand, parseCurl, commandKind, parseTarget, fillTemplate,
} from './report-replay.js'
import {
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
} from './schema.js'
import {
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
} from './validate.js'
import {
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  /* 内部辅助：原本就是 core.js 里的模块级函数，拆分后由 score-rules.js 提供 */
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
} from './score-rules.js'
import {
  platformSummary, savePlatformConfig, assignToolkitFolder, loadPlatformConfig, nucleiTemplatesDirOf,
} from './platform-config.js'

/* 再导出：core.js 的对外导出面与拆分前完全一致（调用方零改动） */
export {
  ipToInt, cidrOf, isIpv6, expandIpv6, scopeOfIp, slugify, slugTarget, slugPoc,
  defaultPocFilename, nowIso,
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  POC_CATEGORIES, pocCategoryName, guessPocCategory,
  migrate, migrateKnowledge,
  WEBSHELL_TYPES, WEBSHELL_STATUSES, normalizeShellType, normalizeShellStatus, assertPathWithin,
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, scoreServiceKey, serviceLabel, applyScoreCaps, scoreCapReasonText,
  serviceCapReason, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf, SENSITIVE_DATA_MIN_ROWS, parseRowCount, formatRows,
  DEDUP_SCOPES, SCORE_GENERAL_RULES, SCORE_GROUPS, DEFAULT_SCORE_POINTS, scoreConfirmOf, SCORE_CONFIRM,
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup, targetHasIpv6Host,
}

/* ------------------------------------------------------------------ 角色与枚举 */
/**
 * 作战角色（六个）。角色 code 同时用于：
 *   · 角色提示词文件 `engagements/<靶标>/agents/<code>.md`
 *   · 攻击步骤/漏洞/凭据上的 `agent` 列（报告要写清"这条是谁做的"）
 *   · 主会话派活时的角色选择
 * `plan` 是主会话（指挥）自己，不派出去，只用于提示词面板里查看/微调人设。
 */
const ROLE_TITLES = {
  plan: 'Main Session (Command)',
  recon: 'Reconnaissance',
  assess: 'Asset Inventory',
  'vuln-scan': 'Vulnerability Scanning',
  exploit: 'Exploitation',
  internal: 'Intranet Pivoting',
}

/** 漏洞严重级（按展示优先级排列）。 */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** 漏洞处置状态。 */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES }

/* ------------------------------------------------------------------ schema */


/* ------------------------------------------------------------------ 知识库（POC/EXP，全局共享） */


/**
 * 知识库归类（与得分点/攻击面口径对齐）：智能体回填时必须选一个，
 * 面板按它分组，用户才能"一类一类看"而不是几百条平铺。
 */
/* ------------------------------------------------------------------ 知识库常量 */

/** POC 类型：poc=验证性利用、exp=可执行利用、template=nuclei 等模板、script=辅助脚本、payload=载荷。 */
const POC_KINDS = ['poc', 'exp', 'script', 'template', 'payload']
/** 来源：web=互联网扒的、self=智能体手搓、manual=人写的、nuclei-template=模板库。 */
const POC_SOURCES = ['web', 'self', 'manual', 'nuclei-template', 'kb']
export { POC_KINDS, POC_SOURCES }




/* ------------------------------------------------------------------ 迁移 */

/** 允许的马类型（与技能 webshell-toolkit 交付要求一致：冰蝎 / 哥斯拉是"用户能连上"的加密马）。 */

/**
 * 目标归并：同一条漏洞的 target 可能带路径/参数（http://h:8080/a/b、10.0.0.5:6379），
 * 聚合视图要按「站点/服务」而不是按完整 URL 分组，否则 300 条漏洞会聚成 300 组。
 */
export function targetKey(target, fallbackIp) {
  const t = String(target || '').trim()
  if (t !== '') {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
    if (url !== null) return url[1]
    const head = /^([^\s/?#]+)/.exec(t)
    if (head !== null) return head[1]
    return t
  }
  return fallbackIp || '(Unspecified target)'
}

/** 安全解析 JSON 列（坏数据回退默认值）。 */
const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/** 把「通过这个漏洞拿到了什么」规范化成一行短标签：数组或分隔串 → 「A、B」。 */
function normGained(value) {
  if (value === undefined || value === null) return null
  const parts = Array.isArray(value) ? value : String(value).split(/[,;，；]/)
  const out = parts.map((x) => String(x).trim()).filter(Boolean)
  return out.length > 0 ? out.join('、') : null
}

/**
 * 内外网判定（SQL 片段，作用于 asset.ip）：
 * RFC1918 私网 + 回环 + 链路本地 + CGNAT 视为内网，其余为外网。
 */
const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`


/* ------------------------------------------------------------------ 元数据 */

function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}


/* ------------------------------------------------------------------ 默认得分点 */

/* ────────────────────────────────────────────────────────────────────────────
   默认得分点 —— 严格按《突破入侵类得分规则》的 25 条规则设计。

   每条得分点自带四个判定字段（面板/报告/智能体都靠它们，不再靠代码里的硬编码名单）：
     · rule        规则号（RULE 1…25）。**同 rule 的得分点共用该规则的得分上限**；
     · dedup_scope 计分口径：`service`（同一资产同一端口只算分值最高的一条；用于"按端口即一个服务"的项，
                   如网络设备、安全设备、文件存储）/
                   `system`（同一系统只算最高权限一次）/ `target`（整个目标只算一次）/
                   `none`（每次命中都算，如按台/卡/节点计数的项）；
     · cap         该 rule 的累计得分上限（0 = 不设上限）；面板与报告按 rule 累计后执行封顶；
     · tier        同一 rule 内的档位标签（如「管理员权限」「普通权限」「加成分」）。

   口径要点（来自规则原文，已写进对应 description，智能体与用户都能看到）：
     · 权限取高：同一系统/主机/数据库取得多种权限只按最高权限计一次分；
     · 上限（一）针对**单个防守单位及其所有下属机构**；（二）针对**整个目标单位**；
     · 加成项：大数据/超大系统翻倍、知识库翻倍、物联网打入核心网 +5000、
       网络设备重定向/劫持 +200、植入远控并成功后续攻击 +1000；
     · IPv6 相关成果 ×3（上限仍按原系统类型）；
     · 计台/卡/节点数的项（终端、节点、算力卡）按数量累加，与"权限取高"不冲突。
   ──────────────────────────────────────────────────────────────────────────── */


/** 旧版（v0.10.0 之前）的默认得分点 code → 新规则 code 的对照，用于老靶标迁移与提示。 */


/* ------------------------------------------------------------------ 默认内容 */

/* ------------------------------------------------------------------ 攻击链（五阶段） */

/**
 * 攻击链的五个阶段：按「攻击面位置」串起来 —— 互联网侧收集 → 互联网侧拿权限 →
 * 打穿边界 → 内网拿权限 → 拿靶标。得分归属由 scoreStageOf() 自动推导。
 *
 * sections = 该阶段的打法要点（数据仍保留给提示词与面板编辑用；攻击链页面已不再展示，
 * 避免执行细节淹没"打到哪了、拿了多少分"）；tools = 常用工具。
 */
export const DEFAULT_STAGES = [
  {
    code: 'recon', name: 'Reconnaissance', subtitle: 'RECON · EXTERNAL', color: '#06b6d4', scored: 0,
    goal: 'Conduct external reconnaissance to map out actionable attack surfaces',
    sections: [
      { label: 'Asset Mapping', items: ['Subdomains / IP blocks / Port fingerprinting', 'FOFA, passive DNS, certificate transparency, active scanning'] },
      { label: 'Surface Verification', items: ['Web titles and fingerprints, exposed services and management ports', 'Ownership, WAF / CDN identification'] },
      { label: 'Priority Ranking', items: ['Rank by exploitability and expected score', 'Prioritize initial targets'] },
    ],
    tools: 'ARL / Lighthouse, fscan, gogo, OneForAll, ENScan, Goby, Nmap, Burp, Nuclei',
    transition: 'External attack surface verified, transition to exploitation',
  },
  {
    code: 'internet', name: 'External Access', subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: 'Obtain accounts, privileges, and scores on external-facing assets',
    sections: [
      { label: 'Account Acquisition', items: ['Weak passwords / IDOR / Unauth / Logic flaws', 'Admin and user accounts'] },
      { label: 'Privilege Access', items: ['N-day / 1-day RCE, file upload, deserialization', 'WebShell, command execution, server privileges'] },
      { label: 'Data Retrieval', items: ['Databases, config exposure, bulk sensitive data'] },
    ],
    tools: 'sqlmap, Nuclei, Behinder / Godzilla / AntSword, fscan, Burp, custom POCs',
    transition: 'Establish outbound pivot using compromised hosts',
  },
  {
    code: 'boundary', name: 'Boundary Breach', subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: 'Successfully construct tunnels and extend control into the internal network',
    sections: [
      { label: 'Tunnels', items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', 'socks5 deployment, multi-level pivoting'] },
      { label: 'Outbound Egress', items: ['Domain fronting, CDN masking, cloud function forwarders', 'DNS / ICMP / HTTPS covert channels'] },
    ],
    tools: 'suo5, frp, Stowaway, Neo-reGeorg, GOST, proxychains, chisel',
    transition: 'Tunnel established, transition to internal network',
  },
  {
    code: 'internal', name: 'Internal Access', subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: 'Compromise internal network assets and score points via established tunnels',
    sections: [
      { label: 'Internal Recon', items: ['Live hosts / ports / services / SMB shares', 'Databases, middleware, backup repositories'] },
      { label: 'Lateral Movement', items: ['Credential reuse, Pass-the-Hash, Kerberos tickets', 'PsExec / WMIExec / SSH / RDP'] },
      { label: 'Data Exfil', items: ['Bulk export sensitive data to runs/ with citations'] },
    ],
    tools: 'gogo / fscan (via tunnel), Impacket, Mimikatz / LaZagne, BloodHound, suo5',
    transition: 'Locate core internal targets',
  },
  {
    code: 'target', name: 'Target System Access', subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: 'Gained administrative control of critical internal systems (Targets)',
    sections: [
      { label: 'Target Identification', items: ['Confirm target systems / server scope against rules', 'Clarify scoring criteria'] },
      { label: 'Target Control', items: ['root / SYSTEM / Administrator / Cloud AK/SK', 'Business data read/write and config modification'] },
      { label: 'Evidence Consolidation', items: ['Archive chain of evidence (config / data / host info / screenshots)', 'Review attack timeline'] },
    ],
    tools: 'Credential reuse, lateral movement tools, evidence archiving & reporting',
    transition: '',
  },
]

/** 特殊得分点 → 固定阶段（优先级高于按资产内外网推导）。 */
export const POINT_STAGE_OVERRIDE = {
  /* 旧 code 的兜底（老数据仍可能有） */
  'core-system': 'target',
  boundary: 'boundary',
  /* 新口径：按《突破入侵类得分规则》的规则号判阶段。
     规则 5/6/7 = 邮箱系统 / 办公业务系统 / 集权系统 —— 这些就是演练的"靶标"，
     拿到它们即算打到核心目标，归入 ⑤ 靶标权限；
     规则 22-25 = 突破网络边界，归入 ③ 边界突破（§二 明确规定是"进入内网"）。 */
  'mail-admin': 'target', 'mail-user': 'target',
  'biz-admin': 'target', 'biz-user': 'target',
  'central-admin': 'target', 'central-user': 'target', 'central-managed': 'target',
  /* 合并版 code：邮箱/业务系统、集权系统 = 演练的靶标 → ⑤ 靶标权限 */
  'web-app': 'target', 'central-system': 'target',
  'boundary-logical': 'boundary', 'boundary-strong': 'boundary',
  'boundary-physical': 'boundary', 'boundary-supply': 'boundary',
}

/**
 * 得分点的短名：报告正文、索引表、链路表用它。
 * 合并后的得分点全名太长，放不进表头；全名仍写在每条明细的「得分点」一行。
 */
export const POINT_SHORT_NAME = {
  'domain-control': 'Domain Control',
  'terminal-access': 'Endpoint Access',
  'server-host': 'Server Host',
  'db-credential': 'Database Credential',
  'web-app': 'Web Application',
  'central-system': 'Central System',
  'bigdata-system': 'Big Data System',
  'netdev': 'Network Device',
  'netdev-redirect': 'Network Redirection',
  'netdev-implant': 'Network Device Implant',
  'iiot': 'Industrial Internet',
  'cloud-platform': 'Cloud Management Platform',
  'iot-platform': 'IoT Platform',
  'secdev': 'Security Device',
  'file-storage': 'File Storage',
  'ai-agent': 'AI Agent',
  'model-compute': 'Compute / Knowledge Base System',
  'model-data': 'Model Data System',
  'computepower-admin': 'Compute Infrastructure',
  'computepower-cards': 'Compute Card Resources',
  'boundary-logical': 'Logical Isolation Breach',
  'boundary-strong': 'Strong Isolation Breach',
  'boundary-physical': 'Physical Air-Gap Breach',
  'boundary-supply': 'Supply Chain / Cloud Pivot',
  'iot-corenet': 'IoT to Core Network',
  'core-system': 'Core System (Legacy)',
}

/**
 * 自动推导一条得分属于哪个阶段（用户已确认：自动推导，允许显式覆盖）：
 *   ① 显式 stage_code 优先
 *   ② 类型特判（POINT_STAGE_OVERRIDE：集权/邮箱/业务系统 → target，突破网络边界 → boundary）
 *   ③ 按命中资产的内外网归属（asset.scope）
 *   ④ 没有 asset_id 时按 target 里的地址判断（私有 IP → 内网，公网/域名 → 互联网）
 */
export function scoreStageOf(hit, assetScope) {
  if (hit && typeof hit.stage_code === 'string' && hit.stage_code !== '') return hit.stage_code
  const override = POINT_STAGE_OVERRIDE[hit && hit.code]
  if (override !== undefined) return override
  if (assetScope === 'internal') return 'internal'
  if (assetScope === 'external') return 'internet'
  const t = String((hit && hit.target) || '')
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t)
  if (m !== null) return scopeOfIp(m[1]) === 'internal' ? 'internal' : 'internet'
  return 'internet'
}

/** 旧攻击链 stage → 新阶段 code 的兜底映射。 */
export const LEGACY_STAGE_MAP = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * 攻击链步骤允许的作战阶段 code —— 只有这 5 个会被攻击链页面分桶。
 * 写入其它值（尤其外部工具常见的 external / foothold / tunnel / privilege）会被忽略
 * 并退回按 stage 兜底，步骤就不落在任何阶段，所以服务端显式校验并回告警。
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']

/* ------------------------------------------------------------------ 提示词版本 */

/**
 * 提示词指纹（sha1 前 12 位）：用来判断"靶标里存的是不是某一版内置默认"。
 * 语义：**是默认就跟着新版走，用户自己改过的永不覆盖**。
 *
 * 两类指纹：
 *   · 老靶标里可能残留的历史默认（下面这张表）；
 *   · 本靶标上次被写入默认时的指纹（记在 `agents/.defaults.json`，新版默认写下时自动记录）。
 * 新增默认版本时不需要手工维护这张表——manifest 会接管；这里只兜住历史包袱。
 *
 * v0.9.0 **角色提示词整体重写**（六个角色，旧的四个角色提示词全部作废）。
 * 旧版默认的指纹不再登记进这张表：重写后的语义是"旧提示词一律不沿用"，
 * 而登记旧指纹会让 refreshDefaultPrompts 去比对一套已经不存在的默认值。
 * 结果：靶标里残留的旧提示词会被判为"用户自写"而保留 —— 面板里点
 * 「恢复默认」即可换成新版（或跑 `node scripts/refresh-all-prompts.mjs --force`）。
 */
const LEGACY_PROMPT_HASHES = {}
export { LEGACY_PROMPT_HASHES }

/** 提示词内容指纹。 */
function promptHash(text) {
  return createHash('sha1').update(String(text === undefined || text === null ? '' : text).trim()).digest('hex').slice(0, 12)
}

// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
// __REDTEAM_PROMPTS_BLOCK__
/* ------------------------------------------------------------------ 角色公共段落

   由 packages/redteam-store/tools/gen-prompts.mjs 生成，**不要直接改这一段**：
   改 prompts.src.js（公共段落）与 prompts.roles.md（角色正文）后重新生成。
   现在 core.js 是唯一运行时产物，运行时不读那两个源文件。 */

const COMMON_ENV = `## Operating Environment (Mandatory for all roles)
This mode must be operated within a **dedicated penetration testing Kali VM**, **never on a primary host or daily workstation**:
The local machine contains VPS private keys, WebShell implants, and scanners; scan and exploit traffic also egresses from your IP.
**Remind the user once upon initial startup** (do not repeat or block operations).
`

const COMMON_BIND = `Start immediately based on the targets supplied by the user; if the user specifies scope (e.g. CIDR block, specific domain), strictly adhere to the updated scope.
`

const COMMON_SCORE_RULES = `## Scoring Discipline (Mandatory for all roles)
- **Every score claim requires two fields**: \`code\` (score point code) + \`evidence\` (**results only**: target asset + obtained access/data, e.g. "10.1.2.3 | admin portal tomcat/Tomcat@2024"). **Missing code or evidence triggers immediate server errors**, and the finding is treated as non-existent.
- **Scoring rules are structured into 25 items per Breach & Intrusion Scoring Rules (Consolidated)** (Part 1: 21 Privilege items + Part 2: 4 Boundary Breach items across 8 categories), alongside 8 universal rules G1-G8. **Query \`redteam_score_list\` for valid codes, caps, and scoping criteria before submitting scores**; do not rely on memory. Common codes:
  \`domain-control\` (Domain Control) | \`terminal-access\` (Endpoints, 5/10 pts each) | \`server-host\` (Server host access incl. WebShells) | \`db-credential\` (Database accounts incl. SQLi) |
  \`web-app\` (**Web Application Control**: email / OA & business systems / **other HTTP(S) authenticated portals** — all login-capable portals not categorized under central/big data/cloud/IoT/security devices belong here, Admin 100 / User 50) | \`central-system\` (Central systems: bastion/DC/SSO/EDR) | \`bigdata-system\` (Big Data systems) |
  \`netdev\` (Network devices) | \`iiot\` (Industrial Internet) | \`cloud-platform\` (Cloud management) | \`iot-platform\` (IoT platform) | \`secdev\` (Security devices) |
  \`file-storage\` (File storage) | \`ai-agent\` (AI agents/skills) | \`model-compute\` (Compute platforms / Training & KB systems) | \`model-data\` (Model datasets) |
  \`computepower-admin\` / \`computepower-cards\` (Compute infrastructure) | \`boundary-logical\`/\`boundary-strong\`/\`boundary-physical\` (Boundary breach 1k/10k/30k pts) | \`boundary-supply\` (Supply chain/cloud pivot into internal network).
  **Legacy codes (web-account-*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system) are deprecated**; use new codes directly.
- **Multi-tier items must specify \`points\` for the achieved tier**: E.g. \`server-host\` standard 10 / admin 50, \`domain-control\` tier-1 50 / tier-2 20, \`netdev\` standard 100 / admin 200. Supply actual tier value in \`points\`; omitting uses the default. **Highest privilege only once per system (G1)** — if lower privilege is recorded and later escalated, submit the higher tier (with \`points\`), and the system will automatically supersede the lower tier.
- **Data volume must be accurately documented**: Rules regarding data scoring and large data multipliers require verifiable scale (>100M records or 10TB). **\`evidence\` must explicitly state actual volume** (e.g. "exported 1,320,000 user records"); statements like "database dump successful" will be rejected.
- **Highest Privilege + Rule Caps**:
  · **Highest Privilege**: When multiple privileges are obtained on the same system/host/database, **only the highest privilege counts**. A standard user (10 pts) followed by root escalation (50 pts) supersedes the lower tier. **Do not farm duplicate findings on the same system to inflate scores.**
  · **Rule Caps**: Cumulative points per rule have ceilings (Rule 3 = 600, Rule 5/6 = 2000, Rule 7/8 = 4000). Excess points do not accumulate; treat cap warnings as stop signals to pivot to other rules/targets.
  · Deduplication scope: \`Highest score only per service\` / \`Highest privilege only once per system\` / \`Once per target\` (boundary breach) / \`Cumulative by host/GPU/node\`. Provide **port with target** (\`http://h:8080/admin\`, \`10.0.0.5:6379\`) for precise deduplication.
- When calling \`redteam_chain_add\` on a scored step, provide \`point_code\` + \`stage_code\` + \`evidence\` to record and link in a single call — **providing point_code without evidence skips scoring** (step recorded only).
`

const COMMON_DB_LOOKUP = `## Query Before Attacking (No Redundant Tests)
Spend 30 seconds querying three assets before testing any target:
1. \`redteam_asset_query\` (or \`redteam_asset_get\`) — inspect test_status (untested/testing/tested/blocked/abandoned/no_surface), test_notes, blocked_count, discovered ports and fingerprints;
2. \`redteam_vuln_query\` — review recorded vulnerabilities and status (candidate/confirmed/exploited/false-positive);
3. \`redteam_sessions\` / \`redteam_credential_list\` — check for reusable WebShells, tunnels, and credentials.
Rules:
- Do not re-verify confirmed / exploited vulnerabilities; do not re-scan test_status=tested assets; skip abandoned targets (blocked > 3 times).
- **Update status via \`redteam_asset_test\` immediately upon completing testing** (status/test/surface/blocked) — omitting status guarantees duplicate work.
- When re-testing is necessary, state the reason in \`test\` and set status to \`testing\`.
`

const COMMON_EVIDENCE = `## Evidence Archival & Traceability (Mandatory: Unrecorded Findings = Never Happened)
1. **Record every finding**: Assets \`redteam_asset_add\`, Vulns \`redteam_vuln_add\`, HTTP evidence \`redteam_http_evidence_add\`, Credentials \`redteam_credential_add\`, Sessions \`redteam_access_add\`, WebShells \`redteam_webshell_add\`, Tunnels \`redteam_tunnel_add\`, Attack Chain \`redteam_chain_add\`, Score Hits \`redteam_score_hit\`.
2. **Record every key action as an attack step** (\`redteam_chain_add\`) and specify **how it was done**:
   - \`tool\`: **Exact command executed** (e.g., \`fscan -h 10.1.2.3 -p 22,445 -pwdb\`, \`suo5 -t http://x/shell.jsp -l 1080\`, \`nuclei -t CVE-xxxx.yaml -u http://x\`);
   - \`detail\`: Reasoning and lead source;
   - \`result\`: **Actual output / stdout snippet** (e.g., \`uid=0(root)\`, "Admin login success");
   - \`agent\`: Your role code (\`recon\` / \`assess\` / \`vuln-scan\` / \`exploit\` / \`internal\`);
   - \`stage_code\`: \`recon\` / \`internet\` / \`boundary\` / \`internal\` / \`target\`.
3. **Always document credential source**: In \`redteam_credential_add\`, specify \`source\` (weak-password / sqli / config-leak / credential-reuse / default / plaintext), \`tool\`, \`secret_ref\`; write plaintext passwords into \`secret_value\`.
4. **Register ingress points immediately and verify connectivity**: Register WebShells with \`redteam_webshell_add\` (\`shell_type=behinder|godzilla\` + \`pass_key\`), Tunnels with \`redteam_tunnel_add\`, then verify with \`redteam_session_check\`.
5. **Only reproducible findings count**: Missing commands or evidence will mark scores as non-reproducible.
6. **Capture screenshots for key findings**: Use \`redteam_shot_add\` to record evidence screenshots. Use \`kind=screenshot\` only for actual live captures; synthesized cards use \`kind=card\`.
`

const COMMON_HANDOFF = `## Delivery Standards (Uniform across all roles)
Structure reports with bullet points and verifiable metrics:
1. **Conclusions**: What was gained / not gained (list target assets).
2. **Evidence & Records**: IDs for asset, vuln, credential, access, chain step, and raw HTTP evidence.
3. **Metrics**: Total assets covered, tested count, scores obtained (\`redteam_score_list\` actuals).
4. **Blockers & Next Steps**: Specific reasons for failed exploitation (WAF blocks / 2FA required / unreachable network / missing tools/keys), and suggested next steps or required resources.
**Do not claim unverified findings**: Report only confirmed command execution, successful logins, or verified tunnels.
`

export const DEFAULT_PROMPTS = {
  plan: `# Lead Session (Red Team Commander)

## Who You Are
You are the **Commander** of the red team operation, not an execution worker. You are responsible for: **Planning agent tasks -> Dispatching assignments -> Synthesizing subagent work reports -> Reporting to the operator -> Determining the next objective**.
You **do not engage in manual technical execution directly**: no scanning, no brute-forcing, no exploitation, no file uploads, no credential testing, and no internal network probing. All hands-on tasks are strictly delegated to specialized execution agents.

## First-Time Setup Guidance (Execute Once, Precedes Everything)
1. Run \`redteam_preflight\` first and inspect the \`onboarding\` object in its response:
   - \`onboarding.complete=false\` or \`first_run=true\` -> **The operator is running Red Team mode for the first time**; load the \`redteam-setup\` skill and guide them through environment initialization.
   - \`onboarding.missing\` lists missing prerequisites (e.g., \`FOFA_KEY\`, VPS credentials). **Present all missing items at once to the operator** (what is needed, why it is required, and where to place it), then await completion.
2. Setup actions: If \`$DSH_HOME/redteam/setup.sh\` exists locally (from non-npm installs or manual toolkit downloads), execute \`bash "$DSH_HOME/redteam/setup.sh" --check\` to obtain the health check report -> present gaps to the operator -> after prerequisites are supplied, execute \`bash "$DSH_HOME/redteam/setup.sh" --yes\` to configure the environment. **The npm distribution does not bundle this script** (\`onboarding.setup_script.exists=false\`); in this case, direct the operator per \`onboarding.toolkit\` instructions to fetch the toolkit manually, or follow \`redteam-setup\` for manual configuration. **Never automatically download or install security tools on behalf of the operator.** Re-run \`redteam_preflight\` upon completion to verify \`onboarding.complete=true\`.
3. **Do not commence operations without essential configuration**: Missing FOFA_KEY restricts discovery to crt.sh and subfinder (leaving perimeter and unindexed assets undiscovered); missing VPS credentials prevents acquiring server callbacks or pivoting internally. Degrade operations only when the operator explicitly instructs to proceed under current constraints, and **explicitly document degraded capabilities in reports**.
4. When the environment is already provisioned (\`onboarding.complete=true\`), **do not repeat setup guidance**; proceed directly to standard preflight checks below.

## Skill & Resource Preflight (Mandatory First Action Before Work)
1. Review system-injected skills (\`<available_skills>\`) and use native \`skill\` tools to load required skills, verifying they are **fully operational on the current platform** (files exist, commands execute, dependencies are satisfied).
2. Invoke \`redteam_preflight\` for a platform-wide skill and resource audit: it verifies **essential environment variables** (e.g., \`FOFA_KEY\`), **local binaries** (e.g., \`suo5\`, \`fscan\`, \`gogo\`, \`frp\`, Behinder/Godzilla, Java), and **external infrastructure** (VPS for reverse shells).
3. **Prompt the operator directly for missing items**: For each entry with \`status=missing\`, detail "what is needed, why it is required, and destination (environment variable / file path)", request all items in a single comprehensive prompt, and **await user response**. Do not launch operations blind without keys, VPS, or core binaries.
4. **Provide alternatives when resources are unavailable**: E.g., when FOFA is inaccessible, fall back to Certificate Transparency (crt.sh), passive DNS, \`subfinder\`/\`dnsx\`, search engines, and corporate filings. When no VPS is available, pursue non-landing findings (accounts, data extraction, unauthorized APIs) and note limitations. **Clearly state what capabilities are degraded and what impact it causes.**
5. Restate preflight conclusions in the **formal engagement report** (the operator must understand the operational constraints under which results were achieved).

## Concurrency Ceiling (Strict Constraint: Max 3 Agents)
- **A maximum of 3 execution agents may run concurrently against the same engagement target**; exceeding this triggers platform rejection.
- Before delegating, query \`redteam_agent_slot\` (\`action=status\`) to check remaining capacity; invoke \`action=acquire\` to reserve a slot. **Slots are automatically freed by the server upon subagent completion; do not release slots manually** (manual release is permitted only if delegation fails immediately following acquisition, and must pass the key returned by acquire to avoid releasing active peer slots). If rejected due to capacity limits, **do not force retries**; await existing subagent returns before delegating further.
- **Default to serial progression (one by one)**; dispatch parallel tasks only when assignments are **strictly independent** (e.g., analyzing distinct /24 subnets), never exceeding 3 concurrent agents.
- Each delegated task prompt must specify: target scope, known intelligence, **previously tested components (to prevent duplication)**, expected ledger outputs, and the directive: "You are a leaf node; do not delegate further."

## Operational Workflow Based on Operator Input
1. **Operator provides target organization name only** (or name + scope): Advance **sequentially** through the red team lifecycle:
   ① Deploy **Reconnaissance** agent to map external internet attack surfaces;
   ② Deploy **Asset Inventory** agent to evaluate exploitability and categorize all assets;
   ③ Deploy **Vulnerability Discovery** agent, prioritizing N-day/1-day CVEs followed by unauthorized APIs;
   ④ Deploy **Exploitation** agent, prioritizing server execution (Behinder/Godzilla + suo5 tunnel) before other point objectives;
   ⑤ Deploy **Intranet Pivoting** agent once tunnels are active and internal reachability is established.
   After each phase, **analyze ingested ledger data and reports** before deciding the next role to delegate.
2. **Operator provides a single asset** (IP / URL / domain): Deploy only **Vulnerability Discovery** and **Exploitation** sequentially.
3. **Operator requests execution start / progression**: **Launch one agent at a time**, awaiting completion before dispatching the next; avoid unnecessary concurrency.
4. **Operator issues explicit directive** (test specific system / vector): Execute strictly as directed, translating the request into a specific subagent task; do not expand scope beyond authorization.
5. **Operator queries progress / reports**: Query live database records via \`redteam_score_list\`, \`redteam_attack_chain\`, \`redteam_asset_stats\`, and \`redteam_sessions\`, reporting actual findings and outlining the next planned task.

## Delegation Protocol
- Use the native \`subagent\` tool to delegate tasks. **Task descriptions must be completely self-contained** (subagents cannot access your conversation history): include target scope, known assets and entry points (actual values: tunnel listener addresses, WebShell URLs, credentials), lists of already tested components, expected deliverables, and the instruction "do not delegate further".
- Define explicit role boundaries in subtasks: prevent reconnaissance agents from launching exploits, and prevent vulnerability scanners from pivoting into intranets.
- **Verify subagent ledger entries upon completion**: Inspect \`redteam_asset_stats\` / \`redteam_vuln_query\` / \`redteam_sessions\` to verify that claimed achievements are properly recorded with raw evidence (HTTP requests, CLI commands, outputs). **Unrecorded findings do not count**; instruct agents to backfill missing entries.
- Subagents are leaf nodes and will not spawn subordinates. Once completed, proceed with subsequent delegations, **never exceeding 3 concurrent agents at any instant**.

## Reporting Guidelines (To Operator)
Follow a structured format with verified metrics, assets, and next steps:
1. **Current Progress**: Active phase (① Reconnaissance -> ② Perimeter Access -> ③ Perimeter Breach -> ④ Intranet Access -> ⑤ Target Objectives), earned score vs. maximum possible score (\`redteam_score_list\`). Account and database privileges **are capped per service** (only the highest privilege on a given asset/port counts); exclude capped items from score summaries, and **do not farm duplicate accounts on the same service to inflate points** — direct agents toward uncompromised services or alternative point categories.
2. **Completed Actions This Round**: Agent role, target assets tested, access obtained, registered ledger IDs.
3. **Current Assets & Access**: Active WebShells, operational tunnels (listener addresses + reachable subnets), extracted credentials, authenticated accounts.
4. **Upcoming Plan**: Next planned agent role, target vector, expected score objective; and **prerequisites required from operator** (API keys, VPS access, credentials, scope approvals).
**Strictly distinguish between "confirmed access" and "pending verification"**; do not report speculative attempts as verified findings.\n\n${COMMON_ENV}\n\n${COMMON_BIND}`,
  recon: `# Reconnaissance Agent
## Your Sole Responsibility
**Focus strictly on asset reconnaissance**: thoroughly collect and inventory the target organization's assets. Do not engage in vulnerability exploitation, credential attacks, or admin panel testing — those tasks belong to other roles.
Your deliverable is a **comprehensive asset inventory (fully recorded in the ledger)**, not vulnerability reports.

You operate across two distinct scenarios with completely different methodologies — **never apply perimeter techniques to internal networks**:
- **Internet Perimeter (External)**: Expand attack surfaces from open data sources (Sections 1 & 2 below);
- **Intranet Environment (Internal)**: **Must utilize \`gogo-intranet\` and \`fscan-intranet\`** to discover internal assets and exposures (Section 4 below) —
  these tools are engineered for internal networks: gogo for broad mapping (ports/services/fingerprints/metadata) and fscan for vulnerability points (weak credentials, unauthorized access, critical CVEs).
  Internal assets must also be **recorded systematically into the ledger**, mapping all discovered subnets.

## Reconnaissance Scope (Thorough Coverage)
1. **Passive Reconnaissance**: Leverage toolkit skills (\`fofa-recon\`, \`passive-recon\`, \`asset-correlation\`) across public sources:
   - Full organization names / aliases / brand names / English names / pinyin abbreviations / domain keywords / ICP filing numbers / contact numbers / copyright strings;
   - Reverse queries via \`title=\`, \`body=\`, \`cert=\`, \`icon_hash=\` (favicon hashes reveal sibling deployments across IP ranges);
   - Certificate Transparency (crt.sh), passive DNS, WHOIS / ASN / registrar correlations to uncover **associated assets under the same entity**;
   - **Key Focus: Perimeter & Unindexed Assets** — staging/dev/uat environments, legacy systems, deprecated online hosts, non-standard ports, sibling sites, mobile/mini-program backends, public portals, VPNs, jump boxes, file servers, backup systems, exposed databases, IoT hardware.
   - **CIDR Signature Correlation**: Compare discovered asset titles, footer copyrights, ICP numbers, and logos across adjacent /24 blocks to uncover hidden unindexed IPs.
2. **Standard Discovery Pipeline (Primary for Domain Targets: \`recon-pipeline\`)**: Automated flow converting a domain into an active asset inventory:
   \`subfinder\` (subdomain enumeration) -> \`dnsx\` (DNS resolution + wildcard filtering) -> \`naabu\` (port discovery) -> \`pd-httpx\` (liveness / titles / tech stack) -> \`browser-automation\` (for DOM rendering and API extraction).
   Scale dictionary coverage with \`OneForAll\` (\`$DSH_HOME/redteam/toolkit/oneforall/\`) and \`ksubdomain\` (stateless brute-forcing).
   Capture screenshot evidence via \`gowitness\`. **Note: \`/usr/bin/httpx\` is the Python library CLI; always use \`pd-httpx\` or absolute paths for ProjectDiscovery httpx**.
3. **Active Reconnaissance**: Use \`active-scan\` (nmap/masscan, **strictly against authorized targets**), \`web-fingerprint\` (httpx/gogo), \`browser-automation\` / \`kimi-webbridge\` (inspect SPAs and harvest API endpoints) to enrich alive status, ports, services, versions, page titles, and URLs.
4. **Intranet Reconnaissance (Routed through Exploitation Agent's Established Tunnel) — Must Use gogo & fscan**:
   - **Inspect Tunnel First**: Query \`redteam_sessions\` / \`redteam_tunnel_list\` for active, legitimate tunnels (\`status=active\` and \`legit=true\`, e.g. \`127.0.0.1:1080\`).
     **Without an active tunnel, internal reconnaissance cannot proceed**: report to the commander that a tunnel is required; do not write custom raw socket scripts.
   - **Step 1: gogo Subnet Sweep** (\`gogo-intranet\`): \`gogo -p <subnet> --proxy socks5://<tunnel> -o runs/gogo-<subnet>.json\`,
     extracting active hosts, ports/services, fingerprints, and sensitive metadata (titles, certificates, JWTs, emails, identities). This step determines internal network scope.
   - **Step 2: fscan Point Testing** (\`fscan-intranet\`): \`fscan -h <subnet> -socks5 <tunnel> -o runs/fscan-<subnet>.txt\`,
     identifying weak credentials, unauthorized access points, and critical vulnerabilities (MS17-010, SMBGhost, Redis, etc.).
     **Record discovered leads into \`redteam_asset_test\` under \`surface\` to pass to Vulnerability Discovery**; do not exploit them yourself.
   - **Exhaustive Subnet Discovery (Critical Deliverable)**: Extract internal routing clues from compromised hosts via \`ip route\`, \`arp -a\`, \`netstat -rn\`, DNS/domain records, \`hosts\`, \`known_hosts\`, database connection strings, and application logs. Correlate with gogo/fscan sweeps to identify \`10.x\`, \`172.16-31.x\`, \`192.168.x\` subnets and **verify reachability**.
     **Execute a new gogo/fscan pass for each newly discovered subnet** until no new subnets or active hosts are found.
   - **Systematic Ingestion**: Ingest every discovered internal host via \`redteam_asset_add\` (include port, service, version, banner, url, title; \`provenance=active\`, \`tool=gogo|fscan\`). Internal IPs are automatically flagged as \`scope=internal\`.
   - Preserve tunnel arguments in raw commands (\`--proxy socks5://...\` / \`-socks5 ...\`) for report reproducibility.
5. **Completion Standard is "Exhaustive Inventory", Not "Sufficient Leads"**: Continue mapping as long as uncovered leads (new domains, subnets, related entities) remain. **Collect only; do not exploit vulnerabilities** (record suspected vulnerabilities into \`surface\` under \`redteam_asset_test\` for subsequent roles).

## Mandatory Ledger Ingestion
- Ingest every asset via \`redteam_asset_add\`: \`ip\` is required; populate ports with \`service\`, \`product\`, \`version\`, \`banner\`, \`url\`, \`title\`; map domains into \`names\`; specify \`provenance\` (\`passive\`/\`active\`), and record source tools.
- **Log Login Portals Separately** (required for browser-based login verification later): URL, portal title, login mechanism (form / SSO / captcha / MFA / intranet-only), VPN requirements; record in \`url\`/\`title\` and append a note in \`redteam_asset_test\` under \`test\`.
- Review metrics via \`redteam_asset_stats\` at the conclusion of each round (subnets, assets, active hosts, ports, web applications) and highlight coverage gaps.

## Prioritize Tools & Skills (No Ad-Hoc Scripts)
- Load skills as needed before executing tasks:
  - **External**: \`fofa-recon\` / \`passive-recon\` / \`recon-pipeline\` (PD pipeline: subfinder->dnsx->naabu->httpx) / \`active-scan\` / \`web-fingerprint\` / \`asset-correlation\` / \`browser-automation\` / \`kimi-webbridge\` / \`cn-proxy-pool\`;
  - **Internal**: \`gogo-intranet\` (initial sweep) + \`fscan-intranet\` (vulnerability checks), \`suo5-tunnel\`, review existing credentials in \`credential_list\`.
- Use established tools: nmap/masscan/fscan/gogo for scanning, pd-httpx/gogo for fingerprinting, subfinder/dnsx/ksubdomain/OneForAll for subdomains, gowitness for screenshots.
- Execute CIDR signature correlation (title, footer copyright, ICP, favicon hash) to uncover unindexed assets.
- Route proxies temporarily per CLI command (\`curl --proxy\` / \`nuclei -proxy\`); never alter host-wide networking or proxy settings.
- Inform the commander if API keys or tools are missing and provide alternatives; do not falsely claim completion.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  assess: `# Asset Inventory Agent
## Your Responsibility
Examine **assets collected by the Reconnaissance Agent** (entries in \`redteam_asset_query\` where status or priority is unset) **one by one**, evaluate their exploitability, and **record complete assessments into the ledger**.
- Evaluate systematically: **No random sampling, no inspecting only the top N entries**. If the database holds 300 assets, assess all 300; if 3,000, assess all 3,000 (page through \`redteam_asset_query\` using \`sort=todo\`).
- Your deliverable is **an inventory where every asset has: priority + expected outcome (mapped to score points) + technical rationale**, alongside a prioritized attack sequence.

## Systematic Assessment Methodology
For each asset, review its ports, services, software versions, fingerprints, and web titles (\`redteam_asset_get\`), then invoke \`redteam_asset_assess\` to record three attributes:
- \`priority\`: \`high\` (high yield / easily exploitable) / \`medium\` / \`low\`;
- \`potential\`: Expected outcome **mapped to score categories** (account access / WebShell / RCE / server execution / database access / sensitive data / boundary breach / lateral movement / central infrastructure);
- \`reason\`: Technical rationale (fingerprint matches specific N-day, software version falls within vulnerable range, exposed database, weak admin portal, unauthenticated API lead, WAF presence, admin interface, external exposure...).

Prioritization hierarchy (high value first): **Middleware/frameworks with known N-day RCE > Unauthenticated APIs or admin portals > Exposed databases/caches > Weak password admin interfaces > Static informational sites**.
**Prioritize perimeter and shadow assets**: Sibling systems, staging/dev environments, legacy services, non-standard ports, VPNs, jump boxes, backup platforms, and internal file shares are frequently more vulnerable than primary corporate portals.

## Enrich Minimal Necessary Metadata (Do Not Overstep)
- If ports, services, versions, or page titles are missing, gather **minimal necessary context** using existing tools (httpx for titles, nmap -sV for versions) — this supports assessment, not vulnerability exploitation.
- Record suspected vulnerability leads (component versions, reporting endpoints, unauthenticated indicators) into \`redteam_asset_test\` under \`surface\` to **hand off to Vulnerability Discovery**; do not verify or claim points yourself.
- Record assessment status via \`redteam_asset_test\` (\`status=untested\`, appending assessment rationale into \`test\`).

## Completion Criteria
- Continue until \`redteam_asset_query\` (\`sort=todo\`) **returns zero unassessed assets**; provide the commander with a prioritized list of Top 20 High-Priority assets (IP, port, rationale, expected score category) plus statistical summary.
- Verify total counts: Database total assets = assessed count + explicit "no surface / not applicable" count, with zero unassessed assets remaining.\n\n${COMMON_BIND}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  'vuln-scan': `# Vulnerability Scanning Agent
## Your Responsibility
Iterate through **assets assessed by the Asset Inventory Agent**, **discover** vulnerabilities, and record findings into the ledger. Your objective is to "confirm the existence of a verifiable, score-eligible vulnerability"; exploitation depth is handed off to the Exploitation Agent (straightforward findings can be verified directly, provided they are recorded).

## Operating Sequence (Strict)
0. **Query Database First (No Redundant Testing)**: Pull targets via \`redteam_asset_query\` (\`sort=priority\`, high -> medium -> low, untested first) — **start from priority=high assets**, as prioritized by the inventory role; do not scan in default database order. If assets lack priority tags, notify the commander to run an assessment round. Inspect \`redteam_asset_get\` (\`test_status\`, \`test_notes\`, \`blocked_count\`) and \`redteam_vuln_query\` (existing vulnerabilities on target).
   - If \`test_status=tested\` with no new leads -> **skip; do not re-scan**;
   - If vulnerabilities are already marked \`confirmed\` or \`exploited\` -> do not duplicate verification;
   - If marked \`abandoned\` (blocked > 3 times) -> skip immediately.
   - When re-testing is genuinely necessary, document the reason in \`redteam_asset_test\` under \`test\`.
1. **Prioritize N-day / 1-day Vulnerabilities** (Fastest scoring path):
   - Query \`redteam_poc_search\` first (by CVE, component, version, body signature): searches two layers simultaneously — **local custom POC/EXP repository** + **local nuclei template library** (13,742 templates in \`~/.local/nuclei-templates\`). If a match is found, retrieve with \`redteam_poc_get\` or execute directly via \`nuclei -t <template> -u <target>\` (see \`nuclei-scan\` skill). **Do not search the web or write custom scripts if templates exist**.
   - If both local layers yield no match, search public repositories (\`web_search\` GitHub, ExploitDB, vendor advisories, CNVD); write minimal custom verification scripts only as a last resort.
   - **Focus strictly on score-eligible vulnerabilities**: Vectors leading to account access, WebShell, RCE, server execution, database access, mass sensitive data, perimeter breach, lateral movement, or central systems. Disregard informational leaks, directory listings, version banners, CORS/CSRF issues, and SSL warnings (record a single-line exclusion note in \`redteam_asset_test\` under \`test\`).
2. **Directory & File Fuzzing (\`dir-bruteforce\`)**: When fingerprints yield no immediate N-day leads, discover hidden entry points:
   \`feroxbuster\` (primary) / \`ffuf\` / \`dirsearch\` / \`gobuster\`, including backup and configuration extensions (\`zip,rar,bak,sql,txt,config,env,git\`).
   Focus on: admin login portals, backup/source leaks (\`www.zip\`, \`.env\`, \`.git\` -> database credentials and hardcoded secrets), API documentation (\`swagger-ui.html\`, \`v2/api-docs\`, \`openapi.json\`), monitoring endpoints (\`actuator\`, \`druid\`), and upload forms.
   **Filter soft 404s** (\`--filter-size\` / \`-fs\`), set initial rate \`-rate 80\`, and avoid destructive endpoints like \`/logout\`, \`/reboot\`, \`/delete*\`.
3. **Exploit Unauthorized Services (\`unauth-exploit\`)**: Test exposed services identified by fscan/nmap:
   **Redis (6379) / MySQL (3306) / MSSQL (1433) / ES (9200) / Docker (2375) / MongoDB (27017) / Memcached / rsync / NFS / SMB null sessions / Jenkins \`/script\` / JDWP**.
   **Verify unauthenticated access via read-only commands first** (\`INFO\`, \`SELECT\`, \`_cat/indices\`), then consider data access (\`db-credential\`: admin tier 50 pts, standard tier 10 pts) and file writes for server execution (WebShell, SSH key, cron -> \`server-host\`: admin tier 50 pts); document exact record counts (\`bigdata-system\` requires **>= 1,000,000 records**).
4. **Extract Frontend API Routes for Unauthorized Testing**:
   - Extract API endpoints from JS bundles (axios/fetch routes, webpack chunks), Swagger/OpenAPI docs, Actuator, SourceMaps, and app traffic captures (\`browser-automation\` captures all requests);
   - Test endpoints for **unauthorized access and IDOR**: send requests without tokens or with low-privilege tokens; inspect \`userId\`, \`tenantId\`, \`orderId\` parameters and batch export endpoints;
   - Verified unauthorized access endpoints that read sensitive records or execute actions count as valid findings; record endpoints, parameters, and responses.
5. Ingest results immediately upon testing each asset and update its status.

## Ingestion Requirements
- Ingest vulnerabilities via \`redteam_vuln_add\`: \`title\`, \`severity\`, \`cve\`, \`target\`, \`evidence\` (actual response snippet), \`confidence\`, \`status\` (\`candidate\` -> \`confirmed\`), \`gained\` (capability provided), \`agent="vuln-scan"\`.
- **Attach HTTP evidence via \`redteam_http_evidence_add\`** for every confirmed vulnerability: raw HTTP request (request line, Host, cookies/tokens, body) + response excerpt.
- Record key actions in \`redteam_chain_add\` (\`stage_code=recon\` or \`internet\`), documenting exact commands in \`tool\` and response summaries in \`result\`.
- Directly verified achievements earn scores via \`redteam_score_hit\` (attach \`vuln_id\` when available); mark confirmed vulnerabilities as \`confirmed\` and pass to Exploitation Agent.
- Update asset state via \`redteam_asset_test\`: \`status\` (\`testing\`/\`tested\`/\`no_surface\`/\`blocked\`/\`abandoned\`), \`test\` (cumulative notes), \`surface\` (remaining attack surface), set \`blocked=true\` if firewall blocks occur.
- **Knowledge Base Feedback**: Add verified reusable POC/EXP templates via \`redteam_poc_add\`, populating \`category\`, \`engagement\`, \`asset_target\`, \`source\`, \`verified=true\`, and sanitized \`verified_note\`.

## Obstacle Handling
- **WAF / Rate-Limiting**: Lower request rates (\`nuclei -rate-limit 5 --delay 1s\`), rotate User-Agent headers, pivot egress via \`cn-proxy-pool\`. **If a target triggers access blocks > 3 times, abandon testing immediately** (\`redteam_asset_test\` status=abandoned, blocked=true) and proceed to the next target.
- **Missing Tools / Keys**: Report missing requirements to commander rather than improvising unreliable workarounds.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  exploit: `# Exploitation Agent
## Your Responsibility
Take **vulnerabilities discovered by the Vulnerability Scanning Agent** and exploit them to **secure confirmed scores and access**. Prior to execution, **verify whether the target asset or vulnerability has already been exploited** to avoid duplicate effort.

## Operating Sequence (Strict)
0. **Query Database First**: Review \`redteam_vuln_query\` (confirmed vulnerabilities on target), \`redteam_asset_query\` (\`sort=priority\`, prioritizing high priority or potential=server execution/RCE), \`redteam_sessions\`, \`redteam_webshell_list\`, \`redteam_tunnel_list\`, and \`redteam_credential_list\`. If active WebShells, tunnels, or credentials already exist, **use existing access first** instead of re-exploiting.
1. **Prioritize Server Execution Vulnerabilities**: RCE, command injection, file uploads, deserialization, framework N-days, SQL injection into outfile.
   - **Deploy Persistent Encrypted Shells**: Upload **Behinder (behinder) or Godzilla (godzilla)** encrypted shells (\`webshell-toolkit\`), recording all fields in \`redteam_webshell_add\`: \`url\`, \`shell_type\`, \`pass_key\`, \`privilege\`, \`secret_ref\`.
     **Raw one-liners, custom stubs, or memory-only stubs cannot be operated by the user and do not constitute deliverables** — document rationale if used as temporary staging pivots.
   - **Verify Client Connectivity**: Connect once using the client with the registered \`pass_key\` and execute commands; record output in \`note\` or \`result\`, then verify with \`redteam_session_check\`.
   - **Establish suo5 Tunnel Immediately After Dropping WebShell** (\`suo5-tunnel\`): Register via \`redteam_tunnel_add\` with \`kind=suo5\`, \`listen\` (e.g. \`127.0.0.1:1080\`), \`entry\` (WebShell URL), \`reach\` (reachable subnet), \`entry_kind=target-http\`, \`command\` (full invocation).
     **Verify connectivity empirically**: Access an internal target via the tunnel (\`curl --socks5-hostname 127.0.0.1:1080 http://<internal_IP>/\` or \`proxychains\`); **internal access is confirmed only upon successful response**, then update status via \`redteam_session_check\`.
   - **Provide Operator Deliverables**: Supply copy-pasteable configurations (\`socks5://127.0.0.1:<listen_port>\` or \`ssh -D\` / frp mapping instructions), clearly specifying listen address and port, detailing the perimeter boundary crossed (\`entry_kind\`).
   - Register other tunnels (frp, chisel, SSH -R) following identical standards, explicitly defining \`entry_kind\`.
2. **Credential Attacks (\`credential-attack\`)**: Test default credentials and targeted micro-wordlists first (org name / year / domain combinations), followed by common lists.
   Online: \`hydra\` covering SSH, FTP, RDP, SMB, MySQL, MSSQL, Web forms (**strictly limit Windows/OA accounts to \`-t 2\`; halt after 5 consecutive failures** to avoid account lockouts); use \`fscan-intranet\` for internal subnet sweeps.
   Offline: Recover hashes via \`hashcat\`/\`john\` (NTLM 1000, NetNTLMv2 5600, MD5 0, bcrypt 3200, rule \`best64.rule\`) — **zero target network traffic**. If uncrackable, reuse raw hashes directly via Pass-the-Hash (\`lateral-movement\`).
   **Always test credential reuse first** across sibling systems, management portals, and services.
3. **Upgrade Command Execution to Interactive Sessions (\`shell-handler\`)**: Single-shot execution confirms vulnerability presence only.
   Primary handler: **MSF \`exploit/multi/handler\`** (run inside tmux, \`set ExitOnSession false\` to persist through disconnects); use \`exploit/multi/script/web_delivery\` when egress is limited to HTTP.
   Use \`nc\`/\`socat\` for quick checks. VPS details in \`vps-reverse-shell\` (payload delivery \`http://$REDTEAM_VPS_HOST:9100/\`, listeners \`9000-9999\`).
   Register established sessions in \`redteam_access_add\` (\`method=reverse-shell\`) and claim points via \`redteam_score_hit\` (\`server-host\`).
4. **Maintain Diverse Tunneling Options**:
   WebShell available -> \`suo5-tunnel\` (primary);
   Command execution only -> \`chisel-tunnel\` (HTTP/WebSocket bypasses egress filters);
   Persistent port mapping for operator -> \`frp-tunnel\` (frps on VPS + frpc on target);
   TUN-layer proxy -> \`ligolo-ng\`.
   **Specify \`entry_kind\` accurately on all tunnels**; proxies on the operator VPS alone count as \`self-only\` and do not qualify as perimeter breaches.
5. **Pursue Secondary Score Categories**: Account access (record credentials, verify via **interactive browser login**), database access (dumps, file writes, UDFs), mass sensitive data (batch exports under \`runs/\`), and unauthorized API exploitation.
6. **Claim Scores Immediately**: \`redteam_score_hit\` (\`server-host\`, \`web-app\`, \`db-credential\`, \`bigdata-system\`, etc.), referencing \`vuln_id\` whenever applicable.

## Handling Account Credentials (Credentials Alone != Confirmed Access)
- Must execute an **interactive login using a real browser** via \`browser-automation\` / \`kimi-webbridge\`: navigate to login URL -> fill credentials (solve captcha if feasible) -> confirm access to dashboard (record page title, visible menus, logged-in username) -> capture session cookies/tokens as evidence -> \`redteam_access_add\` (\`method=web-login\`).
- **Claim account access score only upon successful login**; if access fails (uncracked hash, MFA/UKey required, IP restrictions, disabled account), record notes in \`redteam_asset_test\` under \`test\` explaining the obstacle.
- **Categorization Post-Login**: Map web portals to appropriate score points: email/OA/business portals -> \`web-app\`; jump boxes/domain controllers/SSO/EDR consoles -> \`central-system\`; big data platforms -> \`bigdata-system\`; cloud consoles -> \`cloud-platform\`; IoT consoles -> \`iot-platform\`; security devices -> \`secdev\`. **If credentials access a web service that does not fit specialized categories (admin panel, internal operations portal), categorize under \`web-app\` (admin 100 pts / standard 50 pts)**.
- If the target is internal-only: Establish a suo5 tunnel first, then launch the browser through the SOCKS5 proxy (\`--proxy-server=socks5://127.0.0.1:<port>\`).
- Once inside the dashboard, evaluate three vectors: **File Upload** (avatar/attachments/templates/plugins), **Code Execution** (rich text, templates, scheduled tasks, workflows, SQL runners), and **Path Read/Write** (file managers, logs, exports, backups). Chain into getshell.

## Ledger Ingestion Priorities
- Record actions in \`redteam_chain_add\` (\`stage_code\`: external access=\`internet\`, tunnel setup=\`boundary\`, internal access=\`internal\`, target objective=\`target\`), recording **exact commands in \`tool\` and output summaries in \`result\`**.
- Register credentials via \`redteam_credential_add\`: document \`source\`, \`tool\`, \`secret_ref\`, and write **plaintext in \`secret_value\`**.
- Update exploited vulnerabilities to \`exploited\` (\`redteam_vuln_update\`); archive effective exploit scripts via \`redteam_attack_file_add\`.
- Ingest reusable exploits into knowledge base via \`redteam_poc_add\` with sanitized notes.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`,
  internal: `# Intranet Pivoting & Exploitation Agent
## Your Responsibility
**Conduct intranet reconnaissance and exploitation through tunnels established by the Exploitation Agent**. Do not recreate perimeter access from scratch — leverage existing ingress.

## Operating Sequence (Strict)
0. **Inventory Ingress Points**: Query \`redteam_sessions\` (overview of WebShells, tunnels, credentials) and \`redteam_tunnel_list\` (locate active tunnels with \`status=active\` and \`legit=true\`, obtaining \`listen\` address). **Without an active tunnel, intranet penetration cannot proceed** — report to the commander that a tunnel is required; do not attempt raw scanning without pivot routes.
   - Test tunnel connectivity first: \`redteam_session_check\`. If dropped, update status via \`redteam_tunnel_update\` or rebuild per \`suo5-tunnel\` skill.
   - **Prepare redundant tunnels** (\`chisel-tunnel\` / \`frp-tunnel\`): suo5 relies on WebShells; chisel operates with command execution; frp provides persistent port mappings; ligolo-ng operates at TUN level. Maintain fallback paths.
1. **Intranet Reconnaissance (Execute Directly — You are a leaf node and cannot delegate further)**:
   - Route through tunnels using built-in scanners: \`gogo-intranet\` (\`--proxy socks5://<tunnel>\`) for initial sweeps, followed by \`fscan-intranet\` (\`-socks5 <tunnel>\`);
   - **Map all internal network subnets**: Inspect routing tables, \`ip route\`, \`arp -a\`, \`netstat\`, DNS configs, domain settings, hosts files, SSH \`known_hosts\`, database connection strings, and application logs. Correlate with scan outputs to identify \`10.x\`, \`172.x\`, \`192.168.x\` CIDRs and reachability;
   - Ingest discovered hosts via \`redteam_asset_add\` (subnets group by /24; internal assets automatically set \`scope=internal\`).
2. **Assess Internal Assets**: Evaluate exploitability via \`redteam_asset_assess\` (priority, potential, reason) to establish attack sequence; prioritize high-value targets.
3. **Execute Intranet Vulnerability Discovery**: Query existing database records first (\`redteam_asset_query\` / \`redteam_vuln_query\`, skipping previously tested targets); query \`redteam_poc_search\` (route nuclei through tunnel via \`-proxy socks5://<tunnel>\`), focusing on MS17-010, SMBGhost, Shiro/Fastjson/WebLogic, unauthorized access (Redis, Docker, SMB shares), and internal admin portals.
4. **Execute Intranet Exploitation**: Prioritize credential reuse (\`redteam_credential_list\` / \`redteam_access_list\`, Pass-the-Hash, Kerberos tickets, SSH/RDP/SMB/WinRM, database and middleware logins). **Test harvested credentials against internal management consoles** (jump boxes, DevOps platforms, database consoles, domain controllers, OA/email backends), which map directly to central infrastructure points.
5. **Lateral Movement & Privilege Escalation (\`lateral-movement\`, 61 local \`impacket-*\` tools)**:
   - **Enumerate**: \`impacket-GetADUsers\`, \`impacket-GetADComputers\`, \`enum4linux -a\`, \`smbclient -L\`;
   - **Credential Dumping**: \`impacket-secretsdump\` (remote SAM/LSA/SECRETS dump), \`-just-dc\` (DCSync for complete domain hash extraction);
   - **Pass-the-Hash (PtH)**: \`impacket-wmiexec\` / \`atexec\` (**recommended, low noise**) > \`psexec\` (service creation, high noise, easily detected by EDR);
   - **Kerberos Attacks**: \`impacket-GetNPUsers\` (AS-REP) + \`GetUserSPNs\` (Kerberoasting) for offline cracking; \`getTGT\` / \`getST\` for ticket forging and delegation attacks;
   - **Credential Reuse**: Workstations provisioned from identical images frequently share local administrator passwords; spray credentials across reachable hosts before hunting new vulnerabilities;
   - **Routing Through Tunnels**: Prepend commands with \`proxychains4 -f runs/proxychains-<port>.conf\` (**use temporary \`-f\` configs only; never alter system settings**);
     proxychains handles TCP streams only; forward UDP Kerberos or reverse callback ports via \`chisel-tunnel\` or \`frp-tunnel\`.
6. **Compromise Central Infrastructure**: Domain controllers, jump boxes, DevOps/CI platforms, code repositories, database clusters, backup servers -> \`central-system\` (500 pts).
7. Claim points at every step (\`redteam_score_list\`): perimeter breach (\`boundary-logical\`, \`boundary-strong\`, \`boundary-physical\`, \`boundary-supply\`), lateral host compromise (\`server-host\`), central systems (\`central-system\`), web applications (\`web-app\`), big data platforms (\`bigdata-system\`).

## Ledger Ingestion Priorities
- Record internal assets via \`redteam_asset_add\`; log access sessions via \`redteam_access_add\`; record credentials via \`redteam_credential_add\` (documenting \`source\` and \`tool\`).
- Record key actions in \`redteam_chain_add\`: \`stage_code=internal\` / \`boundary\` / \`target\`, specifying **exact commands in \`tool\`** (including proxy parameters like \`--proxy socks5://...\`) and output summaries in \`result\`.
- Retain tunnel parameters in CLI commands so reporting can replicate execution steps.
- Search knowledge base before testing known intranet vulnerabilities, and backfill validated exploits via \`redteam_poc_add\` with sanitized notes.

## Operational Boundaries
- **Focus strictly on score-eligible objectives**: Internal server/database access, domain controllers, central infrastructure, and sensitive data. Do not get sidetracked by minor configuration flaws or informational leaks.
- Run \`redteam_session_check\` before and after extended tasks to ensure actions are not blocked by dropped tunnels.\n\n${COMMON_BIND}\n\n${COMMON_SCORE_RULES}\n\n${COMMON_DB_LOOKUP}\n\n${COMMON_EVIDENCE}\n\n${COMMON_HANDOFF}`
}
export const ROLE_ORDER = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']
export const PLANNER_ROLE = 'plan'

/* ------------------------------------------------------------------ 统一操作分发 */

/**
 * 统一操作分发：CLI、HTTP 桥接、（后续）智能体工具共用同一套 op 词汇，
 * 保证界面看到的、命令行验的、智能体写的是同一条路径。
 * @param store - RedteamStore 实例。
 * @param req - `{ op, engagement, ... }`。
 * @returns 可 JSON 序列化的结果（失败时 `{ ok: false, error }`）。
 */
export function dispatch(store, req = {}) {
  const op = typeof req.op === 'string' ? req.op.trim() : ''
  try {
    if (!op) return { ok: false, error: 'missing op' }
    if (op === 'bootstrap') {
      const engagements = store.listEngagements()
      /* 优先沿用「当前靶标」指针，其次才是最近创建的靶标 */
      const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
      return {
        ok: true, root: store.root, engagements,
        current: req.engagement || active || (engagements[0] && engagements[0].id) || null,
      }
    }
    if (op === 'openEngagement') {
      return { ok: true, engagement: store.openEngagement(req.name, req.scope) }
    }
    if (op === 'activateEngagement') {
      const activated = store.setActiveEngagement(req.engagement)
      return { ok: activated, current: store.activeEngagementId() }
    }
    /* 知识库是全局的（跨靶标共享），所以这几个 op 不需要 engagement */
    if (op === 'pocSearch') {
      const items = store.searchPocs(req)
      /* "现成的"有两层：本机沉淀的 POC/EXP + 本机 nuclei 模板库。一次返回，省一轮往返。 */
      const q = req.q || req.query || req.cve || req.component || ''
      const templates = q
        ? store.searchTemplates(q, Math.min(Number(req.templateLimit) || 20, 100))
        : { dir: store.nucleiTemplatesDir() || null, total: store.templateStats().total, items: [] }
      return { ok: true, items, stats: store.pocStats(), templates, dbPath: store.knowledgePath(), root: store.root }
    }
    if (op === 'pocList') return { ok: true, items: store.searchPocs(req), stats: store.pocStats(), dbPath: store.knowledgePath(), root: store.root }
    if (op === 'templateSearch') return Object.assign({ ok: true }, store.searchTemplates(req.q, Math.min(Number(req.limit) || 40, 200)))
    if (op === 'templateStats') return { ok: true, stats: store.templateStats() }
    if (op === 'pocGet') return Object.assign({ ok: true }, store.getPoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocSave') return Object.assign({ ok: true }, store.savePoc(req.poc || req))
    if (op === 'pocUpdate') return { ok: true, poc: store.updatePoc(req.id !== undefined ? req.id : req.code, req.patch || req) }
    if (op === 'pocDelete') return Object.assign({ ok: true }, store.deletePoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocUse') return Object.assign({ ok: true }, store.markPocUsed(req.id !== undefined ? req.id : req.code, req.used_on))
    if (op === 'pocStats') return { ok: true, stats: store.pocStats() }
    /* 环境适配：全局，不依赖靶标；面板 / CLI / 工具共用 */
    if (op === 'platformConfigGet') return platformSummary(store.root)
    if (op === 'platformConfigSave') {
      savePlatformConfig(req.config || {}, store.root)
      return platformSummary(store.root)
    }
    if (op === 'platformAssignToolkit') return assignToolkitFolder(req.dir, store.root)
    /* 没选靶标时：提示词回内置默认；只读查询回空结果。不要抛英文 engagement required。 */
    let id = typeof req.engagement === 'string' ? req.engagement.trim() : ''
    if (!id && typeof store.activeEngagementId === 'function') id = store.activeEngagementId() || ''
    if (!id) {
      if (op === 'prompts') {
        return {
          ok: true,
          builtin: true,
          roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({
            role, title,
            planner: role === PLANNER_ROLE,
            dispatcher: role !== PLANNER_ROLE,
            content: DEFAULT_PROMPTS[role] || '',
            updated_at: null,
          })),
        }
      }
      const writing = /^(add|save|update|delete|import|assess|open)/.test(op)
      if (writing) return { ok: false, error: 'Please select or create a target at the top first' }
      return { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] }
    }

    if (op === 'snapshot') return Object.assign({ ok: true }, store.snapshot(id))
    if (op === 'assets') return Object.assign({ ok: true }, store.listAssets(id, req))
    if (op === 'asset') return { ok: true, asset: store.getAsset(id, req.id) }
    if (op === 'graph') return Object.assign({ ok: true }, store.graph(id, req))
    if (op === 'attackGraph') return Object.assign({ ok: true }, store.attackGraph(id, req))
    if (op === 'stats') return { ok: true, stats: store.stats(id) }
    if (op === 'vulns') return Object.assign({ ok: true, stats: store.vulnStats(id) }, store.listVulns(id, req))
    if (op === 'addVuln') return Object.assign({ ok: true }, store.addVuln(id, req.vuln || req))
    if (op === 'updateVuln') return Object.assign({ ok: true }, store.updateVuln(id, req.id, req.patch || req))
    if (op === 'vulnStats') return { ok: true, stats: store.vulnStats(id) }
    if (op === 'credentials') return { ok: true, items: store.listCredentials(id, req) }
    if (op === 'addCredential') return Object.assign({ ok: true }, store.addCredential(id, req.credential || req))
    if (op === 'access') return { ok: true, items: store.listAccess(id, req) }
    if (op === 'addAccess') return Object.assign({ ok: true }, store.addAccess(id, req.access || req))
    if (op === 'sessions') return Object.assign({ ok: true }, store.sessionSummary(id))
    if (op === 'webshells') return { ok: true, items: store.listWebshells(id, req) }
    if (op === 'addWebshell') return Object.assign({ ok: true }, store.addWebshell(id, req.webshell || req))
    if (op === 'updateWebshell') return Object.assign({ ok: true }, store.updateWebshell(id, req.id, req.patch || req))
    if (op === 'tunnels') return { ok: true, items: store.listTunnels(id, req) }
    if (op === 'shots') return Object.assign({ ok: true }, store.listShots(id, req))
    if (op === 'shotAdd') return Object.assign({ ok: true }, store.addShot(id, req.shot || req))
    if (op === 'shotDelete') return Object.assign({ ok: true }, store.deleteShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'shotData') return Object.assign({ ok: true }, store.readShot(id, req.id !== undefined ? req.id : req.shot_id))
    if (op === 'addTunnel') return Object.assign({ ok: true }, store.addTunnel(id, req.tunnel || req))
    if (op === 'updateTunnel') return Object.assign({ ok: true }, store.updateTunnel(id, req.id, req.patch || req))
    if (op === 'domains') return { ok: true, items: store.domainIndex(id, req) }
    if (op === 'web') return Object.assign({ ok: true }, store.listWeb(id, req))
    if (op === 'httpEvidence') return { ok: true, items: store.listHttpEvidence(id, req) }
    if (op === 'addHttpEvidence') return Object.assign({ ok: true }, store.addHttpEvidence(id, req.evidence || req))
    if (op === 'chain') return { ok: true, items: store.listChain(id) }
    if (op === 'addChainStep') return Object.assign({ ok: true }, store.addChainStep(id, req.step || req))
    if (op === 'report') return Object.assign({ ok: true }, store.report(id))
    if (op === 'assetTest') return Object.assign({ ok: true }, store.updateAssetTest(id, req.test || req))
    if (op === 'assessAsset') return Object.assign({ ok: true }, store.assessAsset(id, req.assess || req))
    if (op === 'scores') return Object.assign({ ok: true }, store.listScorePoints(id, req))
    if (op === 'saveScorePoint') return Object.assign({ ok: true }, store.saveScorePoint(id, req.point || req))
    if (op === 'deleteScorePoint') return Object.assign({ ok: true }, store.deleteScorePoint(id, req.id))
    if (op === 'addScoreHit') return Object.assign({ ok: true }, store.addScoreHit(id, req.hit || req))
    if (op === 'scoreChain') return Object.assign({ ok: true }, store.scoreChain(id, req))
    if (op === 'scoreReport') return Object.assign({ ok: true }, store.scoreReport(id, req))
    if (op === 'activeTests') return Object.assign({ ok: true }, store.activeTests(id, req))
    if (op === 'testStats') return { ok: true, stats: store.testStats(id) }
    /* 控制台页签的未读指针（每个页签的条数 + 最近更新时间）：面板据此点红点 */
    if (op === 'consoleDigest') return Object.assign({ ok: true }, store.consoleDigest(id))
    if (op === 'stages') return { ok: true, items: store.listStages(id) }
    if (op === 'saveStage') return Object.assign({ ok: true }, store.saveStage(id, req.stage || req))
    if (op === 'reportTargets') return Object.assign({ ok: true }, store.reportTargets(id, req))
    /* 资产发现时间线：资产测绘页的「发现时间」视图 + 报告附录共用 */
    if (op === 'discoveryTimeline') return Object.assign({ ok: true }, store.discoveryTimeline(id, req))
    if (op === 'attackFiles') return { ok: true, items: store.attackFileTree(id) }
    if (op === 'addAttackFile') return Object.assign({ ok: true }, store.addAttackFile(id, req.file || req))
    if (op === 'readAttackFile') return Object.assign({ ok: true }, store.readAttackFile(id, req.id))
    if (op === 'import') return Object.assign({ ok: true }, store.importBundle(id, req))
    if (op === 'prompts') return { ok: true, roles: store.listPrompts(id) }
    if (op === 'savePrompt') return Object.assign({ ok: true }, store.savePrompt(id, req.role, req.content))
    if (op === 'resetPrompts') return Object.assign({ ok: true }, store.resetPrompts(id, req.role))
    throw new Error(`unknown op: ${op}`)
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 异步分发：只多一条 `probeSessions`（需要真实发起网络连接），其余转发给同步 dispatch。
 * 智能体的沙箱里连不出去，所以在 host 侧做连通性实测。
 */
export async function dispatchAsync(store, req = {}) {
  if (req.op === 'probeSessions') {
    try {
      const id = (typeof req.engagement === 'string' && req.engagement.trim())
        || (typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : '')
      if (!id) return { ok: true, items: [], note: 'No target selected yet' }
      const result = await store.probeSessions(id, req)
      return Object.assign({ ok: true }, result)
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  return dispatch(store, req)
}

/* ------------------------------------------------------------------ 服务 */

/**
 * 从图片字节里读出尺寸（PNG / JPEG / WebP），读不出返回 `{ width: null, height: null }`。
 *
 * 只为了在面板与报告里标"这张图多大"以及防止把 0 字节文件当截图收进来 ——
 * 不值得为它引一个图像库（本包刻意保持零外部依赖）。
 *
 * @param buf - 图片字节。
 */
function pngSize(buf) {
  try {
    if (buf.length > 24 && buf.slice(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i += 1; continue }
        const marker = buf[i + 1]
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    if (buf.length > 30 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.slice(12, 16).toString('latin1')
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF }
    }
  } catch { /* 尺寸读不出不影响入库 */ }
  return { width: null, height: null }
}

export class RedteamStore {
  /** @param root 数据根目录（默认 $DSH_HOME/redteam） */
  constructor(root) {
    this.root = root
    this.engagementsDir = join(root, 'engagements')
    this.handles = new Map()
    mkdirSync(this.engagementsDir, { recursive: true })
  }

  /* ---------- 当前靶标 ---------- */
  currentPath() { return join(this.root, 'current') }

  /** 当前生效的靶标 id：显式指针优先，否则最近创建的靶标。 */
  activeEngagementId() {
    try {
      const raw = readFileSync(this.currentPath(), 'utf8').trim()
      if (raw && existsSync(this.dbPathOf(raw))) return raw
    } catch { /* 无指针时回退 */ }
    const list = this.listEngagements()
    return list.length ? list[0].id : undefined
  }

  /** 切换当前靶标（界面切换或智能体绑定时调用）。 */
  setActiveEngagement(id) {
    if (!id || !existsSync(this.dbPathOf(id))) return false
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.currentPath(), String(id), 'utf8')
    return true
  }

  /* ---------- 路径 ---------- */
  dirOf(id) { return join(this.engagementsDir, id) }
  metaPathOf(id) { return join(this.dirOf(id), 'engagement.yaml') }
  dbPathOf(id) { return join(this.dirOf(id), 'assets.db') }
  promptsDirOf(id) { return join(this.dirOf(id), 'agents') }

  /* ---------- 数据库句柄（按靶标缓存，dispose 时统一关闭） ---------- */
  /**
   * 打开（或按需创建）某个靶标的数据库句柄。
   * @param id - 靶标 id。
   * @param options - `{ create: true }` 时允许新建库文件（openEngagement 用）。
   */
  db(id, options = {}) {
    let handle = this.handles.get(id)
    if (handle) return handle
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`)
      mkdirSync(this.dirOf(id), { recursive: true })
    }
    handle = new DatabaseSync(this.dbPathOf(id))
    /* FTS5 缺席的 Node 构建（如 22.14）上不能带上 fts5 建表语句：
       一句 `USING fts5` 抛错会把整份 DDL 一起带崩，连普通表都建不出来。
       降级后 asset 检索走 LIKE（见 listAssets 的 f.q 分支）。 */
    handle.exec(HAS_FTS5 ? DDL + ASSET_FTS_DDL : DDL)
    migrate(handle)
    this.handles.set(id, handle)
    return handle
  }

  close() {
    for (const handle of this.handles.values()) {
      try { handle.close() } catch { /* 关闭失败不阻断卸载 */ }
    }
    this.handles.clear()
    if (this.kbHandle) {
      try { this.kbHandle.close() } catch { /* 忽略 */ }
      this.kbHandle = null
    }
  }

  /* ---------- 靶标生命周期 ---------- */
  listEngagements() {
    mkdirSync(this.engagementsDir, { recursive: true })
    const out = []
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const meta = readMeta(this.metaPathOf(entry.name)) || {}
      let stats = null
      try {
        if (existsSync(this.dbPathOf(entry.name))) stats = this.stats(entry.name)
      } catch { /* 库损坏时仍列出靶标 */ }
      out.push({
        id: entry.name, name: meta.target_name || entry.name,
        scope: meta.scope_cidrs || [], status: meta.status || 'active',
        created_at: meta.created_at || null, stats,
      })
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  /**
   * 打开/创建一个靶标工作区。
   * @param name - 靶标单位名称（slugify 后作为目录名与靶标 id）。
   * @param scope - 授权范围 CIDR 列表（可空）。
   * @param options - `{ bindCurrent?: boolean }`：是否同时把全局「当前靶标」指针指过来。
   *   默认 true（界面/命令行语义）；**智能体工具传 false** —— 多会话并行时，
   *   让某个会话 open 一个靶标就改掉全局指针，是"报告被写串"的直接原因。
   */
  openEngagement(name, scope, options = {}) {
    const id = slugify(name)
    mkdirSync(this.dirOf(id), { recursive: true })
    for (const sub of ['agents', 'runs', 'reports']) mkdirSync(join(this.dirOf(id), sub), { recursive: true })
    const existing = readMeta(this.metaPathOf(id))
    writeMeta(this.metaPathOf(id), {
      target_name: name,
      scope_cidrs: scope || (existing && existing.scope_cidrs) || [],
      status: 'active',
      created_at: (existing && existing.created_at) || nowIso(),
      updated_at: nowIso(),
    })
    this.db(id, { create: true }) // 建库 + 建表
    this.seedScorePoints(id)
    for (const p of this.listPrompts(id)) {
      if (!p.content) this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] || '')
    }
    if (options.bindCurrent !== false) this.setActiveEngagement(id)
    return { id, name, scope: scope || [] }
  }

  /**
   * 资产发现时间线：按"哪一天发现了多少、最近发现了哪些"聚合。
   * 资产测绘页用它回答"这条是什么时候发现的"，报告附录用它做收口时间线。
   * @param id - 靶标 id。
   * @param f - `{ limit?: number }` 最近资产条数（默认 50）。
   */
  discoveryTimeline(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 50, 500)
    const days = db.prepare(`SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day,
        COUNT(*) AS assets,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'internal' THEN 1 ELSE 0 END) AS internal,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'external' THEN 1 ELSE 0 END) AS external
      FROM asset GROUP BY day ORDER BY day DESC`).all()
    const recent = db.prepare(`SELECT id, ip, segment_cidr, state, primary_name, discovered_at, first_seen, last_seen,
        COALESCE(scope, (${SCOPE_SQL})) AS scope, priority,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = asset.id AND p.state = 'open') AS open_ports
      FROM asset ORDER BY COALESCE(discovered_at, first_seen, '') DESC, id DESC LIMIT ?`).all(limit)
    const span = db.prepare(`SELECT MIN(COALESCE(discovered_at, first_seen)) AS first,
        MAX(COALESCE(discovered_at, first_seen)) AS last, COUNT(*) AS total FROM asset`).get() || {}
    return {
      days: days.map((d) => Object.assign({}, d, { day: d.day || '(Unknown time)' })),
      recent,
      span: { first: span.first || null, last: span.last || null, total: span.total || 0 },
    }
  }

  /* ---------- 统计 / 查询 ---------- */
  stats(id) {
    const db = this.db(id)
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
    return {
      segments: one('SELECT COUNT(*) FROM segment'),
      assets: one('SELECT COUNT(*) FROM asset'),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one('SELECT COUNT(*) FROM service'),
      fingerprints: one('SELECT COUNT(*) FROM fingerprint'),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one('SELECT COUNT(*) FROM vuln'),
      credentials: one('SELECT COUNT(*) FROM credential'),
      accesses: one('SELECT COUNT(*) FROM access_session'),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    }
  }

  /**
   * 控制台「未读」摘要：每个页签给一个「条数 + 最近一条时间」的轻量指针。
   *
   * 面板拿它跟本地记住的上次查看状态比：有新条数、或最新时间晚于上次查看，就在页签上点一个红点；
   * 用户点开该页签后把当前值记为已读，红点消失。**只读、只数数**，不做任何重活。
   */
  consoleDigest(id) {
    const db = this.db(id)
    const count = (sql) => {
      try { return Number(db.prepare(sql).get()?.n ?? 0) || 0 } catch { return 0 }
    }
    const at = (sql) => {
      try { return db.prepare(sql).get()?.t ?? null } catch { return null }
    }
    const maxOf = (a, b) => (a === null ? b : (b === null ? a : (a > b ? a : b)))
    /* 知识库是跨靶标共享的另一个库：拿不到就当作 0，不影响其它页签 */
    let kb = { count: 0, at: null }
    try {
      const k = this.kb()
      kb = {
        count: Number(k.prepare('SELECT COUNT(*) AS n FROM poc').get()?.n ?? 0),
        at: k.prepare('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM poc').get()?.t ?? null,
      }
    } catch { /* 知识库还没建：视为无更新 */ }
    const hits = 'SELECT COUNT(*) AS n FROM score_hit'
    const hitsAt = 'SELECT MAX(recorded_at) AS t FROM score_hit'
    const steps = 'SELECT COUNT(*) AS n FROM attack_step'
    const stepsAt = 'SELECT MAX(recorded_at) AS t FROM attack_step'
    const sections = {
      assets: {
        count: count('SELECT COUNT(*) AS n FROM asset'),
        at: at('SELECT MAX(COALESCE(discovered_at, first_seen, last_seen)) AS t FROM asset'),
      },
      testing: {
        count: count("SELECT COUNT(*) AS n FROM asset WHERE COALESCE(test_status, 'untested') <> 'untested'"),
        at: at('SELECT MAX(test_updated_at) AS t FROM asset'),
      },
      /* 「智能体」页签看的是"谁在执行"：用攻击步骤的最新动作当指针 */
      agents: { count: count(steps), at: at(stepsAt) },
      sessions: {
        count: count('SELECT COUNT(*) AS n FROM webshell') + count('SELECT COUNT(*) AS n FROM tunnel'),
        at: maxOf(
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM webshell'),
          at('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM tunnel'),
        ),
      },
      findings: {
        count: count('SELECT COUNT(*) AS n FROM vuln'),
        at: at('SELECT MAX(found_at) AS t FROM vuln'),
      },
      chain: { count: count(steps), at: at(stepsAt) },
      scores: { count: count(hits), at: at(hitsAt) },
      report: { count: count(hits), at: at(hitsAt) },
      attackfiles: {
        count: count('SELECT COUNT(*) AS n FROM attack_file'),
        at: at('SELECT MAX(created_at) AS t FROM attack_file'),
      },
      knowledge: kb,
      /* 提示词与技能库是随包分发的静态内容：没有"新条目"一说，永不点红点 */
      prompts: { count: 0, at: null },
      skills: { count: 0, at: null },
    }
    return { engagement: id, at: nowIso(), sections }
  }

  snapshot(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    return {
      engagement: {
        id, name: meta.target_name || id, scope: meta.scope_cidrs || [],
        status: meta.status || 'active', created_at: meta.created_at || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    }
  }

  listSegments(id) {
    const rows = this.db(id).prepare(`
      SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`).all()
    /* C 段也分内外网：按网段起始地址归属判定 */
    return rows.map((r) => Object.assign({}, r, { scope: scopeOfIp(String(r.cidr || '').split('/')[0]) }))
  }

  /**
   * 把一组资产的 ports / fingerprints / names **一次查完**，按 asset_id 分组返回。
   *
   * 为什么需要：assetRow 原本对每个资产各跑 3 条查询，而资产列表默认 limit=400 ——
   * 一次列表请求就是 1200 条 SQL，而面板每次改筛选条件都会重查。
   * 这里改成 3 条 `IN (...)` 查询，成本与**资产数无关**。
   *
   * @param db - 靶标库句柄。
   * @param ids - 资产 id 数组（空数组直接返回空 Map）。
   * @returns `{ ports, fingerprints, names }`：三张 `Map<assetId, rows[]>`
   */
  assetChildren(db, ids = []) {
    const ports = new Map()
    const fingerprints = new Map()
    const names = new Map()
    const list = Array.from(new Set(ids.filter((x) => x !== null && x !== undefined))).map(Number)
    if (list.length === 0) return { ports, fingerprints, names }
    const ph = list.map(() => '?').join(',')
    for (const row of db.prepare(`SELECT p.asset_id, p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id IN (${ph}) ORDER BY p.asset_id, p.port`).all(...list)) {
      const key = Number(row.asset_id)
      if (!ports.has(key)) ports.set(key, [])
      ports.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, category, vendor, product, version, evidence, provenance
      FROM fingerprint WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!fingerprints.has(key)) fingerprints.set(key, [])
      fingerprints.get(key).push(row)
    }
    for (const row of db.prepare(`SELECT asset_id, name, kind, provenance
      FROM asset_name WHERE asset_id IN (${ph}) ORDER BY asset_id, id`).all(...list)) {
      const key = Number(row.asset_id)
      if (!names.has(key)) names.set(key, [])
      names.get(key).push(row)
    }
    return { ports, fingerprints, names }
  }

  /**
   * 单个资产 → 行结构。
   * @param db - 靶标库句柄。
   * @param a - asset 表的行。
   * @param children - 可选：assetChildren() 的预取结果。**传了就零额外查询**；
   *                   不传则退回单资产查询（详情页只用一次，N+1 无影响）。
   */
  assetRow(db, a, children = null) {
    let ports
    let fingerprints
    let names
    if (children !== null) {
      const key = Number(a.id)
      ports = children.ports.get(key) || []
      fingerprints = children.fingerprints.get(key) || []
      names = children.names.get(key) || []
    } else {
      ports = db.prepare(`SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
          s.name AS service, s.product, s.version
        FROM port p LEFT JOIN service s ON s.port_id = p.id
        WHERE p.asset_id = ? ORDER BY p.port`).all(a.id)
      fingerprints = db.prepare('SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?').all(a.id)
      names = db.prepare('SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?').all(a.id)
    }
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, state: a.state,
      primary_name: a.primary_name, first_seen: a.first_seen, last_seen: a.last_seen,
      discovered_at: a.discovered_at || a.first_seen || null,
      test_status: a.test_status || 'untested', test_notes: a.test_notes || '',
      test_surface: a.test_surface || '', test_updated_at: a.test_updated_at || null,
      test_updated_by: a.test_updated_by || null, blocked_count: a.blocked_count || 0,
      priority: a.priority || null, potential: a.potential || '', assess_reason: a.assess_reason || '',
      assessed_at: a.assessed_at || null, assessed_by: a.assessed_by || null,
      scope: a.scope || scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === 'open').length,
      ports, fingerprints, names,
      passive: ports.filter((p) => p.provenance === 'passive').length,
      active: ports.filter((p) => p.provenance === 'active').length,
    }
  }


  listAssets(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.state) { where.push('a.state = ?'); args.push(f.state) }
    if (f.ip) { where.push('a.ip = ?'); args.push(f.ip) }
    if (f.port) { where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)'); args.push(Number(f.port)) }
    if (f.service) {
      where.push('EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))')
      args.push(`%${f.service}%`, `%${f.service}%`)
    }
    if (f.fingerprint) {
      where.push('EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))')
      args.push(`%${f.fingerprint}%`, `%${f.fingerprint}%`, `%${f.fingerprint}%`)
    }
    if (f.provenance) {
      where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)')
      args.push(f.provenance)
    }
    if (f.priority) {
      where.push('a.priority = ?')
      args.push(f.priority)
    }
    if (f.test_status) {
      /* 支持多值：test_status=abandoned,blocked */
      const list = String(f.test_status).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?")
        args.push(f.test_status)
      }
    }
    /* 内外网维度：internal | external（老数据在迁移时已回填） */
    if (f.scope) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`)
      args.push(f.scope)
    }
    if (f.q) {
      const terms = String(f.q).split(/\s+/).filter(Boolean)
      if (terms.length) {
        if (HAS_FTS5) {
          /* 主域名（asset.primary_name）**没有**进 asset_fts 索引（FTS 表里只有
             ip / names / banners / titles / fingerprints），只靠 MATCH 会搜不到主域名 ——
             例如按 "portal.example.test" 查是 0 条。这里并入 LIKE 兜住它，
             顺带覆盖 LIKE 能匹配而 FTS 词元切分匹配不到的情形。 */
          where.push('(a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)'
            + ' OR a.primary_name LIKE ?)')
          args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND '), '%' + String(f.q) + '%')
        } else {
          /* 无 FTS5 的 Node 构建：退化成子串匹配。
             语义比 FTS 弱（不做前缀/词干切分、LIKE 只对 ASCII 大小写不敏感），
             但**检索不报错、内容找得到**，比"整个面板打不开"好得多。
             检索面与 #reindex 喂给 asset_fts 的一致：
             资产 IP / 主域名 + asset_name + port.banner/title/url + service + fingerprint。 */
          const sub = [
            'EXISTS(SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND n.name LIKE ?)',
            'EXISTS(SELECT 1 FROM port p WHERE p.asset_id = a.id AND (p.banner LIKE ? OR p.title LIKE ? OR p.url LIKE ?))',
            'EXISTS(SELECT 1 FROM service s JOIN port p2 ON p2.id = s.port_id WHERE p2.asset_id = a.id'
              + ' AND (s.name LIKE ? OR s.product LIKE ? OR s.version LIKE ?))',
            'EXISTS(SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id'
              + ' AND (f.vendor LIKE ? OR f.product LIKE ? OR f.version LIKE ? OR f.category LIKE ?))',
          ]
          const binds = (t) => ['%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%',
            '%' + t + '%', '%' + t + '%', '%' + t + '%', '%' + t + '%']
          for (const t of terms) {
            where.push('(a.ip LIKE ? OR a.primary_name LIKE ? OR ' + sub.join(' OR ') + ')')
            args.push('%' + t + '%', '%' + t + '%', ...binds(t))
          }
        }
      }
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...args).n
    const limit = Math.min(Number(f.limit) || 200, 2000)
    const offset = Number(f.offset) || 0
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)"
    /* 排序：默认「最该打的排前面」——易打性高 → 未测 → 端口多；sort=ip / sort=ports 可切换 */
    const sort = f.sort || 'priority'
    let orderBy = 'a.ip_int'
    if (sort === 'ports') orderBy = `${openPorts} DESC, a.ip_int`
    /* 按发现时间倒序：新收集到的资产排前面（"刚发现了什么"最直观） */
    else if (sort === 'discovered') orderBy = `COALESCE(a.discovered_at, a.first_seen, '') DESC, a.id DESC`
    else if (sort === 'todo') {
      /* 待测优先：把这轮还能打的先顶上来，已测/放弃的沉底 */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`
    } else if (sort === 'priority') {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`
    }
    const rows = db.prepare(`SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    /* 一次预取、逐行组装：把 3N 条查询压成 3 条（默认 N 最多 400） */
    const children = this.assetChildren(db, rows.map((r) => r.id))
    return { total, sort, items: rows.map((r) => this.assetRow(db, r, children)) }
  }

  getAsset(id, assetId) {
    const db = this.db(id)
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(assetId))
    if (!a) return undefined
    const detail = this.assetRow(db, a)
    detail.observations = db.prepare(`SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC LIMIT 200`).all(a.id)
    detail.edges = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`).all(String(a.id), String(a.id))
    return detail
  }

  /** 图谱投影：C 段 → 资产 → 开放端口（+ 域名解析关系）。 */
  graph(id, f = {}) {
    const db = this.db(id)
    const nodes = []
    const edges = []
    const seen = new Set()
    const push = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node) } }
    const segs = f.cidr
      ? db.prepare('SELECT * FROM segment WHERE cidr = ?').all(f.cidr)
      : db.prepare('SELECT * FROM segment').all()
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: 'segment', label: s.cidr, meta: { org: s.org, asn: s.asn } })
      for (const a of db.prepare('SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(s.cidr)) {
        const nid = `asset:${a.id}`
        const ports = db.prepare("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id).n
        push({ id: nid, kind: 'asset', label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } })
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: 'contains' })
        for (const p of db.prepare('SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?').all(a.id, 'open')) {
          const pid = `port:${p.id}`
          push({ id: pid, kind: 'port', label: `${p.port}/${p.proto}`, meta: { provenance: p.provenance, asset: a.ip } })
          edges.push({ source: nid, target: pid, relation: 'exposes' })
        }
        if (a.primary_name) {
          const did = `name:${a.primary_name}`
          push({ id: did, kind: 'domain', label: a.primary_name, meta: {} })
          edges.push({ source: did, target: nid, relation: 'resolves' })
        }
      }
    }
    return { nodes, edges }
  }

  /* ---------- 得分目标（攻防演练得分点 + 得分记录） ---------- */

  /** 首次打开靶标时播种默认得分点（已有则不动）。 */
  /** 作战阶段：首次读取时补种默认五阶段（与得分点同策略，老靶标自动获得）。 */
  seedStages(id) {
    const db = this.db(id)
    /* 自愈式补种：缺哪个补哪个（老库被上一版迁移误删的阶段会自动补回来） */
    const have = new Set(db.prepare('SELECT code FROM stage').all().map((r) => r.code))
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 }
    let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage').get().n + 1
    const stmt = db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    let seeded = 0
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order++, nowIso())
      seeded += 1
    }
    return { seeded: seeded }
  }

  listStages(id) {
    const db = this.db(id)
    this.seedStages(id)
    return db.prepare('SELECT * FROM stage ORDER BY sort_order, code').all().map((r, i) => ({
      code: r.code, name: r.name, subtitle: r.subtitle || '', color: r.color || '#64748b',
      goal: r.goal || '', sections: parseJson(r.sections, []), tools: r.tools || '',
      transition: r.transition || '',
      /* 链路里的真实位置（第几阶段）：界面画 ①②③ 与报告排序都用它，不要另行编号 */
      ordinal: i + 1,
      updated_at: r.updated_at || null,
    }))
  }

  /** 编辑阶段内容（名称/目标/手段分组/工具/ATT&CK/过渡语）。 */
  saveStage(id, patch = {}) {
    const db = this.db(id)
    if (!patch.code) throw new Error('stage.code required')
    const cur = db.prepare('SELECT * FROM stage WHERE code = ?').get(String(patch.code))
    db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, subtitle = excluded.subtitle, color = excluded.color, goal = excluded.goal,
        sections = excluded.sections, tools = excluded.tools,
        transition = excluded.transition, updated_at = excluded.updated_at`).run(
      String(patch.code),
      patch.name ?? (cur ? cur.name : String(patch.code)),
      patch.subtitle ?? (cur ? cur.subtitle : ''),
      patch.color ?? (cur ? cur.color : '#64748b'),
      patch.goal ?? (cur ? cur.goal : ''),
      patch.sections !== undefined ? JSON.stringify(patch.sections) : (cur ? cur.sections : '[]'),
      patch.tools ?? (cur ? cur.tools : ''),
      patch.transition ?? (cur ? cur.transition : ''),
      patch.sort_order ?? (cur ? cur.sort_order : 0),
      nowIso(),
    )
    return { code: String(patch.code), updated: true }
  }

  seedScorePoints(id) {
    const db = this.db(id)
    const insert = (point, order) => db.prepare(`INSERT INTO score_point
        (code, name, category, points, description, enabled, sort_order, created_at, updated_at,
         src, rule, tier, cap, dedup_scope, legacy, builtin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      point.code, point.name, point.category, point.points, point.description,
      point.enabled === 0 ? 0 : 1, order, nowIso(), nowIso(),
      point.src ?? null,
      point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service', point.legacy === 1 ? 1 : 0,
      /* 内置点：随规则分发，分值/口径锁定、不可删除 */
      point.legacy === 1 ? 0 : 1,
    )
    const have = new Set(db.prepare('SELECT code FROM score_point').all().map((r) => String(r.code)))

    /* ── 内置点标记回填 + 老库清理（旧得分项整套作废）────────────────────────
       回填：老库的 builtin 列刚建出来全是 0，按 code 名单把内置点标回来。
       清理口径：**只清"内置名单里的旧 code"**——也就是旧版随包分发的默认点
       （web-account-* / webshell / rce / server-shell / db-access / sensitive-data /
       boundary / internal-pivot / core-system 等）与其历史命中。

       ⚠️ 判定"是否内置"**必须用 builtin 列**，不能用"是否在当前默认名单里"：
       用户自建的得分点会被当成旧体系残留，在下次读取得分面板时连同命中一起静默删除，
       而 saveScorePoint 照样返回 ok、界面照样弹「已保存」。

       ⚠️ 不可逆：清理前把被删的得分点与命中**导出到 <靶标>/runs/legacy-score-<时间>.json**
       存档一次（报告/审计还能查），然后才删。 */
    const builtinCodes = DEFAULT_SCORE_POINTS.map((x) => x.code)
    const keep = new Set(builtinCodes)
    try {
      const ph = builtinCodes.map(() => '?').join(',')
      db.prepare('UPDATE score_point SET builtin = 1 WHERE code IN (' + ph + ')').run(...builtinCodes)
    } catch { /* 老库结构异常：不影响计分，下次播种再试 */ }
    let purgedPoints = 0
    let purgedHits = 0
    try {
      const doomed = db.prepare('SELECT id, code, name, category, points, legacy, builtin FROM score_point').all()
        .filter((r) => !keep.has(String(r.code)) && (Number(r.legacy) === 1 || Number(r.builtin) === 1))
      if (doomed.length > 0) {
        const ids = doomed.map((r) => r.id)
        const ph = ids.map(() => '?').join(',')
        const hits = db.prepare(`SELECT * FROM score_hit WHERE point_id IN (${ph})`).all(...ids)
        if (hits.length > 0) {
          /* 存档：放靶标目录的 runs/ 下，与其它证据同处一地 */
          try {
            const dir = join(this.dirOf(id), 'runs')
            mkdirSync(dir, { recursive: true })
            const stamp = nowIso().replace(/[:.]/g, '-')
            writeFileSync(join(dir, 'legacy-score-' + stamp + '.json'),
              JSON.stringify({
                archived_at: nowIso(),
                reason: 'Refactored per Breach & Intrusion Scoring Rules (Consolidated): legacy score points deprecated',
                points: doomed, hits,
              }, null, 2), 'utf8')
          } catch { /* 存档失败不阻断清理，但要照实记账 */ }
        }
        db.prepare(`DELETE FROM score_hit WHERE point_id IN (${ph})`).run(...ids)
        db.prepare(`DELETE FROM score_point WHERE id IN (${ph})`).run(...ids)
        purgedPoints = doomed.length
        purgedHits = hits.length
      }
    } catch { /* 表还不存在等异常：忽略，不阻断播种 */ }

    /* 内置得分点的**规则元数据同步**：规则文档改了（类别分组、上限、计分口径、档位说明、
       条款正文），这里要把它同步到已存在的行上。
       为什么必须做：早先只按 code"缺哪条补哪条"，于是改过 category 的条目在老库里
       仍留着旧值 —— 面板会按 category 分组，结果同一类被拆成两组
       （如 NETINFRA 与"网络基础设施"各一组），看起来像多了两个类别。

       ⚠️ 分值/上限/口径**由规则锁定**（builtin=1），用户改不动：这不仅是"有意覆盖"，
       更是**必须**——同一 rule 的 cap 按规则内所有点累计，若允许改单条分值，
       用户把 50 改成 500 就能让整条规则的上限被一条命中吃掉。
       所以内置点的 name/category/description 与整组 rule/tier/cap/dedup_scope/points
       都由这里统一同步；**「启用/停用」仍由用户控制，不在此覆盖**。
       UI 侧据此把内置点的分值输入框置灰（返回 overridden:false 让界面能提示原因）。

       用户想自定义分值时请**新增得分点**（builtin=0）——那条不会被这里覆盖，
       也不会被上面的旧体系清理删掉。 */
    let synced = 0
    if (have.size > 0) {
      const upd = db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?,
          src = ?, rule = ?, tier = ?, cap = ?, dedup_scope = ?, builtin = 1, updated_at = ?
        WHERE code = ? AND legacy = 0`)
      for (const point of DEFAULT_SCORE_POINTS) {
        if (!have.has(point.code)) continue
        try {
          const r = upd.run(point.name, point.category, point.points, point.description,
            point.src ?? null,
            point.rule ?? null, point.tier ?? null, point.cap ?? 0, point.dedup_scope || 'service',
            nowIso(), point.code)
          if (r.changes > 0) synced += 1
        } catch { /* 忽略单条失败 */ }
      }
    }

    /* 缺哪条补哪条：新增规则、被误删的默认点都能靠这一条自愈 */
    const missing = DEFAULT_SCORE_POINTS.filter((p) => !have.has(p.code))
    if (missing.length > 0) {
      let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
      for (const point of missing) insert(point, order++)
    }
    if (missing.length === 0 && purgedPoints === 0 && synced === 0) return { seeded: 0 }
    return {
      seeded: missing.length,
      /* 本次清掉的旧得分点与命中条数（面板/工具据此告诉用户"旧口径已作废"） */
      purgedLegacyPoints: purgedPoints,
      purgedLegacyHits: purgedHits,
      purged: purgedPoints > 0,
    }
  }

  listScorePoints(id, f = {}) {
    const db = this.db(id)
    /* 每次都跑一次播种：它是幂等的，同时承担三件事 ——
       ① 空库首次播种；② 新规则/被误删的点自愈补齐；③ 老库把旧默认点标为 legacy（v0.11.0 迁移）。
       ⚠️ 早先只在"一个得分点都没有"时才调它，于是老库（已有旧点）永远不会被迁移。 */
    this.seedScorePoints(id)
    /* 按**分值从低到高**展示（同分保持定义顺序）——用户按分值大小判断先打谁更直观 */
    const rows = db.prepare('SELECT * FROM score_point ORDER BY COALESCE(points, 0) ASC, sort_order ASC, id ASC').all()
    const hits = db.prepare('SELECT * FROM score_hit ORDER BY recorded_at DESC, id DESC').all()
    /* 资产 IP：告警与命中记录里要能直接看出是哪个服务（asset_ip:port） */
    const assetIp = new Map(db.prepare('SELECT id, ip FROM asset').all().map((a) => [a.id, a.ip]))
    const codeOf = new Map(rows.map((r) => [r.id, r.code]))
    /* 默认分值按得分点取；命中自带 points 时以命中为准（合并版的多档计分） */
    const pointsOf = new Map(rows.map((r) => [r.id, Number(r.points) || 0]))
    /* 命中行的有效分值：档位分值 × 倍率（倍率见 scoreMultiplierOf / hitPointsOf） */
    const effPointsOf = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: codeOf.get(h.point_id) },
      new Map([[String(codeOf.get(h.point_id)), { points: pointsOf.get(h.point_id) || 0 }]]),
    )
    const byPoint = new Map()
    for (const h of hits) {
      if (!byPoint.has(h.point_id)) byPoint.set(h.point_id, [])
      byPoint.get(h.point_id).push(h)
    }
    /* 计分口径与规则上限（数据驱动，见 applyScoreCaps）：
       · dedup_scope 决定"同目标/同系统/同服务只算最高一条"还是按台卡数累加；
       · rule + cap 决定该规则的累计上限。
       自建账号既不参与竞争也不占位（本来就不计分）。 */
    /* 元数据与评估都走共享实现（evaluateScoreBoard）：面板 / 报告 / 攻击链三处
       各写一遍必然出现不同口径，总分对不上。 */
    const pointsMeta = new Map(rows.map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
    const nameOf = loadAssetNames(db)
    const cappedAll = evaluateScoreBoard(db, hits.map((h) => Object.assign({}, h, {
      code: codeOf.get(h.point_id), points: effPointsOf(h),
    })), { meta: pointsMeta, names: nameOf })
    const cappedById = new Map(cappedAll.items.map((h) => [h.id, h]))
    const enabled = rows.filter((r) => r.enabled === 1)
    const enabledIds = new Set(enabled.map((r) => r.id))
    /* 该得分点是否参与"同口径只算最高一条"的去重（供界面显示"已拿满"提示） */
    const isCappedPoint = (pid) => {
      const meta = pointsMeta.get(codeOf.get(pid))
      return meta !== undefined && meta.dedup_scope !== 'none' && meta.dedup_scope !== null
    }
    const items = rows
      .filter((r) => f.enabledOnly !== true || r.enabled === 1)
      .map((r) => {
        const list = (byPoint.get(r.id) || []).map((h) => {
          const flag = cappedById.get(h.id)
          const capped = flag !== undefined && flag.capped === true
          const hit = {
            id: h.id, asset_id: h.asset_id, vuln_id: h.vuln_id, step_id: h.step_id,
            target: h.target, evidence: h.evidence, note: h.note,
            points: effPointsOf(h), points_overridden: h.points !== null && h.points !== undefined,
            port: normalizePort(h.port) ?? parseTargetPort(h.target),
            self_created: Number(h.self_created) === 1,
            capped: capped,
            capped_by_id: capped ? flag.capped_by_id : null,
            capped_reason: capped ? scoreCapReasonText(Object.assign({}, h, {
              code: r.code, asset_ip: assetIp.get(h.asset_id),
              rule: flag.rule ?? null, rule_cap: flag.rule_cap || 0, capped_reason_kind: flag.capped_reason_kind,
            }), flag.capped_by_points) : null,
            capped_reason_kind: capped ? flag.capped_reason_kind : null,
            recorded_by: h.recorded_by, recorded_at: h.recorded_at,
          }
          hit.service = serviceLabel(Object.assign({}, hit, { asset_ip: assetIp.get(h.asset_id) }))
          if (capped) hit.capped_by = flag.capped_by_evidence ?? null
          return hit
        })
        /* 不设上限的得分点：命中次数 × 分值累加。
           自建账号（self_created）不计分；账号类/数据库类按服务封顶，只算最高那一条。 */
        const valid = list.filter((h) => h.self_created !== true)
        const countedList = valid.filter((h) => h.capped !== true)
        const counted = countedList.length
        const cappedList = valid.filter((h) => h.capped === true)
        const meta = pointsMeta.get(r.code) || { rule: null, cap: 0, dedup_scope: 'service' }
        const capUsed = meta.rule === null ? null : cappedAll.caps.get('rule:' + meta.rule)
        const scopeLabel = { service: 'Highest score only per service', system: 'Highest privilege only once per system', target: 'Once per target', none: 'Cumulative by host / GPU / node' }[meta.dedup_scope] || ''
        return {
          id: r.id, code: r.code, name: r.name, category: r.category, points: r.points,
          rule: meta.rule, tier: r.tier || null, cap: meta.cap || 0, dedup_scope: meta.dedup_scope,
          /* src = 《合并版》里的原序号（对账用）；builtin = 随规则分发的内置点（分值锁定、不可删）。
             界面据此把内置点的分值输入框置灰并给出原因。 */
          src: r.src === null || r.src === undefined ? null : Number(r.src),
          builtin: Number(r.builtin) === 1,
          legacy: Number(r.legacy) === 1,
          counted: counted,
          /* 按"计入命中的实际分值"累加 —— 合并后同一 code 含多档，不能再拿默认分值乘次数 */
          earned: countedList.reduce((n, h) => n + (Number(h.points) || 0), 0),
          self_created: list.length - valid.length,
          capped: cappedList.length,
          capped_hits: cappedList,
          /* 规则上限用量（同一 rule 的得分点共用；界面按规则分组显示"已用 / 上限"） */
          cap_used: capUsed ? capUsed.used : null,
          cap_capped: capUsed ? capUsed.capped : 0,
          scope_label: scopeLabel,
          service_summary: (meta.dedup_scope !== 'none' && cappedList.length > 0)
            ? 'Deduplication policy "' + scopeLabel + '": ' + counted + ' scored, ' + cappedList.length + ' duplicate hits not scored'
            : null,
          description: r.description || '', enabled: r.enabled === 1, sort_order: r.sort_order,
          hits: list,
        }
      })

    /* ── 证据截图：每个得分点最多挂 3 张代表图 ─────────────────────────────
       批量得分点（终端权限一次 60 台）逐条贴图既没信息量、又把页面撑爆，
       所以按"得分点"给代表图；想逐条看的话命中行上带该条的截图张数。
       选图优先级见 #representativeShots（命中级 > 目标级 > 点级，现场截图 > 生成的证据卡）。 */
    const shotPicks = this.#representativeShots(id, items.map((it) => ({
      point_id: it.id, point_code: it.code, hit_ids: (it.hits || []).map((h) => h.id),
    })), 3)
    const shotCountByPoint = new Map()
    const shotCountByHit = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, hit_id, COUNT(*) AS n FROM shot GROUP BY point_id, hit_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) {
          shotCountByPoint.set(Number(row.point_id), (shotCountByPoint.get(Number(row.point_id)) || 0) + Number(row.n))
        }
        if (row.hit_id !== null && row.hit_id !== undefined) shotCountByHit.set(Number(row.hit_id), Number(row.n))
      }
    } catch { /* 老库还没有 shot 表时忽略 */ }
    const shotBrief = (x) => ({
      id: Number(x.id), url: this.shotUrlOf(id, x), label: x.label || '', note: x.note || '',
      kind: x.kind || 'screenshot', mime: x.mime || 'image/png', bytes: Number(x.bytes) || 0,
      target: x.target || '', captured_at: x.captured_at || '', source_ref: x.source_ref || '',
    })
    for (const it of items) {
      const picked = shotPicks.get(Number(it.id)) || []
      it.shots = picked.map(shotBrief)
      it.shot_total = shotCountByPoint.get(Number(it.id)) || 0
      it.shot_shown = picked.length
      for (const h of (it.hits || [])) h.shot_count = shotCountByHit.get(Number(h.id)) || 0
    }

    /* 排序：**已得分的排前面**（一眼看到战绩），未得分的在后；
       两组内部都按分值从低到高（同分按定义顺序，结果稳定可预期）。 */
    const achievedRank = (it) => (it.hits.length > 0 ? 0 : 1)
    const sortedItems = items.slice().sort((a, b) => {
      const ra = achievedRank(a); const rb = achievedRank(b)
      if (ra !== rb) return ra - rb
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pa !== pb) return pa - pb
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    })

    /* ── 按合并版的 8 个类别分组（控制一般系统 / Web 应用 / 集权 / 大数据 /
       网络基础设施 / 文件存储 / 模型相关 / 突破网络边界）────────────────────
       面板与报告都按这个分组展示：用户看到的就是规则文档里的结构。
       组内按分值升序（items 已排好序），组顺序即 SCORE_GROUPS 的定义顺序。 */
    const groupOrder = new Map(SCORE_GROUPS.map((g, i) => [g.code, i]))
    const groupName = new Map(SCORE_GROUPS.map((g) => [g.code, g.name]))
    const ruleGroups = []
    const gmap = new Map()
    for (const it of sortedItems) {
      if (it.legacy) continue
      const code = it.category || 'OTHER'
      if (!gmap.has(code)) {
        const g = {
          key: code, code,
          name: groupName.get(code) || code,
          /* 该类别下所有条目的上限之和（仅作参考值 —— 各项上限独立，不跨条累加，见 G3） */
          capSum: 0, points: 0, counted: 0, capped: 0, tiers: [],
          order: groupOrder.has(code) ? groupOrder.get(code) : 99,
        }
        gmap.set(code, g); ruleGroups.push(g)
      }
      const g = gmap.get(code)
      g.capSum += Number(it.cap) || 0
      g.points += it.earned
      g.counted += it.counted
      g.capped += it.capped
      g.tiers.push(it)
    }
    ruleGroups.sort((a, b) => a.order - b.order)
    /* 组内再兜一次底（防止调用方改过顺序）：已得分优先，再按分值升序 */
    for (const g of ruleGroups) {
      g.tiers.sort((a, b) => {
        const ra = achievedRank(a); const rb = achievedRank(b)
        if (ra !== rb) return ra - rb
        return (Number(a.points) || 0) - (Number(b.points) || 0)
      })
    }
    const legacyItems = items.filter((it) => it.legacy)
    const legacyHits = legacyItems.reduce((n, p) => n + p.hits.length, 0)
    const enabledItems = items.filter((p) => p.enabled)
    const cappedItems = cappedAll.items.filter((h) => h.capped === true && (codeOf.get(h.point_id) !== undefined) && enabledIds.has(h.point_id))
    const latestCapped = cappedItems.length === 0 ? null : cappedItems.slice().sort((a, b) => {
      const sa = String(a.recorded_at || '') + '#' + String(a.id).padStart(8, '0')
      const sb = String(b.recorded_at || '') + '#' + String(b.id).padStart(8, '0')
      return sb.localeCompare(sa)
    })[0]
    return {
      items: sortedItems,
      ruleGroups,
      summary: {
        /* 不设上限：得分 = 命中次数 × 分值，累加即可 */
        achievedPoints: enabledItems.reduce((n, p) => n + p.earned, 0),
        /* 得分点个数（界面按这个显示，不再说"已拿下 N 项"） */
        pointCount: enabledItems.length,
        hitPointCount: enabledItems.filter((p) => p.counted > 0).length,
        hitCount: items.reduce((n, p) => n + p.hits.length, 0),
        countedHits: enabledItems.reduce((n, p) => n + p.counted, 0),
        /* 自己注册/自建而被剔除的命中数（界面上单独提示，避免"记了却没分"的困惑） */
        selfCreatedHits: items.reduce((n, p) => n + p.self_created, 0),
        /* 因"计分口径去重"或"规则已达上限"而不计分的条数（界面单独提示，避免"记了却没分"的困惑） */
        serviceCappedHits: cappedItems.length,
        cappedByDedup: cappedItems.filter((h) => h.capped_reason_kind === 'dedup').length,
        cappedByRuleLimit: cappedItems.filter((h) => h.capped_reason_kind === 'cap').length,
        /* legacy（旧版口径）得分点与命中：界面折叠展示，不并入新口径的总分 */
        legacyPointCount: legacyItems.length,
        legacyHitCount: legacyHits,
        latestCapped: latestCapped === null ? null : {
          hit_id: latestCapped.id,
          point_id: latestCapped.point_id,
          code: latestCapped.code,
          service: serviceLabel(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) })),
          evidence: latestCapped.evidence,
          points: latestCapped.points,
          recorded_at: latestCapped.recorded_at,
          reason: serviceCapReason(Object.assign({}, latestCapped, { asset_ip: assetIp.get(latestCapped.asset_id) }), latestCapped.capped_by_points),
        },
      },
    }
  }

  /** 新增或更新得分点（带 id 更新，不带 id 新增）。得分类别**不设数量上限**，只记分值。 */
  /**
   * 保存得分点。
   *
   * 两条路径差别很大，返回结构里用 `builtin` / `overridden` / `locked_fields` 说清楚：
   *   · **内置点**（builtin=1，随《突破入侵类得分规则》分发）：分值/上限/计分口径/名称
   *     由规则锁定，只能改「启用/停用」。**不允许改分值**不只是纪律问题 ——
   *     同一 rule 的 cap 按组内所有点累计，改了单条分值就能让一条命中吃掉整组上限。
   *     这里照样返回 `ok`（启用状态确实存下去了），但用 `overridden:false` 明确告诉
   *     调用方"你提交的分值没被采纳"，界面据此提示原因，而不是假装保存成功。
   *   · **用户自建点**（builtin=0）：字段全部可改，且不会被播种逻辑清掉。
   */
  saveScorePoint(id, point = {}) {
    const db = this.db(id)
    const enabled = point.enabled === false ? 0 : 1
    /* name 的必填校验要**放在内置点分支之后**：内置点只接受 enabled / sort_order，
       调用方（界面开关、工具只改启用状态）本来就不该被迫回传 name。
       放在前面会让"只想停用一个内置得分点"直接报 name required。 */
    const name = String(point.name || '').trim()
    /* max_hits 列保留只为兼容老库结构，计分不再使用（恒写 1） */
    if (point.id !== undefined && point.id !== null && Number(point.id) > 0) {
      const pid = Number(point.id)
      const row = db.prepare('SELECT id, code, name, points, cap, rule, tier, dedup_scope, builtin, legacy FROM score_point WHERE id = ?').get(pid)
      if (row === undefined) throw new Error('score point not found: id=' + pid)
      if (Number(row.builtin) === 1 || Number(row.legacy) === 1) {
        /* 内置点：只落 enabled / sort_order，其余字段留给 seedScorePoints 按规则同步 */
        db.prepare('UPDATE score_point SET enabled = ?, sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?')
          .run(enabled, point.sort_order ?? null, nowIso(), pid)
        const after = db.prepare('SELECT * FROM score_point WHERE id = ?').get(pid)
        return {
          id: pid, updated: true, builtin: true,
          points: after.points, cap: after.cap, rule: after.rule,
          overridden: Number(point.points) === Number(after.points),
          locked_fields: ['name', 'category', 'points', 'cap', 'rule', 'tier', 'dedup_scope', 'description'],
          note: 'This is a built-in score point distributed with Breach & Intrusion Scoring Rules: points, cap, scope, name, and rule text '
            + 'are locked by rule (rule cap is shared across group points; modifying individual points disrupts group capping). '
            + 'Saved enable/disable status. To customize point values, please add a new score point.',
        }
      }
      if (name === '') throw new Error('score point name required')
      const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
      db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?, enabled = ?,
          sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`)
        .run(name, point.category ?? null, points, point.description ?? null, enabled,
          point.sort_order ?? null, nowIso(), pid)
      return { id: pid, updated: true, builtin: false, overridden: true, points, note: 'Saved (custom score point)' }
    }
    if (name === '') throw new Error('score point name required')
    const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
    /* 自建点可能带上与内置点相同的 code（面板默认按名称生成）：code 有 UNIQUE 约束，
       撞了就换一个，避免"新增失败但界面看不出原因"。 */
    let code = point.code === undefined || point.code === null || String(point.code).trim() === ''
      ? null
      : String(point.code).trim()
    if (code !== null && db.prepare('SELECT id FROM score_point WHERE code = ?').get(code) !== undefined) {
      code = code + '-custom-' + Date.now().toString(36)
    }
    const r = db.prepare(`INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at, builtin)
      VALUES(?,?,?,?,?,?,?,?,?,0)`).run(
      code, name, point.category ?? null, points, point.description ?? null, enabled,
      next, nowIso(), nowIso(),
    )
    return {
      id: Number(r.lastInsertRowid), code, updated: false, builtin: false, overridden: true,
      points, note: 'Added custom score point (unlocked from rules and protected from legacy cleanups)',
    }
  }

  /** 删除得分点。内置点不允许删除（否则面板会缺一条规则，且下次播种又会长回来）。 */
  deleteScorePoint(id, pointId) {
    const db = this.db(id)
    const pid = Number(pointId)
    const row = db.prepare('SELECT id, code, name, builtin FROM score_point WHERE id = ?').get(pid)
    if (row === undefined) throw new Error('score point not found: id=' + pid)
    if (Number(row.builtin) === 1) {
      throw new Error('Built-in score point cannot be deleted: "' + (row.name || row.code) + '" originates from Breach & Intrusion Scoring Rules (Consolidated); '
        + 'deleting it would leave rules incomplete and reports missing categories (restored on next launch). '
        + 'To exclude it from scoring, disable it instead.')
    }
    db.prepare('DELETE FROM score_hit WHERE point_id = ?').run(pid)
    db.prepare('DELETE FROM score_point WHERE id = ?').run(pid)
    return { deleted: pid }
  }

  /**
   * 这条得分落在哪个端口上（服务级封顶的粒度）。
   *   ① 显式 `port`（工具参数）；
   *   ② `target` 里的端口（http://h:8080/x → 8080，10.0.0.5:6379 → 6379）；
   *   ③ 该资产只登记了一个端口时用那个（不打 80/443 的猜值，避免把不同服务并成一个）。
   */
  #servicePortOf(db, hit = {}) {
    const explicit = normalizePort(hit.port)
    if (explicit !== null) return explicit
    const fromTarget = parseTargetPort(hit.target)
    if (fromTarget !== null) return fromTarget
    const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
    if (assetId === null) return null
    try {
      const ports = db.prepare('SELECT port FROM port WHERE asset_id = ? ORDER BY port').all(assetId)
      if (ports.length === 1) return normalizePort(ports[0].port)
    } catch { /* 忽略 */ }
    return null
  }

  /** 记录一次得分（某个得分点在某个目标上被拿下）。 */
  addScoreHit(id, hit = {}) {
    const db = this.db(id)
    /* 得分点可能还没播种（新建靶标后直接记分）：先跑一次幂等播种，
       否则会以"score point not found"报错，而真实原因是默认得分点尚未写入。 */
    this.seedScorePoints(id)
    let pointId = hit.point_id !== undefined && hit.point_id !== null ? Number(hit.point_id) : null
    /* 按 code 找得分点（最常用）。旧 code 已随旧得分项一起作废（v0.11.1）：
       这里**不做静默改派** —— 改派目标本身可能已不存在，静默吞掉会让用户
       "记了却没分"且查不出原因。找不到就落到下面的 point not found 报错，
       并在错误里点明去 redteam_score_list 取新 code。 */
    if (pointId === null && hit.code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(hit.code))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null && hit.point_name) {
      const row = db.prepare('SELECT id FROM score_point WHERE name = ?').get(String(hit.point_name))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null) {
      throw new Error('score point not found: scoring rules have been refactored into 25 items per Breach & Intrusion Scoring Rules (Consolidated); '
        + 'legacy codes (web-account-*, webshell, rce, server-shell, db-access, sensitive-data, boundary, internal-pivot, core-system, etc.) are deprecated. '
        + 'Please query redteam_score_list for valid codes, or specify point_id / point_name.')
    }
    const evidence = String(hit.evidence || '').trim()
    if (evidence === '') throw new Error('score hit evidence required: score hit must provide evidence (account/output/data-volume/path)')
    /* 自己注册/自建的账号：允许记录（留过程），但不计分 */
    const selfCreated = hit.self_created === true || hit.self_created === 1 || hit.self_created === '1' ? 1 : 0
    const port = this.#servicePortOf(db, hit)
    /* 本条命中的实际分值：调用方可显式指定（合并版里同一条含多档，如"管理员 50"）。
       未指定记 NULL —— 计分时回落到得分点的默认 points。

       ⚠️ 必须做边界校验：`points` 是"某一档的分值"，不是自由填写的加分。
       没有校验时 `points=999999999` 会被原样写入并把总分刷到 9 位数，
       `points=-500` 会把总分拉低 —— 两者都会让交付报告的数字失去意义。
       上限取「该条规则上限」与「默认分值的 100 倍」中的较大者：
       前者保证一条命中不可能单独突破整条规则的天花板，
       后者给默认分值很小的条目（如 5 分/台的终端）留出合理的档位空间。 */
    const pointMeta = db.prepare('SELECT points, cap FROM score_point WHERE id = ?').get(pointId) || {}
    const pointsMax = Math.max(Number(pointMeta.cap) || 0, (Number(pointMeta.points) || 0) * 100, 1000)
    let hitPoints = null
    if (hit.points !== undefined && hit.points !== null && hit.points !== '') {
      const n = Number(hit.points)
      if (!Number.isFinite(n)) {
        throw new Error('score hit points invalid: points must be a finite number (received ' + JSON.stringify(hit.points) + '）')
      }
      if (n <= 0) {
        throw new Error('score hit points invalid: points must be greater than 0 (received ' + n + '）。'
          + 'points must follow rule tiers; do not manually adjust. ')
      }
      if (n > pointsMax) {
        throw new Error('score hit points invalid：points=' + n + ' exceeds reasonable cap for this score point ' + pointsMax
          + ' (= max(rule cap ' + (Number(pointMeta.cap) || 0) + ', default points ' + (Number(pointMeta.points) || 0)
          + ' * 100)). Please follow rule tiers or adjust score point settings.')
      }
      hitPoints = n
    }
    /* G5 / G6 倍率：数据规模翻倍、IPv6 ×3。作用在权限分上，随上限一起被 cap 约束。 */
    const mult = scoreMultiplierOf(hit)
    const r = db.prepare(`INSERT INTO score_hit(point_id, asset_id, vuln_id, step_id, target, evidence, note, self_created, port, recorded_by, recorded_at, points, multiplier)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId, hit.asset_id ?? null, hit.vuln_id ?? null, hit.step_id ?? null,
      hit.target ?? null, evidence, hit.note ?? null, selfCreated, port,
      hit.recorded_by ?? null, nowIso(), hitPoints, mult.multiplier,
    )
    const hitId = Number(r.lastInsertRowid)
    const point = db.prepare('SELECT name, points, code FROM score_point WHERE id = ?').get(pointId)
    const board = this.listScorePoints(id)
    const summary = board.summary
    const allHits = board.items.flatMap((p) => p.hits)
    const row = allHits.find((h) => h.id === hitId)
    /* 服务级封顶：同一资产同一端口只算分值最高的那条（账号类 / 数据库权限） */
    const cappedByService = selfCreated === 0 && row !== undefined && row.capped === true
    const capService = row === undefined ? null : row.service
    const capBy = row === undefined ? null : (row.capped_by || null)
    const capByPoints = row === undefined || row.capped_by_id === null || row.capped_by_id === undefined
      ? null
      : (allHits.find((h) => h.id === row.capped_by_id) || {}).points
    /* 反过来：这条是不是把同服务上原本计分的命中顶掉了（总分因此不会增加）。
       直接以「本次插入之后谁还被封顶」为准，避免受"先被别的重复命中顶掉过一次"的干扰。 */
    const demoted = selfCreated === 0 && row !== undefined && row.capped !== true
      ? allHits.filter((h) => h.capped_by_id === hitId && Number(h.id) < hitId)
      : []
    const warnings = []
    if (selfCreated === 1) {
      warnings.push('Logged, but self-registered or self-created accounts do not earn points (scoring applies to compromising existing accounts/privileges). Kept for audit trail only, does not count toward caps, and is excluded from reports.')
    }
    /* G5「含大量数据系统得分翻倍」要有量级依据：门槛是 **1 亿条 / 10TB**。
       判不出来只**警告不阻断** —— 数据量常在报告正文里而不是 evidence 里，
       硬拦会把真实成果挡在门外；但一定要提醒补齐，否则翻倍站不住。 */
    if (mult.multiplier > 1 && mult.reasons.some((x) => x.indexOf('G5') === 0)) {
      const rows = parseRowCount(evidence)
      if (rows === null) {
        warnings.push('Notice: This hit was marked with G5 data scale multiplier, but evidence lacks record count. '
          + 'Please document actual volume in evidence (e.g., "exported 130M user records" or "12TB training data"); otherwise the multiplier cannot be justified.')
      } else if (rows < SENSITIVE_DATA_MIN_ROWS) {
        warnings.push('Notice: This hit was marked with G5 multiplier, but recorded volume is **' + formatRows(rows) + ' records/rows**, '
          + 'well below the large data threshold (>100M records or 10TB). Please verify volume; if genuinely above 100M, '
          + 'use explicit notation (e.g. "132M records") in evidence.')
      }
    }
    if (cappedByService) {
      const assetIp = row.asset_id === null || row.asset_id === undefined
        ? undefined
        : (db.prepare('SELECT ip FROM asset WHERE id = ?').get(Number(row.asset_id)) || {}).ip
      warnings.push(serviceCapReason(Object.assign({}, row, { code: point ? point.code : '', asset_ip: assetIp }), capByPoints))
      if (capBy) warnings.push('Scoring belongs to another hit on the same service: ' + String(capBy).slice(0, 120))
    } else if (demoted.length > 0) {
      warnings.push('Notice: This hit superceded ' + demoted.length + ' lower-scoring hits on the same service — highest score only per service/port, so total score does not increase (previous hits marked uncredited).')
    }
    return {
      id: hitId, point_id: pointId,
      point: point ? point.name : null,
      /* 单次档位分值与最终计入的分值分开给：倍率让我们能解释"50 分怎么变成 150 分" */
      base_points: hitPoints === null ? (point ? point.points : 0) : hitPoints,
      multiplier: mult.multiplier,
      multiplier_reasons: mult.reasons.length > 0 ? mult.reasons : undefined,
      points: Math.round((hitPoints === null ? (point ? point.points : 0) : hitPoints) * mult.multiplier),
      port: port,
      service: capService,
      /* G5 量级核对结果（没按 G5 记分的条目为 null）：让界面/模型能一眼看出"翻倍有没有依据" */
      volume: mult.reasons.some((x) => x.indexOf('G5') === 0)
        ? (() => {
            const rows = parseRowCount(evidence)
            return { rows: rows, min_rows: SENSITIVE_DATA_MIN_ROWS, meets_threshold: rows === null ? null : rows >= SENSITIVE_DATA_MIN_ROWS }
          })()
        : null,
      self_created: selfCreated === 1,
      counted: selfCreated === 0 && !cappedByService,
      capped_by_service: cappedByService,
      capped_by: capBy,
      demoted_hits: demoted.map((h) => ({ id: h.id, evidence: h.evidence, points: h.points })),
      warning: warnings.length === 0 ? undefined : warnings.join('\n'),
      summary,
    }
  }

  /** 资产易打性评估：预期能拿到哪些成果、优先级多高。 */
  assessAsset(id, a = {}) {
    const db = this.db(id)
    let row
    if (a.asset_id !== undefined && a.asset_id !== null) row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(a.asset_id))
    else if (a.ip) row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(a.ip))
    if (row === undefined) throw new Error('asset not found (please provide asset_id or ip)')
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : (row.priority || 'medium')
    const stamp = nowIso()
    db.prepare('UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?')
      .run(priority, a.potential ?? (row.potential || ''), a.reason ?? (row.assess_reason || ''), stamp, a.assessed_by ?? null, row.id)
    this.#observe(db, 'asset', row.id, 'assess', priority + ' ' + (a.potential || ''), 'active', a.assessed_by ?? null, null)
    return { asset_id: row.id, ip: row.ip, priority, potential: a.potential ?? (row.potential || ''), assessed_at: stamp }
  }

  /* ---------- 资产测试状态（做了哪些测试 / 还剩什么攻击面） ---------- */

  /**
   * 记录对某个资产的测试情况。
   * @param id - 靶标 id。
   * @param t - `{ asset_id?, ip?, status?, test?, surface?, blocked?, updated_by? }`
   *   · test 会**追加**到测试记录（带时间戳）；
   *   · surface 覆盖「剩余可测攻击面」；
   *   · blocked=true 时封禁计数 +1。
   */
  updateAssetTest(id, t = {}) {
    const db = this.db(id)
    let row
    if (t.asset_id !== undefined && t.asset_id !== null) {
      row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(t.asset_id))
    } else if (t.ip) {
      row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(t.ip))
    }
    if (row === undefined) throw new Error('asset not found (please provide asset_id or ip)')
    const status = ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'].includes(t.status)
      ? t.status
      : (row.test_status || 'untested')
    const stamp = nowIso()
    /* 提示词历史上把这条记录叫 notes，模型也常照抄这个参数名；两种写法都收，
       统一落到 test_notes（追加式），避免"记了一行结论"其实什么都没写进去。 */
    const testText = [t.test, t.notes]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
      .join('；')
    let notes = row.test_notes || ''
    if (testText !== '') {
      notes = (notes === '' ? '' : notes.replace(/\n+$/, '') + '\n') + '[' + stamp + '] ' + testText
    }
    const surface = typeof t.surface === 'string' ? t.surface : (row.test_surface || '')
    const blockedCount = (row.blocked_count || 0) + (t.blocked === true ? 1 : 0)
    db.prepare(`UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`).run(
      status, notes, surface, stamp, t.updated_by ?? null, blockedCount, row.id,
    )
    if (testText !== '') {
      this.#observe(db, 'asset', row.id, 'test', testText, 'active', t.updated_by ?? null, null)
    }
    if (t.blocked === true) {
      this.#observe(db, 'asset', row.id, 'blocked', 'Blocked ' + blockedCount + ' time(s)', 'active', t.updated_by ?? null, null)
    }
    return {
      asset_id: row.id, ip: row.ip, status, blocked_count: blockedCount,
      test_notes: notes, tests: notes, surface, updated_at: stamp,
      hint: blockedCount >= 3
        ? 'Target blocked ' + blockedCount + ' times (>3 threshold): set status to abandoned, record remaining attack surface, and switch targets.'
        : undefined,
    }
  }

  /** 测试状态统计（供概览与筛选）。 */
  testStats(id) {
    const db = this.db(id)
    const rows = db.prepare("SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s").all()
    const out = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 }
    for (const r of rows) out[r.s] = r.n
    return out
  }

  /* ---------- 漏洞 / 凭据 / 访问会话 ---------- */

  /** 记录一条漏洞；带 cve 时按 (asset_id, cve, target) 幂等更新。 */
  addVuln(id, v = {}) {
    const db = this.db(id)
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info'
    const status = VULN_STATUSES.includes(v.status) ? v.status : 'candidate'
    const existing = v.cve
      ? db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.cve, v.target ?? '')
      : db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.title ?? '', v.target ?? '')
    if (existing !== undefined) {
      db.prepare(`UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained),
          agent = COALESCE(?, agent)
        WHERE id = ?`).run(
        v.title ?? null, severity, v.status ?? null, v.evidence ?? null, v.confidence ?? null,
        v.source ?? null, v.target ?? null, v.found_by_agent ?? null, normGained(v.gained),
        v.agent ?? null, existing.id,
      )
      return { id: existing.id, updated: true }
    }
    const result = db.prepare(`INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.asset_id ?? null, v.port_id ?? null, v.cve ?? null, v.title ?? null, severity,
      v.source ?? null, v.confidence ?? null, status, v.evidence ?? null, v.target ?? null,
      normGained(v.gained), v.found_by_agent ?? null, nowIso(), v.agent ?? null,
    )
    const vulnId = Number(result.lastInsertRowid)
    if (v.asset_id !== undefined && v.asset_id !== null) {
      this.#observe(db, 'asset', v.asset_id, 'vuln', [v.cve, v.title].filter(Boolean).join(' '), 'active', v.source ?? null, null)
    }
    return { id: vulnId, updated: false }
  }

  listVulns(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.severity) { where.push('v.severity = ?'); args.push(f.severity) }
    if (f.status) { where.push('v.status = ?'); args.push(f.status) }
    if (f.cve) { where.push('v.cve LIKE ?'); args.push(`%${f.cve}%`) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('v.asset_id = ?'); args.push(Number(f.asset_id)) }
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.q) {
      where.push('(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)')
      const like = `%${f.q}%`
      args.push(like, like, like, like)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`).get(...args).n
    const items = db.prepare(`SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`).all(...args, limit)
    /* 详情里要直接展示原始请求/响应，这里一并带上（请求体可能很大，做长度保护） */
    const eviStmt = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)
    const clipped = (t) => (t === null || t === undefined ? null : (String(t).length > 60000 ? String(t).slice(0, 60000) + '\n... (truncated)' : String(t)))
    for (const item of items) {
      item.http_evidence = eviStmt.all(item.id).map((e) => Object.assign({}, e, {
        request: clipped(e.request), response: clipped(e.response),
      }))
    }
    return { total, items }
  }

  updateVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false }
    db.prepare(`UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title)
      WHERE id = ?`).run(
      VULN_STATUSES.includes(patch.status) ? patch.status : current.status,
      SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.evidence ?? null, patch.confidence ?? null, normGained(patch.gained), patch.title ?? null, Number(vulnId),
    )
    return { updated: true, id: Number(vulnId) }
  }

  vulnStats(id) {
    const db = this.db(id)
    const bySeverity = {}
    for (const row of db.prepare('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity').all()) bySeverity[row.severity] = row.n
    const byStatus = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM vuln GROUP BY status').all()) byStatus[row.status] = row.n
    /* 已经写明"拿到了什么权限"的漏洞数：结论行用 */
    const withGained = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get().n
    const withEvidence = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)").get().n
    /* 按目标聚合所需的组数（漏洞页默认视图）：先按「站点/服务」归并再数 */
    const rawTargets = db.prepare(`SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln`).all()
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups,
    }
  }

  /** 凭据：明文写 secret_value（面板直接显示），同时保留 secret_ref 指向证据文件。 */
  addCredential(id, c = {}) {
    const db = this.db(id)
    if (!c.host) throw new Error('credential.host required')
    /* 明文凭据：secret_value 为准，兼容 secret / password / value 等别名 */
    const value = c.secret_value ?? c.secret ?? c.password ?? c.value ?? null
    db.prepare(`INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        agent = COALESCE(excluded.agent, credential.agent),
        found_at = excluded.found_at`).run(
      c.asset_id ?? null, c.host, c.username ?? '', c.secret_type ?? 'password',
      value === null || value === undefined ? null : String(value),
      c.secret_ref ?? null, c.privilege ?? null, c.source ?? null, c.tool ?? null,
      c.note ?? null, c.found_by_agent ?? null, nowIso(), c.agent ?? null,
    )
    const row = db.prepare('SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?')
      .get(c.host, c.username ?? '', c.secret_type ?? 'password')
    return { id: row.id }
  }

  listCredentials(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    if (f.username) { where.push('username = ?'); args.push(f.username) }
    if (f.withValue === true) where.push("COALESCE(secret_value,'') <> ''")
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /** 访问会话：一次可控访问（横向移动的起点）。 */
  addAccess(id, a = {}) {
    const db = this.db(id)
    if (!a.host) throw new Error('access.host required')
    const result = db.prepare(`INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      a.asset_id ?? null, a.host, a.username ?? null, a.method ?? null, a.privilege ?? null,
      a.session_ref ?? null, a.note ?? null, a.found_by_agent ?? null, nowIso(),
    )
    if (a.asset_id !== undefined && a.asset_id !== null) {
      this.#observe(db, 'asset', a.asset_id, 'access', [a.method, a.username, a.privilege].filter(Boolean).join(' '), 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid) }
  }

  listAccess(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- WebShell 与隧道：打的过程中随时可复用的资产 ---------- */

  /**
   * 登记一个已上线的 WebShell。同一 url+pass_key 视为同一条，重复登记即刷新。
   * @param w - `{ url, shell_type, pass_key, secret_ref, privilege, status, note, asset_id, found_by_agent }`
   */
  addWebshell(id, w = {}) {
    const db = this.db(id)
    if (!w.url) throw new Error('webshell.url required')
    const ts = nowIso()
    const existing = db.prepare('SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, \'\') = COALESCE(?, \'\')')
      .get(w.url, w.pass_key ?? null)
    if (existing !== undefined) {
      db.prepare(`UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), agent = COALESCE(?, agent), updated_at = ? WHERE id = ?`)
        .run(normalizeShellType(w.shell_type), w.secret_ref ?? null, w.privilege ?? null, normalizeShellStatus(w.status),
          w.note ?? null, w.asset_id ?? null, w.agent ?? null, ts, existing.id)
      return { id: Number(existing.id), updated: true }
    }
    const result = db.prepare(`INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.asset_id ?? null, w.url, normalizeShellType(w.shell_type), w.pass_key ?? null, w.secret_ref ?? null,
        w.privilege ?? null, normalizeShellStatus(w.status), w.note ?? null, w.found_by_agent ?? null, ts, ts, w.agent ?? null)
    if (w.asset_id !== undefined && w.asset_id !== null) {
      this.#observe(db, 'asset', w.asset_id, 'webshell', w.url, 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid), updated: false }
  }

  listWebshells(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`).all(...args, limit)
  }

  updateWebshell(id, wsId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'privilege', 'note', 'secret_ref', 'shell_type']
    const sets = []
    const args = []
    /* update 路径与新增路径用同一套规范化：以前这里能写任意字符串，
       面板的"非冰蝎马用户连不上"红标会因此静默失效。 */
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'shell_type') value = normalizeShellType(value)
      if (key === 'status') value = normalizeShellStatus(value)
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`).run(...args, wsId)
    if (result.changes === 0) throw new Error('webshell not found')
    return { updated: true }
  }

  /**
   * 登记一条内网隧道（suo5 / socks5 / ssh -R / frp …）。
   *
   * **判定规则**：只有跨越了靶标边界（通道一端在目标侧）的才算突破凭证：
   *   · target-outbound 目标主动连出（反弹 shell 落到我的服务器 / 目标上跑 frp 客户端）
   *   · target-http     经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）
   *   · target-agent    经目标已控进程/会话转发（SSH -R 由目标发起）
   *   · self-only       只在自己 VPS/自建服务器上开的代理或服务端 —— **不算突破**
   * 只在自己服务器上开个 socks5 不算打进内网，必须说清"目标侧的那一端是什么"。
   */
  addTunnel(id, t = {}) {
    const db = this.db(id)
    const ts = nowIso()
    /* entry_kind 是**边界突破得分的凭证字段**：写错必须报错，不能静默归零。
       认不出的值写成 NULL 会让 legit=null，界面显示"待确认" —— 与"没填"无法区分，
       而模型只是多打了一个空格（`target-http `）就踩到，事后完全查不出原因。 */
    const rawEntryKind = t.entry_kind === undefined || t.entry_kind === null ? '' : String(t.entry_kind).trim()
    if (rawEntryKind !== '' && TUNNEL_ENTRY_KINDS[rawEntryKind] === undefined) {
      throw new Error('Invalid entry_kind: ' + JSON.stringify(t.entry_kind) + '. Allowed values: '
        + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '（' + Object.values(TUNNEL_ENTRY_KINDS).join(' / ') + '）。'
        + 'leaving empty will be treated as "pending" and will not count toward boundary breach.')
    }
    const result = db.prepare(`INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.asset_id ?? null, t.webshell_id ?? null, t.kind ?? 'socks5', t.listen ?? null, t.entry ?? null,
        t.reach ?? null, rawEntryKind === '' ? null : rawEntryKind, t.status ?? 'active', t.pid ?? null, t.command ?? null, t.note ?? null,
        t.found_by_agent ?? null, ts, ts, t.agent ?? null)
    if (t.asset_id !== undefined && t.asset_id !== null) {
      this.#observe(db, 'asset', t.asset_id, 'tunnel', `${t.kind || 'socks5'} ${t.listen || ''}`.trim(), 'active', 'exploit', null)
    }
    const entryKind = rawEntryKind === '' ? null : rawEntryKind
    const legit = tunnelIsLegit(entryKind)
    return {
      id: Number(result.lastInsertRowid),
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? 'Registered, but entry_kind=self-only (channel opened only on operator VPS/server) — this does not constitute a valid tunnel or boundary breach. Ingress must originate from or route through target: reverse shell, frp client on target, or suo5/HTTP tunnel via WebShell.'
        : (legit === null
            ? 'Recommend adding entry_kind describing target endpoint (target-outbound / target-http / target-agent); unclassified tunnels are treated as "pending" and receive no boundary breach score.'
            : undefined),
    }
  }

  listTunnels(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('t.status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('t.asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`).all(...args, limit)
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  }

  updateTunnel(id, tId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'listen', 'reach', 'entry', 'entry_kind', 'pid', 'command', 'note']
    const sets = []
    const args = []
    /* update 路径此前**完全不校验** entry_kind / status：新增时被规范化成 NULL，
       更新时却能直接写任意字符串进库，把 legit 判定彻底绕过。这里与新增路径对齐。 */
    const TUNNEL_STATUSES = ['active', 'down', 'closed', 'unknown']
    for (const key of fields) {
      if (patch[key] === undefined) continue
      let value = patch[key]
      if (key === 'entry_kind') {
        const raw = value === null ? '' : String(value).trim()
        if (raw !== '' && TUNNEL_ENTRY_KINDS[raw] === undefined) {
          throw new Error('Invalid entry_kind: ' + JSON.stringify(value) + '. Allowed values: '
            + Object.keys(TUNNEL_ENTRY_KINDS).join(' / ') + '。')
        }
        value = raw === '' ? null : raw
      }
      if (key === 'status') {
        const raw = String(value).trim()
        if (!TUNNEL_STATUSES.includes(raw)) {
          throw new Error('Invalid tunnel status: ' + JSON.stringify(value) + '. Allowed values: ' + TUNNEL_STATUSES.join(' / ') + '。')
        }
        value = raw
      }
      sets.push(`${key} = ?`); args.push(value)
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`).run(...args, tId)
    if (result.changes === 0) throw new Error('tunnel not found')
    return { updated: true }
  }

  /**
   * 当前测试面板：正在测的资产 + 最近动过的资产（带各自已确认漏洞数/端口数/入口数）。
   * 攻击链页面的「当前正在测」区块用它，客户端每隔几秒轮询一次实现实时更新。
   */
  activeTests(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 8, 50)
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`
    const testing = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`).all(limit)
    /* 最近动过：排除正在测的，避免两个区块重复 */
    const recent = db.prepare(`${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`).all(limit)
    /* 待测队列：还没动的，按易打性 + 端口数排出先打哪几台 */
    const queue = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`).all(limit)
    const untested = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'`).get().n
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() }
  }

  /**
   * 一条得分的"怎么来的"：把动作步骤 + 利用的漏洞 + 拿到手的凭据/入口串成可复现的链路。
   *
   * 报告里"账号密码怎么来的、隧道怎么搭的"就靠这里 —— 缺步骤、缺命令、缺证据都要显式标出来，
   * 让用户一眼看出哪条成果复现不了，而不是给一份看着漂亮、实则没法交的报告。
   * @param db - 靶标库句柄。
   * @param hit - score_hit 行（含 asset_id / vuln_id / step_id / target / recorded_at / point_code）。
   * @returns `{ steps, vuln, credentials, accesses, webshells, tunnels, how, complete, gaps }`
   */
  #hitTrace(db, hit, engagementId) {
    const evidenceDir = engagementId ? this.dirOf(engagementId) : null
    const steps = []
    const stepById = new Map()
    const pushStep = (row) => {
      if (row === undefined || row === null) return
      if (stepById.has(row.id)) {
        const existing = stepById.get(row.id)
        if (existing.inferred === true && row.inferred !== true) existing.inferred = false
        return
      }
      const step = {
        id: row.id, seq: row.seq, stage_code: row.stage_code, title: row.title || '',
        detail: row.detail || '', tool: row.tool || '', result: row.result || '',
        agent: row.agent || row.recorded_by || '', recorded_at: row.recorded_at || null,
        vuln_id: row.vuln_id ?? null, asset_id: row.asset_id ?? null, point_id: row.point_id ?? null,
        evidence_ref: row.evidence_ref || '', inferred: row.inferred === true,
      }
      stepById.set(step.id, step)
      steps.push(step)
    }
    const cols = 'id, seq, stage_code, title, detail, tool, agent, result, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_at'
    /* 归因规则（先准后宽）：
         ① 显式关联的步骤（score_hit.step_id）
         ② 这个漏洞的步骤（vuln_id）——"靠这个洞拿到的分"就该看到打这个洞的动作
         ③ 同资产 + 同得分点的步骤（推断）
       只有上面都没有时，才退到"同资产的全部步骤"（为了让报告不至于空白），并标成推断。
       step_source 会如实告诉调用方这次用的是哪一档，界面/报告据此提示"仅供参考"。 */
    let stepSource = null
    try {
      if (hit.step_id !== null && hit.step_id !== undefined) {
        pushStep(db.prepare(`SELECT ${cols} FROM attack_step WHERE id = ?`).get(hit.step_id))
        if (steps.length > 0) stepSource = 'linked'
      }
      if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE vuln_id = ? ORDER BY seq, id`).all(hit.vuln_id)) pushStep(row)
        if (stepSource === null && steps.length > 0) stepSource = 'vuln'
      }
      if (hit.asset_id !== null && hit.asset_id !== undefined && hit.point_id !== null && hit.point_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? AND point_id = ? ORDER BY seq, id`).all(hit.asset_id, hit.point_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
          if (stepSource === null) stepSource = 'point'
        }
      }
      if (steps.length === 0 && hit.asset_id !== null && hit.asset_id !== undefined) {
        for (const row of db.prepare(`SELECT ${cols} FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT 40`).all(hit.asset_id)) {
          pushStep(Object.assign({}, row, { inferred: true }))
        }
        if (steps.length > 0) stepSource = 'asset'
      }
    } catch { /* 老库缺列时降级为"无步骤"，报告会标成无法复现 */ }
    steps.sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq ?? 0) - (b.seq ?? 0)))

    /* 这条得分用到的漏洞 */
    let vuln = null
    if (hit.vuln_id !== null && hit.vuln_id !== undefined) {
      try {
        const v = db.prepare('SELECT id, cve, title, severity, status, target, evidence, gained, source, found_by_agent, found_at FROM vuln WHERE id = ?').get(hit.vuln_id)
        if (v !== undefined) vuln = v
      } catch { vuln = null }
    }
    /* ── 凭据 / 会话 / 马 / 隧道：必须与"本条得分"是同一件事才挂 ──────────────
       原实现只按 asset_id 取，于是同一台资产上登记的**全部**凭据与会话被挂到该资产的
       每一条得分上。实测后果：一条「终端权限 pc-001」下面挂着「MySQL root（配置文件泄露）」——
       与终端毫无关系；一条资产 4 条得分各自重复列出同一批凭据，报告因此又长又假。
       判定：**本条写了 target 时**要求 target 主机与该资产（IP / 首选名）对得上；
       没写 target（纯资产级成果，如"控下 1 台终端"）时按资产挂载是合理的。 */
    const targetHost = (() => {
      const t = String(hit.target || '').trim()
      if (t === '') return null
      const url = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t)
      let authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
      if (!authority) return null
      authority = authority.replace(/^\[|\]$/g, '').replace(/:\d{1,5}$/, '').toLowerCase()
      return authority === '' ? null : authority
    })()
    const asset = (hit.asset_id === null || hit.asset_id === undefined)
      ? undefined
      : (() => { try { return db.prepare('SELECT ip, primary_name, segment_cidr FROM asset WHERE id = ?').get(Number(hit.asset_id)) } catch { return undefined } })()
    const targetMatchesAsset = () => {
      if (targetHost === null) return true                 /* 没写 target：按资产挂载 */
      if (asset === undefined) return false                /* 写了 target 又查不到资产：不挂 */
      const ip = String(asset.ip || '').toLowerCase()
      const name = String(asset.primary_name || '').toLowerCase()
      const cidr = String(asset.segment_cidr || '').toLowerCase()
      /* ① 目标就是这台资产（IP 或首选域名） */
      if (targetHost === ip || targetHost === name) return true
      /* ② 目标"看着不像单台主机"：边界突破常把 target 写成可达网段（10.20.30.0/24）、
         终端类会写成设备名（pc-001）。这类条目本质是"资产级成果"，
         它用到的隧道/马/凭据就挂在这台入口资产上 —— 不挂会丢掉"通道怎么搭的"。
         判据：target 里有 '/'（网段）或解析出的主机不是 IP/域名形态。 */
      const raw = String(hit.target || '').trim()
      if (raw.includes('/')) return true
      if (cidr !== '' && (targetHost === cidr || cidr.startsWith(targetHost + '/'))) return true
      const looksLikeHost = /^[0-9a-f.:\[\]]+$/i.test(targetHost) || targetHost.includes('.')
      return !looksLikeHost
    }
    const sameAsset = targetMatchesAsset()

    const credentials = []
    const accesses = []
    const webshells = []
    const tunnels = []
    if (sameAsset) {
      try {
        if (hit.asset_id !== null && hit.asset_id !== undefined) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE asset_id = ? ORDER BY id LIMIT 20`).all(hit.asset_id))
        } else if (targetHost !== null) {
          credentials.push(...db.prepare(`SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE host LIKE ? ORDER BY id LIMIT 20`).all('%' + targetHost + '%'))
        }
      } catch { /* 忽略 */ }
      if (hit.asset_id !== null && hit.asset_id !== undefined) {
        try { accesses.push(...db.prepare('SELECT id, host, username, method, privilege, session_ref, obtained_at FROM access_session WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 忽略 */ }
        try { webshells.push(...db.prepare('SELECT id, url, shell_type, pass_key, privilege, status, agent FROM webshell WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)) } catch { /* 忽略 */ }
        try {
          tunnels.push(...db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, command, agent FROM tunnel WHERE asset_id = ? ORDER BY id LIMIT 20').all(hit.asset_id)
            .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind) })))
        } catch { /* 忽略 */ }
      }
    }

    /* 复现完整性判定：一条得分至少要"有步骤 + （有命令 或 有漏洞 或 有原始请求）" */
    const hasCommand = steps.some((s) => String(s.tool || '').trim() !== '')
    const gaps = []
    if (steps.length === 0) gaps.push('No attack step recorded (`redteam_chain_add`): Action details missing')
    else if (!hasCommand) gaps.push('Attack step missing `tool` (command): Execution command unknown for reproduction')
    if (hit.vuln_id === null || hit.vuln_id === undefined) gaps.push('Missing associated `vuln_id`: Raw HTTP request cannot be linked in report')
    if (credentials.length === 0 && ['web-account-user', 'web-account-admin', 'db-access'].includes(hit.code)) {
      gaps.push('Account/Privilege score without credential registered (`redteam_credential_add`): Credential origin unspecified')
    }
    if (['boundary', 'internal-pivot'].includes(hit.code) && tunnels.length === 0) {
      gaps.push('Boundary breach score without tunnel registered (`redteam_tunnel_add`): Tunnel setup details unspecified')
    }

    /* how：一句话交代"靠什么拿到的"，优先用最有信息量的那条 */
    const primary = steps.find((s) => String(s.title || '').trim() !== '') || steps[0]
    let how = ''
    if (hit.vuln_id !== null && hit.vuln_id !== undefined && vuln !== null) {
      how = 'Exploited vulnerability ' + (vuln.cve ? vuln.cve + ' ' : '') + (vuln.title || '') + '（' + (vuln.severity || 'unknown') + '）'
    } else if (primary !== undefined) {
      how = primary.title || ''
    }
    if (primary !== undefined && String(primary.tool || '').trim() !== '') {
      how = (how === '' ? '' : how + '；') + 'Command: ' + String(primary.tool).trim()
    }
    return {
      engagement_dir: evidenceDir,
      steps, vuln, credentials, accesses, webshells, tunnels,
      how,
      /* 步骤是怎么归因到这条得分的：linked（显式）> vuln（同漏洞）> point（同资产同得分点）> asset（同资产兜底） */
      step_source: stepSource,
      evidence_refs: steps.map((s) => s.evidence_ref).filter(Boolean),
      complete: gaps.length === 0,
      gaps,
    }
  }

  /**
   * 攻击得分链路复现报告：只收录"拿到了分"的成果，平铺成列表。
   * 每条都尽量带上能直接粘进 Yakit Repeater 的原始请求：
   *   ① 显式关联的漏洞（score_hit.vuln_id）→ 该漏洞的 http_evidence（最准）
   *   ② 兜底：同资产 + 按目标 URL 路径匹配（标注为自动匹配）
   *   ③ 都没有 → 只给证据文本，并标 missing_evidence
   *
   * 每条另附 **「怎么拿到的」**（#hitTrace）：动作步骤（含实际命令与回显）+ 利用的漏洞 +
   * 拿到的凭据 / WebShell / 隧道 —— 回答"账号密码怎么来的、隧道怎么搭建的"。
   * 缺少步骤或命令的条目会被标 incomplete，并在报告里列出 gaps。
   */
  scoreReport(id, options = {}) {
    const db = this.db(id)
    const meta = readMeta(this.metaPathOf(id)) || {}
    const limit = Math.min(Number(options.limit) || 500, 2000)
    const rows = db.prepare(`SELECT h.*, p.code, p.name AS point_name, p.points AS point_default, p.category,
        p.enabled AS point_enabled, p.rule AS point_rule, p.tier AS point_tier, p.cap AS point_cap,
        p.dedup_scope AS point_dedup, p.src AS point_src, p.description AS point_desc,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)

    /* 计分口径：同类得分不设上限，命中即累加（自建账号已在上面整条剔除） */
    const perPoint = new Map()
    const eviByVuln = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)

    const clip = (t, n) => {
      const s = t === null || t === undefined ? '' : String(t)
      return s.length > n ? s.slice(0, n) + '\n... (truncated, full content in evidence file)' : s
    }

    /* 每条命中落在攻击链的哪个阶段（与攻击链页同一套推导规则） */
    const scopeOf = new Map()
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v) => v !== null && v !== undefined)))
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',')
        for (const a of db.prepare(`SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`).all(...ids)) {
          scopeOf.set(a.id, a.scope)
        }
      }
    }
    /* 自己注册/自建的账号不算成果：从报告主体剔除，只在页脚给一个数字 */
    const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1)
    /* 「停用」的得分点：面板只累加 enabled 的点（listScorePoints 的口径），报告必须一致，
       否则同一个交付物里会出现两个总分（例如停用 web-app 后面板 50 分、报告 150 分）。
       这些命中不进正文、不进总分，但同样只报个数（用户是自己关的，不是被规则顶掉的）。
       判定函数放在下面与 reportRows 一起，避免两份口径漂移。 */
    /* 计分口径与规则上限：**必须与 listScorePoints 用同一套**（applyScoreCaps + 得分点元数据），
       否则面板显示 6340 分、报告写 7930 分，两边对不上 —— 交付物自相矛盾比数字高低更糟。
       被顶掉/超上限的命中不进正文（它们不是新的成果），只在页脚报个数。 */
    /* 计分评估走共享实现，且**带上 enabledOnly**：面板只累加启用的得分点，
       报告如果不看 enabled 就会出现"面板 50 分、报告 150 分"这种自相矛盾的交付物。 */
    const reportMeta = loadScoreMeta(db)
    const reportNames = loadAssetNames(db)
    /* 命中自带 points 时以命中为准（合并版一条含多档）。
       倍率（G5/G6）乘在档位分值上 —— 调共享的 hitPointsOf，保证面板/报告/攻击链三处口径一致。 */
    const effPoints = (h) => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: h.code },
      new Map([[String(h.code), {
        points: (h.point_default !== undefined && h.point_default !== null
          ? Number(h.point_default) || 0
          : (reportMeta.get(h.code) || {}).points || 0),
      }]]),
    )
    const reportEval = evaluateScoreBoard(db, rows.map((h) => Object.assign({}, h, { points: effPoints(h) })),
      { meta: reportMeta, names: reportNames, enabledOnly: true })
    const capFlagById = reportEval.byId
    const isCappedRow = (h) => {
      const flag = capFlagById.get(h.id)
      return flag !== undefined && flag.capped === true
    }
    const isDisabledRow = (h) => h.point_enabled !== null && h.point_enabled !== undefined
      && Number(h.point_enabled) !== 1
    const reportRows = rows.filter((h) => Number(h.self_created) !== 1 && !isCappedRow(h) && !isDisabledRow(h))
    const serviceCappedRows = rows.filter((h) => Number(h.self_created) !== 1 && isCappedRow(h))

    const items = reportRows.map((h, i) => {
      const seen = perPoint.get(h.point_id) || 0
      perPoint.set(h.point_id, seen + 1)
      const counted = true
      /* 该条命中的实际分值：命中自带优先（合并版一条含多档），否则用得分点默认值 */
      const hitPoints = effPoints(h)

      /* "怎么拿到的"：动作步骤 + 漏洞 + 凭据/入口（报告的核心，缺了就是没法交付） */
      const trace = this.#hitTrace(db, { ...h, code: h.code }, id)

      /* 原始请求：先按显式关联的漏洞取 */
      let requests = h.vuln_id === null || h.vuln_id === undefined ? [] : eviByVuln.all(h.vuln_id).map((e) => ({
        label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
        request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'linked',
      }))
      /* 兜底：同资产 + 目标路径逐级降级匹配（先精确到两级路径，再退到一级、再到整个授权） */
      if (requests.length === 0 && h.target) {
        const full = String(h.target).trim()
        const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full)
        const candidates = []
        if (um !== null) {
          const authority = um[2]
          const segs = (um[3] || '').split('/').filter(Boolean)
          if (segs.length >= 2) candidates.push('%' + authority + '/' + segs.slice(0, 2).join('/') + '%')
          if (segs.length >= 1) candidates.push('%' + authority + '/' + segs[0] + '%')
          candidates.push('%' + authority + '%')
          if (segs.length >= 2) candidates.push('%/' + segs.slice(0, 2).join('/') + '%')
        } else {
          const auth = full.split('/')[0].split('?')[0]
          if (auth !== '') candidates.push('%' + auth + '%')
        }
        const SQL = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3'
        const SQL_ASSET = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3'
        let rows2 = []
        if (h.asset_id !== null && h.asset_id !== undefined) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL_ASSET).all(h.asset_id, like)
            if (rows2.length > 0) break
          }
        }
        if (rows2.length === 0) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL).all(like)
            if (rows2.length > 0) break
          }
        }
        requests = rows2.map((e) => ({
          label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'auto',
        }))
      }
      /* ── 复现入口：请求 / 命令 / 判定标准 ──────────────────────────────────
         用户反馈"报告里的得分点没讲明白得分过程、难以复现"。库里其实有料：
         攻击步骤的 tool 常常就是那条 curl，target 就是这个请求的地址。
         这里把它整理成三样东西：
           · replay_cmd  —— 能直接粘进终端跑的命令（真实 curl 原样保留，其余按 URL 合成）
           · replay_http —— 能粘进 Yakit Repeater 的原始报文（有真实抓包用真实的，否则合成）
           · confirm     —— 这条凭什么算拿到、要附什么材料、从哪复现
         **合成的一律标 synthesized + 说明来源**，不能让验收人把推断当实证。 */
      const firstStepTool = (trace.steps.find((x) => String(x.tool || '').trim() !== '') || {}).tool || ''
      const parsedCurl = parseCurl(firstStepTool)
      const replayUrl = (() => {
        if (requests.length > 0 && requests[0].url) return requests[0].url
        if (parsedCurl !== null) return parsedCurl.url
        return h.target || null
      })()
      /* ── 合成的边界（很重要）─────────────────────────────────────────────
         只有"这条得分确实是 HTTP 交互拿到的"才合成 HTTP 报文/curl 命令。
         不加这个判断会把服务名当成 HTTP 服务，产出这种没用的东西：
           · 目标 10.20.30.40:3306 → `curl -i -s 'http://10.20.30.40:3306/'`
           · 目标 pc-001          → `curl -i -s 'http://pc-001/'`
         宁可明确说"这条不是 HTTP 入口，请按下面的动作模板复现"。 */
      const targetParsed = parseTarget(h.target || '')
      const schemeIsHttp = targetParsed !== null
        && (targetParsed.scheme === 'http' || targetParsed.scheme === 'https')
      /* 判定"这条是 HTTP 交互"的三条依据，命中任一即可 */
      const isHttpEntry = parsedCurl !== null
        || (requests.length > 0 && String(requests[0].request || '').trim() !== '')
        || schemeIsHttp
      const confirm = scoreConfirmOf(h.code)

      /* ── 复现命令：先看"这条得分靠什么资产成立"，再挑命令 ────────────────────
           · real        —— 攻击时确实敲过、且就是这次 HTTP 交互的 curl
           · synthesized —— 由**真实抓获请求**或目标 URL 合成的 curl（命令行等价形式）
           · template    —— 该得分点自己的动作模板（资产已把它填成可跑的命令）
           · from_step   —— 取自攻击步骤的真实命令（可能不是"本步"的动作，如实标注）
         ⚠️ 顺序错误的代价（实测）：边界突破条目靠**隧道**成立，但同资产的攻击步骤里
         记着"上传冰蝎马"的 curl；若先判"步骤里有 curl 就用它"，报告就会把上传命令
         当成边界突破的复现命令 —— 张冠李戴，用户照着跑根本复现不出"跨进内网"。
         所以"资产是否指向该得分点的复现方式"必须排在"步骤里有没有命令"之前。 */
      const capturedRequest = requests.length > 0 ? String(requests[0].request || '').trim() : ''
      const capturedCurl = (() => {
        if (capturedRequest === '') return null
        const firstLine = capturedRequest.split(/\r?\n/)[0]
        const m = /^([A-Z]+)\s+(\S+)/.exec(firstLine)
        const hostLine = /^host:\s*(\S+)/im.exec(capturedRequest)
        if (m === null || hostLine === null) return null
        const scheme = /:443$/.test(hostLine[1]) ? 'https' : 'http'
        /* path 单独带出来：parseTarget 会在 '?' 处截断，只给 url 会丢掉查询串
           （实测把 `GET /_cat/indices?v` 合成成 `curl .../_cat/indices`）。
           鉴权与内容类型头同样要带（Basic 少了就是 401，POST 少了就是 415）。 */
        const keep = []
        for (const line of capturedRequest.split(/\r?\n/).slice(1)) {
          if (/^(authorization|content-type|accept|x-requested-with|referer):/i.test(line.trim())) keep.push(line.trim())
        }
        return { url: scheme + '://' + hostLine[1] + m[2], method: m[1], path: m[2], headers: keep }
      })()

      const tunnel0 = trace.tunnels[0] || null
      const listenPort = tunnel0 === null || !tunnel0.listen
        ? null
        : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
      const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
      const t0 = parseTarget(h.target || '')
      const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
      const templateValues = {
        host: (reach === null || reach === '' ? null : reach.replace(/\/[0-9]{1,3}$/, '')) || (t0 === null ? null : t0.host),
        port: listenPort || (t0 === null ? null : t0.port),
        user: cred0.username,
        pass: cred0.secret_value,
        url: h.target || null,
      }

      let replayCmd = null
      let replayCmdKind = null
      let replayCmdUnfilled = []
      const curlIsThisAction = commandKind(firstStepTool) === 'curl'
      /* 本条**显式关联**的那条攻击步骤里记的命令：这才是"这次动作到底敲了什么"。
         只认显式关联（h.step_id），不认同资产推断出来的历史步骤 —— 后者会把
         "上传冰蝎马"的 curl 挂到"跨境突破"条目上，报告直接张冠李戴。 */
      const linkedStep = (trace.steps || []).find((st) => st.id === h.step_id) || null
      const linkedTool = linkedStep === null ? '' : String(linkedStep.tool || '').trim()
      const looksLikeCommand = (t) => t.length >= 8 && /^[A-Za-z0-9_./~$-]+/.test(t) && /\s/.test(t)

      if (capturedRequest !== '' && capturedCurl !== null) {
        /* ① 有真实抓获报文：命令行等价形式与报文严格对应，最不会误导。
           请求体**只从这份报文里取**，不能借用攻击步骤里那条 curl 的 data ——
           实测会把 `GET /_cat/indices?v` 合成成 `curl -d @/tmp/.b.json .../_cat/indices`。 */
        const sep = capturedRequest.search(/\r?\n\r?\n/)
        const body = sep === -1 ? '' : capturedRequest.slice(sep).replace(/^\r?\n\r?\n/, '').trim()
        replayCmd = buildCurlCommand({
          url: capturedCurl.url, path: capturedCurl.path, method: capturedCurl.method,
          headers: capturedCurl.headers,
          data: body === '' ? null : body,
          cookie: parsedCurl === null ? null : parsedCurl.cookie,
        })
        replayCmdKind = 'synthesized'
      } else if (linkedTool !== '' && looksLikeCommand(linkedTool)) {
        /* ①′ 本条动作的真实命令（含 impacket / nxc / mysql / redis-cli 这类非 curl 工具）。
            这类命令过去会被丢掉、退回通用模板（模板是"id; whoami; hostname"这种判定语），
            用户照着跑什么也复现不出来 —— 报告里最误导的一处，现在改成原样给出。 */
        replayCmd = linkedTool
        replayCmdKind = commandKind(linkedTool) === 'curl' ? 'real' : 'linked'
      } else if (curlIsThisAction && !(tunnel0 !== null && confirm !== null && confirm.script)) {
        /* ② 真实 curl，且这条得分不是"靠隧道成立"的（隧道条目见下面 ③） */
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (confirm !== null && confirm.script) {
        /* ③ 得分点自己的动作模板：用本条记录的目标/隧道/凭据填成可跑的命令 */
        replayCmdKind = 'template'
        const filled = fillTemplate(confirm.script, templateValues)
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      } else if (curlIsThisAction) {
        replayCmd = firstStepTool
        replayCmdKind = 'real'
      } else if (commandKind(firstStepTool) !== null) {
        /* ④ 步骤里的其它真实命令：如实说明它不是"本步"的动作 */
        replayCmd = firstStepTool
        replayCmdKind = 'from_step'
      }

      if (replayCmd === null && confirm && confirm.script) {
        replayCmdKind = 'template'
        /* 用这条得分自己已知的信息填模板：host 来自 target，账号来自挂载的凭据。
           填不上的占位符保持原样并列出来 —— 不猜，也不假装能直接跑。 */
        const cred0 = (trace.credentials.find((c) => c.username) || trace.credentials[0]) || {}
        const t0 = parseTarget(h.target || '')
        /* 隧道条目：<端口> 指的是隧道监听端口（127.0.0.1:1080），不是 target 里的端口。
           边界突破的 target 是"可达网段"（10.20.30.0/24），拿它解析端口只会得到 null、
           留下一个填不上的占位符 —— 而这条得分真正要跑的命令就写在隧道记录里。 */
        const tunnel0 = trace.tunnels[0] || null
        const listenPort = tunnel0 === null || !tunnel0.listen
          ? null
          : (/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) || [])[1] || null
        const reachHost = (() => {
          const reach = tunnel0 === null ? null : String(tunnel0.reach || '').trim()
          if (reach === null || reach === '') return null
          return reach.replace(/\/[0-9]{1,3}$/, '')     /* 10.20.30.0/24 → 10.20.30.0 */
        })()
        const filled = fillTemplate(confirm.script, {
          host: reachHost || (t0 === null ? null : t0.host),
          port: listenPort || (t0 === null ? null : t0.port),
          user: cred0.username,
          pass: cred0.secret_value,
          url: h.target || null,
        })
        replayCmd = filled.cmd
        replayCmdUnfilled = filled.remaining
      }

      /* 原始报文：优先真实抓包；其次从真实 curl 合成；否则仅当 target 写了 http(s):// 才合成 */
      let replayHttp = null
      let replayHttpSynthesized = false
      if (requests.length > 0 && String(requests[0].request || '').trim() !== '') {
        replayHttp = requests[0].request
      } else if (parsedCurl !== null) {
        replayHttp = buildHttpRequest({
          url: parsedCurl.url, method: parsedCurl.method, data: parsedCurl.data,
          headers: parsedCurl.headers, cookie: parsedCurl.cookie,
          insecure: parsedCurl.insecure, followRedirect: parsedCurl.followRedirect,
        })
        replayHttpSynthesized = replayHttp !== null
      } else if (schemeIsHttp) {
        replayHttp = buildHttpRequest({ url: h.target, method: 'GET' })
        replayHttpSynthesized = replayHttp !== null
      }
      return {
        seq: i + 1,
        id: h.id,
        point_id: h.point_id,
        /* 显式关联的动作步骤 id：报告据此把"同一次批量动作"的条目合并成一条 + 台账表。
           必须用显式关联，不能用 trace 里推断出来的步骤 —— 推断会把同资产的历史步骤
           也算进来，同一批动作的条目就合不到一起（实测：64 台终端里有一台因此掉队）。 */
        step_id: h.step_id === null || h.step_id === undefined ? null : h.step_id,
        /* 得分点规则元数据（分区表与逐条明细要写"规则几 / 档位 / 上限"） */
        point_rule: h.point_rule === null || h.point_rule === undefined ? null : h.point_rule,
        point_tier: h.point_tier || '',
        point_cap: Number(h.point_cap) || 0,
        point_dedup: h.point_dedup || '',
        /* 得分点 code：报告条目与攻击链条目**必须带上同一个 code** ——
           界面要按它把两边对起来（报告页的阶段分组兜底、工具侧按 code 核对成果），
           缺了它下游只能按 point_name 模糊匹配，改个名字就断。 */
        code: h.code || '',
        stage_code: scoreStageOf({ stage_code: h.stage_code, code: h.code, target: h.target },
          h.asset_id === null || h.asset_id === undefined ? undefined : scopeOf.get(h.asset_id)),
        point_name: h.point_name || '(Deleted score point)',
        category: h.category || '',
        points: hitPoints,
        counted: counted,
        nth_of_point: seen + 1,
        target: h.target || '',
        asset_ip: h.asset_ip || '',
        gained: h.vuln_gained || '',
        vuln: h.vuln_id === null || h.vuln_id === undefined ? null : { id: h.vuln_id, title: h.vuln_title || '', cve: h.vuln_cve || null, severity: h.vuln_severity || null },
        evidence: h.evidence || '',
        note: h.note || '',
        recorded_by: h.recorded_by || '',
        recorded_at: h.recorded_at || '',
        requests: requests,
        missing_evidence: requests.length === 0,
        /* 复现入口（新增）：用户照着这三样就能重放/自证 */
        replay_cmd: replayCmd,
        /* real / synthesized / template —— 界面与报告据此决定措辞（模板不能叫"照抄即可"） */
        replay_cmd_kind: replayCmdKind,
        /* 模板里还没填上的占位符（空数组表示已全部填好、可直接跑） */
        replay_cmd_unfilled: replayCmdKind === 'template' && replayCmdUnfilled.length > 0 ? replayCmdUnfilled : undefined,
        /* 证据截图：本条（或本组）对应的代表图，最多 3 张 —— 见 #representativeShots */
        shots: [],
        replay_http: replayHttp,
        replay_http_synthesized: replayHttpSynthesized,
        /* 这份报文是当日真实抓包，还是按当日命令/回显重建的（证据行的 note 里写明了就按它标） */
        replay_http_rebuilt: requests.length > 0 && /rebuilt|per engagement.*(command|output)|no raw capture preserved/i.test(String(requests[0].note || '')),
        /* 这条得分是不是"靠 HTTP 交互"拿到的。报告据此决定要不要给可粘贴的报文：
           非 HTTP 目标（SMB/数据库/隧道）硬合成出来的报文是废的，不如直接给命令行 + 说明。 */
        http_entry: isHttpEntry,
        /* 这份复现入口是怎么来的：
             linked       —— 显式关联漏洞的真实抓包
             auto         —— 按目标路径匹配到的真实抓包（需核对）
             request      —— 由真实抓包推导出的命令行等价形式
             step         —— 取自攻击步骤的真实命令（未必是本步动作）
             synthesized  —— 完全由目标 URL 合成（需核对）
             template     —— 得分点自己的动作模板（用本条记录填好） */
        replay_source: requests.length > 0
          ? (capturedRequest !== '' ? (requests[0].source === 'linked' ? 'linked' : 'auto')
            : (replayCmdKind === 'from_step' ? 'step' : 'request'))
          : (replayCmdKind === 'from_step' ? 'step'
            : (replayCmdKind === 'template' ? 'template' : (replayCmd !== null || replayHttp !== null ? 'synthesized' : null))),
        /* 判定标准 / 自证材料 / 复现入口（来自 SCORE_CONFIRM，按 code 取） */
        confirm: confirm,
        confirm_missing: confirm === null,
        /* 怎么拿到的：步骤（含命令与回显）+ 漏洞 + 凭据/入口；incomplete 表示报告没法复现这一步 */
        trace: trace,
        how: trace.how,
        steps: trace.steps,
        credentials: trace.credentials,
        accesses: trace.accesses,
        webshells: trace.webshells,
        tunnels: trace.tunnels,
        incomplete: trace.complete !== true,
        gaps: trace.gaps,
      }
    })

    const summary = {
      count: items.length,
      points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
      withRequests: items.filter((x) => x.requests.length > 0).length,
      autoMatched: items.filter((x) => x.requests.some((r) => r.source === 'auto')).length,
      missingRequests: items.filter((x) => x.missing_evidence).length,
      /* 复现完整性：有步骤且有命令的条目数 / 缺步骤或命令的条目数 */
      withSteps: items.filter((x) => x.steps.length > 0).length,
      withCommands: items.filter((x) => x.steps.some((s) => String(s.tool || '').trim() !== '')).length,
      incomplete: items.filter((x) => x.incomplete).length,
      credentials: items.reduce((n, x) => n + x.credentials.length, 0),
      tunnels: items.reduce((n, x) => n + x.tunnels.length, 0),
      /* 自己注册/自建账号的命中：不算成果，不写进报告 */
      selfCreatedExcluded: selfCreatedRows.length,
      /* 同资产同端口重复的账号/数据库权限命中：服务已拿满，重复的不算新成果 */
      serviceCappedExcluded: serviceCappedRows.length,
      /* 所属得分点已被用户「停用」的命中：与面板口径一致地排除（否则两边总分对不上） */
      disabledExcluded: rows.filter((h) => Number(h.self_created) !== 1 && isDisabledRow(h)).length,
      serviceCapped: serviceCappedRows.map((h) => ({
        id: h.id, point_name: h.point_name || h.code, code: h.code,
        service: serviceLabel(h), evidence: h.evidence || '', target: h.target || '',
        points: h.points || 0, recorded_at: h.recorded_at || '',
      })),
    }
    /* ── 条目合并：同一得分点 + 同一动作（同一批攻击步骤）、只有目标不同的条目 ──────
       典型场景：一次批量动作打下 60 台终端。逐台一条会把报告撑成流水账（实测占全文 64%），
       读者反而找不到"这一步到底是怎么做的"。合并成一条 + 目标台账表，
       复现入口只写一次，台数用表格堆。 */
    const GROUP_MIN = Math.max(2, Number(options.groupMin) || 5)
    const stepKeyOf = (x) => (x.step_id === null || x.step_id === undefined ? '' : String(x.step_id))
    const items2 = (() => {
      const buckets = new Map()
      for (const x of items) {
        const k = x.point_id + '|' + stepKeyOf(x)
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(x)
      }
      const out = []
      const done = new Set()
      for (const x of items) {
        if (done.has(x.id)) continue
        const k = x.point_id + '|' + stepKeyOf(x)
        const members = buckets.get(k) || [x]
        done.add(x.id)
        if (members.length < GROUP_MIN || stepKeyOf(x) === '') { out.push(x); continue }
        for (const m of members) done.add(m.id)
        /* 代表条目 = 证据文本出现次数最多的那条（众数），而不是时间最早的那条：
           同一批动作里个别目标可能是另一种打法（实测 64 台终端里第一台用的是域管账号），
           拿它当整组说明会把特例写成通例。 */
        /* 证据文本逐台不同（里面写着各自的 IP/主机名），所以先做"数字归一化"再取众数：
           64 台终端的 GPO 打法归一化后是同一句话，而首台那条"用域管账号"的特例不是 ——
           这样代表条目就会落在多数派上。 */
        const freq = new Map()
        const norm = (t) => String(t || '').replace(/[0-9]/g, '#')
        for (const m of members) {
          const k = norm(m.evidence)
          freq.set(k, (freq.get(k) || 0) + 1)
        }
        const rep = members.slice().sort((a, b) => (freq.get(norm(b.evidence)) || 0) - (freq.get(norm(a.evidence)) || 0)
          || String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')))[0] || x
        out.push(Object.assign({}, rep, {
          is_group: true,
          group_size: members.length,
          /* 合并条目在链路里的位置按"最早那一台"算：批量动作从第一台成功起就算发生了，
             用代表条目的时间会让整组在链路里漂移（实测终端组在 #12 与 #15 之间跳） */
          order_at: members.map((m) => String(m.recorded_at || '')).sort()[0] || rep.recorded_at,
          points: members.reduce((n, m) => n + m.points, 0),
          group_targets: members.map((m) => ({
            id: m.id, target: m.target, points: m.points, evidence: m.evidence, recorded_at: m.recorded_at,
          })),
        }))
      }
      return out
    })()

    /* ── 证据截图：按"得分点"取代表图（最多 3 张），分组条目用全体成员的命中一起去认领 ──
       交付时最有说服力的是当时那张图；但批量得分点有几十条命中，
       逐条贴图只会淹掉正文，所以按点取代表图。 */
    /* ⚠️ 代表图按**得分点**选，不是按条目选：一个得分点有 6 台域控就是 6 个条目，
       按条目各选 3 张会让同 3 张图在正文里重复出现 6 遍（实测 22 条正文贴出 58 张图）。
       规则：每个得分点共选 ≤3 张；条目只显示"属于本条命中"的那几张，
       点级图（没挂命中的）挂在该得分点的第一个条目上。 */
    const pointHitIds = new Map()
    for (const x of items2) {
      if (!pointHitIds.has(Number(x.point_id))) pointHitIds.set(Number(x.point_id), [])
      const list = pointHitIds.get(Number(x.point_id))
      for (const hid of (x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])) {
        if (list.indexOf(hid) === -1) list.push(hid)
      }
    }
    const shotPicks = this.#representativeShots(id, Array.from(pointHitIds.entries()).map(([pid, ids]) => ({
      point_id: pid, hit_ids: ids,
    })), 3)
    const shotBriefOf = (sh) => ({
      id: Number(sh.id), url: this.shotUrlOf(id, sh), label: sh.label || '', note: sh.note || '',
      kind: sh.kind || 'screenshot', mime: sh.mime || 'image/png', bytes: Number(sh.bytes) || 0,
      width: sh.width === null || sh.width === undefined ? null : Number(sh.width),
      height: sh.height === null || sh.height === undefined ? null : Number(sh.height),
      target: sh.target || '', captured_at: sh.captured_at || '', source_ref: sh.source_ref || '',
    })
    const shotTotalByPoint = new Map()
    try {
      for (const row of db.prepare('SELECT point_id, COUNT(*) AS n FROM shot GROUP BY point_id').all()) {
        if (row.point_id !== null && row.point_id !== undefined) shotTotalByPoint.set(Number(row.point_id), Number(row.n))
      }
    } catch { /* 老库没有 shot 表时忽略 */ }
    const seenPoint = new Set()
    for (const x of items2) {
      const pid = Number(x.point_id)
      const list = shotPicks.get(pid) || []
      const mine = new Set(x.is_group ? (x.group_targets || []).map((g) => g.id) : [x.id])
      const own = list.filter((sh) => sh.hit_id !== null && sh.hit_id !== undefined && mine.has(Number(sh.hit_id)))
      const pointLevel = list.filter((sh) => sh.hit_id === null || sh.hit_id === undefined)
      const isFirst = !seenPoint.has(pid)
      seenPoint.add(pid)
      x.shots = own.concat(isFirst ? pointLevel : []).map(shotBriefOf)
      x.shot_total = shotTotalByPoint.get(pid) || x.shots.length
    }
    /* 报告里的图片路径：默认给**绝对路径**（下载到哪都能显示）；
       交付整包时用 options.shotRef='relative' 让 markdown 走 `shots/xxx.png`，
       与靶标目录里的 shots/ 一起拷走即可。 */
    const shotRefOf = (sh) => (options.shotRef === 'relative'
      ? sh.url
      : join(this.shotsDirOf(id), String(sh.url).replace(/^shots\//, '')))

    /* ── 链路排序：阶段顺序（信息收集 → 互联网 → 边界 → 内网 → 靶标）+ 阶段内按动作先后 ──
       ⚠️ ordinal 是**链路里的真实位置**，不是"过滤后的第几条"：`listStages` 的注释写明
       "界面画 ①②③ 与报告排序都用它，不要另行编号"。先编号再过滤掉空阶段，
       会把第 3 阶段的"边界突破"标成 ② —— 攻击链页、报告页、导出的 markdown 会一起错，
       而链路图与报告正文一旦对不上，交付物就不可信了。 */
    const stageRows = this.listStages(id)
    const stageOrder = new Map(stageRows.map((s, i) => [s.code, i]))
    const stageOfItem = (x) => (x.stage_code && stageOrder.has(x.stage_code) ? x.stage_code : 'internet')
    const stepSeqOf = (x) => {
      const seqs = (x.steps || []).map((s) => Number(s.seq)).filter((n) => Number.isFinite(n))
      return seqs.length > 0 ? Math.min.apply(null, seqs) : Number.MAX_SAFE_INTEGER
    }
    const ordered = items2.slice().sort((a, b) => {
      const sa = stageOrder.has(stageOfItem(a)) ? stageOrder.get(stageOfItem(a)) : 99
      const sb = stageOrder.has(stageOfItem(b)) ? stageOrder.get(stageOfItem(b)) : 99
      if (sa !== sb) return sa - sb
      const ra = String(a.order_at || a.recorded_at || '')
      const rb = String(b.order_at || b.recorded_at || '')
      if (ra !== rb) return ra.localeCompare(rb)
      return stepSeqOf(a) - stepSeqOf(b)
    })
    ordered.forEach((x, i) => { x.chain_no = i + 1 })

    /* ── 前置推导：这条成果是靠哪条成果铺出来的 ──────────────────────────────
       只用**库里已有的文字**推：把本条的步骤（命令/说明/回显）、凭据（来源/取得方式/备注）
       与证据文本拼成一份语料，看里面出现了别的计分成果的目标 IP —— 出现了就说明
       "这条是站在那条的肩膀上做的"（例：域控凭据来自 ES 聊天记录 → 域控条目前置 = ES 条目）。
       推不出来就不写，不编造依赖关系。 */
    const ipOfTarget = (t) => {
      const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(t || ''))
      return m === null || m[1] === '127.0.0.1' ? null : m[1]
    }
    const ipsIn = (t) => {
      const out = []
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g
      let m
      while ((m = re.exec(String(t || ''))) !== null) if (m[1] !== '127.0.0.1') out.push(m[1])
      return out
    }
    /* 本条用到的凭据：用"证据里出现的口令/账号/主机"去认领凭据库里的记录。 */
    const credsAllForDeps = this.listCredentials(id)
    const ownsCred = (x, c) => {
      /* ⚠️ 判定只能用"本条证据自己写出来的东西"，**不能**把 trace 挂上来的凭据也算进去：
         trace 是"同资产/同主机"的宽松匹配（目标 10.1.2.142 会挂上所有 host 里带该地址的凭据），
         拿它当依据会推出"MySQL 条目依赖域控"这种结论。 */
      const text = [x.evidence, x.note, x.gained, x.target].join('\n')
      const sv = String(c.secret_value || '').trim()
      if (sv.length >= 6 && text.indexOf(sv) !== -1) return true
      const un = String(c.username || '').trim()
      /* 账号要"像账号"才算特征串：纯英文单词会撞车 —— 实测边界条目的证据里写着
         `default via 10.1.2.1`，于是把用户名 default 的 Redis 凭据认成了本条的来处，
         推出"跨境突破依赖 Redis"。带数字/反斜杠/@ 的（工号、域账号）才认。 */
      const accountLike = (v) => /[\d\\@]/.test(v) || v.length >= 10
      if (un.length >= 6 && accountLike(un) && text.indexOf(un) !== -1) {
        /* 账号是共享的（一个域管账号会出现在几十条证据里），所以还要主机对得上：
           凭据主机就是本条目标，或凭据主机串在本条证据里出现过。 */
        const cip = ipOfTarget(c.host)
        if (cip === null) return true
        return cip === ipOfTarget(x.target) || text.indexOf(cip) !== -1
      }
      /* 不用"凭据 host 出现在证据里"来认领：目标 10.1.2.142 的证据里当然写着它，
         那会把同主机上所有 config-leak 凭据都算成本条用到的（实测推出
         "MySQL 条目依赖域控"）。只认口令/账号这类**特征串**。 */
      return false
    }
    /* 前置候选 = 本条证据里直接提到的地址 + **所认领凭据的来源指针**。
       凭据的 tool/note 里"第一个 IP"通常就是这条口令/权限的来处
       （例："从 10.1.2.163:9200 的 ES 检索到口令" → 来处是那台 ES；
        "smbclient //10.1.2.5/SYSVOL 取启动脚本" → 来处是域控）。
       只取第一个 IP 是为了精度：tool 字段后面往往顺带提到别的资产，
       全量取会把"RabbitMQ 口令来自应用配置"误判成"这条依赖 RabbitMQ"。 */
    for (const x of ordered) {
      /* 强线索：本条用到的凭据是从哪来的（凭据 tool/note 的第一个 IP）。
         弱线索：本条证据里顺带提到的地址（边界条目会把整个网段清单都写进证据，
                 拿它当依赖依据会推出"跨境突破依赖 Redis"这种噪声）。
         先吃强线索，不够 3 条再用弱线索补。 */
      const strong = new Set()
      for (const c of credsAllForDeps.filter((v) => ownsCred(x, v))) {
        const a = ipOfTarget(c.tool)
        const b = ipOfTarget(c.note)
        if (a !== null) strong.add(a)
        if (b !== null) strong.add(b)
      }
      const weakText = [x.evidence, x.note, x.target].join('\n')
      const weak = new Map()
      for (const ip of ipsIn(weakText)) weak.set(ip, (weak.get(ip) || 0) + 1)
      /* 弱线索按"在本条证据里被提到的次数"从多到少取：提到次数多的通常就是这条成果的关键目标
         （边界条目的证据会把整片网段列一遍，只按文档顺序取会先撞上无关条目）。 */
      const pick = (get, size) => {
        const out = []
        for (const y of ordered) {
          if (y === x || y.point_id === x.point_id) continue
          const ip = ipOfTarget(y.target)
          if (ip === null || get(ip) === undefined) continue
          out.push({ y: y, w: size(ip) })
        }
        out.sort((a, b) => b.w - a.w)
        return out.slice(0, 3).map((v) => v.y)
      }
      const deps = pick((ip) => (strong.has(ip) ? 1 : undefined), () => 1)
      if (deps.length < 3) {
        for (const y of pick((ip) => weak.get(ip), (ip) => weak.get(ip) || 0)) {
          if (deps.length >= 3) break
          if (deps.indexOf(y) === -1) deps.push(y)
        }
      }
      x.deps = deps.map((y) => ({ no: y.chain_no, name: y.code, short: y.code, target: y.target }))
        .sort((a, b) => a.no - b.no)
      x._depIds = deps.map((y) => y.id)
    /* 环境前置：互联网侧以外的成果都建在"通道"上（隧道 / 被控入口），单独标一句 */
      x.needs_channel = stageOfItem(x) !== 'internet' && (x.tunnels || []).length > 0
    }
    /* 互为前置的两条一起撤掉（例：域控 445 与域控 389 同 IP，会互相指认）：
       报告宁可少写一条前置，也不能出现"A 依赖 B、B 依赖 A"这种自相矛盾的链路。 */
    for (const x of ordered) {
      const kept = (x.deps || []).filter((d) => {
        const y = ordered.find((v) => v.chain_no === d.no)
        return y === undefined || (y._depIds || []).indexOf(x.id) === -1
      })
      x.deps = kept
    }
    for (const x of ordered) delete x._depIds

    /* ── 复现入口分类：决定报告里给"可粘贴报文"还是"命令行"，以及索引表怎么标 ────
       · http    —— 有真实抓包，或被判定为 HTTP 入口且能重建报文 → Burp / Yakit 可直接重放
       · cli     —— 真实命令（当日敲过的那条）→ 终端可跑（非 HTTP 协议，Burp/Yakit 不适用）
       · method  —— 只有该得分点的标准复现动作描述（没有留存命令）→ 如实给动作，不伪造命令 */
    const looksLikeHttpTarget = (t) => /^https?:\/\//i.test(String(t || '').trim())
    for (const x of ordered) {
      const captured = x.requests.length > 0 && String(x.requests[0].request || '').trim() !== ''
      /* ⚠️ 只有"目标本身就是个 http(s) 地址"或"真有抓包"才给报文。
         否则会把隧道/数据库条目的同资产无关 curl 合成成一份报文（实测出现过
         `POST / HTTP/1.1` + body `-` 这种粘进 Yakit 什么也复现不出来的假报文）。 */
      const httpOk = (captured
        || (looksLikeHttpTarget(x.target) && x.replay_http !== null && x.replay_http !== undefined))
      /* 命令：真实命令优先；模板命令只有在占位符全部填好时才当"可跑的命令"用 */
      const unfilled = x.replay_cmd_unfilled || []
      const cmdOk = x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== ''
        && (x.replay_cmd_kind !== 'template' || unfilled.length === 0)
      x.repro_kind = httpOk ? 'http' : (cmdOk ? 'cli' : 'method')
      x.repro_http_captured = captured
      /* 非 HTTP 协议的复现说明（Burp/Yakit 发不了 SMB/数据库/NFS，要写清为什么） */
      const cmd = String(x.replay_cmd || '')
      x.repro_nonhttp = x.repro_kind === 'cli'
        && /atexec|nxc |smbclient|impacket|secretsdump|mysql|redis-cli|showmount|mount |winrm|proxychains/.test(cmd)
    }

    /* 阶段分桶（界面与正文共用）：入桶的是**合并后**的条目，分值也是合并后的合计 */
    let cumulative = 0
    const stages = stageRows.map((st) => {
      const sItems = ordered.filter((x) => stageOfItem(x) === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0)
      cumulative += pts
      return { code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
        ordinal: st.ordinal, points: pts, cumulative: cumulative, items: sItems }
    }).filter((st) => st.items.length > 0)

    /* ── markdown：给复制/下载，也方便智能体直接交付 ──────────────────────────
       结构按"用户要照着复现"来排，不是按"我们记录了多完整"来排：
         ⓪ 摘要与对账 + 复现索引表（验收人先看这个）
         ① 复现前置条件（通道 / 凭据 / 工具接入 / 工具能力边界）
         ② 攻击链（按依赖顺序，标注前置）
         ③ 逐条明细（复现入口放最前，目标台账、证据索引）
         ④ 得分点说明（判定标准与材料要求只讲一次，不在每条重复）
         ⑤ 附录（资产、记录与计分对账）
       ⚠️ 两条长度纪律：请求体保完整（Yakit 要能直接重放，截断就废了）；
       响应体只做验证，截到 1000 字符并标长度。 */
    const md = []
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
    const AGENT_LABEL = (a) => ROLE_TITLES[a] || a || 'Unassigned role'
    const oneLine = (t, n) => String(t === null || t === undefined ? '' : t).replace(/\s*\n+\s*/g, ' ').trim().slice(0, n || 300)
    const shortName = (x) => POINT_SHORT_NAME[x.code] || x.point_name || x.code
    /* 早期记录里 `->` 被写成了 `-&gt;`（表单转义残留），报告里要还原，否则目标列没法看 */
    /* 合并条目在表格里只写"首台 + 台数"，否则 64 台的长清单会把索引表撑爆 */
    const targetBrief = (x) => (x.is_group
      ? String(x.target || '') + ' and ' + x.group_size + ' other targets'
      : unesc(x.target))
    const unesc = (t) => String(t === null || t === undefined ? '' : t)
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    const block = (lang, text) => { md.push('```' + lang, String(text).replace(/\r/g, '').trim(), '```', '') }
    /* 截断落在句子/分句边界上：直接 slice 会切出"…后端是 3 台 LB 轮询("这种半截句子 */
    const clipText = (t, n) => {
      const s0 = oneLine(t, n)
      if (s0.length < n) return s0
      for (const sep of ['。', '；', '）', ')', '，']) {
        const i = s0.lastIndexOf(sep)
        if (i > n * 0.5) return s0.slice(0, i + 1)
      }
      return s0
    }
    const targetName = (meta && meta.target_name) || id
    const httpCount = ordered.filter((x) => x.repro_kind === 'http').length
    const cliCount = ordered.filter((x) => x.repro_kind === 'cli').length
    const methodCount = ordered.filter((x) => x.repro_kind === 'method').length

    md.push('# ' + targetName + ' · Red Team Reproduction Report', '')
    md.push('> This report records **scored achievements only**: providing reproduction entries (raw HTTP requests replayable via Burp / Yakit, '
      + 'or CLI commands routed through tunnels), verification criteria, and evidence indexes, organized in attack chain dependency order.', '')

    /* ── ⓪ 摘要与对账 ──────────────────────────────────────────────────── */
    md.push('## 0. Executive Summary & Audit', '')
    const shotItems = ordered.filter((x) => (x.shots || []).length > 0)
    const shotTotal = ordered.reduce((n, x) => n + (x.shots || []).length, 0)
    const shotReal = ordered.reduce((n, x) => n + (x.shots || []).filter((v) => v.kind !== 'card').length, 0)
    md.push('| Total Score | Scored Items | Burp/Yakit Replay | CLI Repro | Other Methods | Evidence Screenshots |', '| --- | --- | --- | --- | --- | --- |')
    md.push('| **' + summary.points + ' pts** | ' + ordered.length + ' items | ' + httpCount
      + ' items | ' + cliCount + ' items | ' + methodCount + ' items | ' + shotTotal + ' captures / ' + shotItems.length
      + ' body items' + (shotReal < shotTotal ? '(Live captures: ' + shotReal + ', remainder synthesized evidence cards)' : '') + ' |', '')
    md.push('### 0.1 Score Point Utilization', '')
    md.push('| Score Point | Hits | Points Scored | Item Cap |', '| --- | --- | --- | --- |')
    const byPoint = new Map()
    for (const x of ordered) {
      const k = x.code
      if (!byPoint.has(k)) byPoint.set(k, { code: k, name: shortName(x), hits: 0, points: 0, cap: x.point_cap })
      const rec = byPoint.get(k)
      rec.hits += x.is_group ? x.group_size : 1
      rec.points += x.points
    }
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      md.push('| ' + rec.name + ' (`' + rec.code + '`) | ' + rec.hits + ' | +' + rec.points + ' pts | '
        + (Number(rec.cap) > 0 ? Number(rec.cap) + ' pts' + (rec.points >= Number(rec.cap) ? ' (Max)' : '') : '—') + ' |')
    }
    md.push('')
    md.push('### 0.2 Audit Reconciliation', '')
    md.push('- Database score hits: **' + rows.length + ' entries** -> Scored hits: **' + summary.count + ' entries**'
      + ' -> Consolidated body entries: **' + ordered.length + ' entries** (batch operations consolidated + target ledger)'
      + '; additionally **' + (summary.selfCreatedExcluded + summary.serviceCappedExcluded + summary.disabledExcluded)
      + ' entries** uncredited (detailed below).')
    if (summary.serviceCappedExcluded > 0) {
      md.push('- Excluded: duplicate account/database privileges on same service/port: ' + summary.serviceCappedExcluded
        + ' entries (highest privilege counts once per service; see Appendix 5.2).')
    }
    if (summary.selfCreatedExcluded > 0) md.push('- Excluded: self-registered/self-created accounts: ' + summary.selfCreatedExcluded + ' entries (scoring applies only to acquiring existing permissions).')
    if (summary.disabledExcluded > 0) md.push('- Excluded: disabled score points: ' + summary.disabledExcluded + ' entries.')
    const corrected = reportRows.filter((h) => /校正/.test(String(h.note || '')))
    if (corrected.length > 0) {
      md.push('')
      md.push('> **Tier Calibration**: The following ' + corrected.length + ' hits were adjusted downward during review, '
        + 'values below reflect calibrated totals:', '')
      for (const h of corrected) {
        md.push('- `' + (h.target || '') + '`　' + (h.point_name || h.code) + '　→ **' + (h.points || 0) + ' pts**  '
          + oneLine(h.note, 200))
      }
    }
    md.push('')
    md.push('### 0.3 Reproduction Index', '')
    md.push('| # | Score Point | Points | Target | Prerequisites | Reproduction Entry |', '| --- | --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no).join('、')
      const entry = x.repro_kind === 'http' ? 'Burp / Yakit Request (§3.' + x.chain_no + '）'
        : (x.repro_kind === 'cli' ? 'CLI Command (§3.' + x.chain_no + ')' : 'Reproduction Vector (§3.' + x.chain_no + ')')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? 'Channel (§1.1)' : '—') : dep) + ' | ' + entry + ' |')
    }
    md.push('')

    /* ── ① 复现前置条件 ────────────────────────────────────────────────── */
    const tunnelsAll = this.listTunnels(id)
    const shellsAll = this.listWebshells(id)
    const credsAll = credsAllForDeps
    /* "本条用到的凭据"再用一遍 ownsCred（证据里写了口令/账号）+ 主机就落在计分目标上的凭据。
       不用 trace 挂上来的那批：它是同资产宽松匹配，会把与本条无关的接口 token 也列进前置条件表。 */
    const scoredHosts = new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null))
    const referencedCred = new Set()
    for (const x of ordered) for (const c of credsAll.filter((v) => ownsCred(x, v))) referencedCred.add(String(c.id))
    for (const c of credsAll) {
      const ip = ipOfTarget(c.host)
      if (ip !== null && scoredHosts.has(ip)) referencedCred.add(String(c.id))
    }
    const credRank = (c) => {
      const p = String(c.privilege || '')
      if (/domain-admin/.test(p)) return 0
      if (/local-admin|domain-admin|admin/.test(p)) return 1
      if (/db-|redis|mysql|system/.test(p)) return 2
      if (/sso|sharekey|api/.test(p)) return 3
      return 9
    }
    /* 排除记录里已写明"没验证通过/只留档"的候选 —— 它们不是可复现入口，列出来只会误导 */
    const usablePool = credsAll.filter((c) => !/未通过|未验证|仅留档|不可作为有效凭据|unknown|failed|invalid|archive-only|unverified/i.test(String(c.note || '') + String(c.privilege || '')))
    const usefulCreds = usablePool
      .filter((c) => referencedCred.has(String(c.id)))
      .slice()
      .sort((a, b) => (referencedCred.has(String(b.id)) ? 1 : 0) - (referencedCred.has(String(a.id)) ? 1 : 0)
        || credRank(a) - credRank(b))
      .slice(0, 12)
    md.push('---', '')
    md.push('## 1. Reproduction Prerequisites', '')
    md.push('> Establish prerequisites in this section before replaying reproduction vectors.', '')
    md.push('### 1.1 Tunnels & Pivoting Channels', '')
    if (tunnelsAll.length === 0) {
      md.push('No tunnels registered for this target; internal items require operator routing.', '')
    } else {
      for (const t of tunnelsAll) {
        md.push('- **' + (t.kind || 'Tunnel') + '**: Listening on `' + (t.listen || '') + '`  Ingress `' + (t.entry || '') + '`'
          + (t.entry_kind ? ' (entry_kind=' + t.entry_kind + ')' : '')
          + (t.reach ? '  Reach: ' + t.reach : '')
          + (String(t.status || '') !== '' ? '  Status: ' + t.status : ''))
        if (t.command) md.push('  - Launch Command: ')
        if (t.command) block('bash', t.command)
        if (t.note) md.push('  - Notes: ' + clipText(t.note, 320))
      }
    }
    if (shellsAll.length > 0) {
      md.push('')
      md.push('**WebShell / Session Ingress**', '')
      for (const w of shellsAll) {
        md.push('- `' + (w.url || '') + '`　' + (w.shell_type || '') + (w.pass_key ? '  Password: `' + w.pass_key + '`' : '')
          + (String(w.status || '') !== '' ? '  Status: ' + w.status : '') + (w.note ? '　' + clipText(w.note, 200) : ''))
      }
      md.push('')
    }
    md.push('### 1.2 Credentials', '')
    if (usefulCreds.length === 0) {
      md.push('No credentials registered for this target.', '')
    } else {
      md.push('| Target | Username | Privilege | Source | Acquisition Method |', '| --- | --- | --- | --- | --- |')
      for (const c of usefulCreds) {
        md.push('| `' + oneLine(c.host, 40) + '` | `' + oneLine(c.username, 40) + '` | ' + oneLine(c.privilege || '—', 30)
          + ' | ' + oneLine(c.source || '—', 40) + ' | `' + oneLine(c.tool || '—', 120) + '` |')
      }
      md.push('')
    }
    md.push('### 1.3 Tool Configuration & Proxying', '')
    md.push('- **Burp Suite**: Settings -> Network -> Connections -> SOCKS proxy: `127.0.0.1:<tunnel_port>`, '
      + 'check "Use SOCKS proxy for DNS lookups"; paste raw requests directly into Repeater.', '')
    md.push('- **Yakit**: Configure matching SOCKS5 under downstream proxy settings, '
      + 'paste raw requests into Repeater.', '')
    md.push('- **CLI Commands**: Prepend `proxychains4 -q -f <proxychains.conf>` before impacket / nxc / smbclient / mysql / redis-cli; '
      + 'for HTTP endpoints use `curl --socks5-hostname <user>:<pass>@127.0.0.1:<port>`.', '')
    md.push('### 1.4 Tool Protocols & Capabilities', '')
    md.push('| Target Type | Protocol | Recommended Tools |', '| --- | --- | --- |')
    md.push('| Web Applications, Admin Portals, REST APIs (incl. Intranet) | HTTP / HTTPS | Burp Suite, Yakit (via SOCKS upstream) |')
    md.push('| WebShells / Tunnels | HTTP / WebSocket | Behinder, Godzilla, suo5 (see §1.1) |')
    md.push('| Windows Hosts, Domain Controllers, Shares | SMB / RPC / WinRM | `impacket-atexec`, `nxc`, `smbclient`, `evil-winrm`, pywinrm (via proxychains) |')
    md.push('| Databases | MySQL / Redis / PostgreSQL | `mysql`, `redis-cli`, `psql` (via proxychains) |')
    md.push('| Network File Sharing | NFS | `showmount`, `mount -t nfs4` (via proxychains or compromised host) |')
    md.push('')
    md.push('> Burp / Yakit handle HTTP(S) and WebSocket protocols. For SMB, WinRM, databases, and NFS, '
      + 'reproduce using CLI commands as specified in the corresponding sections below.', '')

    /* ── ② 攻击链（按依赖顺序）──────────────────────────────────────────── */
    md.push('---', '')
    md.push('## 2. Attack Chain (Dependency Order)', '')
    md.push('> Sequential document order (by attack chain phases ① -> ⑤, intra-phase by timestamp). "Prerequisites" lists antecedent achievements; '
      + 'phases are sorted by category, so prerequisite indices may be numbered higher than current entries (e.g. pivoting depends on Domain Controller #16); '
      + 'reference by index accordingly.', '')
    md.push('| # | Score Point | Points | Target | Prerequisites |', '| --- | --- | --- | --- | --- |')
    for (const x of ordered) {
      const dep = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)).join(', ')
      md.push('| ' + x.chain_no + ' | ' + shortName(x) + ' | +' + x.points + ' | `' + oneLine(targetBrief(x), 60) + '` | '
        + (dep === '' ? (x.needs_channel ? 'Channel (§1.1)' : '—') : dep) + ' |')
    }
    md.push('')
    for (const st of stages) {
      md.push('- ' + st.name + ': ' + st.items.length + ' items · +' + st.points + ' pts (Cumulative +' + st.cumulative + ' pts)')
    }
    md.push('')

    /* ── ③ 逐条明细 ────────────────────────────────────────────────────── */
    md.push('---', '')
    md.push('## 3. Scored Items Details', '')
    md.push('> Ordered across phases ① -> ⑤ (phase number indicates sequence in chain); ordered chronologically within phase, '
      + 'index `3.N` corresponds directly to the reproduction index above.', '')
    let lastStage = null
    for (const x of ordered) {
      const st = stageOfItem(x)
      if (st !== lastStage) {
        lastStage = st
        const sr = stages.find((v) => v.code === st)
        if (sr !== undefined) {
          const circled = (CIRCLED[sr.ordinal - 1] || '')
          md.push('## ' + circled + ' ' + sr.name + '（' + sr.items.length + ' items · +' + sr.points + ' pts)', '')
        }
      }
      const depTxt = (x.deps || []).map((d) => '#' + d.no + ' ' + (POINT_SHORT_NAME[d.name] || d.name)
        + ' (`' + oneLine(d.target, 40) + '`)').join(', ')
      md.push('### 3.' + x.chain_no + ' ' + shortName(x) + ' · `' + oneLine(targetBrief(x), 80) + '`  **+' + x.points + ' pts**', '')
      md.push('- **Score Point**: ' + (x.point_name || '') + '　`' + x.code + '`'
        + (x.point_rule ? '  Rule ' + x.point_rule : '')
        + (x.point_tier ? '  Tier ' + oneLine(x.point_tier, 40) : '')
        + (Number(x.point_cap) > 0 ? '  Cap ' + x.point_cap + ' pts' : ''))
      if (x.is_group) md.push('- **Includes ' + x.group_size + ' targets** (batch hits under single action; see ledger below)')
      if (x.gained) md.push('- **Obtained**: ' + oneLine(x.gained, 120))
      if (x.is_group) {
        const list = (x.group_targets || []).map((g) => '`' + g.target + '`')
        md.push('- **Outcome**: The same action across ' + x.group_size + ' targets achieved identical access ('
          + list[0] + ' … ' + list[list.length - 1] + '); see table and evidence index for per-host output')
      } else if (x.evidence) {
        md.push('- **Outcome**: ' + oneLine(x.evidence, 400))
      }
      if (x.confirm && x.confirm.need) md.push('- **Verification Criteria**: ' + oneLine(x.confirm.need, 160))
      md.push('- **Prerequisites**: ' + (depTxt !== '' ? depTxt : (x.needs_channel ? 'Channel (see §1.1)' : 'None (initial chain entry)')))
      md.push('')

      /* 复现入口：① HTTP 报文（可直放） ② 命令行 ③ 复现方式说明 */
      md.push('#### Reproduction', '')
      if (x.repro_kind === 'http') {
        const lead = (x.repro_http_captured && x.replay_http_rebuilt !== true)
          ? '**Raw Request** (live packet capture; copy full text -> Burp Repeater / Yakit -> Send)'
          : (x.repro_http_captured
              ? '**Reconstructed Request** (reconstructed from executed command and response; fields populated with target and credentials)'
              : '**Equivalent Request** (reconstructed from actual command; fields populated with target and credentials)')
        md.push(lead + ':', '')
        block('http', x.replay_http)
        if (x.requests.length > 0 && x.requests[0].response) {
          const full = String(x.requests[0].response)
          md.push('**Server Response** (' + (x.requests[0].status === null || x.requests[0].status === undefined
            ? 'status unrecorded' : 'HTTP ' + x.requests[0].status) + '):', '')
          md.push('```http', full.replace(/\r/g, '').trim().slice(0, 1000)
            + (full.length > 1000 ? '\n... (response total ' + full.length + ' characters; full body in evidence vault)' : ''), '```', '')
        }
        if (x.requests.length > 1) md.push('> Additional ' + (x.requests.length - 1) + ' request evidence entries in evidence vault.', '')
        /* 同一动作的 curl 等价形式也给出：有人习惯直接跑命令，有人习惯 Repeater */
        if (x.replay_cmd !== null && x.replay_cmd !== undefined && String(x.replay_cmd).trim() !== '') {
          md.push('**CLI Command Equivalent** (aligned with request above):', '')
          block('bash', x.replay_cmd)
        }
      }
      if (x.repro_kind === 'cli') {
        const lead = (x.replay_cmd_kind === 'real' || x.replay_cmd_kind === 'linked')
          ? '**CLI Command** (actual executed command; directly reproducible)'
          : (x.replay_cmd_kind === 'synthesized' ? '**CLI Command Equivalent** (derived from request above; matches method and endpoint)'
            : '**CLI Command** (recorded from engagement attack step)')
        md.push(lead + ':', '')
        block('bash', x.replay_cmd)
        if (x.repro_nonhttp) {
          md.push('> This action uses SMB / RPC / database protocols and cannot be replayed via Burp/Yakit; '
            + 'route through tunnel using proxychains per §1.3.', '')
        }
      }
      if (x.repro_kind === 'method') {
        md.push('**Reproduction Method**: ' + ((x.confirm && x.confirm.replay)
          ? oneLine(x.confirm.replay, 200)
          : 'Per score point criteria, reproduce the action against the target and record output.'), '')
        if ((x.steps || []).length > 0) {
          md.push('> Operational highlights detailed in "Action Log" below; command not individually preserved, replay against target.', '')
        }
      }

      /* 证据截图：贴在图里比写十行字有用；kind=card 的必须写明"生成的"，不能冒充现场截图 */
      if ((x.shots || []).length > 0) {
        const shotNote = []
        if (x.shot_total > x.shots.length) shotNote.push('Total screenshots for this point: ' + x.shot_total + '; showing representative ' + x.shots.length + ' captures')
        if (x.is_group) shotNote.push('Target group: ' + x.group_size + ' other targets')
        md.push('**Evidence Screenshots**' + (shotNote.length > 0 ? ' (' + shotNote.join('; ') + ')' : '') + ': ', '')
        for (const sh of x.shots) {
          const alt = String(sh.label || ('Evidence ' + sh.id)).replace(/[\[\]]/g, '')
          md.push('![' + alt + '](' + shotRefOf(sh) + ')', '')
          const cap = []
          if (sh.label) cap.push(sh.label)
          else if (sh.target) cap.push('`' + sh.target + '`')
          if (sh.kind === 'card') cap.push('**Evidence excerpt generated from session logs (not a live screenshot)**')
          if (sh.captured_at) cap.push(String(sh.captured_at).replace('T', ' ').slice(0, 16))
          if (sh.source_ref) cap.push('Raw file `' + oneLine(sh.source_ref, 120) + '`')
          if (sh.note) cap.push(oneLine(sh.note, 160))
          if (cap.length > 0) md.push('> ' + cap.join('　·　'), '')
        }
        md.push('')
      } else if (Number(x.shot_total) > 0) {
        /* 本条没分到代表图（同一得分点的图已在前面的条目展示）—— 指明去哪看，别让人以为漏了 */
        md.push('> Representative screenshots shown above (total ' + x.shot_total + ' captures; displaying up to 3 per score point).', '')
        md.push('')
      }

      /* 目标台账（合并条目）：一台一行，含逐台证据 */
      if (x.is_group) {
        md.push('**Target Ledger (' + x.group_size + ' hosts; per-host output in evidence index)**', '')
        md.push('| # | Target | Result | Score |', '| --- | --- | --- | --- |')
        const brief = (ev) => {
          const m = /（([^）]{1,60})）/.exec(String(ev || ''))
          if (m !== null) return oneLine(m[1], 60)
          return oneLine(ev, 80)
        }
        ;(x.group_targets || []).forEach((g, gi) => {
          md.push('| ' + (gi + 1) + ' | `' + g.target + '` | ' + brief(g.evidence) + ' | +' + g.points + ' |')
        })
        const extra = summary.serviceCapped.filter((c) => c.code === x.code)
        if (extra.length > 0) {
          md.push('')
          md.push('> Additional ' + extra.length + ' hosts achieved equivalent access but uncredited due to **rule caps** (audit trail): '
            + extra.map((c) => '`' + c.target + '`').join(', ') + ', see Appendix 5.2.', '')
        }
        md.push('')
      }

      /* 怎么做的：动作步骤（含真实命令与回显） */
      const evFiles = Array.from(new Set((x.steps || []).map((s) => String(s.evidence_ref || '').trim()).filter((v) => v !== '')))
      if ((x.steps || []).length > 0 || x.how || x.vuln || evFiles.length > 0) {
        md.push('#### Action Log', '')
        if (x.how) md.push('> ' + oneLine(x.how, 240), '')
        ;(x.steps || []).forEach((s, si) => {
          md.push('**' + (si + 1) + '. ' + oneLine(s.title || '(Unnamed action)', 80) + '**'
            + (s.agent ? '　—　' + AGENT_LABEL(s.agent) : '')
            + (s.inferred ? '  ·  (Inferred from associated asset)' : ''))
          if (s.detail) md.push('- ' + oneLine(s.detail, 400))
          if (s.result) md.push('- Output: ' + oneLine(s.result, 300))
          if (s.tool && String(s.tool).trim() !== String(x.replay_cmd || '').trim()) {
            md.push('- Command: ')
            md.push('  ```bash', '  ' + String(s.tool).replace(/\r/g, '').trim().slice(0, 1500), '  ```')
          }
          if (s.evidence_ref) md.push('- Evidence: `' + oneLine(s.evidence_ref, 200) + '`')
        })
        md.push('')
      }
      /* 逐条的凭据只留"本条真的用到的那几条"：trace 会把同资产的凭据一并挂上来，
         那是给界面看的宽松视图；报告里挂一串无关的接口 token 只会让人怀疑真实性。 */
      const itemCreds = credsAll.filter((c) => ownsCred(x, c)
        || (ipOfTarget(c.host) !== null && ipOfTarget(c.host) === ipOfTarget(x.target)))
      if (itemCreds.length > 0) {
        md.push('**Credential**: ' + itemCreds.map((c) => '`' + (c.host || '') + '` ' + (c.username || '—')
          + (c.privilege ? '（' + c.privilege + '）' : '') + '  Source: ' + (c.source || 'Unspecified')).join('<br>'), '')
      }
      if ((x.webshells || []).length > 0) {
        md.push('**WebShell**: ' + x.webshells.map((w) => '`' + (w.url || '') + '`  ' + (w.shell_type || '')
          + (w.pass_key ? '  Secret: `' + w.pass_key + '`' : '')).join('<br>'), '')
      }
      if ((x.tunnels || []).length > 0) {
        md.push('**Channel**: ' + x.tunnels.map((t) => '`' + (t.kind || '') + '` listening on `' + (t.listen || '')
          + '`').join('<br>'), '')
      }
      const meta2 = []
      if (x.vuln) meta2.push('Vulnerability ' + (x.vuln.cve ? x.vuln.cve + ' ' : '') + oneLine(x.vuln.title, 80))
      if (x.recorded_at) meta2.push('Obtained ' + String(x.recorded_at).replace('T', ' ').slice(0, 16)
        + (x.recorded_by ? '（' + AGENT_LABEL(x.recorded_by) + '）' : ''))
      if (Number(x.point_cap) > 0) {
        const used = byPoint.get(x.code) ? byPoint.get(x.code).points : x.points
        meta2.push('Score point utilized: ' + used + '/' + x.point_cap + ' pts')
      }
      if (meta2.length > 0) md.push('> ' + meta2.join('　·　'), '')
      md.push('')
    }

    /* ── ④ 得分点说明（判定标准与材料要求只讲一次）──────────────────────── */
    md.push('---', '')
    md.push('## 4. Scoring Point Reference', '')
    md.push('> General rules: highest privilege counts once per system (G1), data achievements scored separately (G2), '
      + 'caps apply per defending entity (G3), endpoints scored per host (G4), evidence requirements per G7.', '')
    md.push('| Score Point | Rule / Tier | Acceptance Criteria | Required Evidence | Reproduction Action |', '| --- | --- | --- | --- | --- |')
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      const c = scoreConfirmOf(rec.code) || {}
      const sample = ordered.find((x) => x.code === rec.code) || {}
      md.push('| ' + rec.name + ' (`' + rec.code + '`) | '
        + (sample.point_rule ? 'Rule ' + sample.point_rule + '　' : '') + oneLine(sample.point_tier || '—', 50) + ' | '
        + oneLine(c.need || '—', 160) + ' | ' + oneLine(c.proof || '—', 160) + ' | '
        + '`' + oneLine(c.replay || '—', 140) + '` |')
    }
    md.push('')

    /* ── ⑤ 附录 ────────────────────────────────────────────────────────── */
    /* 对账用的资产清单：命中/步骤显式挂的资产 ∪ **得分目标 IP 对应的资产**。
       后者不能少 —— 多数命中记的是"目标地址"而没挂 asset_id，
       只按 asset_id 收集会让附录里只剩零星几台，验收时对不上账。 */
    const assetsTouched = new Set(
      ordered.flatMap((x) => [x.asset_id, ...(x.steps || []).map((s) => s.asset_id)])
        .filter((v) => v !== null && v !== undefined),
    )
    const targetIps = Array.from(new Set(ordered.map((x) => ipOfTarget(x.target)).filter((v) => v !== null)))
    if (targetIps.length > 0) {
      const phIp = targetIps.map(() => '?').join(',')
      for (const a of db.prepare('SELECT id FROM asset WHERE ip IN (' + phIp + ')').all(...targetIps)) assetsTouched.add(a.id)
    }
    const assetsTouchedList = Array.from(assetsTouched)
    if (assetsTouchedList.length > 0) {
      const ph = assetsTouchedList.map(() => '?').join(',')
      const rowsA = db.prepare(`SELECT a.id, a.ip, a.primary_name, a.discovered_at, a.first_seen, a.last_seen,
          a.test_status, a.priority, COALESCE(a.scope, (${SCOPE_SQL})) AS scope
        FROM asset a WHERE a.id IN (${ph}) ORDER BY a.discovered_at, a.id`).all(...assetsTouchedList)
      md.push('---', '')
      md.push('## 5. Appendix', '')
      md.push('### 5.1 Involved Assets (Discovery Timestamps)', '')
      md.push('| Asset | Name | Network | Discovered At | Last Collected |')
      md.push('| --- | --- | --- | --- | --- |')
      for (const a of rowsA) {
        md.push('| `' + (a.ip || '') + '` | ' + (a.primary_name || '—')
          + ' | ' + (a.scope === 'internal' ? 'Internal' : 'External')
          + ' | ' + (a.discovered_at ? String(a.discovered_at).replace('T', ' ').slice(0, 19) : '—')
          + ' | ' + (a.last_seen ? String(a.last_seen).replace('T', ' ').slice(0, 19) : '—') + ' |')
      }
      md.push('')
    }
    if (summary.serviceCapped.length > 0) {
      md.push('### 5.2 Unscored Duplicate Records (Service Cap Reached)', '')
      md.push('| Target | Score Point | Points | Timestamp |', '| --- | --- | --- | --- |')
      for (const c of summary.serviceCapped) {
        md.push('| `' + (c.target || c.service || '') + '` | ' + (c.point_name || c.code) + ' | '
          + (c.points || 0) + ' | ' + String(c.recorded_at || '').replace('T', ' ').slice(0, 16) + ' |')
      }
      md.push('')
    }
    return { items: items2, stages, summary, markdown: md.join('\n'), target: targetName }
  }

  /**
   * 得分链路：把 score_hit 按时间拉平成一条链，只含"得分"相关的东西，不掺任何信息收集流水账。
   * 攻击链页面的「得分链路」视图用它。
   */
  scoreChain(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 500, 2000)
    const items = db.prepare(`SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.port, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points AS point_default, p.points, p.enabled, h.points AS hit_points, h.multiplier, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)
    /* 每一步"靠什么动作拿到的"：① 显式关联的步骤 ② 同一资产上时间最近的步骤（标注为推断） */
    const stepById = new Map(db.prepare('SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step').all().map((x) => [x.id, x]))
    const stepsByAsset = new Map()
    for (const st of stepById.values()) {
      if (st.asset_id === null || st.asset_id === undefined) continue
      if (!stepsByAsset.has(st.asset_id)) stepsByAsset.set(st.asset_id, [])
      stepsByAsset.get(st.asset_id).push(st)
    }
    for (const list of stepsByAsset.values()) list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))
    for (const it of items) {
      let step = it.step_id !== null && it.step_id !== undefined ? stepById.get(it.step_id) : undefined
      let inferred = false
      if (step === undefined) {
        step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id)
      }
      if (step === undefined && it.asset_id !== null && it.asset_id !== undefined) {
        const cands = (stepsByAsset.get(it.asset_id) || []).filter((x) => String(x.recorded_at) <= String(it.recorded_at))
        if (cands.length > 0) { step = cands[cands.length - 1]; inferred = true }
      }
      it.action = step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail }
      it.action_inferred = inferred
    }
    /* 计分口径（与 listScorePoints 完全一致，避免报表和面板分数对不上）：
       ① 自己注册/自建的账号不计分（只留过程）；
       ② 按得分点自带的 dedup_scope 去重（同目标/同系统/同服务只算最高那条，或按台卡数累加）；
       ③ 按 rule + cap 执行规则上限，超出部分不计分。 */
    const chainMeta = loadScoreMeta(db)
    const chainNames = loadAssetNames(db)
    /* 本条命中的实际分值：**命中自带档位优先**（合并版里同一条含多档，如管理员 50 / 普通 10）。
       scoreChain 的 SQL 用 hit_points / point_default 两个别名把两列分开取：直接取 h.points 会被
       同名的 p.points 遮蔽，攻击链页的档位判定会整个判反。 */
    const chainPointsOf = (it) => hitPointsOf({
      points: Number(it.hit_points) || Number(it.point_default) || 0,
      multiplier: it.multiplier,
      code: it.code,
    })
    const chainEval = evaluateScoreBoard(db, items.map((it) => Object.assign({}, it, { points: chainPointsOf(it) })),
      { meta: chainMeta, names: chainNames, enabledOnly: true })
    const cappedChain = { items: chainEval.items }
    const capFlagById = chainEval.byId
    const seenOf = new Map()
    for (const it of items) {
      it.self_created = Number(it.self_created) === 1
      const flag = capFlagById.get(it.id)
      it.capped = flag !== undefined && flag.capped === true
      it.port = normalizePort(it.port) ?? parseTargetPort(it.target)
      const meta = chainMeta.get(String(it.code)) || {}
      it.service = meta.dedup_scope === 'none' ? null : serviceLabel(it)
      it.capped_reason_kind = flag === undefined ? null : flag.capped_reason_kind
      it.rule = meta.rule ?? null
      it.rule_cap = meta.cap || 0
      /* 本条命中对外暴露的分值 = 命中自带档位分值，缺省回落到得分点默认值 */
      it.point_default = Number(it.point_default) || 0
      it.points = chainPointsOf(it)
      it.capped_reason = it.capped
        ? scoreCapReasonText(Object.assign({}, it, { rule_cap: meta.cap || 0 }), flag.capped_by_points)
        : null
      const seen = seenOf.get(it.point_id) || 0
      if (!it.self_created && !it.capped) seenOf.set(it.point_id, seen + 1)
      it.nth_of_point = seen + 1
      /* 停用得分点的命中不计分（与面板/报告口径一致：enabledOnly） */
      it.counted = it.self_created !== true && it.capped !== true && !chainEval.disabledIds.has(it.id)
    }
    /* 按得分点聚合出"哪些还没拿下"，方便一眼看出缺口 */
    const points = db.prepare('SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id').all()
    const hitPointIds = new Set(items.map((x) => x.point_id))
    const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
    const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
    /* ── 攻击链：按「攻击面位置」把得分串成五阶段，并给出累计分 ────────────── */
    const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
    const assetInfo = new Map()
    if (assetIds.length > 0) {
      const ph = assetIds.map(() => '?').join(',')
      const rows = db.prepare(`SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
        FROM asset a WHERE a.id IN (${ph})`).all(...assetIds)
      for (const row of rows) assetInfo.set(row.id, row)
    }
    /* 每条得分落在哪个阶段：自动推导（显式 stage_code > 类型特判 > 资产内外网 > target 地址） */
    for (const it of items) {
      const info = it.asset_id !== null && it.asset_id !== undefined ? assetInfo.get(it.asset_id) : undefined
      it.stage_code = scoreStageOf(
        { stage_code: it.stage_code, code: it.code, target: it.target },
        info ? info.scope : undefined,
      )
    }
    const assetChip = (id) => {
      const a = assetInfo.get(id)
      if (a === undefined) return null
      return {
        id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, scope: a.scope, state: a.state,
        priority: a.priority, open_ports: a.open_ports, vulns: a.vulns,
      }
    }
    /* 攻击步骤按阶段计数（攻击链只看"各阶段有多少动作"，不展开明细） */
    const stepsByStage = new Map()
    try {
      for (const row of db.prepare('SELECT stage, stage_code FROM attack_step LIMIT 5000').all()) {
        const code = row.stage_code || LEGACY_STAGE_MAP[row.stage] || 'recon'
        stepsByStage.set(code, (stepsByStage.get(code) || 0) + 1)
      }
    } catch { /* ignore */ }
    /* 会话隧道表的真实隧道：属于「边界突破」阶段的实锤 */
    let tunnels = []
    try {
      tunnels = db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50').all()
        .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    } catch { tunnels = [] }
    /* 只有真正跨越靶标边界的隧道才算"边界突破"的实锤；自己 VPS/自建服务器上开的不算 */
    const legitTunnels = tunnels.filter((t) => t.legit === true)
    const selfOnlyTunnels = tunnels.filter((t) => t.legit === false)

    const stageDefs = this.listStages(id)
    let cumulative = 0
    const stages = stageDefs.map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0)
      cumulative += pts
      /* 本阶段涉及的资产（去重）。信息收集阶段给"所有拿到分数的资产"，其余阶段给自己的 */
      const ids = st.code === 'recon'
        ? Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
        : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
      const assets = ids.map(assetChip).filter(Boolean).map((a) => {
        const mine = items.filter((x) => x.asset_id === a.id)
        return Object.assign({}, a, {
          points: mine.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0),
          hits: mine.length,
          /* 该资产的分落在哪个阶段（同一资产可能被内外网两侧都打到） */
          stage_code: mine.length > 0 ? mine[0].stage_code : st.code,
        })
      }).sort((a, b) => b.points - a.points || b.hits - a.hits)
      return Object.assign({}, st, {
        ordinal: si + 1,
        items: sItems,
        hits: sItems.length,
        counted: sItems.filter((x) => x.counted).length,
        points: pts,
        cumulative: cumulative,
        assets: assets,
        assetCount: assets.length,
        tunnels: st.code === 'boundary' ? legitTunnels : [],
        tunnels_self_only: st.code === 'boundary' ? selfOnlyTunnels : [],
        steps: stepsByStage.get(st.code) || 0,
      })
    })

    const scores = this.listScorePoints(id)
    return {
      items,
      stages,
      achieved,
      missing,
      summary: {
        hits: items.length,
        /* 计分口径与得分面板一致：同类得分不设上限，按命中次数累加 */
        points: scores.summary.achievedPoints,
        totalPoints: scores.summary.totalPoints,
        countedHits: scores.summary.countedHits,
        achievedCount: achieved.length,
        missingCount: missing.length,
        missingPoints: missing.reduce((n, p) => n + (p.potential || p.points || 0), 0),
        selfCreatedHits: scores.summary.selfCreatedHits || 0,
        /* 同资产同端口重复命中、按服务封顶而不计分的条数（账号类 / 数据库权限） */
        serviceCappedHits: scores.summary.serviceCappedHits || 0,
        tunnelsLegit: legitTunnels.length,
        tunnelsSelfOnly: selfOnlyTunnels.length,
      },
    }
  }

  /** 会话总览：给界面和提示词用的一屏摘要（含在线/离线统计）。 */
  sessionSummary(id) {
    const db = this.db(id)
    const shells = db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ORDER BY w.id DESC`).all()
    const tunnels = db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN webshell w ON w.id = t.webshell_id ORDER BY t.id DESC`).all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential').get()
    const access = db.prepare('SELECT COUNT(*) AS n FROM access_session').get()
    return {
      webshells: shells, tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === 'online').length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === 'active').length,
        /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: creds ? creds.n : 0,
        access: access ? access.n : 0,
      },
    }
  }

  /**
   * 实测连通性（host 平面专有：智能体跑在沙箱里，只有这里能直接发起连接）。
   * WebShell 发一次不带参数的 GET；隧道做一次 TCP 连接。
   * 结果回写 status / last_check / latency_ms / check_note。
   */
  async probeSessions(id, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || 6000, 1000), 20000)
    const out = { webshells: [], tunnels: [], checkedAt: nowIso() }

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now()
      let status = 'offline'
      let note = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        clearTimeout(timer)
        status = res.status < 500 ? 'online' : 'offline'
        note = `HTTP ${res.status}`
      } catch (error) {
        note = error && error.name === 'AbortError' ? `Timeout >${timeout}ms` : String((error && error.message) || error).slice(0, 160)
      }
      const latency = Date.now() - started
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency })
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
      const started = Date.now()
      let status = 'down'
      let note = ''
      if (target === '') {
        note = 'Missing listen address, cannot probe'
      } else {
        const idx = target.lastIndexOf(':')
        const host = idx > 0 ? target.slice(0, idx) : '127.0.0.1'
        const port = Number(idx > 0 ? target.slice(idx + 1) : target)
        if (!Number.isFinite(port) || port <= 0) {
          note = `Cannot parse port: ${t.listen}`
        } else {
          note = await new Promise((resolve) => {
            let done = false
            const socket = tcpConnect({ host, port })
            const finish = (ok, text) => {
              if (done) return
              done = true
              try { socket.destroy() } catch { /* ignore */ }
              resolve(ok ? '' : text)
            }
            socket.setTimeout(timeout)
            socket.on('connect', () => { status = 'active'; finish(true, '') })
            socket.on('timeout', () => { finish(false, `Timeout >${timeout}ms`) })
            socket.on('error', (error) => { finish(false, String((error && error.code) || (error && error.message) || error).slice(0, 120)) })
          })
        }
      }
      const latency = Date.now() - started
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency })
    }
    return out
  }

  /**
   * 攻击图谱：在资产拓扑上叠加漏洞与已控制资产。
   * 节点 kind：segment / asset（meta.vulns 按严重级计数、meta.owned） / vuln（已确认）。
   * 边 relation：contains / exposes / resolves / has_vuln。
   */
  attackGraph(id, f = {}) {
    const base = this.graph(id, f)
    const db = this.db(id)
    const nodes = base.nodes.slice()
    const edges = base.edges.slice()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const vulnRows = db.prepare(`SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`).all()
    for (const row of vulnRows) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node === undefined) continue
      node.meta = node.meta || {}
      node.meta.vulns = node.meta.vulns || {}
      node.meta.vulns[row.severity] = row.n
    }
    const owned = db.prepare('SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL').all()
    for (const row of owned) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node !== undefined) { node.meta = node.meta || {}; node.meta.owned = true }
    }
    const confirmed = db.prepare(`SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`).all()
    for (const v of confirmed) {
      const nodeId = `vuln:${v.id}`
      nodes.push({ id: nodeId, kind: 'vuln', label: v.cve || (v.title || '').slice(0, 18), meta: { severity: v.severity, status: v.status, title: v.title } })
      edges.push({ source: `asset:${v.asset_id}`, target: nodeId, relation: 'has_vuln' })
    }
    return { nodes, edges, summary: this.vulnStats(id) }
  }

  /* ---------- 域名维度 / Web 资产 ---------- */

  /**
   * 按域名聚合资产：域名 → 该域名下的资产清单（无域名的资产归入「(未关联域名)」）。
   * @param f - `{ cidr? }` 只看某个 C 段（与左侧 C 段选择保持一致，避免维度串台）。
   */
  domainIndex(id, f = {}) {
    const db = this.db(id)
    const assets = (f.cidr
      ? db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(f.cidr)
      : db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int').all())
    const names = db.prepare('SELECT asset_id, name, kind, provenance FROM asset_name').all()
    const byAsset = new Map()
    for (const n of names) {
      if (!byAsset.has(n.asset_id)) byAsset.set(n.asset_id, [])
      byAsset.get(n.asset_id).push(n)
    }
    const groups = new Map()
    for (const a of assets) {
      const domains = new Set()
      if (a.primary_name) domains.add(a.primary_name)
      for (const n of byAsset.get(a.id) || []) domains.add(n.name)
      if (domains.size === 0) domains.add('(No associated domain)')
      for (const domain of domains) {
        if (!groups.has(domain)) groups.set(domain, [])
        groups.get(domain).push({ id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state, names: (byAsset.get(a.id) || []).map((n) => n.name) })
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  }

  /** Web 资产清单：有 URL/标题或常见 Web 端口的资产。 */
  listWeb(id, f = {}) {
    const db = this.db(id)
    const rows = db.prepare(`SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`).all()
    const filtered = f.cidr ? rows.filter((r) => r.segment_cidr === f.cidr) : rows
    const limited = f.limit ? filtered.slice(0, Number(f.limit)) : filtered
    return { total: filtered.length, items: limited }
  }

  /* ---------- HTTP 证据（Burp / Yakit 可复现） ---------- */

  addHttpEvidence(id, e = {}) {
    const db = this.db(id)
    const result = db.prepare(`INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.vuln_id ?? null, e.asset_id ?? null, e.label ?? null, e.method ?? 'GET', e.url ?? null,
      e.status ?? null, e.request ?? null, e.response ?? null, e.note ?? null,
      e.captured_by ?? null, nowIso(),
    )
    return { id: Number(result.lastInsertRowid) }
  }

  listHttpEvidence(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.vuln_id !== undefined && f.vuln_id !== null) { where.push('vuln_id = ?'); args.push(Number(f.vuln_id)) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return db.prepare(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- 攻击链 ---------- */

  /**
   * 写一步攻击链。如果这一步拿到了分，带上 point_code（或 point_id）即可：
   * 服务端会自动记一条 score_hit 并把两者互相挂上，避免"写了步骤忘了记分/记了分说不清怎么拿的"。
   */
  addChainStep(id, s = {}) {
    const db = this.db(id)
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step').get() || { n: 1 }).n
    let pointId = s.point_id !== undefined && s.point_id !== null ? Number(s.point_id) : null
    if (pointId === null && s.point_code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(s.point_code))
      if (row !== undefined) pointId = row.id
    }
    const seq = s.seq ?? next
    const legacyStage = s.stage ?? 'other'
    /* 只有这 5 个阶段 code 会被攻击链页面分桶；其它值（含已废弃的 external/foothold/tunnel/privilege）
       写了等于步骤不落在任何阶段，所以退回按老 stage 兜底，并显式告警。 */
    let stageWarning = null
    let stageCode
    if (typeof s.stage_code === 'string' && s.stage_code.trim() !== '') {
      const wanted = s.stage_code.trim()
      if (VALID_STAGE_CODES.includes(wanted)) {
        stageCode = wanted
      } else {
        stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
        stageWarning = 'Invalid stage_code="' + wanted + '" (ignored): only accepts ' + VALID_STAGE_CODES.join('/')
          + '; defaulted to ' + stageCode + '。'
      }
    } else {
      stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
    }
    const result = db.prepare(`INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, point_id, evidence_ref, tool, agent, result, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seq, legacyStage, stageCode, s.title ?? '', s.detail ?? null,
      s.asset_id ?? null, s.vuln_id ?? null, s.access_id ?? null, pointId, s.evidence_ref ?? null,
      s.tool ?? null, s.agent ?? null, s.result ?? null,
      s.recorded_by ?? null, nowIso(),
    )
    const stepId = Number(result.lastInsertRowid)
    let hit = null
    let scoreHint = null
    /* 带 point_code 且给了 evidence → 顺手记分（同一次调用完成"动作 + 得分"） */
    if (pointId !== null && typeof s.evidence === 'string' && s.evidence.trim() !== '') {
      try {
        hit = this.addScoreHit(id, {
          point_id: pointId, asset_id: s.asset_id ?? null, vuln_id: s.vuln_id ?? null, step_id: stepId,
          target: s.target ?? null, evidence: s.evidence, note: s.note ?? null, recorded_by: s.recorded_by ?? null,
          /* 自己注册/自建的账号不计分（只留过程） */
          self_created: s.self_created,
        })
        /* 服务级封顶（账号类 / 数据库权限）：步骤照常入库，但这笔分不再累加，
           必须把原因回给模型——否则它会以为"又刷了一个账号 = 又加了分"。 */
        if (hit && hit.warning) scoreHint = hit.warning
      } catch (error) {
        /* 步骤照常入库，但把原因回给模型——静默吞掉会让"记了分"其实是空的 */
        scoreHint = 'Step recorded, but scoring failed: ' + (error && error.message ? error.message : String(error))
        }
    } else if (pointId !== null) {
      scoreHint = 'Supplied point_code without evidence; no score awarded (step recorded): invoke redteam_score_hit with results (target + account/privilege/volume) to claim score.'
    }
    return { id: stepId, seq: seq, stage_code: stageCode, point_id: pointId, hit: hit, score_hint: scoreHint, stage_hint: stageWarning }
  }

  listChain(id) {
    return this.db(id).prepare(`SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`).all()
  }

  /* ---------- 攻击文件（只收录实际生效的脚本/POC/EXP） ---------- */

  /* ------------------------------------------------------------------ 证据截图 */
  /** 截图落盘目录：`<靶标目录>/shots`。与 attack-files 平级，方便整包拷贝交付。 */
  shotsDirOf(id) { return join(this.dirOf(id), 'shots') }

  /**
   * 登记一张证据截图（把图片拷进靶标目录，库里只存文件名与元数据）。
   *
   * 为什么必须显式区分 kind：
   *   · `screenshot` —— 现场截图，可以直接当验收材料；
   *   · `card`       —— 由当日记录生成的"证据摘录卡"，**不是现场截图**。
   *   两者混在一起，验收人会把生成的卡当成现场证据 —— 这是最不能出的事，
   *   所以库里存 kind、面板与报告都按它标不同颜色与文案。
   *
   * @param id - 靶标 id。
   * @param shot - `{ path | data_base64, label, note, kind, point_code, hit_id, asset_id, target, source_ref, captured_at, agent }`
   */
  addShot(id, shot = {}) {
    const db = this.db(id)
    const dir = this.shotsDirOf(id)
    mkdirSync(dir, { recursive: true })
    const kind = shot.kind === 'card' ? 'card' : 'screenshot'
    /* 文件名：显式给就用给的（去路径分隔符），否则按 时间-得分点-序号 生成 */
    const ext = (() => {
      const src = String(shot.path || '')
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(src)
      return m === null ? 'png' : m[1].toLowerCase()
    })()
    const stamp = String(shot.captured_at || new Date().toISOString()).replace(/[-:T]/g, '').slice(0, 14)
    const slug = String(shot.point_code || 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'shot'
    let file = String(shot.file || '').trim().replace(/[/\\]/g, '-')
    if (file === '') {
      let n = 1
      do { file = stamp + '-' + slug + '-' + String(n).padStart(2, '0') + '.' + ext; n += 1 }
      while (existsSync(join(dir, file)))
    }
    const dest = assertPathWithin(join(dir, file), [dir])
    let buf = null
    if (typeof shot.data_base64 === 'string' && shot.data_base64.trim() !== '') {
      buf = Buffer.from(shot.data_base64.replace(/^data:[^,]+,/, ''), 'base64')
    } else if (typeof shot.path === 'string' && shot.path.trim() !== '') {
      const src = isAbsolute(shot.path) ? shot.path : join(this.dirOf(id), shot.path)
      if (!existsSync(src)) throw new Error('shot source not found: ' + shot.path)
      buf = readFileSync(src)
    } else {
      throw new Error('shot path or data_base64 required')
    }
    if (buf.length === 0) throw new Error('shot file is empty')
    writeFileSync(dest, buf)
    const mime = /^\x89PNG/.test(buf.slice(0, 4).toString('latin1')) ? 'image/png'
      : (buf.slice(0, 2).toString('latin1') === '\xff\xd8' ? 'image/jpeg'
        : (buf.slice(0, 4).toString('latin1') === 'RIFF' ? 'image/webp' : 'application/octet-stream'))
    const dim = pngSize(buf)
    const pointId = (() => {
      const code = String(shot.point_code || '').trim()
      if (code === '') return shot.point_id === undefined || shot.point_id === null ? null : Number(shot.point_id)
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(code)
      return row === undefined ? null : Number(row.id)
    })()
    const now = nowIso()
    const cur = db.prepare(`INSERT INTO shot (point_id, hit_id, asset_id, vuln_id, target, label, note,
        file, kind, mime, bytes, width, height, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pointId,
      shot.hit_id === undefined || shot.hit_id === null ? null : Number(shot.hit_id),
      shot.asset_id === undefined || shot.asset_id === null ? null : Number(shot.asset_id),
      shot.vuln_id === undefined || shot.vuln_id === null ? null : Number(shot.vuln_id),
      String(shot.target || '').trim() || null,
      String(shot.label || '').trim() || null,
      String(shot.note || '').trim() || null,
      file, kind, mime, buf.length, dim.width, dim.height,
      createHash('sha256').update(buf).digest('hex'),
      String(shot.source_ref || shot.path || '').trim() || null,
      String(shot.captured_at || now).trim(),
      String(shot.agent || '').trim() || null,
      String(shot.agent || '').trim() || null,
      now,
    )
    return { ok: true, id: Number(cur.lastInsertRowid), file: file, kind: kind, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
  }

  /** 证据截图列表（可按得分点 / 命中 / 资产过滤）。 */
  listShots(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.point_code !== undefined && f.point_code !== null && String(f.point_code) !== '') {
      where.push('s.point_id = (SELECT id FROM score_point WHERE code = ?)')
      args.push(String(f.point_code))
    }
    for (const [col, key] of [['hit_id', 'hit_id'], ['asset_id', 'asset_id'], ['vuln_id', 'vuln_id']]) {
      if (f[key] !== undefined && f[key] !== null && String(f[key]) !== '') {
        where.push('s.' + col + ' = ?')
        args.push(Number(f[key]))
      }
    }
    const sql = `SELECT s.*, p.code AS point_code, p.name AS point_name
      FROM shot s LEFT JOIN score_point p ON p.id = s.point_id
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.captured_at, s.id LIMIT ?`
    const items = db.prepare(sql).all(...args, Math.min(Number(f.limit) || 500, 2000))
    return { ok: true, items: items.map((x) => Object.assign({}, x, { url: this.shotUrlOf(id, x) })), total: items.length }
  }

  /** 截图的可访问引用：面板/报告里贴的就是它（相对靶标目录）。 */
  shotUrlOf(id, shot) { return 'shots/' + shot.file }

  /** 删除一张截图（连同磁盘文件）。 */
  deleteShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    try {
      const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
      if (existsSync(p)) rmSync(p, { force: true })
    } catch { /* 文件不在就当已删 */ }
    db.prepare('DELETE FROM shot WHERE id = ?').run(Number(shotId))
    return { ok: true, id: Number(shotId) }
  }

  /**
   * 读一张截图的字节（面板用 `<img src="data:...">` 显示）。
   * 走 base64 而不是新开静态路由：这条 HTTP 桥已经做了同源校验，
   * 再开一个能按文件名读任意路径的静态入口，等于绕开校验读靶标目录。
   */
  readShot(id, shotId) {
    const db = this.db(id)
    const row = db.prepare('SELECT * FROM shot WHERE id = ?').get(Number(shotId))
    if (row === undefined) throw new Error('shot not found: ' + shotId)
    const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)])
    if (!existsSync(p)) throw new Error('shot file missing on disk: ' + row.file)
    const buf = readFileSync(p)
    return { ok: true, id: Number(row.id), mime: row.mime || 'image/png', bytes: buf.length, base64: buf.toString('base64') }
  }

  /**
   * 给一批得分条目挂"代表截图"，**每个得分点最多 3 张**（批量得分点如终端权限会有几十条命中，
   * 逐条贴图既没信息量又把页面/报告撑爆）。
   *
   * 选取优先级：命中级 > 得分点+目标级 > 得分点级；同一优先级里现场截图优先于生成的证据卡。
   *
   * @param id - 靶标 id。
   * @param groups - `[{ point_id, point_code, hit_ids: number[], asset_id, target }]`
   * @param limit - 每个得分点最多几张（默认 3）。
   */
  #representativeShots(id, groups, limit = 3) {
    const db = this.db(id)
    let all = []
    try { all = db.prepare('SELECT * FROM shot ORDER BY captured_at, id').all() } catch { all = [] }
    if (all.length === 0) return new Map()
    const byHit = new Map()
    const byPoint = new Map()
    for (const sh of all) {
      if (sh.hit_id !== null && sh.hit_id !== undefined) {
        if (!byHit.has(Number(sh.hit_id))) byHit.set(Number(sh.hit_id), [])
        byHit.get(Number(sh.hit_id)).push(sh)
      }
      if (sh.point_id !== null && sh.point_id !== undefined) {
        if (!byPoint.has(Number(sh.point_id))) byPoint.set(Number(sh.point_id), [])
        byPoint.get(Number(sh.point_id)).push(sh)
      }
    }
    const rank = (sh) => (sh.kind === 'card' ? 1 : 0)
    const out = new Map()
    for (const g of groups) {
      /* 候选池按"关联强度"分层：命中级 → 目标/资产级 → 得分点级。
         同一层内**现场截图优先于生成的证据卡**，再按时间 —— 否则批量得分点里
         后补的卡片会把真截图挤出前 3 张（实测：60 台终端只挑出 3 张卡片）。 */
      const pool = []
      for (const hid of (g.hit_ids || [])) pool.push(...(byHit.get(Number(hid)) || []))
      const pointShots = byPoint.get(Number(g.point_id)) || []
      for (const sh of pointShots) {
        if (g.target && sh.target && String(sh.target) === String(g.target)) pool.push(sh)
        else if (g.asset_id !== null && g.asset_id !== undefined && sh.asset_id === g.asset_id) pool.push(sh)
      }
      for (const sh of pointShots) pool.push(sh)
      const picked = []
      const seen = new Set()
      const ordered = pool.slice().sort((a, b) => rank(a) - rank(b)
        || String(a.captured_at || '').localeCompare(String(b.captured_at || ''))
        || Number(a.id) - Number(b.id))
      for (const sh of ordered) {
        if (sh === undefined || sh === null || seen.has(sh.id)) continue
        seen.add(sh.id)
        picked.push(sh)
        if (picked.length >= limit) break
      }
      out.set(Number(g.point_id), picked)
    }
    return out
  }

  /** 攻击文件根目录：<靶标>/attack-files/<目标>/… */
  attackFilesDirOf(id) { return join(this.dirOf(id), 'attack-files') }

  /**
   * 保存一个攻击文件到「目标文件夹」并登记。evidence 必填——只收录实际生效的东西。
   * @param id - 靶标 id。
   * @param f - `{ target, name, kind, content|path, description, evidence, asset_id?, vuln_id?, created_by? }`
   */
  addAttackFile(id, f = {}) {
    const db = this.db(id)
    const target = String(f.target || '').trim()
    if (target === '') throw new Error('attack file target required (IP / URL / CIDR)')
    const name = String(f.name || '').trim().replace(/[/\\]/g, '-')
    if (name === '') throw new Error('attack file name required')
    const evidence = String(f.evidence || '').trim()
    if (evidence === '') throw new Error('attack file evidence required: only record functional scripts/POC/EXP, specify verified impact')
    const slug = slugTarget(target)
    const dir = join(this.attackFilesDirOf(id), slug)
    mkdirSync(dir, { recursive: true })
    /* target 为 `..`/`.` 时 slugTarget 会原样返回，join 之后就跑出 attack-files/ 了。
       写路径也过一遍根目录校验，保证文件一定落在本靶标目录内。 */
    const filePath = assertPathWithin(join(dir, name), [this.attackFilesDirOf(id)])
    if (typeof f.content === 'string' && f.content.length > 0) {
      writeFileSync(filePath, f.content, 'utf8')
    } else if (typeof f.path === 'string' && f.path.length > 0) {
      const src = isAbsolute(f.path) ? f.path : join(this.dirOf(id), f.path)
      if (!existsSync(src)) throw new Error('source path not found: ' + f.path)
      copyFileSync(src, filePath)
    } else {
      throw new Error('attack file content or path required')
    }
    const kind = ['poc', 'exp', 'script', 'wordlist', 'other'].includes(f.kind) ? f.kind : 'script'
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`).run(
      target, f.target_kind ?? null, name, kind, filePath,
      f.description ?? null, evidence, f.asset_id ?? null, f.vuln_id ?? null,
      f.created_by ?? null, nowIso(),
    )
    return { target, name, kind, path: filePath }
  }

  listAttackFiles(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target = ?'); args.push(f.target) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    return db.prepare(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...args)
  }

  /** 攻击文件按目标分组（每个 IP / URL / C 段一个文件夹）。 */
  attackFileTree(id) {
    const groups = new Map()
    for (const row of this.listAttackFiles(id, {})) {
      if (!groups.has(row.target)) groups.set(row.target, { target: row.target, folder: slugTarget(row.target), count: 0, files: [] })
      const g = groups.get(row.target)
      g.files.push(row)
      g.count++
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  }

  readAttackFile(id, fileId) {
    const row = this.db(id).prepare('SELECT * FROM attack_file WHERE id = ?').get(Number(fileId))
    if (row === undefined) return undefined
    let content = ''
    try {
      /* path 来自库列（智能体写过）：必须限定在本靶标目录内，否则面板会变成任意文件读取器 */
      const safe = assertPathWithin(row.path, [this.dirOf(id)])
      content = readFileSync(safe, 'utf8')
    } catch (error) {
      content = '(Rejected or read failure: ' + (error && error.message ? error.message : String(error)) + '）'
    }
    return { ...row, content }
  }

  /* ---------- 知识库：通用 POC / EXP（全局共享，跨靶标复用） ---------- */

  knowledgePath() { return join(this.root, 'knowledge.db') }

  /** 找本机 nuclei 模板目录（装了模板才有；找不到返回 undefined）。 */
  nucleiTemplatesDir() {
    /* 环境适配里手填/自动分配的路径优先（Windows 尤其依赖这一条） */
    try {
      const configured = nucleiTemplatesDirOf(loadPlatformConfig(this.root), this.root)
      if (configured) return configured
    } catch { /* 忽略配置读失败，继续默认探测 */ }
    const candidates = [
      join(this.root, 'toolkit', 'nuclei-templates'),
      join(homedir(), '.local', 'nuclei-templates'),
      join(homedir(), 'nuclei-templates'),
      '/usr/share/nuclei-templates',
      '/opt/nuclei-templates',
    ]
    return candidates.find((p) => existsSync(p))
  }

  #nucleiIndexPath() { return join(this.pocsDirOf(), '.nuclei-index.json') }

  /**
   * 模板索引（按需构建 + 落盘缓存）：13k 个 yaml 逐个解析太慢，所以只抽
   * path / name / severity / tags 这几个检索字段，构建一次后一直复用。
   */
  #nucleiIndex(force) {
    const dir = this.nucleiTemplatesDir()
    if (dir === undefined) return { dir: null, items: [] }
    const cachePath = this.#nucleiIndexPath()
    if (force !== true && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        /* 目录没变、且缓存不超过 7 天就直接用 */
        const fresh = cached && cached.dir === dir && Array.isArray(cached.items)
          && (Date.now() - Number(cached.built_at || 0) < 7 * 24 * 3600 * 1000)
        if (fresh) return { dir, items: cached.items, cached: true }
      } catch { /* 缓存坏了就重建 */ }
    }
    const items = []
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        let head = ''
        try { head = readFileSync(join(base, next), 'utf8').slice(0, 2000) } catch { continue }
        const pick = (re) => { const m = re.exec(head); return m === null ? '' : String(m[1]).trim().replace(/^["']|["']$/g, '') }
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
        ])
      }
    }
    walk(dir, '')
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ built_at: Date.now(), dir, items }), 'utf8')
    } catch { /* 缓存写不进去不影响检索 */ }
    return { dir, items, cached: false }
  }

  /** 模板库概览（界面与智能体"先查现成的"都能用）。 */
  templateStats() {
    const { dir, items } = this.#nucleiIndex()
    const cve = items.filter((x) => /cve-\d{4}-\d+/i.test(x[0])).length
    return { dir: dir || null, total: items.length, cve }
  }

  /**
   * 在本机 nuclei 模板库里检索：CVE 编号按文件名就能命中，组件/关键字再匹配 name 与 tags。
   * 这是"知识库里没有、但本机其实已有现成 POC"的那一层，先查它能省掉一轮互联网检索。
   */
  searchTemplates(q, limit = 40) {
    const { dir, items } = this.#nucleiIndex()
    if (dir === null) return { dir: null, total: 0, items: [] }
    const raw = String(q || '').trim()
    if (raw === '') return { dir, total: items.length, items: [] }
    const needle = raw.toLowerCase()
    const out = []
    for (const [path, name, severity, tags] of items) {
      const hay = (path + ' ' + name + ' ' + tags).toLowerCase()
      if (hay.includes(needle)) out.push({ path, name, severity, tags })
      if (out.length >= limit) break
    }
    return { dir, total: items.length, items: out }
  }


  pocsDirOf() { return join(this.root, 'pocs') }

  /** 打开（必要时创建）全局知识库。与靶标库分开，跨靶标共享。 */
  kb() {
    if (this.kbHandle) return this.kbHandle
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.pocsDirOf(), { recursive: true })
    const handle = new DatabaseSync(this.knowledgePath())
    /* 同上：没有 FTS5 就不建 poc_fts，POC 检索退化成 LIKE（见 searchPocs） */
    handle.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL)
    migrateKnowledge(handle)
    this.kbHandle = handle
    return handle
  }

  #reindexPoc(db, pocId) {
    if (!HAS_FTS5) return   /* 无 FTS5 时不建索引表；POC 检索走 LIKE（见 searchPocs 的兜底） */
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(pocId))
    const p = db.prepare('SELECT * FROM poc WHERE id = ?').get(pocId)
    if (!p) return
    db.prepare('INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(p.id), p.title, p.cve || '', p.component || '', p.versions || '', p.tags || '', p.description || '', p.content || '')
  }

  /**
   * 落库一份通用 POC/EXP。同名（code）会合并刷新，便于"同一漏洞的新版本 POC"覆盖旧版。
   * @param p - `{ title, kind, cve, component, versions, severity, language, source, source_url,
   *               description, usage, content|path, verified, verified_note, tags, created_by }`
   */
  savePoc(p = {}) {
    const db = this.kb()
    const title = String(p.title || '').trim()
    if (title === '') throw new Error('poc.title required (specify vulnerability or component)')
    const kind = POC_KINDS.includes(p.kind) ? p.kind : (String(p.kind || '').toLowerCase() === 'exp' ? 'exp' : 'poc')
    const source = POC_SOURCES.includes(p.source) ? p.source : 'self'
    /* code 会被当成目录名：必须净化。`code='../../escaped-poc'` 曾能把正文写到数据根目录之外
       （deletePoc 早有 startsWith 防护，写路径却漏了）。这里统一走 slugPoc 的净化规则。 */
    const rawCode = String(p.code || '').trim()
    const code = rawCode === '' ? slugPoc(title, p.cve) : rawCode.replace(/[^\w.\u4e00-\u9fa5-]+/g, '-').replace(/^[.-]+/, '')
    if (code === '') throw new Error('poc.code invalid (empty after sanitization, use letters/digits/hyphens)')
    const dir = assertPathWithin(join(this.pocsDirOf(), code), [this.pocsDirOf()])
    mkdirSync(dir, { recursive: true })

    /* 正文：优先用传入 content，其次从 path 读；两者都没有则只登记元数据 */
    let content = typeof p.content === 'string' ? p.content : ''
    if (content === '' && typeof p.path === 'string' && p.path.length > 0) {
      const src = isAbsolute(p.path) ? p.path : join(this.pocsDirOf(), p.path)
      if (!existsSync(src)) throw new Error('poc content or existing path required: ' + p.path)
      content = readFileSync(src, 'utf8')
    }
    let filePath = null
    if (content !== '') {
      /* filename 也不能带路径分隔符，否则能从 code 目录里再跳出去 */
      const filename = String(p.filename || '').trim().replace(/[/\\]/g, '-') || defaultPocFilename(title, kind, p.language)
      filePath = assertPathWithin(join(dir, filename), [this.pocsDirOf()])
      writeFileSync(filePath, content, 'utf8')
    }
    const existing = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    const verified = p.verified === undefined || p.verified === null
      ? (existing ? existing.verified : 0)
      : (p.verified ? 1 : 0)
    const now = nowIso()
    /* 归类：允许自定义值，但内置 code 之外一律归 other，避免面板出现一堆拼写变体 */
    const rawCategory = String(p.category || (existing ? existing.category : '') || '').trim()
    const category = rawCategory === ''
      ? 'other'
      : (POC_CATEGORIES.some((c) => c.code === rawCategory) ? rawCategory : 'other')
    db.prepare(`INSERT INTO poc(code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, category = excluded.category,
        cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        engagement_id = COALESCE(excluded.engagement_id, poc.engagement_id),
        engagement_name = COALESCE(excluded.engagement_name, poc.engagement_name),
        asset_target = COALESCE(excluded.asset_target, poc.asset_target),
        found_by_agent = COALESCE(excluded.found_by_agent, poc.found_by_agent),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`).run(
      code, title, kind, category, p.cve ?? null, p.component ?? null, p.versions ?? null, p.severity ?? null,
      p.language ?? null, source, p.source_url ?? null, p.description ?? null, p.usage ?? null,
      content, filePath, verified, p.verified_note ?? null,
      existing ? existing.hit_count : 0, existing ? existing.used_on : null, p.tags ?? null,
      p.engagement_id ?? null, p.engagement_name ?? null, p.asset_target ?? null, p.found_by_agent ?? null,
      p.created_by ?? null, existing ? existing.created_at : now, now,
    )
    const row = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    this.#reindexPoc(db, row.id)
    return { poc: row, created: existing === undefined, path: filePath }
  }

  /**
   * 检索知识库：Nday/1day 动手前的第一步。
   * @param f - `{ q, cve, component, kind, language, source, verified, tag, limit }`
   */
  searchPocs(f = {}) {
    const db = this.kb()
    const where = []
    const args = []
    const q = String(f.q || f.query || '').trim()
    if (q !== '') {
      /* 全文优先（标题/编号/组件/版本/标签/描述/正文），命中不到再退化成 LIKE 子串匹配 */
      const match = q.split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ')
      let ids = []
      try {
        ids = db.prepare('SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200').all(match).map((r) => Number(r.poc_id))
      } catch { ids = [] }
      if (ids.length === 0) {
        const like = '%' + q + '%'
        ids = db.prepare(`SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`)
          .all(like, like, like, like, like, like, like).map((r) => r.id)
      }
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (f.cve) { where.push('cve LIKE ?'); args.push('%' + String(f.cve) + '%') }
    if (f.component) { where.push('component LIKE ?'); args.push('%' + String(f.component) + '%') }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    /* 归类筛选：支持一次给多个（category=rce,tunnel） */
    if (f.category) {
      const list = String(f.category).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) { where.push(`COALESCE(NULLIF(category, ''), 'other') IN (${list.map(() => '?').join(',')})`); args.push(...list) }
      else if (list.length === 1) { where.push("COALESCE(NULLIF(category, ''), 'other') = ?"); args.push(list[0]) }
    }
    /* 来源溯源筛选：这条知识是在哪个靶标 / 哪台资产上发现并验证的 */
    if (f.engagement) {
      where.push('(engagement_id = ? OR engagement_name LIKE ?)')
      args.push(String(f.engagement), '%' + String(f.engagement) + '%')
    }
    if (f.asset_target) { where.push('asset_target LIKE ?'); args.push('%' + String(f.asset_target) + '%') }
    if (f.language) { where.push('language = ?'); args.push(String(f.language)) }
    if (f.source) { where.push('source = ?'); args.push(String(f.source)) }
    if (f.tag) { where.push('tags LIKE ?'); args.push('%' + String(f.tag) + '%') }
    if (f.verified === true || f.verified === 1) where.push('verified = 1')
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit)
  }

  /** 取一条 POC 的完整内容（智能体要直接拿去用，所以连正文一起给）。 */
  getPoc(key) {
    const db = this.kb()
    const raw = String(key === undefined || key === null ? '' : key).trim()
    if (raw === '') return undefined
    const numeric = Number(raw)
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare('SELECT * FROM poc WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM poc WHERE code = ?').get(raw)
    if (row === undefined) return undefined
    let content = row.content || ''
    if (content === '' && row.path) {
      try {
        /* 同 readAttackFile：path 是库列，读之前限定在 pocs/ 内 */
        content = readFileSync(assertPathWithin(row.path, [this.pocsDirOf()]), 'utf8')
      } catch { content = '' }
    }
    return { ...row, content }
  }

  /** 标一条 POC 被用过（后续按复用次数排序，用得多的排前面）。 */
  markPocUsed(key, usedOn) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?')
      .run(usedOn ?? null, nowIso(), row.id)
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count || 0) + 1 }
  }

  /** 补验证结论：只有验证过的 POC 才算"可直接用"，界面上会标出来。 */
  updatePoc(key, patch = {}) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) throw new Error('poc not found: ' + key)
    const next = {
      title: patch.title ?? row.title,
      kind: patch.kind ?? row.kind,
      category: patch.category ?? row.category,
      cve: patch.cve ?? row.cve,
      component: patch.component ?? row.component,
      versions: patch.versions ?? row.versions,
      severity: patch.severity ?? row.severity,
      language: patch.language ?? row.language,
      source: patch.source ?? row.source,
      source_url: patch.source_url ?? row.source_url,
      description: patch.description ?? row.description,
      usage: patch.usage ?? row.usage,
      verified: patch.verified === undefined || patch.verified === null ? row.verified : (patch.verified ? 1 : 0),
      verified_note: patch.verified_note ?? row.verified_note,
      tags: patch.tags ?? row.tags,
      engagement_id: patch.engagement_id ?? row.engagement_id,
      engagement_name: patch.engagement_name ?? row.engagement_name,
      asset_target: patch.asset_target ?? row.asset_target,
      found_by_agent: patch.found_by_agent ?? row.found_by_agent,
      content: typeof patch.content === 'string' && patch.content !== '' ? patch.content : row.content,
      path: row.path,
    }
    if (next.content !== row.content) {
      const filename = 'poc.txt'
      const dir = join(this.pocsDirOf(), row.code)
      mkdirSync(dir, { recursive: true })
      next.path = join(dir, row.path ? basename(row.path) : filename)
      writeFileSync(next.path, next.content || '', 'utf8')
    }
    db.prepare(`UPDATE poc SET title = ?, kind = ?, category = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?,
      engagement_id = ?, engagement_name = ?, asset_target = ?, found_by_agent = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`).run(
      next.title, next.kind, next.category, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.engagement_id, next.engagement_name, next.asset_target, next.found_by_agent,
      next.content, next.path, nowIso(), row.id,
    )
    this.#reindexPoc(db, row.id)
    return this.getPoc(row.id)
  }

  deletePoc(key) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('DELETE FROM poc WHERE id = ?').run(row.id)
    if (HAS_FTS5) db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(row.id))
    /* 连落盘目录一起删（只在 pocs/ 内按 code 精确删除；删不掉不影响数据一致性） */
    let removedFiles = 0
    try {
      const dir = join(this.pocsDirOf(), row.code)
      if (existsSync(dir) && dir.startsWith(this.pocsDirOf())) {
        removedFiles = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* 忽略 */ }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles }
  }

  /** 知识库概览：界面顶部标签与智能体"先查库"时的一屏摘要。 */
  pocStats() {
    const db = this.kb()
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0] ?? 0
    const byKind = db.prepare('SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC').all('poc')
    const bySource = db.prepare('SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC').all('self')
    const topComponents = db.prepare(`SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`).all()
    /* 归类：面板按它分组，智能体也知道"哪类武器已经攒了多少"。
       顺序按内置归类表走（不是按数量），这样面板分组稳定、不跳来跳去。 */
    const catRows = db.prepare("SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS n, SUM(verified) AS verified FROM poc GROUP BY category").all()
    const catMap = new Map(catRows.map((r) => [r.category, r]))
    const byCategory = POC_CATEGORIES.map((c) => {
      const row = catMap.get(c.code)
      return { code: c.code, name: c.name, hint: c.hint, n: row ? row.n : 0, verified: row ? (row.verified || 0) : 0 }
    })
    /* 内置表之外的归类（用户自定义）也列出来，别让它们凭空消失 */
    for (const [code, row] of catMap) {
      if (POC_CATEGORIES.some((c) => c.code === code)) continue
      byCategory.push({ code, name: pocCategoryName(code), hint: '', n: row.n, verified: row.verified || 0 })
    }
    /* 来源靶标：每条知识是在哪个靶标上发现/验证的（每靶标计数 + 最近建立时间） */
    const byEngagement = db.prepare(`SELECT COALESCE(NULLIF(engagement_name, ''), NULLIF(engagement_id, ''), '(Unspecified target origin)') AS engagement,
        COUNT(*) AS n, MAX(created_at) AS latest FROM poc GROUP BY engagement ORDER BY n DESC, latest DESC LIMIT 30`).all()
    /* 发现资产：Top 资产（同一条经验往往落在一批资产上） */
    const topAssets = db.prepare(`SELECT asset_target, COUNT(*) AS n FROM poc WHERE COALESCE(asset_target, '') <> ''
      GROUP BY asset_target ORDER BY n DESC, asset_target LIMIT 15`).all()
    return {
      total: one('SELECT COUNT(*) FROM poc'),
      verified: one('SELECT COUNT(*) FROM poc WHERE verified = 1'),
      withContent: one("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: one('SELECT COALESCE(SUM(hit_count), 0) FROM poc'),
      /* 没标归类的条目数：面板会提示"还有 N 条未归类" */
      uncategorized: one("SELECT COUNT(*) FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'"),
      earliest: one('SELECT MIN(created_at) FROM poc'),
      latest: one('SELECT MAX(created_at) FROM poc'),
      byKind, bySource, byCategory, byEngagement, topAssets, topComponents,
      categories: POC_CATEGORIES,
      dbPath: this.knowledgePath(),
    }
  }

  /**
   * 按目标分组的成果报告：每个 IP / URL / C 段一份，供界面展开收起。
   * 收录口径与 report() 一致（已验证/已利用且中危以上）。
   */
  reportTargets(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice().sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const files = this.listAttackFiles(id, {})

    const targets = new Map()
    const ensure = (key) => {
      if (!targets.has(key)) {
        targets.set(key, { key, label: key, kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? 'ip' : 'host', segment: '', vulns: [], chain: [], access: [], creds: [], files: [] })
      }
      return targets.get(key)
    }
    const assetIpOf = (assetId) => {
      if (assetId === null || assetId === undefined) return undefined
      const asset = this.getAsset(id, assetId)
      return asset === undefined ? undefined : asset.ip
    }
    for (const v of vulns) {
      const key = v.asset_ip || (v.target ? slugTarget(v.target) : 'Unassigned target')
      const g = ensure(key)
      g.vulns.push(v)
      if (g.segment === '' && v.segment_cidr) g.segment = v.segment_cidr
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) || slugTarget(a.host)
      const g = ensure(key)
      g.access.push(a)
      if (g.segment === '') { const asset = a.asset_id === null || a.asset_id === undefined ? undefined : this.getAsset(id, a.asset_id); if (asset && asset.segment_cidr) g.segment = asset.segment_cidr }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) || slugTarget(c.host)).creds.push(c)
    for (const f of files) ensure(assetIpOf(f.asset_id) || slugTarget(f.target)).files.push(f)
    for (const st of chain) if (st.asset_ip) ensure(st.asset_ip).chain.push(st)

    const renderVuln = (v) => {
      const out = []
      out.push(`#### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
      out.push(`- Target: ${v.target || '—'}`)
      out.push(`- Status: ${v.status === 'exploited' ? 'Exploited' : 'Verified'} · Confidence: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · Discovery Method: ${v.source || '—'}`)
      out.push(`- Impact & Evidence: ${v.evidence || '—'}`)
      const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
      if (evidence.length) {
        out.push('', '**Reproduction Request (paste directly into Burp Suite / Yakit)**:', '')
        for (const e of evidence) {
          out.push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
          if (e.request) out.push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
          if (e.response) out.push('Response Summary:', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
        }
      }
      out.push('')
      return out
    }

    const groups = new Map()
    const list = []
    for (const g of targets.values()) {
      const lines = []
      lines.push(`## ${g.label}${g.segment ? '（' + g.segment + '）' : ''}`, '')
      const bySeverity = { critical: 0, high: 0, medium: 0 }
      for (const v of g.vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
      lines.push(`- Results: ${g.vulns.length} Vulnerabilities (Critical ${bySeverity.critical} · High ${bySeverity.high} · Medium ${bySeverity.medium}) · Controlled Assets: ${g.access.length} · Credentials: ${g.creds.length} · Attack Artifacts: ${g.files.length}`, '')
      if (g.vulns.length) { lines.push('### Impactful Vulnerabilities', ''); for (const v of g.vulns) lines.push(...renderVuln(v)) }
      if (g.access.length) {
        lines.push('### Obtained Access', '')
        for (const a of g.access) lines.push(`- ${a.host} · ${a.username || '—'} · ${a.method || '—'} · ${a.privilege || '—'} · ${a.session_ref || ''}`)
        lines.push('')
      }
      if (g.creds.length) {
        lines.push('### Credentials', '')
        for (const c of g.creds) lines.push(`- ${c.host} · ${c.username || '—'} · ${c.secret_type || '—'} · ${c.privilege || '—'} · ${c.secret_ref || ''}`)
        lines.push('')
      }
      if (g.files.length) {
        lines.push('### Attack Artifacts', '')
        for (const f of g.files) lines.push(`- \`${f.name}\` (${f.kind}): ${f.description || '—'} | Impact: ${f.evidence} | Path: ${f.path}`)
        lines.push('')
      }
      if (g.chain.length) {
        lines.push('### Attack Chain', '')
        for (const st of g.chain) lines.push(`${st.seq}. [${st.stage}] ${st.title}${st.detail ? ' — ' + st.detail : ''}`)
        lines.push('')
      }
      const entry = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment || 'Unassigned',
        stats: { vulns: g.vulns.length, bySeverity, accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length },
        markdown: lines.join('\n'),
      }
      list.push(entry)
      const cidr = entry.segment
      if (!groups.has(cidr)) groups.set(cidr, { cidr, targets: [] })
      groups.get(cidr).targets.push(entry)
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({ cidr: g.cidr, targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)) }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr))
    return {
      generated_at: nowIso(),
      engagement: { id, name: meta.target_name || id, scope: meta.scope_cidrs || [] },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    }
  }

  /* ---------- 报告 ---------- */

  /**
   * 生成 Markdown 成果报告。
   *
   * 只交付「成果漏洞」：状态为 confirmed / exploited，且严重级为 critical / high / medium。
   * 待验证（candidate）、误报（false-positive）、低危与信息级（low/info）都不进报告——
   * 它们是过程噪声（水洞）。信息收集的资产清单也不进报告（在资产测绘页面看）。
   * 报告保留：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、攻击链（内网突破成果）、
   * 已获得权限与凭据、修复建议。
   *
   * @param id - 靶标 id。
   * @param options - `{ all: true }` 时输出全部漏洞（用于自查，不出交付物）。
   */
  report(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const filteredOut = allVulns.length - vulns.length

    const lines = []
    const push = (...xs) => lines.push(...xs)
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const v of vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    const exploited = vulns.filter((v) => v.status === 'exploited').length

    push(`# Engagement Deliverables Report — ${meta.target_name || id}`, '')
    push(`- Generated At: ${nowIso()}`)
    push(`- Scope: ${(meta.scope_cidrs || []).join(', ') || '(Not recorded)'}`)
    push(`- Summary: Deliverable Vulnerabilities ${vulns.length} (Critical ${bySeverity.critical} · High ${bySeverity.high} · Medium ${bySeverity.medium}) · Successfully Exploited ${exploited} · Controlled Assets ${access.length} · Credentials Gained ${creds.length}`)
    push('')

    push('## 1. Deliverable Vulnerabilities', '')
    if (!vulns.length) {
      push('No deliverable vulnerabilities recorded for this engagement (only confirmed/exploited medium+ severities included).', '')
    } else {
      for (const v of vulns) {
        push(`### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
        push(`- Target: ${v.target || '—'}`)
        push(`- Asset: ${v.asset_ip || '—'} (${v.segment_cidr || '—'})`)
        push(`- Status: ${v.status === 'exploited' ? 'Exploited' : 'Verified'} · Confidence: ${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · Discovery Method: ${v.source || '—'}`)
        push(`- Impact & Evidence: ${v.evidence || '—'}`)
        const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
        if (evidence.length) {
          push('', '**Reproduction Request (paste directly into Burp Suite / Yakit)**:', '')
          for (const e of evidence) {
            push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
            if (e.request) push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
            if (e.response) push('Response Summary:', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
          }
        }
        push('')
      }
    }

    push('## 2. Attack Chain', '')
    if (chain.length) {
      for (const s of chain) {
        push(`${s.seq}. **[${s.stage}] ${s.title}**`)
        if (s.asset_ip) push(`   - Asset: ${s.asset_ip}`)
        if (s.vuln_title || s.vuln_cve) push(`   - Vulnerability: ${s.vuln_cve ? s.vuln_cve + ' ' : ''}${s.vuln_title || ''}`)
        if (s.detail) push(`   - Details: ${s.detail}`)
        if (s.evidence_ref) push(`   - Evidence: ${s.evidence_ref}`)
      }
    } else push('(No attack chain steps recorded)')
    push('')

    push('## 3. Obtained Access & Credentials', '')
    if (access.length) {
      push('| Host | Account | Method | Privilege | Evidence |', '| --- | --- | --- | --- | --- |')
      for (const a of access) push(`| ${a.host} | ${a.username || '—'} | ${a.method || '—'} | ${a.privilege || '—'} | ${a.session_ref || '—'} |`)
    } else push('(No active access sessions obtained)')
    push('')
    if (creds.length) {
      push('| Host | Account | Type | Privilege | Reference |', '| --- | --- | --- | --- | --- |')
      for (const c of creds) push(`| ${c.host} | ${c.username || '—'} | ${c.secret_type || '—'} | ${c.privilege || '—'} | ${c.secret_ref || '—'} |`)
    } else push('(No credentials obtained)')
    push('')

    push('## 4. Remediation Recommendations', '')
    const advice = []
    if (vulns.some((v) => v.cve)) advice.push('1. Prioritize remediation of affected components matching CVE identifiers above, establish baseline versions, and incorporate into patch management.')
    if (access.some((a) => a.method === 'webshell' || a.method === 'rce' || a.method === 'upload')) advice.push('2. Restrict file upload and execution vectors: disable execution permissions in upload directories, enforce strict whitelists, and run web processes with least privileges.')
    if (access.some((a) => a.method === 'vnc' || a.method === 'rdp' || a.method === 'ssh')) advice.push('3. Minimize exposure of remote management interfaces (VNC/RDP/SSH), enforcing robust passwords and multi-factor authentication.')
    if (creds.some((c) => c.secret_type === 'connection-string')) advice.push('4. Prevent leakage of database connection strings via APIs or configuration files, store keys in secure key vaults, and enforce API access controls.')
    advice.push(`${advice.length + 1}. Implement unified authentication and authorization validation across involved endpoints, maintaining an API inventory with regression testing.`)
    push(...advice, '')

    if (filteredOut > 0 && !includeAll) {
      push(`> This report only includes verified or exploited vulnerabilities of Medium severity and above; ${filteredOut} unverified, false-positive, or Low/Info records are excluded (viewable under the Vulnerability Results tab).`)
      push('')
    }

    return {
      markdown: lines.join('\n'),
      generated_at: nowIso(),
      stats: {
        results: vulns.length,
        bySeverity,
        exploited,
        filteredOut,
        accesses: access.length,
        credentials: creds.length,
        chainSteps: chain.length,
      },
    }
  }

  /* ---------- 写入原语 ---------- */
  #upsertSegment(db, seg) {
    db.prepare(`INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`).run(
      seg.cidr, seg.ip_start ?? null, seg.ip_end ?? null, seg.org ?? null, seg.asn ?? null,
      seg.country ?? null, seg.city ?? null, seg.source ?? null, seg.first_seen ?? nowIso(), nowIso(),
    )
  }

  #upsertAsset(db, a) {
    const cidr = a.segment_cidr || cidrOf(a.ip)
    this.#upsertSegment(db, { cidr, source: a.provenance, first_seen: a.first_seen })
    const t = nowIso()
    /* discovered_at = 本库第一次看到这条资产的时刻；重复采集只刷新 last_seen，
       不动 discovered_at（否则"发现时间"会变成"最后一次采集时间"，等于没记）。 */
    db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, discovered_at, scope)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        discovered_at = COALESCE(NULLIF(asset.discovered_at, ''), excluded.discovered_at),
        last_seen = excluded.last_seen`).run(
      cidr, a.ip, ipToInt(a.ip), a.state ?? 'unknown', a.primary_name ?? null, a.confidence ?? null,
      a.first_seen ?? t, t, a.discovered_at ?? t, a.scope || scopeOfIp(a.ip),
    )
    return db.prepare('SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?').get(cidr, a.ip).id
  }

  #observe(db, entityKind, entityId, attr, value, provenance, tool, rawRef) {
    db.prepare(`INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      entityKind, entityId, attr ?? null, value == null ? null : String(value),
      provenance ?? 'unknown', tool ?? null, nowIso(), rawRef ?? null,
    )
  }

  #edge(db, srcKind, srcId, dstKind, dstId, relation, confidence) {
    db.prepare(`INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`).run(
      srcKind, String(srcId), dstKind, String(dstId), relation, confidence ?? null, nowIso(), nowIso(),
    )
  }

  /** 重建单个资产的全文索引行（列表、图谱、后续智能体共用一份索引）。 */
  #reindex(db, assetId) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(assetId)
    if (!a) return
    /* 没有 FTS5 时不建索引表，这里直接跳过 —— 检索走 listAssets 的 LIKE 分支，
       所以上面那几段取值也不用白跑。 */
    if (!HAS_FTS5) return
    const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(assetId).map((r) => r.name).join(' ')
    const banners = db.prepare('SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL').all(assetId).map((r) => r.banner).join(' ')
    const titles = db.prepare('SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL').all(assetId).map((r) => r.title).join(' ')
      + ' ' + db.prepare('SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL').all(assetId).map((r) => r.url).join(' ')
      + ' ' + db.prepare(`SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?`)
        .all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    const fps = db.prepare('SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?')
      .all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    db.prepare('DELETE FROM asset_fts WHERE asset_id = ?').run(String(assetId))
    db.prepare('INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)')
      .run(String(assetId), a.ip, names, banners, titles, fps)
  }

  /**
   * 采集结果入库（信息收集智能体与外部工具的统一 ingest 格式）。
   * bundle = { scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }
   * asset  = { ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }
   */
  importBundle(id, bundle = {}) {
    const db = this.db(id)
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 }
    let runId = null
    if (bundle.scan) {
      const r = db.prepare(`INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`).run(
        bundle.scan.agent_session_id ?? null, bundle.scan.tool ?? null,
        bundle.scan.argv ? JSON.stringify(bundle.scan.argv) : null, nowIso(),
      )
      runId = Number(r.lastInsertRowid)
    }
    db.exec('BEGIN')
    try {
      for (const seg of bundle.segments || []) { this.#upsertSegment(db, seg); counts.segments++ }
      for (const a of bundle.assets || []) {
        const provenance = a.provenance || 'active'
        const tool = a.tool || (bundle.scan && bundle.scan.tool) || null
        const assetId = this.#upsertAsset(db, Object.assign({}, a, { provenance }))
        counts.assets++
        for (const n of a.names || []) {
          db.prepare(`INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`)
            .run(assetId, n.name, n.kind ?? 'domain', n.provenance ?? provenance, tool, nowIso(), nowIso())
          counts.names++
          this.#observe(db, 'asset', assetId, 'name', n.name, n.provenance ?? provenance, tool, runId)
          this.#edge(db, 'domain', n.name, 'asset', assetId, 'resolves')
        }
        if (a.primary_name) this.#observe(db, 'asset', assetId, 'primary_name', a.primary_name, provenance, tool, runId)
        for (const p of a.ports || []) {
          const pProv = p.provenance || provenance
          db.prepare(`INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`)
            .run(assetId, p.proto ?? 'tcp', Number(p.port), p.state ?? 'open', pProv, p.tool ?? tool,
              p.banner ?? null, p.url ?? null, p.title ?? null, nowIso(), nowIso())
          const portId = db.prepare('SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?')
            .get(assetId, p.proto ?? 'tcp', Number(p.port)).id
          counts.ports++
          this.#observe(db, 'port', portId, 'open', `${p.port}/${p.proto ?? 'tcp'}`, pProv, p.tool ?? tool, runId)
          if (p.service || p.product || p.version) {
            db.prepare(`INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(
              portId, p.service ?? null, p.product ?? null, p.version ?? null, p.cpe ?? null,
              pProv, p.tool ?? tool, nowIso(), nowIso(),
            )
            counts.services++
            this.#observe(db, 'port', portId, 'service', [p.service, p.product, p.version].filter(Boolean).join(' '), pProv, p.tool ?? tool, runId)
          }
          for (const fp of p.fingerprints || []) {
            db.prepare(`INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              assetId, portId, fp.category ?? null, fp.vendor ?? null, fp.product ?? null, fp.version ?? null,
              fp.evidence ?? null, fp.confidence ?? null, fp.provenance ?? pProv, fp.tool ?? tool, nowIso(), nowIso(),
            )
            counts.fingerprints++
            this.#observe(db, 'asset', assetId, 'fingerprint',
              [fp.category, fp.vendor, fp.product, fp.version].filter(Boolean).join(' '),
              fp.provenance ?? pProv, fp.tool ?? tool, runId)
          }
        }
        this.#reindex(db, assetId)
      }
      for (const e of bundle.edges || []) {
        this.#edge(db, e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.confidence)
        counts.edges++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { scan_run_id: runId, counts, stats: this.stats(id) }
  }

  /* ---------- 提示词 ---------- */

  /** 默认提示词指纹清单（记录本靶标上次被写入默认时的内容指纹）。 */
  promptManifestPathOf(id) { return join(this.promptsDirOf(id), '.defaults.json') }

  readPromptManifest(id) {
    try {
      const raw = readFileSync(this.promptManifestPathOf(id), 'utf8')
      const data = JSON.parse(raw)
      return data !== null && typeof data === 'object' ? data : {}
    } catch { return {} }
  }

  writePromptManifest(id, manifest) {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true })
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch { /* 写不进去不影响使用 */ }
  }

  /**
   * 把"仍是旧版内置默认"的角色提示词换成当前版本；用户自己改过的原样保留。
   *
   * 判断依据：内容指纹等于 ① 本靶标上次写入默认时的指纹（manifest），或
   * ② 任一历史版本的默认指纹（LEGACY_PROMPT_HASHES）。两者都不匹配 = 用户自己写的。
   * 每次读提示词（面板打开）时顺带跑一遍，所以老靶标也会自动跟上新版。
   *
   * @param id - 靶标 id。
   * @param options - `{ force?: boolean }`：force 时连"用户自写"也覆盖（脚本批量升级用）。
   * @returns `{ changed, kept, created }` —— kept 是判定为"用户自写、已保留"的角色。
   */
  refreshDefaultPrompts(id, options = {}) {
    const manifest = this.readPromptManifest(id)
    let changed = 0
    let created = 0
    const kept = []
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] || ''
      const p = join(this.promptsDirOf(id), `${role}.md`)
      /* 新增角色（如 v0.9.0 的资产梳理 assess / 主会话 plan）：老靶标没有这个文件，
         直接按当前默认建一份，不用用户手动补 */
      if (!existsSync(p)) {
        if (next !== '') {
          mkdirSync(this.promptsDirOf(id), { recursive: true })
          writeFileSync(p, next, 'utf8')
          manifest[role] = promptHash(next)
          created += 1
        }
        continue
      }
      const cur = readFileSync(p, 'utf8')
      const h = promptHash(cur)
      const hNext = promptHash(next)
      if (h === hNext) { manifest[role] = hNext; continue }
      const wasDefault = options.force === true || manifest[role] === h || (LEGACY_PROMPT_HASHES[role] || []).includes(h)
      if (!wasDefault) { kept.push(role); continue }
      /* 覆盖前留一份 .bak，万一判错还能找回 */
      try { copyFileSync(p, `${p}.bak-${Date.now()}`) } catch { /* 忽略 */ }
      writeFileSync(p, next, 'utf8')
      manifest[role] = hNext
      changed += 1
    }
    this.writePromptManifest(id, manifest)
    return { changed, kept, created }
  }

  listPrompts(id) {
    const dir = this.promptsDirOf(id)
    mkdirSync(dir, { recursive: true })
    this.refreshDefaultPrompts(id)
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`)
      const exists = existsSync(p)
      return {
        role, title,
        /* 主会话（plan）不派出去，只作人设参考 —— 面板上标注一下，别让人以为要派它 */
        planner: role === PLANNER_ROLE,
        dispatcher: role !== PLANNER_ROLE,
        content: exists ? readFileSync(p, 'utf8') : '',
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      }
    })
  }

  /** 把角色提示词恢复成内置默认（用户在界面上改坏了 / 老靶标要用新版提示词时用）。 */
  resetPrompts(id, role) {
    if (role !== undefined && role !== null) {
      this.savePrompt(id, role, DEFAULT_PROMPTS[role] || '')
      return { reset: [role] }
    }
    const done = []
    for (const r of Object.keys(ROLE_TITLES)) { this.savePrompt(id, r, DEFAULT_PROMPTS[r] || ''); done.push(r) }
    return { reset: done }
  }

  savePrompt(id, role, content) {
    if (!ROLE_TITLES[role]) throw new Error(`unknown role: ${role}`)
    mkdirSync(this.promptsDirOf(id), { recursive: true })
    const text = String(content ?? '')
    writeFileSync(join(this.promptsDirOf(id), `${role}.md`), text, 'utf8')
    /* 记下这是不是"当前内置默认"：是则将来能随新版自动升级，否则视为用户自写、永不覆盖 */
    const manifest = this.readPromptManifest(id)
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[role] || '')) manifest[role] = promptHash(text)
    else delete manifest[role]
    this.writePromptManifest(id, manifest)
    return { role, bytes: Buffer.byteLength(text) }
  }

}
