/**
 * 报告复现工具（纯函数，零依赖）。
 *
 * 目标：让报告里**每一条得分**都有"可照做"的复现入口，而不是只有一句
 * "没有原始请求记录"。数据其实都在库里（攻击步骤的 tool、目标 URL、证据文本），
 * 这里把它整理成 Yakit 能重放的报文与终端能直接跑的命令。
 *
 * 两条底线：
 *   · **合成的东西必须标注来源**（`synthesized: true`）—— 推断出来的请求与真实抓包
 *     在可信度上不是一回事，报告里要能一眼分辨，不能让验收人把推断当实证。
 *   · 合成只在"信息足够"时做：有 URL 或有明确的 curl/httpie 命令才合成，
 *     否则宁可留空并给补录指引，不编造。
 */

/**
 * 从 target 里解析出 scheme / host / port / path，用于补全合成请求。
 *
 * 必须显式处理 IPv6 的方括号写法：`http://[2001:db8::1]:8080/x` 里
 * "IPv6 地址内部的冒号" 与 "端口分隔冒号" 混在一起，用一条正则一起抓会错位
 * （实测把 host 解析成 `2001:db8:`、path 变成 `:8080/x`，
 *  合成出来的报文首行成了 `GET :8080/x HTTP/1.1`）。
 * 所以分两步：先按方括号取 authority，再按"最后一个冒号"剥端口。
 *
 * @param target - 形如 `http://h:8080/p` / `10.0.0.5:6379` / `[::1]:22` 的字符串。
 * @returns `{ scheme, host, port, path, authority }`；解析不出返回 null。
 */
function parseTarget(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)([^?#\s]*)?/i.exec(t)
  if (url !== null) {
    const scheme = url[1].toLowerCase()
    const authority = url[2]
    const path = url[3] && url[3] !== '' ? url[3] : '/'
    /* 方括号 IPv6：[2001:db8::1]:8080 → host 2001:db8::1, port 8080 */
    const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority)
    if (bracket !== null) {
      return {
        scheme, host: bracket[1], port: bracket[2] === undefined ? (scheme === 'https' ? 443 : 80) : Number(bracket[2]),
        path, authority, ipv6: true,
      }
    }
    const portMatch = /:(\d{1,5})$/.exec(authority)
    const host = portMatch === null ? authority : authority.slice(0, -portMatch[0].length)
    return {
      scheme, host,
      port: portMatch === null ? (scheme === 'https' ? 443 : 80) : Number(portMatch[1]),
      path, authority, ipv6: false,
    }
  }
  /* 没写协议：host[:port]，同样要先认方括号 */
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(t)
  if (bracket !== null) {
    return { scheme: null, host: bracket[1], port: bracket[2] === undefined ? null : Number(bracket[2]), path: null, authority: t, ipv6: true }
  }
  const bare = /^([^\s/?#:]+)(?::(\d{1,5}))?$/.exec(t)
  if (bare !== null) {
    return { scheme: null, host: bare[1], port: bare[2] === undefined ? null : Number(bare[2]), path: null, authority: t, ipv6: false }
  }
  /* 认不出的形态（带路径的裸主机等）：只取第一段当主机，其余留给调用方 */
  const head = /^([^\s/?#]+)/.exec(t)
  if (head === null) return null
  return { scheme: null, host: head[1], port: null, path: null, authority: t, ipv6: false }
}

/** 这条命令看起来是什么工具（用于决定能不能直接当复现命令用）。 */
function commandKind(tool) {
  const t = String(tool || '').trim()
  if (t === '') return null
  if (/^curl\b/i.test(t)) return 'curl'
  if (/^http(ie| x)?\b/i.test(t) || /^http\s/i.test(t)) return 'httpie'
  if (/^(nuclei|ffuf|feroxbuster|gobuster|dirsearch|sqlmap|hydra|nmap|masscan|fscan|gogo)\b/i.test(t)) return 'scanner'
  if (/^(msfconsole|use\s|set\s)/i.test(t)) return 'msf'
  if (/^(python|python3|java|go run|node)\b/i.test(t)) return 'script'
  return 'other'
}

/**
 * 从一条 curl 命令里抽出 URL 与方法（用于补一份可重放的 HTTP 报文）。
 * 只做保守解析：抽不出就返回 null，不猜。
 */
function parseCurl(tool) {
  const t = String(tool || '').trim()
  if (!/^curl\b/i.test(t)) return null
  const urlMatch = /(https?:\/\/[^\s'"]+)/i.exec(t)
  if (urlMatch === null) return null
  const methodMatch = /(?:-X|--request)\s+([A-Z]+)/i.exec(t)
  const dataMatch = /(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i.exec(t)
  const headerMatches = Array.from(t.matchAll(/(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)")/gi))
    .map((m) => m[1] !== undefined ? m[1] : m[2])
    .filter((x) => typeof x === 'string' && x.includes(':'))
  const cookieMatch = /(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i.exec(t)
  const data = dataMatch === null ? null : (dataMatch[1] ?? dataMatch[2] ?? dataMatch[3] ?? null)
  const method = methodMatch !== null ? methodMatch[1].toUpperCase() : (data === null ? 'GET' : 'POST')
  return {
    url: urlMatch[1], method, data,
    headers: headerMatches,
    cookie: cookieMatch === null ? null : (cookieMatch[1] ?? cookieMatch[2] ?? cookieMatch[3] ?? null),
    insecure: /(^|\s)-k(\s|$)|--insecure/.test(t),
    followRedirect: /(^|\s)-L(\s|$)|--location/.test(t),
  }
}

/**
 * 合成一条可粘进 Yakit Repeater 的 HTTP 报文。
 * @param options - `{ url, method, data, headers, cookie, insecure, followRedirect }`
 * @returns 报文文本，信息不足时返回 null。
 */
function buildHttpRequest(options = {}) {
  const target = parseTarget(options.url)
  if (target === null) return null
  const scheme = target.scheme || 'http'
  /* IPv6 的 Host 头必须带方括号（RFC 3986），否则是非法头 */
  const hostText = target.ipv6 ? '[' + target.host + ']' : target.host
  const defaultPort = scheme === 'https' ? 443 : 80
  const hostHeader = (target.port !== null && target.port !== defaultPort)
    ? hostText + ':' + target.port
    : hostText
  const path = options.path !== undefined && options.path !== null && options.path !== ''
    ? options.path
    : (target.path || '/')
  const method = String(options.method || (options.data === undefined || options.data === null ? 'GET' : 'POST')).toUpperCase()
  const lines = [method + ' ' + path + ' HTTP/1.1', 'Host: ' + hostHeader]
  /* 上游 1.1.87：抓来的头部/Cookie 可能带换行，直接拼进去等于让人往报文里插新头。 */
  const headers = Array.isArray(options.headers)
    ? options.headers.map((h) => String(h).replace(/[\r\n]+/g, ' '))
    : []
  const hasHeader = (name) => headers.some((h) => String(h).toLowerCase().startsWith(name.toLowerCase() + ':'))
  if (!hasHeader('User-Agent')) headers.push('User-Agent: Mozilla/5.0')
  if (!hasHeader('Accept')) headers.push('Accept: */*')
  if (options.cookie && !hasHeader('Cookie')) headers.push('Cookie: ' + String(options.cookie).replace(/[\r\n]+/g, ' '))
  const body = options.data === undefined || options.data === null ? '' : String(options.data)
  if (body !== '' && !hasHeader('Content-Type')) {
    headers.push(/^\{.*\}$/.test(body.trim()) ? 'Content-Type: application/json' : 'Content-Type: application/x-www-form-urlencoded')
  }
  if (body !== '' && !hasHeader('Content-Length')) headers.push('Content-Length: ' + Buffer.byteLength(body, 'utf8'))
  if (!hasHeader('Connection')) headers.push('Connection: close')
  return [lines[0], ...headers, '', body].join('\r\n')
}

/**
 * 合成一条"可直接在终端跑"的复现命令。
 * 优先用真实的 curl 命令（原样保留，最可信）；否则按 URL/方法拼一条。
 */
function buildCurlCommand(options = {}) {
  const raw = String(options.tool || '').trim()
  if (commandKind(raw) === 'curl') return raw          /* 真实命令原样给出，别改 */
  const target = parseTarget(options.url)
  if (target === null) return null
  const scheme = target.scheme || 'http'
  const hostText = target.ipv6 ? '[' + target.host + ']' : target.host
  const defaultPort = scheme === 'https' ? 443 : 80
  const hostPart = target.port !== null && target.port !== defaultPort
    ? hostText + ':' + target.port
    : hostText
  const url = scheme + '://' + hostPart + (options.path || target.path || '/')
  const parts = ['curl -i -s' + (options.insecure ? ' -k' : '') + (options.followRedirect ? ' -L' : '')]
  if (options.method && String(options.method).toUpperCase() !== 'GET') parts.push('-X ' + String(options.method).toUpperCase())
  if (options.cookie) {
    parts.push("-b '" + String(options.cookie).replace(/[\r\n]/g, ' ').replace(/'/g, "'\\''") + "'")
  }
  if (options.data !== undefined && options.data !== null && options.data !== '') {
    parts.push("-d '" + String(options.data).replace(/[\r\n]/g, ' ').replace(/'/g, "'\\''") + "'")
  }
  parts.push("'" + url + "'")
  return parts.join(' ')
}

/**
 * 用本条得分**已经记录的信息**填充动作模板里的占位符。
 *
 * 为什么值得做：数据库/终端/隧道这类得分项的模板长这样
 *   `mysql -h <host> -u <user> -p -e "..."`
 * 而这条得分自己就知道 host（target）与账号（挂载的凭据）。把已知部分填进去，
 * 一线拿到报告就能跑；剩下没填的占位符**保持原样并如实报告**，不猜。
 *
 * @param template - 含 `<占位符>` 的命令模板。
 * @param values - `{ host, port, user, pass, url, listen }` 等已知值。
 * @returns `{ cmd, filled, remaining }`：填充后的命令 + 填了哪些 + 还剩哪些占位符。
 */
function fillTemplate(template, values = {}) {
  let cmd = String(template || '')
  const filled = []
  const table = [
    [/<host>/gi, values.host],
    [/<ip>/gi, values.host],
    [/<port>/gi, values.port],
    [/<user(name)?>/gi, values.user],
    [/<账号>/g, values.user],
    [/<用户名>/g, values.user],
    [/<pass(word)?>/gi, values.pass],
    [/<口令>/g, values.pass],
    [/<密钥>/g, values.pass],
    [/<pwd>/gi, values.pass],
    [/<url>/gi, values.url],
    [/<域名>/g, values.host],
    [/<目标IP>/g, values.host],
    [/<内网IP>/g, values.host],
    [/<端口>/g, values.port],
    [/<listen端口>/g, values.port],
    [/<u>/g, values.user],
    [/<p>/g, values.pass],
  ]
  for (const [re, value] of table) {
    if (value === undefined || value === null || String(value) === '') continue
    const needle = new RegExp(re.source, re.flags.replace('g', ''))
    if (!needle.test(cmd)) continue
    /* 填进去的值可能是抓包来的（带换行）—— 一条命令里换行就是第二条命令。 */
    const safe = String(value).replace(/[\r\n]+/g, ' ')
    cmd = cmd.replace(new RegExp(re.source, re.flags), safe)
    /* 记录填了什么，报告里要如实说明（模板被改过，读者需要知道哪些是补进去的） */
    filled.push(re.source.replace(/[\\<>?()/]|gi$/g, '') + ' → ' + safe)
  }
  const remaining = Array.from(new Set(Array.from(cmd.matchAll(/<[^>\s]{1,24}>/g)).map((m) => m[0])))
  return { cmd, filled, remaining }
}

export { parseTarget, commandKind, parseCurl, buildHttpRequest, buildCurlCommand, fillTemplate }
