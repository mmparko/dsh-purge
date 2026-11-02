import nodeFs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

let cachedDiskFs;

/**
 * 真实磁盘上的 fs。
 * Electron 自带的 fs 会把 `resources/app` 映射进仍在的 `app.asar`，
 * 往里面新建文件会 ENOENT。解开目录，以及归档还在时打补丁，走这里。
 * 非 Electron 环境没有 original-fs，退回 node:fs。
 */
export function diskFs() {
  if (cachedDiskFs) return cachedDiskFs;
  process.noDeprecation = true;
  try {
    cachedDiskFs = createRequire(import.meta.url)("original-fs");
  } catch {
    cachedDiskFs = nodeFs;
  }
  return cachedDiskFs;
}

/**
 * asar 判定缓存(启动性能修复 / F14 + F17)。
 *
 * `asarShadowsPath()` 每次调用都要向上探最多 12 层,每层 1~2 次 original-fs 系统调用,
 * 于是**每一次**经 hostFs 的调用都变成约 25 次系统调用。实测:
 *   - findAiBaseWeb 的兜底目录扫描 6 万个目录:裸 node:fs 6.2 s → 经这层 94 s;
 *   - 兜底扫描修掉之后,剩下的模块加载期里,光是这套探针自身仍占宿主启动 CPU 的 24%
 *     (4117 ms / 17226 ms)。
 *
 * 缓存分两级:
 *   1) 持久级:5 s 存活期。任何一次经 hostFs 的**写操作**立即清空;插件自己搬 app.asar 的
 *      那些函数(renameAsarAside / extractAsarToSide / commitExtractedDir / …)也显式清空。
 *      进程外的官方更新器换 app.asar 由 5 s 存活期兜底,官方更新后本来也会重启宿主。
 *   2) 作用域级:withFsProbeCache() 显式开合的强缓存。作用域内不改文件系统,
 *      给目录递归扫描那种十万次调用的一次性突发用。
 */

const PROBE_TTL_MS = 5000;
const PROBE_MAX_ENTRIES = 400000;

let probePersist = null;
let probePersistEpoch = 0;
let probeScope = null;

/** 丢弃全部 asar 判定缓存。任何可能改动 app.asar 的操作之后都必须调用。 */
export function invalidateAsarProbes() {
  probePersist = new Map();
  probePersistEpoch = Date.now();
}

function activeProbes() {
  if (probeScope) return probeScope;
  const now = Date.now();
  if (!probePersist || now - probePersistEpoch >= PROBE_TTL_MS) invalidateAsarProbes();
  return probePersist;
}

/** 在给定的同步函数内启用强缓存(作用域内不得改动文件系统)。可重入。 */
export function withFsProbeCache(fn) {
  if (probeScope) return fn();
  probeScope = new Map();
  try {
    return fn();
  } finally {
    probeScope = null;
  }
}

function probeKey(kind, p) {
  return kind + String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function probeAsarFileIn(dir) {
  try {
    const asar = path.join(dir, "app.asar");
    return diskFs().existsSync(asar) && diskFs().statSync(asar).isFile();
  } catch {
    return false;
  }
}

function asarFileIn(dir) {
  if (!dir) return false;
  const cache = activeProbes();
  const k = probeKey("f:", dir);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = probeAsarFileIn(dir);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

function computeAsarShadows(raw) {
  let dir = path.normalize(raw);
  for (let i = 0; i < 12; i += 1) {
    const base = path.basename(dir).toLowerCase();
    if ((base === "app" || base.endsWith(".asar")) && asarFileIn(path.dirname(dir))) return true;
    if (asarFileIn(dir)) return true;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return false;
}

/** 这个路径会被 Electron 映射进旁边的 app.asar。已解开且归档已挪走时为假。 */
export function asarShadowsPath(targetPath) {
  const raw = String(targetPath || "").trim();
  if (!raw) return false;
  const cache = activeProbes();
  const k = probeKey("s:", raw);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = computeAsarShadows(raw);
  if (cache.size < PROBE_MAX_ENTRIES) cache.set(k, v);
  return v;
}

/**
 * 宿主文件用哪套 fs。
 * 没有 app.asar（Web、第三方桌面、官方包已经解开并挪走归档）时继续用 node:fs。
 * 归档还在、Electron 会把 resources/app 映进去时，改用真实磁盘。
 */
export function fsFor(targetPath) {
  return asarShadowsPath(targetPath) ? diskFs() : nodeFs;
}

function fsForPair(left, right) {
  return asarShadowsPath(left) || asarShadowsPath(right) ? diskFs() : nodeFs;
}

// 这些方法会改动文件系统,可能新增/删除 app.asar,调用前必须让探针缓存失效。
// openSync 故意不列入:它多数时候是只读打开,放进来会把缓存冲掉。
const HOST_WRITE = new Set([
  "writeFileSync", "mkdirSync", "chmodSync", "unlinkSync", "rmSync",
  "renameSync", "appendFileSync", "symlinkSync", "copyFileSync",
]);

function route(method, pair) {
  const isWrite = HOST_WRITE.has(method);
  return (first, ...rest) => {
    if (isWrite) invalidateAsarProbes();
    const f = pair ? fsForPair(first, rest[0]) : fsFor(first);
    return f[method](first, ...rest);
  };
}

const HOST_SYNC = [
  "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
  "readdirSync", "mkdirSync", "realpathSync", "chmodSync", "unlinkSync",
  "rmSync", "renameSync", "appendFileSync", "openSync", "symlinkSync",
  // 少这几个不报错，是静默坏掉（#96）：
  //   closeSync 缺 → backupAll 的占位 fd 关不掉（TypeError 被 try/catch 吞），
  //   目标文件一直被本进程占着 → rename(tmp,bak) 每个文件 EPERM → 全量备份 0 条，
  //   hasBackup 永远 false，revert 没有原件可回。
  //   readSync 缺 → isTextShim 每次抛 → 一律判「非文本 shim」→ dsh.ps1 / dsh 不注入。
  "closeSync", "readSync", "writeSync", "fsyncSync", "fstatSync", "accessSync",
];

/** 按路径自动选择 node:fs 或真实磁盘。补丁、探测、状态都走这一个。 */
export const hostFs = {
  copyFileSync: route("copyFileSync", true),
  promises: {
    readFile: (p, ...args) => fsFor(p).promises.readFile(p, ...args),
    writeFile: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.writeFile(p, ...args); },
    mkdir: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.mkdir(p, ...args); },
    unlink: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.unlink(p, ...args); },
    rm: (p, ...args) => { invalidateAsarProbes(); return fsFor(p).promises.rm(p, ...args); },
    copyFile: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.copyFile(src, dest, ...args); },
    rename: (src, dest, ...args) => { invalidateAsarProbes(); return fsForPair(src, dest).promises.rename(src, dest, ...args); },
  },
};
for (const method of HOST_SYNC) hostFs[method] = route(method, false);

/** Electron 会把 app.asar 伪装成目录。读归档必须走 original-fs，否则 isFile 为假、解不开。 */
function archiveFs() {
  return diskFs();
}

function renameBusy(error) {
  const code = error && error.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export function renameAsarAside(asarPath) {
  // 这一步直接改动 app.asar 的有无,必须让 asar 判定缓存立刻失效。
  invalidateAsarProbes();
  const afs = archiveFs();
  if (!asarPath || !afs.existsSync(asarPath)) return { renamed: false };
  const bak = `${asarPath}.bak`;
  try {
    if (afs.existsSync(bak)) afs.rmSync(bak, { force: true });
    afs.renameSync(asarPath, bak);
    return { renamed: true, bak };
  } catch (error) {
    if (renameBusy(error)) return { renamed: false, busy: true, bak };
    throw error;
  }
}

export function asarArchiveIsFile(p) {
  try {
    const afs = archiveFs();
    return Boolean(p) && afs.existsSync(p) && afs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 用大小和修改时间认出是不是同一份归档。 */
export function asarFileIdentity(asarPath) {
  try {
    const st = archiveFs().statSync(asarPath);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function sameAsarIdentity(left, right) {
  return Boolean(
    left && right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs,
  );
}

/**
 * 可用目录配同一份归档：不解包。
 * 目录不在，或记录过的归档大小/时间变了：解一次。
 * 升级标记碰上另一份归档，同样解一次。目录还在、又没记录过、也不是升级：先认这份归档，不解。
 */
export function shouldExtractAsar({ usable, identity, recorded, upgrade }) {
  if (!identity) return false;
  if (!usable) return true;
  const same = sameAsarIdentity(identity, recorded);
  if (upgrade && !same) return true;
  if (recorded && !same) return true;
  return false;
}

function readHeader(fd, afs) {
  const pre = Buffer.alloc(16);
  if (afs.readSync(fd, pre, 0, 16, 0) !== 16) throw new Error("asar header truncated");
  if (pre.readUInt32LE(0) !== 4) throw new Error("not an asar archive");
  const headerSize = pre.readUInt32LE(4);
  const jsonSize = pre.readUInt32LE(12);
  if (!headerSize || !jsonSize || jsonSize > 256 * 1024 * 1024) throw new Error("asar header size invalid");
  const jsonBuf = Buffer.alloc(jsonSize);
  if (afs.readSync(fd, jsonBuf, 0, jsonSize, 16) !== jsonSize) throw new Error("asar header short");
  return {
    header: JSON.parse(jsonBuf.toString("utf8")),
    dataOffset: 8 + headerSize,
  };
}

function walk(node, prefix, out) {
  const files = node && node.files;
  if (!files) return;
  for (const [name, info] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (info && info.files) walk(info, rel, out);
    else if (info) out.push({ rel, info });
  }
}

function copyRange(afs, fd, offset, size, outPath) {
  const outFs = diskFs();
  const out = outFs.openSync(outPath, "w");
  try {
    const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
    let left = size;
    let pos = offset;
    while (left > 0) {
      const n = afs.readSync(fd, buf, 0, Math.min(buf.length, left), pos);
      if (n <= 0) throw new Error(`asar short read at ${outPath}`);
      outFs.writeSync(out, buf, 0, n);
      pos += n;
      left -= n;
    }
  } finally {
    outFs.closeSync(out);
  }
}

/** asar 里标记 unpacked 的原生文件不在归档正文。解开目录启动前必须补到 resources/app。 */
export function overlayAsarUnpacked(asarPath, destDir) {
  const outFs = diskFs();
  const unpacked = `${asarPath}.unpacked`;
  if (!destDir || !outFs.existsSync(unpacked)) return { copied: 0, missing: true };
  let copied = 0;
  const walk = (dir) => {
    for (const ent of outFs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, ent.name);
      const to = path.join(destDir, path.relative(unpacked, from));
      if (ent.isDirectory()) {
        outFs.mkdirSync(to, { recursive: true });
        walk(from);
      } else if (ent.isFile()) {
        if (outFs.existsSync(to)) continue;
        outFs.mkdirSync(path.dirname(to), { recursive: true });
        outFs.copyFileSync(from, to);
        copied += 1;
      }
    }
  };
  walk(unpacked);
  return { copied };
}

function discardDir(dir) {
  if (!dir) return;
  try { diskFs().rmSync(dir, { recursive: true, force: true }); } catch { /* 残留目录下次再清 */ }
}

/** 解到目标旁边的目录。失败时删掉半成品，不碰已经在用的那一份。 */
export function extractAsarToSide(asarPath, destDir) {
  const next = `${destDir}.dshpurge-next`;
  discardDir(next);
  try {
    const count = extractAsar(asarPath, next);
    return { next, count };
  } catch (error) {
    discardDir(next);
    throw error;
  }
}

function restoreFromPrev(fs, destDir, prev) {
  if (!prev || fs.existsSync(destDir)) return false;
  try {
    fs.renameSync(prev, destDir);
    return true;
  } catch {
    return false;
  }
}

/** 解开完成之后才把旧目录挪走、新目录换上。换不上就把旧目录放回去,仍然失败就写 recover.json 保留 nextDir 给下次重试。 */
export function commitExtractedDir(destDir, nextDir) {
  const fs = diskFs();
  if (!nextDir || !fs.existsSync(nextDir)) throw new Error("解包目录不存在");
  let prev = "";
  if (fs.existsSync(destDir)) {
    prev = `${destDir}.dshpurge-prev`;
    if (fs.existsSync(prev)) prev = `${destDir}.dshpurge-prev-${Date.now()}`;
    fs.renameSync(destDir, prev);
  }
  try {
    fs.renameSync(nextDir, destDir);
  } catch (error) {
    const restored = restoreFromPrev(fs, destDir, prev);
    const recoverFp = `${destDir}.dshpurge-recover.json`;
    try {
      fs.writeFileSync(recoverFp, JSON.stringify({
        when: new Date().toISOString(),
        destDir,
        nextDir,
        prev,
        prevRestored: restored,
        error: String(error?.message || error),
      }, null, 2));
    } catch { /* 救援信息 best effort */ }
    const err = new Error(
      `commitExtractedDir failed; nextDir kept at ${nextDir}, prev at ${prev}, recover=${recoverFp}: ${error && error.message || error}`
    );
    err.cause = error;
    err.recover = recoverFp;
    throw err;
  }
  return { prev };
}

/** 升级脚本事先挪走的旧目录。补丁没写完时用它放回去。 */
export function newestPreservedDir(destDir) {
  const fs = diskFs();
  const parent = path.dirname(destDir);
  const prefix = `${path.basename(destDir)}.dshpurge-prev`;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return ""; }
  let best = "";
  let bestTime = -1;
  for (const name of names) {
    if (name !== prefix && !name.startsWith(`${prefix}-`)) continue;
    const full = path.join(parent, name);
    let time = 0;
    try { time = fs.statSync(full).mtimeMs; } catch { continue; }
    if (time >= bestTime) {
      best = full;
      bestTime = time;
    }
  }
  return best;
}

/** 补丁没写完时，把刚才挪走的旧目录放回原处。 */
export function restoreExtractedDir(destDir, prev) {
  const fs = diskFs();
  if (!prev || !fs.existsSync(prev)) return false;
  let failed = "";
  if (fs.existsSync(destDir)) {
    failed = `${destDir}.dshpurge-failed-${Date.now()}`;
    fs.renameSync(destDir, failed);
  }
  try {
    fs.renameSync(prev, destDir);
  } catch (error) {
    if (failed && !fs.existsSync(destDir)) {
      try { fs.renameSync(failed, destDir); } catch { /* 旧目录仍在 prev */ }
    }
    throw error;
  }
  if (failed) {
    // 只用 fs.rmSync 清隔离出来的坏目录：它对目录链接只删链接本身，不穿过 junction。
    // 删除前再核一次「必须是 destDir 的同级 app.dshpurge-failed-*」，别的一律留着。
    const failedName = path.basename(failed);
    const sameParent = path.dirname(path.resolve(failed)) === path.dirname(path.resolve(destDir));
    let linkish = false;
    try { linkish = fs.lstatSync(failed).isSymbolicLink(); } catch { linkish = true; }
    if (sameParent && /^app\.dshpurge-failed-\d+$/.test(failedName) && !linkish) {
      try { fs.rmSync(failed, { recursive: true, force: true }); } catch { /* 坏目录留着不影响已放回的那一份 */ }
    }
  }
  return true;
}

export function extractAsar(asarPath, destDir) {
  const afs = archiveFs();
  const fd = afs.openSync(asarPath, "r");
  let count = 0;
  let skippedOutside = 0;
  try {
    const { header, dataOffset } = readHeader(fd, afs);
    const entries = [];
    walk(header, "", entries);
    const outFs = diskFs();
    outFs.mkdirSync(destDir, { recursive: true });
    const destResolved = path.resolve(destDir);
    for (const entry of entries) {
      const info = entry.info;
      // 上游 1.1.87：asar 里的 key 不可信，带 ".." 的路径会写到 destDir 之外。
      const outPath = path.resolve(destDir, ...entry.rel.split("/"));
      if (outPath !== destResolved && !outPath.startsWith(destResolved + path.sep)) {
        skippedOutside += 1;
        continue;
      }
      outFs.mkdirSync(path.dirname(outPath), { recursive: true });
      if (info.unpacked) continue;
      if (typeof info.link === "string") {
        // symlink 目标解析后不能逃离 destDir(防越界,asar 来源不受信时)
        const linkResolved = path.resolve(path.dirname(outPath), info.link);
        const inside = linkResolved === destResolved
          || linkResolved.startsWith(destResolved + path.sep);
        if (!inside) {
          // 目标在 destDir 外,跳过(主程序原文件仍在归档里)
          continue;
        }
        try {
          outFs.symlinkSync(info.link, outPath);
        } catch {
          // 不能建链接就跳过，主程序文件仍在归档里
        }
        continue;
      }
      const size = Number(info.size || 0);
      const offset = dataOffset + Number(info.offset || 0);
      if (size === 0) {
        outFs.writeFileSync(outPath, Buffer.alloc(0));
      } else {
        copyRange(afs, fd, offset, size, outPath);
      }
      count += 1;
    }
  } finally {
    afs.closeSync(fd);
  }
  if (skippedOutside > 0) {
    try {
      console.warn(`[dsh-purge] extractAsar: skipped ${skippedOutside} entr${skippedOutside === 1 ? "y" : "ies"} outside ${destDir}`);
    } catch { /* 没有 console 也不该让解包失败 */ }
  }
  return count;
}
