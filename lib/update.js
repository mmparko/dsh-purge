import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { atomicWriteSync, findDshHome } from "./core.js";
import * as core from "./core.js";
import * as desktop from "./desktop.js";
import * as web from "./web.js";
import { extractZipBuffer } from "./zip-extract.js";
import * as transaction from "./update-transaction.js";
import { assertRuntime } from "./runtime-check.js";
import { detectSurface } from "./surface.js";

const REPO = "realMisakaMikoto/dsh-purge";
const STABLE_REF = "stable";
const BETA_REF = "beta";
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CHANNELS = {
  stable: { id: "stable", ref: STABLE_REF, label: "正式版" },
  beta: { id: "beta", ref: BETA_REF, label: "测试版" },
};

const HIDDEN = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  timeout: 20000,
};

// 只允许来自 GitHub / jsdelivr 的 302 跳转落地,阻挡中间人把下载指向任意主机。
const UPDATE_REDIRECT_ALLOWED_HOSTS = new Set([
  "github.com",
  "codeload.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "cdn.jsdelivr.net",
]);
const MAX_UPDATE_BYTES = 50 * 1024 * 1024;

export function pluginRoot() {
  return PLUGIN_ROOT;
}

export function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function channelStatePath() {
  return path.join(findDshHome(), "dsh-purge", "channel.json");
}

function historyPath() {
  return path.join(findDshHome(), "dsh-purge", "version-history.json");
}

function stampPath() {
  return path.join(findDshHome(), "dsh-purge", "installed-rev");
}

function autoUpdateGuardPath() {
  return path.join(findDshHome(), "dsh-purge", "auto-update-guard.json");
}


export function normalizeChannel(value) {
  return String(value || "").toLowerCase() === "beta" ? "beta" : "stable";
}

function isBetaName(name) {
  return /(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(String(name || ""));
}

function withdrawnVersion(item) {
  const text = [item?.version, item?.ref, item?.id].filter(Boolean).join(" ");
  return /(?:^|[\sv])1\.1\.11-beta/i.test(String(text).replace(/^v/i, " "));
}

function splitVersion(raw) {
  const text = String(raw || "").trim().replace(/^v/i, "");
  const cut = text.split("-");
  const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
  return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
}

export function versionIsNewer(remote, local) {
  if (!remote) return false;
  if (!local) return true;
  if (String(remote) === String(local)) return false;
  const a = splitVersion(remote);
  const b = splitVersion(local);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  return a.pre > b.pre;
}

export function latestStableVersion(versions) {
  let best = "";
  for (const item of versions || []) {
    if (!item || item.channel === "beta") continue;
    const ver = String(item.version || "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(ver) || isBetaName(ver)) continue;
    if (!best || versionIsNewer(ver, best)) best = ver;
  }
  return best;
}

/** 测试通道只认 beta 分支头。旧的 beta/rc/pre 标签不列出。 */
export function hideListedVersion(item, _stableVersion = "") {
  if (!item || withdrawnVersion(item)) return true;
  if (item.ref === BETA_REF && item.channel === "beta") return false;
  return item.channel === "beta" || isBetaName(item.version) || isBetaName(item.ref) || isBetaName(item.id);
}

export function readChannelState() {
  const raw = readJson(channelStatePath()) || {};
  const stored = String(raw.channel || "").toLowerCase();
  const pin = typeof raw.pin === "string" ? raw.pin.trim() : "";
  const channel = stored === "beta" ? "beta" : "stable";
  const state = {
    channel,
    pin: isBetaName(pin) || ["master", "stable", BETA_REF].includes(pin) ? "" : pin,
  };
  if ((stored === "beta") !== (channel === "beta") || state.pin !== pin) writeChannelState(state);
  return state;
}

function writeChannelState(next) {
  const state = {
    channel: normalizeChannel(next?.channel),
    pin: typeof next?.pin === "string" ? next.pin.trim() : "",
  };
  atomicWriteSync(channelStatePath(), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function channelPublic(state = readChannelState()) {
  const meta = CHANNELS[state.channel] || CHANNELS.stable;
  return {
    channel: meta.id,
    channelLabel: meta.label,
    pin: state.pin || "",
  };
}

function currentChannelRef(state = readChannelState()) {
  return state.pin || (CHANNELS[state.channel] || CHANNELS.stable).ref;
}

function readHistory() {
  const raw = readJson(historyPath());
  const rows = Array.isArray(raw) ? raw : [];
  return rows.filter((item) => item && !withdrawnVersion(item));
}


/** 直连 codeload，避免 github.com/archive → 302 在 Electron/部分 Node 下变成 http 302 / fetch failed。 */
function archiveZipUrl(ref) {
  const value = String(ref || STABLE_REF);
  if (/^[0-9a-f]{40}$/i.test(value)) return `https://codeload.github.com/${REPO}/zip/${value}`;
  if (/^v?\d/.test(value)) return `https://codeload.github.com/${REPO}/zip/refs/tags/${encodeURIComponent(value)}`;
  return `https://codeload.github.com/${REPO}/zip/refs/heads/${encodeURIComponent(value)}`;
}

function archiveTarballUrl(ref) {
  const value = String(ref || STABLE_REF);
  if (/^[0-9a-f]{40}$/i.test(value)) return `https://codeload.github.com/${REPO}/tar.gz/${value}`;
  if (/^v?\d/.test(value)) return `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${encodeURIComponent(value)}`;
  return `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${encodeURIComponent(value)}`;
}

function readStamp() {
  try {
    return fs.readFileSync(stampPath(), "utf8").trim();
  } catch {
    return "";
  }
}


function sameRev(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function realPath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function isGitCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function canGit(dir) {
  if (!isGitCheckout(dir)) return false;
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], HIDDEN);
    return true;
  } catch {
    return false;
  }
}

function gitOk() {
  return canGit(PLUGIN_ROOT);
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], HIDDEN).trim();
  } catch {
    return "";
  }
}

export function isLinkSpec(spec) {
  const s = String(spec || "");
  return /^(link|file):/i.test(s) || s === "." || /^\.\.?(?:[/\\]|$)/.test(s);
}

export function resolveLinkDir(profileDir, spec) {
  const raw = String(spec).replace(/^(link|file):/i, "");
  return path.resolve(profileDir, raw);
}

export function findPurgeProfiles() {
  const root = path.join(findDshHome(), "profiles");
  if (!fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const pkg = readJson(path.join(dir, "package.json"));
    const spec = pkg?.dependencies?.["dsh-purge"] || pkg?.devDependencies?.["dsh-purge"];
    if (!spec) continue;
    out.push({ name, dir, spec: String(spec) });
  }
  return out;
}

export function profilePluginDir(profileDir) {
  const nm = path.join(profileDir, "node_modules", "dsh-purge");
  return fs.existsSync(nm) ? realPath(nm) : "";
}

/** 把 profile 里的安装地址改成 codeload。github.com/archive 会 302，pnpm 的 fetch 接着失败。 */

function planUpdates() {
  const profiles = findPurgeProfiles();
  const jobs = [];
  const seen = new Set();
  const remember = (dir) => {
    const key = realPath(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  for (const p of profiles) {
    if (isLinkSpec(p.spec)) {
      const dir = resolveLinkDir(p.dir, p.spec);
      if (fs.existsSync(path.join(dir, "package.json")) && remember(dir)) {
        jobs.push(canGit(dir) ? { kind: "git", dir, profile: p.name } : { kind: "zip", dir, profile: p.name });
      }
    }
    const dir = profilePluginDir(p.dir) || PLUGIN_ROOT;
    jobs.push({ kind: "dsh", profile: p.name, spec: p.spec, dir, profileDir: p.dir });
    remember(dir);
  }

  if (!jobs.length) {
    jobs.push(canGit(PLUGIN_ROOT) ? { kind: "git", dir: PLUGIN_ROOT } : { kind: "zip", dir: PLUGIN_ROOT });
    return jobs;
  }
  if (remember(PLUGIN_ROOT)) {
    jobs.push(canGit(PLUGIN_ROOT) ? { kind: "git", dir: PLUGIN_ROOT } : { kind: "zip", dir: PLUGIN_ROOT });
  }
  return jobs;
}

function detectVia() {
  if (gitOk()) {
    const extra = findPurgeProfiles().some((p) => !isLinkSpec(p.spec));
    return extra ? "mixed" : "git";
  }
  if (findPurgeProfiles().some((p) => !isLinkSpec(p.spec))) return "dsh";
  if (findPurgeProfiles().length) return "dsh";
  return "zip";
}

function isAbortError(e) {
  const msg = String((e && e.message) || e || "");
  return (e && (e.name === "AbortError" || e.name === "TimeoutError")) || /aborted|abort|超时/i.test(msg);
}

function rewriteDownloadUrl(url) {
  const value = String(url || "");
  let match = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/refs\/(tags|heads)\/(.+)\.(zip|tar\.gz)$/i);
  if (match) {
    const kind = match[4].toLowerCase() === "zip" ? "zip" : "tar.gz";
    return `https://codeload.github.com/${match[1]}/${kind}/refs/${match[2]}/${decodeURIComponent(match[3])}`;
  }
  match = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/([0-9a-f]{7,40})\.(zip|tar\.gz)$/i);
  if (match) {
    const kind = match[3].toLowerCase() === "zip" ? "zip" : "tar.gz";
    return `https://codeload.github.com/${match[1]}/${kind}/${match[2]}`;
  }
  return "";
}

function requestBuffer(url, ms, headers, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    // 上游 1.1.87：只允许 https。旧版放行 http（还专门挑了 http 模块），
    // 一次降级跳转就能把更新包拉成明文。
    if (parsed.protocol !== "https:") {
      reject(new Error(`update: unsupported protocol ${parsed.protocol}`));
      return;
    }
    const req = https.request(parsed, {
      method: "GET",
      headers: { "user-agent": "dsh-purge-update", accept: "*/*", ...headers },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("http redirect loop"));
          return;
        }
        const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        const candidate = loc ? new URL(loc, url).href : rewriteDownloadUrl(url);
        if (!candidate || candidate === url) {
          reject(new Error(`http ${status}`));
          return;
        }
        let nextUrl;
        try {
          nextUrl = new URL(candidate);
        } catch (e) {
          reject(e);
          return;
        }
        if (nextUrl.protocol !== "https:") {
          reject(new Error(`update: redirect rejected (non-https: ${nextUrl.protocol})`));
          return;
        }
        if (!UPDATE_REDIRECT_ALLOWED_HOSTS.has(nextUrl.hostname)) {
          reject(new Error(`update: redirect rejected (host not allowed: ${nextUrl.hostname})`));
          return;
        }
        requestBuffer(nextUrl.href, ms, headers, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const rewritten = rewriteDownloadUrl(url);
        if (rewritten && rewritten !== url && redirectsLeft > 0) {
          requestBuffer(rewritten, ms, headers, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        reject(new Error(`http ${status}`));
        return;
      }
      const chunks = [];
      let received = 0;
      let aborted = false;
      res.on("data", (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) {
          aborted = true;
          req.destroy(new Error(`update: response exceeds ${MAX_UPDATE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (!aborted) resolve({ status, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(ms, () => {
      req.destroy(new Error("GitHub 超时"));
    });
    req.end();
  });
}

async function fetchRes(url, ms = 20000, headers = {}) {
  const started = rewriteDownloadUrl(url) || url;
  try {
    const result = await requestBuffer(started, ms, headers);
    return {
      ok: true,
      status: result.status,
      async text() {
        return result.body.toString("utf8");
      },
      async arrayBuffer() {
        return result.body.buffer.slice(
          result.body.byteOffset,
          result.body.byteOffset + result.body.byteLength,
        );
      },
    };
  } catch (e) {
    if (isAbortError(e) || /GitHub 超时/.test(String(e && e.message))) throw new Error("GitHub 超时");
    throw e;
  }
}

async function fetchText(url, ms = 20000, headers = {}) {
  return (await fetchRes(url, ms, headers)).text();
}

async function fetchJson(url, ms = 20000, headers = {}) {
  return JSON.parse(await fetchText(url, ms, headers));
}

function versionFromPackageText(text) {
  const pkg = JSON.parse(text);
  return pkg && pkg.version ? String(pkg.version) : "";
}

// 远端 package.json 版本号查询:5 分钟 memo,频繁刷新面板时不重复打 raw.github / jsdelivr。
const _remotePkgVerCache = new Map();
const REMOTE_PKG_VER_TTL = 300_000;
async function remotePackageVersion(sha = "", fallbackRef = STABLE_REF) {
  const ref = sha || fallbackRef;
  const key = sha || `ref:${ref}`;
  const now = Date.now();
  const hit = _remotePkgVerCache.get(key);
  if (hit && now - hit.at < REMOTE_PKG_VER_TTL) return hit.value;
  const urls = [
    sha ? `https://cdn.jsdelivr.net/gh/${REPO}@${sha}/package.json` : "",
    `https://raw.githubusercontent.com/${REPO}/${ref}/package.json`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/package.json`,
    `https://api.github.com/repos/${REPO}/contents/package.json?ref=${encodeURIComponent(ref)}`,
  ].filter(Boolean);
  for (const url of urls) {
    try {
      if (url.includes("api.github.com/repos/")) {
        const data = await fetchJson(url, 20000, { accept: "application/vnd.github.raw" });
        let ver = "";
        if (typeof data === "string") ver = versionFromPackageText(data);
        else if (data && data.version) ver = String(data.version);
        else if (data && data.content && data.encoding === "base64") {
          ver = versionFromPackageText(Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8"));
        }
        if (ver) { _remotePkgVerCache.set(key, { value: ver, at: now }); return ver; }
        continue;
      }
      const ver = versionFromPackageText(await fetchText(url));
      if (ver) { _remotePkgVerCache.set(key, { value: ver, at: now }); return ver; }
    } catch {
      // 换下一个源。
    }
  }
  // 失败也记短缓存 30 秒,避免反复打空请求。
  _remotePkgVerCache.set(key, { value: "", at: now - (REMOTE_PKG_VER_TTL - 30_000) });
  return "";
}

async function remoteHeadSha(ref = STABLE_REF) {
  const target = encodeURIComponent(ref || STABLE_REF);
  const fromApi = fetchJson(`https://api.github.com/repos/${REPO}/commits/${target}`)
    .then((data) => (data?.sha ? String(data.sha) : ""))
    .catch(() => "");
  const fromAtom = fetchText(`https://github.com/${REPO}/commits/${ref}.atom`)
    .then((atom) => {
      const hit = atom.match(/<id>tag:github\.com,2008:Grit::Commit\/([0-9a-f]{40})<\/id>/);
      return hit ? hit[1] : "";
    })
    .catch(() => "");
  const [apiSha, atomSha] = await Promise.all([fromApi, fromAtom]);
  return apiSha || atomSha || "";
}

function versionLabel(version, channel, sha = "") {
  const ver = String(version || "").replace(/^v/, "") || (sha ? String(sha).slice(0, 7) : "");
  const mark = channel === "beta" ? "测试" : "正式";
  return ver ? `${ver}（${mark}）` : mark;
}


const UPDATE_REF_RE = /^(?:v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?|stable|master|main|beta|[0-9a-f]{7,40})$/i;

export function safeUpdateRef(ref) {
  const target = String(ref || "").trim();
  if (!target) return "";
  if (!UPDATE_REF_RE.test(target)) return "";
  return target;
}

export function markCurrent(versions, state, localVer, localSha) {
  const pin = String(state?.pin || "");
  const rows = versions || [];
  const ver = String(localVer || "").replace(/^v/i, "");
  const channel = state?.channel || "stable";
  const sameVersion = (item) => ver && String(item?.version || "").replace(/^v/i, "") === ver && item.channel === channel;
  const sameSha = (item) => Boolean(localSha && item?.sha && sameRev(localSha, item.sha));
  let chosen = null;
  if (pin) {
    chosen = rows.find((item) => item.ref === pin) || null;
  } else {
    const pool = rows.filter(sameVersion);
    // 安装记录里的旧提交号不能把较低版本标成当前。只认和正在跑的 package.json 相同的版本。
    chosen = pool.find((item) => sameSha(item) && (item.latest || item.ref === "master" || item.kind === "head"))
      || pool.find((item) => item.latest || item.ref === "master" || item.kind === "head")
      || pool.find((item) => sameSha(item))
      || pool[0]
      || null;
  }
  return rows.map((item) => ({
    ...item,
    shaShort: item.shaShort || (item.sha ? String(item.sha).slice(0, 7) : ""),
    current: Boolean(chosen && item === chosen),
  }));
}

function completeRelease(row) {
  if (!row || row.draft || row.prerelease || !row.published_at || !/^v?\d+\.\d+\.\d+$/.test(row.tag_name || "")) return null;
  const version = row.tag_name.replace(/^v/, "");
  const asset = (row.assets || []).find((item) => item.name === "dsh-purge-" + version + ".zip" && item.state === "uploaded" && item.size > 0);
  const checksum = (row.assets || []).find((item) => item.name === "SHA256SUMS" && item.state === "uploaded");
  if (!asset || (!/^sha256:[0-9a-f]{64}$/i.test(asset.digest || "") && !checksum)) return null;
  return { id: row.tag_name, ref: row.tag_name, version, channel: "stable", kind: "release",
    sha: /^[0-9a-f]{40}$/i.test(row.target_commitish || "") ? row.target_commitish : "",
    asset: asset.browser_download_url, digest: (asset.digest || "").replace(/^sha256:/, ""),
    checksum: checksum?.browser_download_url || "", label: version };
}

async function listGithubReleases() {
  const rows = await fetchJson("https://api.github.com/repos/" + REPO + "/releases?per_page=100");
  if (!Array.isArray(rows)) throw new Error("Invalid GitHub Release response");
  return rows.map(completeRelease).filter(Boolean).sort((a, b) => versionIsNewer(a.version, b.version) ? -1 : versionIsNewer(b.version, a.version) ? 1 : 0);
}

async function resolveTarget(ref = STABLE_REF) {
  if (["master", "main", "stable"].includes(ref)) ref = STABLE_REF;
  if (ref === BETA_REF) {
    const sha = await remoteHeadSha(BETA_REF);
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("No beta branch is available");
    return { ref: BETA_REF, sha, version: await remotePackageVersion(sha, BETA_REF), channel: "beta", asset: archiveZipUrl(sha) };
  }
  let hit;
  if (ref === STABLE_REF) hit = (await listGithubReleases())[0];
  else {
    const listed = await listGithubReleases();
    hit = listed.find((item) => item.ref === ref || item.version === ref || item.sha === ref);
    if (!hit && /^v?\d+\.\d+\.\d+$/.test(ref)) {
      const tag = ref.startsWith("v") ? ref : "v" + ref;
      hit = completeRelease(await fetchJson("https://api.github.com/repos/" + REPO + "/releases/tags/" + encodeURIComponent(tag)));
    }
  }
  if (!hit) throw new Error("No complete published stable Release is available");
  const sha = await remoteHeadSha(hit.ref);
  if (!/^[0-9a-f]{40}$/i.test(sha) || (hit.sha && sha !== hit.sha)) throw new Error("Release tag/commit mismatch");
  return { ...hit, sha };
}

function ensureRunningVersion(versions, state, localVer, localSha) {
  const ver = String(localVer || "").replace(/^v/i, "");
  if (!ver || isBetaName(ver) || state?.channel === "beta") return versions;
  if ((versions || []).some((item) => item.channel === "stable" && String(item.version || "").replace(/^v/i, "") === ver)) {
    return versions;
  }
  const ref = (versions || []).some((item) => item.ref === "master") ? `local-${ver}` : "master";
  return [{
    id: ref,
    ref,
    sha: localSha || "",
    version: ver,
    channel: "stable",
    label: versionLabel(ver, "stable", localSha),
    kind: "local",
    latest: !(versions || []).some((item) => item.channel === "stable" && item.latest),
  }, ...(versions || [])];
}

async function listRemoteVersions() {
  const state = readChannelState();
  const releases = await listGithubReleases();
  const stable = releases[0];
  if (stable) {
    stable.latest = true;
    stable.label = stable.version + " (published)";
    if (!stable.sha) stable.sha = await remoteHeadSha(stable.ref);
  }
  const betaSha = await remoteHeadSha(BETA_REF).catch(() => "");
  const out = [...releases];
  if (betaSha) out.push({ id: BETA_REF, ref: BETA_REF, sha: betaSha, channel: "beta", kind: "head",
    version: await remotePackageVersion(betaSha, BETA_REF), latest: true });
  if (state.pin && !out.some((item) => item.ref === state.pin)) {
    try { out.push(await resolveTarget(state.pin)); } catch { /* Preserve the pin; do not substitute master. */ }
  }
  const localVer = localVersion();
  const localSha = installedRevision();
  const withLocal = ensureRunningVersion(out, state, localVer, localSha);
  return { versions: markCurrent(withLocal, state, localVer, localSha), hasBeta: Boolean(betaSha),
    stableSha: stable?.sha || "", betaSha };
}

function describeLane(id, listed, state, localVer, localRev) {
  const sha = id === "beta" ? listed.betaSha : listed.stableSha;
  const versions = listed.versions.filter((item) => item.channel === id);
  const latest = versions.find((item) => item.latest);
  const version = latest?.version || "";
  const onLane = state.channel === id;
  const matchesHead = Boolean(localRev && sha && sameRev(localRev, sha));
  const current = matchesHead || versions.some((item) => item.current && (item.latest || (state.pin && item.ref === state.pin)));
  let hasUpdate = false;
  if (onLane && state.pin) {
    hasUpdate = Boolean(sha && localRev && !sameRev(localRev, sha));
  } else if (onLane && versionIsNewer(version, localVer)) {
    // 只跟版本号。提交号对不上就再 add --force，会在 dsh 杀掉宿主后形成无限重启。
    hasUpdate = true;
  } else if (onLane && !localVer && sha && localRev && !sameRev(localRev, sha)) {
    hasUpdate = true;
  }
  return {
    id,
    ref: CHANNELS[id].ref,
    version,
    sha: sha ? String(sha).slice(0, 7) : "",
    current,
    hasUpdate,
    hasRemote: Boolean(sha || versions.length),
  };
}

function lanesOf(listed, state, localVer, localRev) {
  return {
    stable: describeLane("stable", listed, state, localVer, localRev),
    beta: describeLane("beta", listed, state, localVer, localRev),
  };
}

export async function checkUpdate() {
  let state = readChannelState();
  const localVer = localVersion();
  const listed = await listRemoteVersions();
  const gitSha = installedRevision();
  const stamp = readStamp();
  const localRev = gitSha || stamp;
  listed.versions = markCurrent(listed.versions, state, localVer, localRev);
  const channelRef = currentChannelRef(state);
  const lanes = lanesOf(listed, state, localVer, localRev);
  const lane = lanes[state.channel] || lanes.stable;
  if (!lane.hasRemote && state.channel === "beta") {
    return rememberUpdate({
      ok: true,
      hasUpdate: false,
      hasBeta: false,
      error: "还没有测试版",
      localVersion: localVer,
      remoteVersion: "",
      localSha: localRev ? localRev.slice(0, 7) : "",
      remoteSha: "",
      updateTarget: channelRef,
      via: detectVia(),
      versions: listed.versions,
      lanes,
      ...channelPublic(state),
    });
  }
  if (!lanes.stable.hasRemote) throw new Error("No complete published Release is available");
  const result = {
    ok: true,
    hasUpdate: Boolean(lane.hasUpdate),
    hasBeta: listed.hasBeta,
    updateTarget: channelRef,
    pinned: Boolean(state.pin),
    localVersion: localVer,
    remoteVersion: lane.version || lane.sha,
    localSha: localRev ? localRev.slice(0, 7) : "",
    remoteSha: lane.sha,
    via: detectVia(),
    versions: listed.versions,
    lanes,
    ...channelPublic(state),
  };
  rememberUpdate(result);
  return result;
}

let lastUpdate = null;

export function installedRevision() {
  try { return fs.readFileSync(path.join(PLUGIN_ROOT, ".dsh-purge-revision"), "utf8").trim(); }
  catch { return (gitOk() ? gitHead(PLUGIN_ROOT) : "") || readStamp(); }
}

function rememberUpdate(result) { lastUpdate = result; return result; }

export function lastUpdateResult() { return lastUpdate; }

function nodeForWorker(state) {
  if (state.desktop_exe) {
    const resources = path.resolve(path.dirname(state.desktop_exe), process.platform === "darwin" ? "../Resources" : "resources");
    const candidate = path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", process.platform === "win32" ? "node.exe" : "node");
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function restartFor(state) {
  if (state.surface === "desktop") {
    const plan = desktop.restartPlan();
    if (!plan.execPath) throw new Error(plan.error);
    return { ...plan, argv: process.platform === "win32" ? ["--updated"] : [],
      asar: path.join(path.dirname(plan.execPath), process.platform === "darwin" ? "../Resources" : "resources", "app.asar") };
  }
  const portIndex = process.argv.indexOf("--port");
  return { kind: "web", execPath: process.execPath, argv: web.restartArgv(), cwd: process.cwd(),
    port: Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1]
      || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || process.env.PORT) || 3080, openBrowser: true };
}

function launchOperation(tx) {
  const engine = path.join(tx.dir, "engine");
  fs.mkdirSync(engine, { recursive: true });
  for (const name of ["update-worker.js", "update-supervisor.js", "update-transaction.js", "operation-boot.js", "runtime-check.js", "file-journal.js", "reapply-transaction.js"]) {
    const destination = path.join(engine, name);
    if (tx.recovering) {
      if (!tx.engine_hashes?.[name] || transaction.digest(fs.readFileSync(destination)) !== tx.engine_hashes[name]) throw new Error("Recovery engine checksum mismatch");
    } else {
      fs.copyFileSync(path.join(PLUGIN_ROOT, "lib", name), destination);
      (tx.engine_hashes ||= {})[name] = transaction.digest(fs.readFileSync(destination));
    }
  }
  transaction.save(tx);
  fs.writeFileSync(path.join(engine, "package.json"), '{"type":"module"}\n');
  const log = fs.openSync(path.join(tx.dir, "worker.log"), "a");
  try {
    const child = spawn(tx.node, [path.join(engine, "update-supervisor.js"), path.join(tx.dir, "journal.json"), ...(tx.recovering ? ["--recover"] : [])], {
      detached: true, stdio: ["ignore", log, log], cwd: tx.dir, windowsHide: true, shell: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.on("error", (error) => {
      const current = transaction.load(path.join(tx.dir, "journal.json"));
      transaction.phase(current, "failed", { error: "Worker launch failed: " + error.message });
      transaction.releaseLocks(current);
    });
    child.unref();
  } finally { fs.closeSync(log); }
}

export async function beginRestart(state, options = {}) {
  assertRuntime();
  transaction.reconcileStale(findDshHome());
  const previous = transaction.latestOperation(findDshHome());
  if (previous && !["verified", "rolled_back", "failed"].includes(previous.phase)) {
    if (previous.phase === "awaiting_restart" && previous.kind === "apply") {
      transaction.phase(previous, "preparing");
      launchOperation(previous);
    }
    return transaction.publicOperation(previous);
  }
  const version = localVersion();
  let sha = "";
  try { sha = fs.readFileSync(path.join(PLUGIN_ROOT, ".dsh-purge-revision"), "utf8").trim(); } catch { /* Legacy installation. */ }
  const tx = transaction.createTransaction(findDshHome(), {
    kind: options.kind || "restart", old_pid: process.pid, primary: PLUGIN_ROOT, destinations: [PLUGIN_ROOT],
    surface: state.surface, profile: process.env.DSH_PROFILE || state.surface, ai_base: state.ai_base,
    target: { version, sha }, previous: { version, sha }, restart: restartFor(state), node: nodeForWorker(state),
  });
  launchOperation(tx);
  return transaction.publicOperation(tx);
}

/** 面板在判断「是否有作业在跑」前先清一次死掉的历史作业（#8）。 */
export function reconcileOperation(home = findDshHome()) {
  return transaction.publicOperation(transaction.reconcileStale(home));
}

export function recordApply(state, restartRequired, complete = true) {
  transaction.reconcileStale(findDshHome());
  const active = transaction.latestOperation(findDshHome());
  if (active && !["verified", "rolled_back", "failed"].includes(active.phase)) return transaction.publicOperation(active);
  let sha = "";
  try { sha = fs.readFileSync(path.join(PLUGIN_ROOT, ".dsh-purge-revision"), "utf8").trim(); } catch { /* Legacy. */ }
  const tx = transaction.createTransaction(findDshHome(), {
    kind: "apply", old_pid: process.pid, primary: PLUGIN_ROOT, destinations: [PLUGIN_ROOT],
    surface: state.surface, profile: process.env.DSH_PROFILE || state.surface, ai_base: state.ai_base,
    target: { version: localVersion(), sha }, previous: { version: localVersion(), sha },
    restart: restartFor(state), node: nodeForWorker(state),
  });
  transaction.phase(tx, restartRequired ? "awaiting_restart" : complete ? "verified" : "failed",
    complete || restartRequired ? {} : { error: "Apply did not complete; see the patch report" });
  if (!restartRequired) transaction.releaseLocks(tx);
  return transaction.publicOperation(tx);
}

async function pendingMetadata(jobs, target, channel, pin, nextPackage) {
  const at = new Date().toISOString();
  const metadata = [
    { path: channelStatePath(), content: JSON.stringify({ channel, pin }) + "\n" },
    { path: stampPath(), content: target.sha + "\n" },
    { path: path.join(findDshHome(), "dsh-purge", "applied.json"), content: JSON.stringify({ version: target.version, sha: target.sha, at }) + "\n" },
    { path: autoUpdateGuardPath(), content: JSON.stringify({ ref: target.ref, sha: target.sha, at }) + "\n" },
    { path: historyPath(), content: JSON.stringify([{ ref: target.ref, sha: target.sha, version: target.version, channel, at },
      ...readHistory().filter((item) => item.ref !== target.ref)].slice(0, 20), null, 2) + "\n" },
  ];
  let tarball;
  for (const job of jobs) {
    if (!job.profileDir) continue;
    const file = path.join(job.profileDir, "package.json");
    const pkg = readJson(file);
    if (!pkg) throw new Error("Profile package is unreadable: " + file);
    let changed = false;
    for (const name of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (pkg[name]?.["dsh-purge"] && !isLinkSpec(pkg[name]["dsh-purge"])) {
        pkg[name]["dsh-purge"] = archiveTarballUrl(target.sha);
        changed = true;
      }
    }
    const lockFile = path.join(job.profileDir, "pnpm-lock.yaml");
    if (changed && fs.existsSync(lockFile)) {
      const current = readJson(path.join(job.dir, "package.json"));
      const normalized = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        if (normalized(current?.[field]) !== normalized(nextPackage?.[field])) throw new Error("Dependency changes require a package-manager install; no files were switched");
      }
      let yaml;
      try { yaml = createRequire(file)("yaml"); } catch { throw new Error("Profile YAML parser is unavailable; lockfile left unchanged"); }
      tarball ||= Buffer.from(await (await fetchRes(archiveTarballUrl(target.sha), 45000)).arrayBuffer());
      const document = yaml.parseDocument(fs.readFileSync(lockFile, "utf8"));
      if (document.errors.length) throw new Error("Profile lockfile cannot be parsed");
      const lock = document.toJS();
      if (String(lock.lockfileVersion).split(".")[0] !== "9") throw new Error("Unsupported profile lockfile version; no files were switched");
      const url = archiveTarballUrl(target.sha);
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const old = lock.importers?.["."]?.[group]?.["dsh-purge"];
        if (!old) continue;
        const qualifier = old.version.includes("(") ? old.version.slice(old.version.indexOf("(")) : "";
        const oldBase = old.version.split("(")[0];
        const oldPackage = lock.packages?.["dsh-purge@" + oldBase];
        const oldSnapshot = lock.snapshots?.["dsh-purge@" + old.version];
        if (!oldPackage || !oldSnapshot) throw new Error("Profile lockfile lacks the complete package graph");
        document.setIn(["importers", ".", group, "dsh-purge"], { specifier: url, version: url + qualifier });
        document.setIn(["packages", "dsh-purge@" + url], { ...oldPackage,
          resolution: { tarball: url, integrity: "sha512-" + (await import("node:crypto")).createHash("sha512").update(tarball).digest("base64") },
          engines: nextPackage.engines || {} });
        document.setIn(["snapshots", "dsh-purge@" + url + qualifier], oldSnapshot);
      }
      metadata.push({ path: lockFile, content: String(document) });
    }
    metadata.push({ path: file, content: JSON.stringify(pkg, null, 2) + "\n" });
  }
  return metadata;
}

let applyUpdateInflight = null;

export async function applyUpdate(jobs = planUpdates(), options = {}) {
  if (applyUpdateInflight) return applyUpdateInflight;
  applyUpdateInflight = _applyUpdateImpl(jobs, options).finally(() => { applyUpdateInflight = null; });
  return applyUpdateInflight;
}

async function _applyUpdateImpl(jobs, options = {}) {
  assertRuntime();
  if (!Array.isArray(jobs)) { options = jobs || {}; jobs = planUpdates(); }
  const channelState = readChannelState();
  const requested = safeUpdateRef(options.ref || currentChannelRef(channelState));
  if (!requested) throw new Error("Unknown update target");
  const target = await resolveTarget(requested);
  const channel = target.channel;
  const pin = options.pin === false ? "" : (options.pin || channelState.pin || "");
  const destinations = [...new Set(jobs.map((job) => realPath(job.dir)).filter(Boolean))];
  const git = destinations.map((root) => transaction.gitState(root)).filter(Boolean);
  const state = options.state || await core.gatherState({ surface: detectSurface() });
  if (!state.ai_base) throw new Error("Host not located; update stopped");
  const primary = options.primary || PLUGIN_ROOT;
  const previousPackage = readJson(path.join(primary, "package.json"));
  if (previousPackage?.name !== "dsh-purge" || !destinations.includes(realPath(primary))) throw new Error("Primary plugin must be one of the verified destinations");
  let previousSha = "";
  try { previousSha = fs.readFileSync(path.join(primary, ".dsh-purge-revision"), "utf8").trim(); } catch { /* Legacy. */ }
  const tx = transaction.createTransaction(findDshHome(), {
    old_pid: process.pid, primary, target, previous: { version: previousPackage.version, sha: previousSha }, git,
    surface: state.surface, profile: process.env.DSH_PROFILE || state.surface, ai_base: state.ai_base,
    restart: restartFor(state), node: nodeForWorker(state), metadata: [],
  });
  try {
    const response = await fetchRes(target.asset, 45000);
    const bytes = Buffer.from(await response.arrayBuffer());
    let expected = target.digest;
    if (!expected && target.checksum) {
      const sums = await fetchText(target.checksum);
      const name = "dsh-purge-" + target.version + ".zip";
      const row = sums.split(/\r?\n/).find((line) => line.trim().endsWith(" " + name));
      expected = row?.trim().split(/\s+/)[0];
    }
    if (target.channel === "stable" && (!/^[0-9a-f]{64}$/i.test(expected || "") || transaction.digest(bytes) !== expected.toLowerCase())) throw new Error("Release ZIP checksum mismatch");
    const unpack = path.join(tx.dir, "unpack");
    extractZipBuffer(bytes, unpack);
    const roots = fs.readdirSync(unpack).map((name) => path.join(unpack, name)).filter((dir) => fs.existsSync(path.join(dir, "package.json")));
    if (roots.length !== 1) throw new Error("Archive must contain exactly one plugin root");
    transaction.preparePayload(tx, roots[0], destinations);
    tx.legacy_target = !fs.existsSync(path.join(tx.source, "lib", "operation-boot.js"));
    transaction.save(tx);
    for (const entry of tx.manifest.filter((item) => /\.(?:js|mjs)$/.test(item.relative))) {
      const check = spawnSync(tx.node, ["--check", path.join(tx.source, entry.relative)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, encoding: "utf8", timeout: 10000 });
      if (check.status !== 0) throw new Error("Staged JavaScript is invalid: " + entry.relative);
    }
    tx.metadata = await pendingMetadata(jobs, target, channel, pin, readJson(path.join(tx.source, "package.json")));
    transaction.save(tx);
    for (const item of tx.metadata) transaction.capture(tx, item.path, "metadata");
    if (options.launch !== false) launchOperation(tx);
    return rememberUpdate({ ok: true, applied: false, verified: false, verification_pending: true, operation: transaction.publicOperation(tx),
      operation_id: tx.id, localVersion: localVersion(), remoteVersion: target.version, remoteSha: target.sha,
      restartAfter: false, reloadClient: false, hasUpdate: true, channel, pinned: Boolean(pin), pin });
  } catch (error) {
    transaction.phase(tx, "failed", { error: String(error.message || error) });
    transaction.releaseLocks(tx);
    throw error;
  }
}

export async function switchChannel(channel, { apply = true } = {}) {
  const next = normalizeChannel(channel);
  if (!apply) {
    writeChannelState({ channel: next, pin: "" });
    return checkUpdate();
  }
  return applyUpdate(planUpdates(), { ref: CHANNELS[next].ref, channel: next, pin: false, force: true });
}

function listedUpdateRef(target, listed) {
  const safe = safeUpdateRef(target);
  if (!safe) return "";
  const hit = (listed?.versions || []).find((item) => (
    item.ref === safe
    || item.id === safe
    || item.sha === safe
    || (item.sha && safe.length >= 7 && (item.sha.startsWith(safe) || safe.startsWith(item.sha)))
  ));
  return safeUpdateRef(hit?.ref || "");
}

export async function switchVersion(ref) {
  const raw = String(ref || "").trim();
  if (withdrawnVersion({ ref: raw, version: raw })) throw new Error("该版本已下线");
  const target = safeUpdateRef(raw);
  if (!target) throw new Error("请选择要回退的版本");
  const listed = await listRemoteVersions();
  const resolved = listedUpdateRef(target, listed);
  if (!resolved) throw new Error("未知版本");
  const hit = listed.versions.find((item) => item.ref === resolved);
  const channel = hit?.channel || readChannelState().channel;
  const pin = hit?.latest ? "" : resolved;
  return applyUpdate(planUpdates(), { ref: resolved, channel, pin, force: true });
}

export async function handleUpdateOp(body = {}) {
  const op = String(body.op || (body.auto ? "auto" : "apply")).toLowerCase();
  if (["check", "status", "versions"].includes(op)) return checkUpdate();
  if (op === "channel") return switchChannel(body.channel, { apply: body.apply !== false });
  if (op === "switch" || op === "rollback") return switchVersion(body.ref || body.version || body.id);
  if (op === "auto") return autoUpdateIfNeeded();
  const requested = body.ref || currentChannelRef(readChannelState());
  const ref = safeUpdateRef(requested);
  if (!ref) throw new Error("Unknown update target");
  return applyUpdate(planUpdates(), { ref, pin: false });
}

export function recoverInterrupted() {
  const tx = transaction.latestOperation(findDshHome());
  if (!tx || ["verified", "rolled_back"].includes(tx.phase) || !tx.host_stopped || tx.recovery_attempted || transaction.alive(tx.owner_pid)) return false;
  tx.recovering = true; transaction.save(tx);
  launchOperation(tx);
  return true;
}

export async function autoUpdateIfNeeded() {
  // 插件只允许用户在面板手动更新；启动路径永不自动升（版本适配依赖本机宿主）。
  return rememberUpdate({
    auto: true,
    skipped: "manual-only",
    hasUpdate: false,
    error: "",
    ...channelPublic(),
  });
}
