/**
 * 上游修复回灌的回归：上游 1.1.80–1.1.83 里对得上本 fork 的那几条。
 *
 * 覆盖：
 *  1. #172 lib/skills.js 的 `fs` 导入（否则 #54 软链自删守卫静默失效）
 *  2. #155/#157 原子写保权限（0755 的 dsh 不能被写成 0644）
 *  3. #157 软链启动器：写穿目标、不吃掉软链；已被老版本写成拷贝的能还原软链
 *  4. #188 的 #77 锚点容错：rc.2 形状与旧形状都要命中，二次 apply 不叠加
 *  5. #108 卸载要清 dsh 0.2 的 pkg.dsh.profile.bundles/plugins
 *  6. #170 zip 目录项（含反斜杠）要建目录，不能写成空文件
 *  7. #188 宿主版本门禁（doctor.hostSupport）
 *
 * 只用临时目录里的夹具，不碰真实安装目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import * as core from "../lib/core.js";
import * as doctor from "../lib/doctor.js";
import * as anchor from "../lib/anchor.js";
import * as control from "../lib/subagent-control.js";
import * as identity from "../lib/identity.js";
import * as validate from "../lib/redteam/validate.js";
import * as replay from "../lib/redteam/report-replay.js";
import { stripPluginFromPackage } from "../lib/uninstall.js";
import { extractZipBuffer } from "../lib/zip-extract.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-ports-"));
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass += 1;
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ""}`);
}

function bad(name, e) {
  fail += 1;
  failures.push(`${name}: ${e && e.message ? e.message : e}`);
  console.log(`FAIL  ${name}  ${e && e.message ? e.message : e}`);
}

function check(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}

function skip(name, why) {
  console.log(`SKIP  ${name}  ${why}`);
}

function dir(...parts) {
  const p = path.join(root, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function write(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

/* ---------------------------------------------------------------- 1. skills fs */

check("#172 lib/skills.js 导入了 fs 本体", () => {
  const src = fs.readFileSync(new URL("../lib/skills.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes('from "node:fs"'));
  assert.ok(line, "找不到 node:fs 的 import");
  assert.match(line, /import\s+fs\s*,/, `默认 fs 未导入：${line.trim()}`);
});

/* --------------------------------------------------------- 2. 原子写保权限 */

if (process.platform === "win32") {
  skip("#155/#157 原子写保留原文件权限", "Windows 无 POSIX 权限位");
} else {
  check("#155/#157 原子写保留原文件权限", () => {
    const fp = write(path.join(dir("mode"), "dsh"), "#!/bin/sh\necho hi\n");
    fs.chmodSync(fp, 0o755);
    core.atomicWriteSync(fp, "#!/bin/sh\necho patched\n");
    assert.equal(fs.statSync(fp).mode & 0o777, 0o755, "同步写把 0755 吃掉了");
  });
  const asyncFp = write(path.join(dir("mode-async"), "dsh"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(asyncFp, 0o755);
  await core.atomicWriteFile(asyncFp, "#!/bin/sh\necho patched\n");
  check("#155/#157 异步原子写保留原文件权限", () => {
    assert.equal(fs.statSync(asyncFp).mode & 0o777, 0o755, "异步写把 0755 吃掉了");
  });
}

/* ------------------------------------------------- 3. 软链启动器（#157） */

function makeNodeLauncher() {
  const base = dir("shim", String(Math.random()).slice(2, 8));
  const pkgDir = dir("shim", path.basename(base), "lib", "node_modules", "@deepseek-ai", "dsh", "lib");
  const bin = write(
    path.join(pkgDir, "bin.js"),
    "#!/usr/bin/env node\nconst boot = require(\"@deepseek-ai/dsh-app-boot\");\nboot.main();\n",
  );
  dir("shim", path.basename(base), "lib", "node_modules", "@deepseek-ai", "dsh-app-boot");
  const binDir = dir("shim", path.basename(base), "bin");
  return { base, bin, binDir };
}

function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

await (async () => {
  const { bin, binDir } = makeNodeLauncher();
  const link = path.join(binDir, "dsh");
  if (!trySymlink(path.join("..", "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), link)) {
    skip("#157 软链启动器写穿目标、保住软链", "当前账户不能建符号链接");
  } else {
    const result = await core.patchShim(binDir);
    check("#157 软链启动器写穿目标、保住软链", () => {
      assert.equal(result.dsh, "patched", `patchShim 返回 ${JSON.stringify(result)}`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "软链被 rename 成了普通文件");
      assert.match(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "目标文件没被注入");
    });
    // 还原：备份跟着真实文件走，写回目标，软链仍在
    const reverted = await core.revertShim(binDir, { scrubDesktop: false });
    check("#157 revert 还原目标文件、软链仍在", () => {
      assert.match(String(reverted.dsh || ""), /^reverted/, `revertShim 返回 ${JSON.stringify(reverted)}`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), "revert 之后软链没了");
      assert.doesNotMatch(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "注入没被去掉");
    });
  }
})();

await (async () => {
  if (process.platform === "win32") {
    skip("#157 已被写成拷贝的启动器能还原软链", "还原软链只在 POSIX 生效（与上游一致）");
    return;
  }
  const { bin, binDir } = makeNodeLauncher();
  const link = path.join(binDir, "dsh");
  // 模拟老版本留下的现场：软链被替换成一个 bin.js 拷贝
  fs.copyFileSync(bin, link);
  const result = await core.patchShim(binDir);
  check("#157 已被写成拷贝的启动器能还原软链", () => {
    assert.equal(result.dsh, "patched_healed_symlink", `patchShim 返回 ${JSON.stringify(result)}`);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "没有还原成软链");
    assert.match(fs.readFileSync(bin, "utf8"), /dsh-purge shim/, "真实入口没被注入");
  });
})();

/* ------------------------------------------------- 4. #77 锚点容错（#188） */

const rewindPatch = core.ALL_PATCHES.find((p) => p.id === 77);
check("#188 #77 补丁存在且用正则锚点", () => {
  assert.ok(rewindPatch, "找不到 #77");
  assert.ok(rewindPatch.replacements[0].pattern instanceof RegExp, "#77 仍在写死整段字面量");
});

const RC2_SHAPE = [
  "\t\t\tappend(record) {",
  "\t\t\t\tconst event = record.event;",
  "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";",
  "\t\t\t\tif (this.revised.size > 0) this.revised.clear();",
  "\t\t\t\tthis.inputs.set(event.seq, record);",
  "\t\t\t}",
  "",
].join("\n");

const LEGACY_SHAPE = [
  "\t\t\tappend(record) {",
  "\t\t\t\tconst event = record.event;",
  "\t\t\t\tif (this.inputs.has(event.seq)) return \"none\";",
  "\t\t\t\tthis.revised.clear();",
  "\t\t\t\tthis.inputs.set(event.seq, record);",
  "\t\t\t}",
  "",
].join("\n");

for (const [label, shape, middle] of [
  ["rc.2 形状", RC2_SHAPE, /this\.revised\.size > 0\) this\.revised\.clear\(\);/],
  ["旧形状", LEGACY_SHAPE, /^\t\t\t\tthis\.revised\.clear\(\);$/m],
]) {
  check(`#188 #77 命中${label}`, () => {
    const once = core.applyReplacementsToText(shape, rewindPatch, "conversation-client.js");
    assert.ok(once.changed, "没有命中");
    assert.match(once.text, /isRewindMarker\(event\)/, "注入没写进去");
    assert.match(once.text, middle, "窗口里的官方代码被吃掉了");
    const twice = core.applyReplacementsToText(once.text, rewindPatch, "conversation-client.js");
    assert.equal(twice.changed, false, "二次 apply 又改了（会叠加注入）");
    assert.equal(
      (twice.text.match(/isRewindMarker\(event\)/g) || []).length,
      1,
      "注入被叠加了",
    );
  });
}

/* --------------------------------------------- 5. 卸载清 dsh.profile bundles */

check("#108 卸载清 pkg.dsh.profile.bundles/plugins", () => {
  const pkg = {
    dependencies: { "dsh-purge": "1.1.79", other: "1.0.0" },
    bundles: ["dsh-purge"],
    dsh: { profile: { bundles: ["dsh-purge@1.1.79", "other-bundle"], plugins: [{ id: "dsh-purge" }] } },
  };
  assert.equal(stripPluginFromPackage(pkg), true, "没有报告任何改动");
  assert.deepEqual(pkg.bundles, [], "顶层 bundles 没清");
  assert.deepEqual(pkg.dsh.profile.bundles, ["other-bundle"], "嵌套 bundles 没清干净或误删");
  assert.deepEqual(pkg.dsh.profile.plugins, [], "嵌套 plugins 没清");
  assert.equal(pkg.dependencies.other, "1.0.0", "误删了别人的依赖");
});

/* ------------------------------------------------ 6. zip 目录项（#170） */

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data || "", "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); // method 0 = stored
    local.writeUInt32LE(0, 14); // crc 不校验
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const body = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, centralBuf, eocd]);
}

check("#170 zip 目录项（含反斜杠）建目录而不是空文件", () => {
  const dest = path.join(root, "unzip");
  const zip = makeZip([
    { name: "dir\\", data: "" },
    { name: "dir\\a.txt", data: "hello" },
    { name: "slash/", data: "" },
    { name: "slash/b.txt", data: "world" },
  ]);
  extractZipBuffer(zip, dest);
  assert.ok(fs.statSync(path.join(dest, "dir")).isDirectory(), "反斜杠目录项被写成了文件");
  assert.equal(fs.readFileSync(path.join(dest, "dir", "a.txt"), "utf8"), "hello");
  assert.ok(fs.statSync(path.join(dest, "slash")).isDirectory(), "正斜杠目录项被写成了文件");
  assert.equal(fs.readFileSync(path.join(dest, "slash", "b.txt"), "utf8"), "world");
});

/* ------------------------------------------------- 7. 宿主版本门禁（#188） */

check("#188 宿主版本门禁认得适配与不适配", () => {
  const base = dir("host-ok", "@deepseek-ai");
  write(
    path.join(base, "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: doctor.HOST_TARGET }),
  );
  const okSupport = doctor.hostSupport(base);
  assert.ok(okSupport, "读不到宿主版本");
  assert.equal(okSupport.supported, true, `声明适配的版本被判成不适配：${JSON.stringify(okSupport)}`);

  const bad = dir("host-new", "@deepseek-ai");
  write(path.join(bad, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.9" }));
  const badSupport = doctor.hostSupport(bad);
  assert.equal(badSupport.supported, false, "更新的宿主没有被标成不适配");

  const none = dir("host-missing", "@deepseek-ai");
  assert.equal(doctor.hostSupport(none), null, "读不到版本却给了结论");
});

check("#188 插件自己不会被当宿主", () => {
  const base = dir("host-self", "@deepseek-ai");
  write(path.join(base, "dsh", "package.json"), JSON.stringify({ name: "dsh-purge", version: "1.1.81" }));
  assert.equal(doctor.readHostVersion(base), null);
});

/* ================================================================= A 类（1.1.87/1.1.88） */

/* A1：0 字节备份不许写回宿主 */
check("A1 0 字节 bak 不写回宿主（shim 回滚路径）", async () => {
  // revertAll 依赖真实宿主文件表；这里用同一段 restoreFromBak 逻辑的 shim 路径验证。
  const shimDir = dir("bak-zero", "bin");
  const shim = write(path.join(shimDir, "dsh"), "#!/bin/sh\necho patched // dsh-purge shim\n");
  fs.writeFileSync(shim + ".dshpurge.bak", "");
  const res = await core.revertShim(shimDir, { scrubDesktop: false });
  assert.match(String(res.dsh || ""), /skipped_empty/, `revertShim 返回 ${JSON.stringify(res)}`);
  assert.equal(fs.readFileSync(shim, "utf8").includes("patched"), true, "拿空备份把宿主文件覆盖了");
  assert.ok(fs.existsSync(shim + ".dshpurge.bak.bad"), "残骸没有被改名隔离");
});

/* A5：命中数契约 + 插入探针 */
check("A5 expect 命中数不符整条拒写", () => {
  const patch = {
    id: 999,
    replacements: [{ pattern: "needle();\n", replace: "replaced();\n", expect: 1 }],
  };
  const twice = "needle();\nneedle();\n";
  const one = "needle();\n";
  const bad = core.applyReplacementsToText(twice, patch, "x.js");
  assert.ok(bad.hitMismatch, "两处命中没有报契约不符");
  assert.equal(bad.hitMismatch.actual, 2);
  assert.equal(bad.text, twice, "契约不符仍然改了文件");
  const good = core.applyReplacementsToText(one, patch, "x.js");
  assert.ok(!good.hitMismatch, "命中 1 次却被判不符");
  assert.ok(good.changed && good.text.includes("replaced();"));
});

check("A5 insertProbe 已存在就跳过（不二次插入）", () => {
  const patch = {
    id: 998,
    replacements: [{
      pattern: "anchor();\n",
      replace: "anchor();\nthis.inserted = true;\n",
      insertProbe: "this.inserted",
    }],
  };
  const first = core.applyReplacementsToText("anchor();\n", patch, "x.js");
  assert.ok(first.changed, "第一次插入没生效");
  const second = core.applyReplacementsToText(first.text, patch, "x.js");
  assert.equal(second.changed, false, "第二次又插了一遍");
  assert.equal((second.text.match(/this\.inserted/g) || []).length, 1);
});

/* A2/A3：补丁清单 */
check("A2 #36 覆盖 bash/pwsh 且 marker 大小写都认", () => {
  const p = core.ALL_PATCHES.find((x) => x.id === 36);
  assert.deepEqual(p.file, ["tool-fs", "escalation", "tool-bash", "tool-pwsh"]);
  assert.equal(p.markersAny, true);
  assert.equal(p.replacements.length, 6, "rc.5 的两条 command 级替换没接上");
  assert.ok(p.markers.includes("Approval is auto-granted."));
});

check("A2 #53 覆盖 harness-dev-context 且带 rc.5 标记", () => {
  const p = core.ALL_PATCHES.find((x) => x.id === 53);
  assert.deepEqual(p.file, ["web-app-lib", "harness-dev-context"]);
  assert.ok(p.replacements.some((r) => r.insertProbe === "[dsh-purge] web surface prohibition cleared"));
  assert.ok(p.markers.includes("[dsh-purge] web surface prohibition cleared"));
});

check("A2 #32 覆盖 rc.5 的 prefix / URL 行", () => {
  const p = core.ALL_PATCHES.find((x) => x.id === 32);
  assert.deepEqual(p.file, ["web-app-lib", "harness-dev-context"]);
  const patterns = p.replacements.map((r) => (typeof r.pattern === "string" ? r.pattern : r.pattern.source));
  assert.ok(patterns.some((s) => s.startsWith('prefix: "You are interacting')), "rc.5 prefix 没接上");
  assert.ok(patterns.some((s) => s.includes("Current DeepSeek Harness Web GUI URL: ")), "rc.5 URL 行没接上");
  assert.ok(patterns.some((s) => s.includes("Advertised URL of the DeepSeek Harness Web GUI")), "rc.5 广告 URL 没接上");
  // rc.5 形状的活体样本：整段清掉，不留品牌词
  const sample = 'prefix: "You are interacting with the user through the DeepSeek Harness Web GUI at ",\n'
    + 'text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(x)}.`\n';
  const out = core.applyReplacementsToText(sample, p, "dsh-harness-dev-context/lib/index.js");
  assert.ok(out.changed, "rc.5 样本没命中");
  assert.equal((out.text.match(/DeepSeek Harness Web GUI/g) || []).length, 0, "仍有品牌词残留");
});

check("A3 #89/#90/#91 已就位", () => {
  for (const id of [89, 90, 91]) {
    const p = core.ALL_PATCHES.find((x) => x.id === id);
    assert.ok(p, `缺 #${id}`);
    assert.equal(p.optional, true, `#${id} 应当是 optional`);
    assert.ok(Array.isArray(p.markers) && p.markers.length > 0, `#${id} 没有 marker`);
  }
});

/* A7：路径校验走 realpath，软链逃逸被拦 */
check("A7 assertPathWithin 拦住指向根外的软链", () => {
  const outside = write(path.join(root, "outside", "secret.txt"), "secret\n");
  const insideDir = dir("path-guard", "run");
  const linkPath = path.join(insideDir, "escape.txt");
  let linked = false;
  try {
    fs.symlinkSync(outside, linkPath, "file");
    linked = true;
  } catch {
    /* 无权限建链接：跳过这条 */
  }
  if (!linked) {
    skip("A7 assertPathWithin 拦住指向根外的软链", "当前账户不能建符号链接");
    return;
  }
  assert.throws(
    () => validate.assertPathWithin(linkPath, [insideDir]),
    /path outside allowed roots/,
    "软链逃逸没被拦住",
  );
});

/* A7：报告回放去换行（头注入） */
check("A7 回放报文不把换行拼进头部/命令", () => {
  const req = replay.buildHttpRequest({
    url: "http://example.test/",
    method: "GET",
    headers: ["X-Test: evil\r\nX-Inj: 1"],
    cookie: "a=1\r\nX-Inj2: 2",
  });
  assert.ok(req, "报文没生成");
  assert.ok(!/\r\nX-Inj:/.test(req), "头部换行注入没被清洗");
  const curl = replay.buildCurlCommand({ url: "http://example.test/", cookie: "a=1\r\nid", data: "x\r\nid" });
  assert.ok(curl && !/\r\n/.test(curl), "curl 命令里残留换行");
});

/* A9/B4：桌面换包脚本的静态契约 */
check("A9 换包脚本先杀 Electron main 并按真实路径等待", () => {
  const src = fs.readFileSync(new URL("../lib/desktop.js", import.meta.url), "utf8");
  assert.match(src, /--type=/, "没有「先杀 Electron main」的判定");
  assert.ok(!/Get-Process -Name \$names/.test(src), "等待循环还在用 Get-Process -Name");
  assert.match(src, /move failed; relaunching original app/, "挪包失败没有重新拉起原版");
  assert.match(src, /killApp: Boolean\(exe\)/, "没定位到 exe 时仍然会杀进程");
});

/* A7：asar 解包越界 */
check("A7 asar 解包拒绝 destDir 之外的条目", () => {
  const src = fs.readFileSync(new URL("../lib/extract-asar.js", import.meta.url), "utf8");
  assert.match(src, /outPath !== destResolved && !outPath\.startsWith\(destResolved \+ path\.sep\)/);
  assert.match(src, /skipped \$\{skippedOutside\} entr/);
});

/* B1：宿主 dsh-tools 解析 */
check("B1 tools.js 增加了桌面端/自身依赖的解析路径", () => {
  const src = fs.readFileSync(new URL("../lib/redteam/tools.js", import.meta.url), "utf8");
  assert.match(src, /app\.asar\.unpacked/);
  assert.match(src, /process\.resourcesPath/);
  assert.match(src, /req\('@deepseek-ai\/dsh-tools'\)|req\("@deepseek-ai\/dsh-tools"\)/);
});

/* B2：尾部锚点 */
check("B2 锚点补在 sections 末尾，anchorMode=off 时不出现", () => {
  const assembled = {
    sections: [
      { name: "host:system", text: "host text", order: 0 },
      { name: "dsh-purge", text: "INJECT BODY", order: -100000, interpolate: false },
    ],
    contexts: [],
    tools: [],
  };
  const on = identity.rewritePromptAssembly(assembled, {
    fallbackInject: "INJECT BODY",
    anchorText: anchor.anchorTextFor({ anchorMode: "auto" }),
    context: null,
  });
  const names = on.sections.map((s) => s.name);
  assert.ok(names.includes(anchor.ANCHOR_SECTION), "锚点段没进 sections");
  assert.equal(names[names.length - 1], anchor.ANCHOR_SECTION, "锚点不在末尾（recency 位）");
  const off = identity.rewritePromptAssembly(assembled, {
    fallbackInject: "INJECT BODY",
    anchorText: anchor.anchorTextFor({ anchorMode: "off" }),
    context: null,
  });
  assert.ok(!off.sections.some((s) => s.name === anchor.ANCHOR_SECTION), "关掉了还在注入锚点");
});

check("B2 重复 apply 不会留下两份锚点", () => {
  const assembled = {
    sections: [
      { name: anchor.ANCHOR_SECTION, text: "old anchor", order: anchor.ANCHOR_ORDER },
      { name: "dsh-purge", text: "INJECT BODY", order: -100000, interpolate: false },
    ],
    contexts: [],
    tools: [],
  };
  const once = identity.rewritePromptAssembly(assembled, {
    fallbackInject: "INJECT BODY",
    anchorText: anchor.anchorTextFor({ anchorMode: "auto" }),
    context: null,
  });
  assert.equal(once.sections.filter((s) => s.name === anchor.ANCHOR_SECTION).length, 1, "锚点重复了");
});

/* B3：子代理审批接管 */
check("B3 subagentControl=false 不挂任何监听", () => {
  const offs = [];
  const ctx = { on: (...args) => { offs.push(args); return () => {}; } };
  control.installSubagentControl(ctx, { subagentControl: false });
  assert.equal(offs.length, 0, "关掉开关后仍然挂了监听");
});

check("B3 只给子会话补 ask 并放行一次", async () => {
  const handlers = new Map();
  const ctx = {
    on: (name, fn, opts) => {
      handlers.set(name, { fn, opts });
      return () => handlers.delete(name);
    },
  };
  const appended = [];
  const child = { header: { origin: "subagent" }, append: (type, data) => appended.push({ type, data }) };
  const main = { header: { origin: "main" }, append: (type, data) => appended.push({ type, data }) };
  control.installSubagentControl(ctx, { subagentControl: true });
  assert.ok(handlers.has("session/event") && handlers.has("approval/request"), "两个监听没挂上");
  const ev = handlers.get("session/event").fn;
  ev(child, { type: "approval/policy", data: { policy: "never" } });
  ev(main, { type: "approval/policy", data: { policy: "never" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(appended.length, 1, `补 ask 的次数不对：${JSON.stringify(appended)}`);
  assert.deepEqual(appended[0], { type: "approval/policy", data: { policy: "ask" } });
  const wf = handlers.get("approval/request").fn;
  assert.equal(wf({ agent: { session: child } }, () => "next"), "allowed-once");
  assert.equal(wf({ agent: { session: main } }, () => "next"), "next");
});

check("B3 子会话判定认三种 header 形状", () => {
  assert.equal(anchor.isSubagentContext({ session: { header: { origin: "subagent" } } }), true);
  assert.equal(anchor.isSubagentContext({ session: { header: { delegationDepth: 1 } } }), true);
  assert.equal(anchor.isSubagentContext({ session: { header: { parentSession: "x" } } }), true);
  assert.equal(anchor.isSubagentContext({ session: { header: { origin: "main" } } }), false);
  assert.equal(anchor.isSubagentContext(null), false);
});

/* A4：原子写 fsync 之后内容仍然完整（含 Buffer 分片写路径） */
check("A4 原子写 Buffer/文本都完整落盘", () => {
  const f1 = path.join(dir("atomic"), "buf.bin");
  const big = Buffer.alloc(300 * 1024, 7);
  core.atomicWriteSync(f1, big);
  assert.equal(fs.statSync(f1).size, big.length, "Buffer 没写全");
  const f2 = path.join(dir("atomic"), "text.txt");
  core.atomicWriteSync(f2, "中文内容 with ascii");
  assert.equal(fs.readFileSync(f2, "utf8"), "中文内容 with ascii");
});

/* 1.2.0 现场：宿主刚重启时一个文件被短暂占用，rename 撞 EPERM，整次更新被回滚。
   现在原子写对 EPERM/EBUSY/EACCES 做有界退避重试，reapply 对失败项再打一轮。 */
check("1.2.1 原子写对瞬时占用做退避重试", async () => {
  const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");
  assert.match(src, /function isTransientFsError/, "没有瞬时错误判定");
  assert.match(src, /function renameRetrySync/, "同步写没有重试");
  assert.match(src, /async function renameRetry\b/, "异步写没有重试");
  assert.equal((src.match(/renameRetry\(tmp, /g) || []).length, 2, "atomicWriteFile / atomicCopyFile 没接重试");
  assert.equal((src.match(/renameRetrySync\(tmp, /g) || []).length, 1, "atomicWriteSync 没接重试");

  // 真机复现：占住目标文件再写，看是否靠重试活下来（占不住就跳过）。
  const target = path.join(dir("atomic-lock"), "locked.yml");
  fs.writeFileSync(target, "original\n");
  let held = null;
  try {
    held = fs.openSync(target, "r+");
  } catch {
    held = null;
  }
  if (held === null) {
    skip("1.2.1 原子写对瞬时占用做退避重试（活体）", "当前账户无法占住文件");
    return;
  }
  // 200ms 后释放：重试窗口内应当成功
  setTimeout(() => { try { fs.closeSync(held); } catch { /* ignore */ } }, 120);
  await core.atomicWriteFile(target, "rewritten\n");
  assert.equal(fs.readFileSync(target, "utf8"), "rewritten\n", "重试没有写回内容");
});

check("1.2.1 reapply 对失败项再打一轮", () => {
  const src = fs.readFileSync(new URL("../lib/reapply.js", import.meta.url), "utf8");
  assert.match(src, /retried failed patches/, "没有失败项重试");
  assert.match(src, /const retryPatches = core\.ALL_PATCHES\.filter/, "重试没有按失败 id 过滤");
});

/* --------------------------------------------------------------- 收尾 */

console.log("");
console.log("────────────────────────────────────────");
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) console.log("失败项:\n  - " + failures.join("\n  - "));
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1);
