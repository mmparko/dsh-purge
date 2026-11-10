// Placeholders are filled by official-update.js. Quit the official client, run the downloaded installer, then reopen.
var exe = __EXE_JSON__;
var installer = __INSTALLER_JSON__;
var resources = __RESOURCES_JSON__;
var installDir = __INSTALL_DIR_JSON__;
if (installDir.length > 3) installDir = installDir.replace(/[\\\/]+$/, '');
var logPath = __LOG_JSON__;
var fso = new ActiveXObject('Scripting.FileSystemObject');
var sh = new ActiveXObject('WScript.Shell');
var wmi = GetObject('winmgmts:\\\\.\\root\\cimv2');
function z(n) { return (n < 10 ? '0' : '') + n; }
function stamp() { var d = new Date(); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()); }
function log(m) { var f = fso.OpenTextFile(logPath, 8, true); f.WriteLine(stamp() + ' ' + m); f.Close(); }
function samePath(a, b) { return String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase(); }
function underDir(fp, dir) {
  var a = String(fp || '').replace(/\//g, '\\').toLowerCase();
  var b = String(dir || '').replace(/\//g, '\\').toLowerCase();
  if (!a || !b) return false;
  if (a.charAt(a.length - 1) !== '\\') a = a + '\\';
  if (b.charAt(b.length - 1) !== '\\') b = b + '\\';
  return a.indexOf(b) === 0;
}
// Kill every process whose EXE lives under this install dir (DeepSeek Harness.exe, the bundled
// node runtime, crashpad, elevate, ...). A leftover handle anywhere in the tree makes the
// installer's MoveFileExW of the whole install dir fail with error 32.
function occupied() {
  var out = [];
  var e = new Enumerator(wmi.ExecQuery("SELECT ProcessId, Name, ExecutablePath FROM Win32_Process WHERE ExecutablePath IS NOT NULL"));
  for (; !e.atEnd(); e.moveNext()) {
    var p = e.item();
    if (samePath(p.ExecutablePath, exe) || underDir(p.ExecutablePath, installDir)) out.push({ pid: p.ProcessId, name: p.Name, path: p.ExecutablePath });
  }
  return out;
}
function killAll(items) {
  for (var i = 0; i < items.length; i++) {
    log('kill ' + items[i].pid + ' ' + items[i].name + ' ' + items[i].path);
    sh.Run('taskkill.exe /F /T /PID ' + items[i].pid, 0, true);
  }
}
function fileSize(fp) { if (!fso.FileExists(fp)) return -1; return fso.GetFile(fp).Size; }
function fileStamp(fp) { if (!fso.FileExists(fp)) return ''; return String(fso.GetFile(fp).DateLastModified); }
log('update-begin');
WScript.Sleep(800);
var list = occupied();
log('pids ' + list.length);
killAll(list);
var deadline = new Date().getTime() + 20000;
var left = list;
while (new Date().getTime() < deadline) { left = occupied(); if (left.length === 0) break; WScript.Sleep(300); }
log('left ' + left.length);
var asar = resources + '\\app.asar';
var bak = asar + '.bak';
var appDir = resources + '\\app';
// Older builds left resources\app\runtime as a junction to resources\runtime. Either the
// installer or FSO recursion then follows it and wipes the real runtime. rmdir removes the
// link itself and fails harmlessly on a real directory, so it is safe to always try.
if (fso.FolderExists(appDir)) {
  sh.Run('cmd.exe /d /c rmdir "' + appDir + '\\runtime" 2>nul', 0, true);
  log('dropped-legacy-runtime-link');
}
var movedApp = false;
var prev = '';
if (fso.FolderExists(appDir)) {
  prev = appDir + '.dshpurge-prev';
  if (fso.FolderExists(prev)) prev = appDir + '.dshpurge-prev-' + (new Date().getTime());
  for (var n = 0; n < 40; n++) {
    try { fso.MoveFolder(appDir, prev); movedApp = true; log('moved-app'); break; }
    catch (moveErr) { log('move-app ' + (moveErr && moveErr.message ? moveErr.message : moveErr)); WScript.Sleep(250); }
  }
}
var copiedAsar = false;
if (!fso.FileExists(asar) && fso.FileExists(bak)) {
  try { fso.CopyFile(bak, asar, true); copiedAsar = true; log('restored-asar'); }
  catch (restoreErr) { log('restore-asar ' + (restoreErr && restoreErr.message ? restoreErr.message : restoreErr)); }
}
if (left.length > 0) {
  // Still held by something: running the installer now only burns attempts and ends with
  // error 32 on the install dir. Keep the scene, log the holders, roll back.
  log('abort-busy ' + left.length + ' ' + left[0].name + ' ' + left[0].path);
  if (movedApp && prev && fso.FolderExists(prev)) {
    try { fso.MoveFolder(prev, appDir); log('restored-app busy'); } catch (busyErr) { log('restored-app busy ' + (busyErr && busyErr.message ? busyErr.message : busyErr)); }
  }
  try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (busyIgnore) {}
  sh.Run('"' + exe + '"', 1, false);
  log('started-old');
} else {
var exeBeforeSize = fileSize(exe);
var exeBeforeStamp = fileStamp(exe);
var asarBeforeSize = fileSize(asar);
function runInstaller(updated) {
  var args = updated ? ' --updated /S /D=' : ' /S /D=';
  return sh.Run('"' + installer + '"' + args + installDir, 0, true);
}
function resourcesPresent() {
  // Required resources for a usable install: the packed archive or the unpacked app dir.
  return fso.FileExists(asar) || fso.FolderExists(appDir);
}
// Success is installer exit code AND required resources present. Size/timestamp drift is
// logged for diagnosis only: a real installer can produce byte-identical output, and the
// old "size changed" heuristic then triggered a second install plus a bogus rollback.
function decide(code, exeChanged, asarChanged, resourcesOk) {
  log('decide exit=' + code + ' resources=' + resourcesOk + ' exeChanged=' + exeChanged + ' asarChanged=' + asarChanged);
  return code === 0 && resourcesOk;
}
var code = runInstaller(true);
log('installer ' + code);
var exeChanged = fileSize(exe) !== exeBeforeSize || fileStamp(exe) !== exeBeforeStamp;
var asarChanged = fileSize(asar) !== asarBeforeSize;
log('observed exe=' + exeChanged + ' asar=' + asarChanged);
var resourcesOk = resourcesPresent();
var ok = decide(code, exeChanged, asarChanged, resourcesOk);
if (!ok && code === 0 && !resourcesOk) {
  // Retry only when the installer reported success but the required resources are missing.
  // A non-zero exit code is a real failure: retrying would start a bogus second install.
  code = runInstaller(false);
  log('installer-plain ' + code);
  exeChanged = fileSize(exe) !== exeBeforeSize || fileStamp(exe) !== exeBeforeStamp;
  asarChanged = fileSize(asar) !== asarBeforeSize;
  resourcesOk = resourcesPresent();
  log('observed-plain exe=' + exeChanged + ' asar=' + asarChanged);
  ok = decide(code, exeChanged, asarChanged, resourcesOk);
}
if (!ok) {
  if (copiedAsar && fso.FileExists(asar)) {
    try { fso.DeleteFile(asar, true); log('rehid-asar'); } catch (hideErr) { log('rehid-asar ' + hideErr); }
  }
  // A concurrent unpack helper may have recreated resources\app. On failure we must NOT
  // fso.DeleteFolder it: FSO deletes through an app\runtime -> resources\runtime junction and
  // wipes the real runtime (that is how office/SKILL.md disappeared). Rename it into a unique
  // app.dshpurge-failed-<ts> quarantine instead and let the Node side clean that up with
  // fs.rmSync after validating the path; if the rename fails, keep the scene and log it.
  var isolated = '';
  if (movedApp) {
    if (fso.FolderExists(appDir)) {
      for (var k = 0; k < 20; k++) {
        var quarantine = appDir + '.dshpurge-failed-' + (new Date().getTime());
        try { fso.MoveFolder(appDir, quarantine); isolated = quarantine; log('isolated-app ' + quarantine); break; }
        catch (isoErr) { log('isolate-app ' + (isoErr && isoErr.message ? isoErr.message : isoErr)); WScript.Sleep(250); }
      }
      if (fso.FolderExists(appDir)) log('isolate-app-kept ' + appDir);
    }
    // Restore the pre-update app: prefer the canonical app.dshpurge-prev (that is the one
    // moved out before the installer ran), otherwise the directory this run moved aside.
    // Never restore the app a concurrent helper just rebuilt - it is the quarantined one.
    var originalPrev = appDir + '.dshpurge-prev';
    var restoreFrom = fso.FolderExists(originalPrev) ? originalPrev : prev;
    if (!fso.FolderExists(appDir) && restoreFrom && fso.FolderExists(restoreFrom)) {
      try { fso.MoveFolder(restoreFrom, appDir); log('restored-app ' + restoreFrom); }
      catch (backErr) { log('restored-app ' + (backErr && backErr.message ? backErr.message : backErr)); }
    } else if (fso.FolderExists(appDir)) {
      log('restore-app-skipped ' + appDir);
    }
  }
  log('decide-final rollback isolated=' + isolated);
  try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore) {}
  sh.Run('"' + exe + '"', 1, false);
  log('started-old');
} else {
  if (!movedApp && fso.FolderExists(appDir)) log('move-app-failed');
  try {
    var marker = fso.CreateTextFile(resources + '\\dsh-purge-reapply-asar', true);
    marker.WriteLine('1');
    marker.Close();
    log('marker');
  } catch (markerErr) { log('marker ' + markerErr); }
  try { sh.Environment('PROCESS').Remove('ELECTRON_RUN_AS_NODE'); } catch (ignore2) {}
  sh.Run('"' + exe + '"', 1, false);
  log('started');
}
}
