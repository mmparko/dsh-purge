window.__ModuleLoader__.load({ id: "dsh-purge", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef, Component } = react;

		const name = "dsh-purge";
		const inject = ["slots", "locale"];
		const NS = "settings.dsh-purge";
		let translate = (key) => key;
		function useT() {
			return translate;
		}
		function clientGuessSurface() {
			try {
				if (typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent || "")) return "desktop";
				if (typeof location !== "undefined") {
					const port = String(location.port || "");
					if (port === "43120") return "desktop";
					const host = String(location.hostname || "");
					if (host && host !== "127.0.0.1" && host !== "localhost" && /dsh desktop/i.test(String(location.href || ""))) return "desktop";
				}
			} catch { /* ignore */ }
			return "";
		}
		function hostSurfaceOf(s) {
			return (s && s.surface) || clientGuessSurface() || "web";
		}
		function hostText(t, key, surface) {
			if (surface && surface !== "web") {
				const specific = key + "." + surface;
				const hit = t(specific);
				if (hit && hit !== specific) return hit;
			}
			return t(key);
		}
		function apiUrl(p) {
			try { return new URL(p, window.location.origin).toString(); } catch { return p; }
		}
		function apiTimeoutMs(p, init) {
			const path = String(p || "");
			const method = String((init && init.method) || "GET").toUpperCase();
			if (path.indexOf("/dsh-purge/update") !== -1) return method === "POST" ? 180000 : 45000;
			if (path.indexOf("/dsh-purge/uninstall") !== -1) return 90000;
			if (path.indexOf("/dsh-purge/skill") !== -1) return method === "POST" ? 120000 : 20000;
			// status 会在"应用"期间被后端的同步落盘阻塞，默认 20s 必然被 abort，界面只会显示"读取失败: timeout"。
			if (path.indexOf("/dsh-purge/status") !== -1) return 60000;
			if (path.indexOf("/dsh-purge/apply") !== -1) return 240000;
			if (path.indexOf("/dsh-purge/revert") !== -1) return 120000;
			if (path.indexOf("/dsh-purge/restart") !== -1) return 60000;
			return 20000;
		}
		function isAbortError(e) {
			const msg = String((e && e.message) || e || "");
			return (e && e.name === "AbortError") || /aborted|abort/i.test(msg);
		}
		async function apiJson(p, init) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), apiTimeoutMs(p, init));
			try {
				const r = await fetch(apiUrl(p), Object.assign({ cache: "no-store", credentials: "same-origin", signal: ctrl.signal }, init || {}));
				const text = await r.text();
				let data;
				try { data = text ? JSON.parse(text) : null; } catch {
					throw new Error(r.status + " non-json: " + text.slice(0, 120));
				}
				if (!r.ok) throw new Error((data && (data.error || data.message)) || (r.status + " " + r.statusText));
				return data;
			} catch (e) {
				if (isAbortError(e)) throw new Error("timeout");
				const msg = String((e && e.message) || e || "");
				if (/failed to fetch|networkerror|load failed/i.test(msg)) {
					throw new Error("连不上接口，请确认 dsh 还在跑后 Ctrl+F5");
				}
				throw e;
			} finally { clearTimeout(timer); }
		}

		function promptBoxEmpty(text) {
			return !String(text || "").trim();
		}

		function responseNeedsPrompt(d) {
			return Boolean(d && (d.needPrompt || d.injectSource === "none"));
		}

		function warnNeedPrompt(d, tr) {
			if (!responseNeedsPrompt(d)) return false;
			window.alert(tr("need.prompt"));
			return true;
		}

		async function bothInjectEmpty(overrideText, defaultText) {
			if (!promptBoxEmpty(overrideText)) return false;
			if (!promptBoxEmpty(defaultText)) return false;
			return true;
		}

		function rulesApi(op, extra) {
			return apiJson("/dsh-purge/rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ op: op }, extra || {})),
			});
		}

		function skillsRouteMissing(e) {
			return /\b404\b|\b405\b|non-json/i.test(String((e && e.message) || e || ""));
		}

		function skillsApi(op, extra) {
			const init = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.assign({ op: op }, extra || {})),
			};
			return apiJson("/dsh-purge/skills", init).catch((e) => {
				if (!skillsRouteMissing(e)) throw e;
				return apiJson("/dsh-purge/skill", init);
			});
		}

		const TARGETS = ["AGENTS.md", "CLAUDE.md"];

		const zh = {
			nav: "规则设定",
			"dock.clean": "清洗",
			"dock.drill": "演练台",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "红队模式",
			"dock.full": "全面浏览",
			"dock.close": "收起",
			"dock.unauthorized": "未授权",
			"welcome.title": "用户须知",
			"welcome.lead": "首次安装本插件时请阅读以下说明。确认后本窗不再弹出。",
			"welcome.warn": "本插件免费开源。任何背着作者私自售卖、付费倒卖或借本项目盈利的行为，作者将依法追究法律责任。",
			"welcome.body": "dsh-purge 是 DeepSeek Harness 的本机网络安全红队评测与清洗插件：在受控本机环境中调整提示词与补丁、做授权范围内的演练台操作。项目免费、非营利，源码仓库：",
			"welcome.repo": "https://github.com/YuJunZhiXue/dsh-purge",
			"welcome.ban1": "禁止将本项目用于未授权的网络攻击、入侵、窃取数据、破坏系统或任何违法犯罪。",
			"welcome.ban2": "禁止商业售卖、付费倒卖、黑灰产牟利，以及隐瞒作者的营利性再分发。",
			"welcome.ban3": "使用者须自行遵守所在地法律法规与平台规范；违法后果由行为人自行承担，与作者无关。",
			"welcome.bans": "禁止事项",
			"welcome.check": "我已阅读并理解上述用户须知，同意合法合规使用。",
			"welcome.ok": "我已知晓并继续",
			"auth.title": "演练台授权确认",
			"auth.lead": "清洗不需要这一步。第一次进入演练台，或打开全面浏览，都要先完成本窗。",
			"auth.warn": "安全警告：演练台只用于你有权管理的本机、离线靶标，或已书面授权的演练环境。未经授权的渗透、攻击、窃取和破坏一律禁止。",
			"auth.hint.wait": "请阅读声明。{n} 秒后才能勾选。",
			"auth.hint.scroll": "倒计时已结束。请把声明滚到文末，再勾选。",
			"auth.hint.check": "倒计时已结束。请勾选全部三项。",
			"auth.check.read": "我已读完《安全与禁止违法声明》，并认可其中的全部条款。",
			"auth.check.scope": "我确认只用在本机已授权环境、离线靶标或合规演练中。",
			"auth.check.ban": "我确认禁止任何违法用途。未完成本授权，不得使用演练台。",
			"auth.no": "暂不进入",
			"auth.ok": "确认授权",
			"auth.ok.tab": "确认授权并进入演练台",
			"auth.ok.full": "确认授权并全面浏览",
			"auth.ok.env": "确认授权并打开环境适配",
			"envGate.title": "环境还没配好",
			"envGate.lead": "红队模式发送前需要本机工具。未检测到可用环境时，先去环境适配，或确认暂不配置。",
			"envGate.kaliHint": "检测到 Kali 时会直接用本机工具，不必填路径。没有 Kali 时，在环境适配里填写各工具路径，或选一个整包文件夹自动分配。",
			"envGate.skip": "暂不配置",
			"envGate.skipConfirm": "确认后这次可以继续对话。扫描和利用类技能仍会因为缺少工具而不可用，之后可以在 dsh-purge → 环境适配里补路径。",
			"envGate.skipNo": "返回",
			"envGate.skipYes": "确认暂不配置",
			"envGate.go": "去环境适配",
			"theme.aria": "外观",
			"theme.white": "白",
			"theme.ink": "墨",
			"purge.title": "补丁",
			"override.title": "提示词",
			"metric.purged": "已写入",
			"metric.activationPending": "等待完整重启后生效",
			"activation.pending": "补丁已写入解包目录，但当前 DSH 仍从 app.asar 启动。普通退出重开不会换走归档：点本页「重启」完成换包后才会生效。",
			"metric.lost": "补丁未生效，请重新应用",
			"metric.purged.skip": "已写入。跳过 {n} 项，本机没有这些文件",
			"metric.pendingShort": "待处理 {n}",
			"metric.unmatchedShort": "没对上 {n}",
			"metric.skipShort": "跳过 {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "本端不需要",
			"metric.bak.yes": "有备份",
			"metric.bak.no": "无备份",
			"metric.bak.hint": "备份",
			"table.patch": "项目",
			"table.status": "状态",
			"status.applied": "已应用",
			"status.off": "已关闭",
			"status.pending": "待应用",
			"status.unmatched": "没对上",
			"status.skipped": "跳过",
			"apply.hint": "点应用会打补丁并把当前默认提示词挂上，框里仍是插件旧默认时自动刷到加密槽，不必再点保存。只有你另写的稿才会按框落盘。待应用=原文还在。跳过=当前版本不需要或组件未安装。",
			"warn.noRoot": "未定位到当前宿主的 @deepseek-ai，清洗不会生效。请完全退出后再打开本宿主，在本页点「应用」。桌面端安装目录可以是任意盘符；目录名带 DeepseekHarness / DeepSeek Harness 均可。",
			"warn.noRoot.desktop": "官方客户端的代码在 app.asar 里。点「应用」会解开并自动重启，不用另跑脚本。若一直显示还没定位，先完全退出客户端再开，再点「应用」。第三方 DSH Desktop 直接点「应用」。",
			"unpack.restarting": "补丁已写入。点「重启」后客户端会自己重新打开。",
			"restart.fullQuit": "正在重启，客户端会自己重新打开。",
			"warn.noInject": "官方始终用默认提示词。红队开了规则集就只用规则集；没开时用去掉 CTF 的默认提示词，再接红队操作。两边都空会提示必须添加。",
			"need.prompt": "提示词和规则集都是空的，必须先添加提示词，或启用一条有内容的规则集。",
			"btn.restoreInject": "恢复默认",
			"saved.restoreInject": "已恢复默认提示词",
			"skip": "跳过",
			"unknown": "未知",
			"delete": "删除",
			"btn.apply": "应用",
			"btn.apply.busy": "处理中…",
			"btn.revert": "还原",
			"btn.uninstall": "卸载",
			"btn.uninstall.busy": "卸载中…",
			"uninstall.title": "卸载 dsh-purge",
			"uninstall.body": "是否卸载？卸载将还原回原版，并清除本插件的全部文件与补丁。",
			"uninstall.confirm": "确认卸载",
			"uninstall.cancel": "取消",
			"uninstall.applying": "正在卸载并还原…",
			"uninstall.done": "已卸载并还原，正在重启…",
			"uninstall.done.desktop": "已卸载并还原，正在重启桌面应用…",
			"uninstall.fail": "卸载失败: {error}",
			"btn.checkUpdate": "检测更新",
			"btn.checkUpdate.busy": "检测中…",
			"btn.doUpdate": "更新",
			"btn.doUpdate.busy": "更新中…",
			"channel.title": "通道",
			"channel.stable": "正式版",
			"channel.beta": "测试版",
			"channel.useStable": "切换到正式版",
			"channel.useBeta": "切换到测试版",
			"channel.local": "本机",
			"update.checking": "正在检测更新…",
			"update.applying": "正在更新…",
			"update.switching": "正在切换版本…",
			"update.latest": "已是最新（{version}）",
			"update.available": "有新版本 {remote}，当前 {local}",
			"update.pinned": "已固定在 {version}，通道最新是 {remote}",
			"operation.waiting": "正在处理，等待重启和生效验证…",
			"operation.verified": "已验证补丁生效",
			"operation.rolledBack": "更新失败，已自动恢复旧版；详情见操作日志",
			"update.done": "已更新到 {version}",
			"update.restarting": "已还原并写入新补丁，正在重启…",
			"update.fullQuit": "补丁已写入。点「重启」后客户端会自己重新打开。",
			"restart.official.title": "需要重启",
			"restart.official.body": "补丁已写入。点「重启」会先结束客户端、把 app.asar 挪走再自己打开；普通退出重开不会换走归档。",
			"update.switched": "已切换到 {version}",
			"update.autoDone": "已自动更新到 {version}",
			"update.reloading": "正在刷新设置页…",
			"update.dirty": "有新版本，本地有改动未自动覆盖",
			"update.fail": "更新失败: {error}",
			"update.timeout": "检测超时，请再点一次检测更新",
			"update.needRestart": "检测接口未加载，请先重启 dsh 再点检测更新",
			"update.noBeta": "还没有测试版",
			"update.switch": "切换到此版本",
			"update.pick": "选择版本",
			"update.tip": "最新",
			"update.current": "当前",
			"update.confirmSwitch": "切换到 {version}？之后可再切回另一通道或其它版本。存在本地修改时会停止更新。",
			"update.confirmChannel": "切换到{version}？会按该通道重新安装插件，存在本地修改时会停止更新。",
			"metric.version": "版本",
			"action.apply": "应用",
			"action.revert": "还原",
			"action.uninstall": "卸载",
			"ok.done": "已完成",
			"err.action": "失败: {error}",
			"err.status": "读取失败: {error}",
			"err.override": "读取失败: {error}",
			"err.rules": "读取失败: {error}",
			"err.read": "读取失败: {error}",
			"err.save": "保存失败: {error}",
			"btn.saveInject": "保存",
			"saved.override": "已保存",
			"rules.title": "规则集",
			"rules.none": "无",
			"rules.reset": "还原",
			"rules.reset.confirm": "还原全局指令文件？规则库会保留。",
			"rules.empty": "暂无规则",
			"rules.pick": "选择规则",
			"policy.title": "工作区策略",
			"policy.strict": "严格",
			"policy.fallback": "空位兜底",
			"policy.always": "总是允许",
			"policy.hint": "严格：永远剥 AGENTS.md / CLAUDE.md；空位兜底：提示词框为空时才用；总是允许：保留 DSH 原生行为",
			"cwd.title": "本地规则（当前目录）",
			"cwd.empty": "当前目录没有 AGENTS.md / CLAUDE.md",
			"cwd.rescan": "重新扫描",
			"cwd.hint": "只有提示词框为空时，被勾选的本地文件才作为兜底注入；提示词框一旦非空就不会用这些文件。",
			"cwd.scope.cwd": "当前目录",
			"cwd.scope.ancestor": "上级",
			"cwd.scope.root": "项目根",
			"cwd.no.workspace": "DSH 尚未选过工作目录，请先在 DSH 里开始一次任务再回来。",
			"pill.current": "当前",
			"btn.use": "启用",
			"btn.inUse": "当前",
			"confirm.delete": "删除 {id}？",
			"ph.id": "id",
			"ph.alias": "名称",
			"ph.alias.short": "名称",
			"btn.create": "新建",
			"need.id": "需要 id",
			"ph.content": "",
			"btn.saveRule": "保存",
			"skills.title": "Skill",
			"skills.hint": "导入到官方目录后，由 DSH 调用：聊天输入 /名称 立即加载；任务对上 description 或 whenToUse 时模型会调 skill 工具。正文写「激活」不会触发。",
			"skills.hint.desktop": "当前桌面宿主的官方 Skill 目录。聊天输入 /名称 立即加载；任务对上 description 时模型会调 skill 工具。",
			"skills.empty": "暂无用户 Skill",
			"btn.importZip": "导入压缩包",
			"btn.importFolder": "导入文件夹",
			"skills.importing": "正在导入…",
			"saved.import": "已导入 {count} 个 Skill",
			"need.import": "请选择压缩包或文件夹",
			"err.import.folder": "没读到文件夹里的文件，请直接选 Skill 目录（里面要有 SKILL.md）",
			"skills.pick": "选择 Skill",
			"skills.invalid": "官方会忽略：格式不对",
			"skills.call.slash": "聊天输入 {cmd}",
			"skills.call.model": "模型可调",
			"skills.call.modelOff": "模型不可调",
			"skills.call.userOff": "不可 /名称",
			"ph.skill.desc": "description（何时用）",
			"btn.saveSkill": "保存",
			"need.skill.id": "id 必须是 kebab-case，例如 code-review",
			"confirm.delete.skill": "从官方 $DSH_HOME/skills 删除 {id}？宿主会自动从目录拿掉。",
			"err.skills": "读取失败: {error}",
			"err.skills.needRestart": "Skill 接口未加载，请先重启当前宿主",
			"btn.restart": "重启",
			"btn.restart.busy": "重启中…",
			"restarting": "重启中…",
			"restarting.desktop": "正在重启桌面应用…",
			"restart.timeout": "超时，请刷新",
			"restart.fail": "失败: {error}",
			"restart.notStarted": "重启没有开始，客户端还在。不会自动再试。",
			"restart.already": "这一次重启已经开始，不会再重启一次。",
			"restart.confirm": "清洗已完成，重启后生效。",
			"restart.confirm.desktop": "清洗已完成，重启桌面应用后生效。",
			"restart.ask.title": "要现在重启吗",
			"restart.ask.body": "已经写入。重启后才会在当前客户端里生效。",
			"restart.now": "现在重启",
			"restart.notNow": "稍后",
			"restart.asarSwap": "补丁已写入磁盘。正在结束桌面进程并挪开 app.asar，完成后会自动重新打开；若仍无效，请先完全退出 Harness（托盘也关），再点一次应用。",
			"surface.web": "Web",
			"surface.desktop": "桌面端",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "提示词已写入。{detail}",
			"restart.incomplete.patches": "还有 {failed} 项代码补丁没对上当前版本（#{ids}），不影响这段提示词",
			"restart.incomplete.flash": "CMD 无感未钉入（{entry}）",
			"restart.later": "以后",
			"group.prompt": "提示词",
			"group.code": "代码",
			"group.engine": "引擎",
			"group.tools": "工具",
			"group.compat": "0.1.5 兼容",
			"group.dsh20": "0.2.0",
			"patch.1": "全局免责 → 强指令",
			"patch.2": "替换式免责 → 强指令",
			"patch.3": "作用域免责 → 强指令",
			"patch.4": "persona 会话强指令",
			"patch.5": "审批提示句 → 全权限",
			"patch.6": "沙箱 deny → allow 写",
			"patch.7": "沙箱默认全权限",
			"patch.8": "审批默认 never",
			"patch.9": "审批门自动放行",
			"patch.10": "审批配置默认 never",
			"patch.11": "never 提示句 → 自动放行",
			"patch.12": "ask 提示句 → 自动放行",
			"patch.13": "豁免升级阶梯",
			"patch.14": "升级无条件授信",
			"patch.15": "沙箱 confine 直通",
			"patch.16": "文件系统围栏取消",
			"patch.17": "观察策略读写放行",
			"patch.18": "重复调用守卫禁用",
			"patch.19": "工具结果修剪禁用",
			"patch.21": "恢复插件延长的 bash 等待",
			"patch.22": "read 上限放宽",
			"patch.23": "子代理深度 3 → 10",
			"patch.24": "preset fetch 启用",
			"patch.25": "去掉官方默认身份（功能提示词不动）",
			"patch.26": "minimal：去掉默认身份并打开 inject",
			"patch.28": "dsh-liangshen（梁神）：phase-1 保留 dsh-purge / dshpg 段",
			"patch.70": "极简模式终端不再禁止网络",
			"patch.71": "梁神去掉官方身份句",
			"patch.29": "dsh-tool-web：外部 untrusted 拦截→可执行",
			"patch.30": "dsh-hooks-claude-code：deny→allow",
			"patch.31": "dsh-hooks-codex：deny→allow",
			"patch.32": "Web 表面身份中性化",
			"patch.33": "Shell 拒绝提示 → 可执行",
			"patch.34": "沙箱提示中性化",
			"patch.35": "升级 never 不拒",
			"patch.36": "文件系统升级 schema 放行",
			"patch.37": "子代理 scope lock 中性化",
			"patch.38": "persona text→prefix（0.1.2 预设）",
			"patch.39": "会话 v0 plugin summary（mnemon）",
			"patch.40": "complete 预设仍保留注入",
			"patch.42": "设置页旧接口",
			"patch.43": "网页预设去掉默认身份",
			"patch.45": "官方桌面更新交接",
			"patch.46": "官方更新脚本只用英文",
			"patch.47": "OAuth 不再插入 Claude 身份",
			"patch.48": "shell 去掉删除前的额外确认",
			"patch.49": "OAuth 不再伪装 claude-cli",
			"patch.50": "跨会话引用不再标不可信",
			"patch.51": "新会话保持完全权限",
			"patch.52": "会话日志默认不上传",
			"patch.53": "网页提示去掉禁止另开服务器",
			"patch.54": "交付物提示去掉多余禁止",
			"patch.55": "每一步替换第一条系统提示",
			"patch.56": "回退只藏被撤掉的那一轮",
			"patch.57": "developer role 仅限 openai/azure，第三方代理回退 system",
			"patch.58": "回退空标记不进模型请求",
			"patch.59": "官方 Auto Review 不再拦工具",
			"patch.60": "官方 run_code 去掉审批教学",
			"patch.61": "官方沙箱策略不再教拒绝",
			"patch.62": "无审批通道时放行（用户拒绝仍有效）",
			"patch.63": "计划模式不再软拦执行",
			"patch.64": "Stop hook 不再注入假用户话",
			"patch.65": "UserPromptSubmit deny 不再整轮 reject",
			"patch.66": "空的系统段不再把这一轮打成内部错误",
			"patch.67": "缺 messages 时这一轮不中断",
			"patch.68": "回退后缺 content 不中断",
			"patch.69": "deepseek-flash 保持官方 in-history",
			"patch.72": "Messages 的 system 用当前系统提示",
			"patch.73": "极简 bash 去掉误留的镜像说明",
			"patch.74": "首发前先挂默认提示词",
			"patch.75": "回退把已完成任务收回成未开始",
			"patch.76": "unrestricted 预设去掉身份句",
			"patch.77": "回退标记到达时丢弃已发送消息",
			"patch.78": "补丁文件缺失时从 .bak 恢复",
			"patch.80": "恢复官方极简工具表",
			"patch.82": "主进程兜底 DSH_PROFILE=desktop",
			"patch.83": "host 信号杀时不报错不弹对话框",
			"patch.84": "host code=0 正常退出不报错 (消除 stopped 对话框)",
			"status.unlocated": "未定位",
			"status.na": "本端不需要",
			"metric.unlocated": "还没定位到本机 Harness",
			"metric.sealed": "已找到官方客户端，点应用解开",
			"metric.sealed.count": "待解开",
			"metric.lost": "补丁已丢失，请重新应用",
			"metric.lost.count": "已丢失",
			"rewind.label": "回退",
			"rewind.aria": "回退",
			"rewind.busy": "回退中…",
			"rewind.empty": "没有可回退的上一句",
			"rewind.fail": "回退失败: {error}",
			"rewind.once": "回退上一步",
			"rewind.once.hint": "撤回最后一步已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"rewind.round": "回退上一轮",
			"rewind.round.hint": "撤回上一整轮（含子代理）已进行的对话，新会话接上之前的上下文；那句回到输入框再发送",
			"hooksDeny.title": "Hooks 拦截",
			"hooksDeny.bypass": "放行 hooks 的 deny / ask（补丁 30 / 31 / 64 / 65）",
			"hooksDeny.hint": "关掉后，用户自己的 PreToolUse / UserPromptSubmit / Stop hook 的 deny 会按官方逻辑生效。官方 ask 分支本身是空操作，关开关不会弹出审批框。改完后点「应用」并重启才写进宿主。",
			"saved.hooksDeny": "已保存",
			"continue.title": "失败重试 / 继续",
			"continue.hint": "请求失败会自动重试；异常停止或中断可点「继续」或自动续跑。自己点停止不会自动继续。次数用完后需新开一轮。",
			"continue.autoRetry": "失败自动重试",
			"continue.retryMax": "重试次数",
			"continue.autoContinue": "中断后自动继续",
			"continue.continueMax": "继续次数",
			"continue.text": "继续用语",
			"saved.continue": "已保存",
			"continue.label": "继续",
			"continue.aria": "异常停止后继续",
			"continue.busy": "继续中…",
			"continue.ready": "继续（还可 {left} 次）",
			"continue.limit": "已达继续上限",
			"continue.fail": "继续失败: {error}",
		};

		const en = {
			nav: "Rules",
			"dock.clean": "Clean",
			"dock.drill": "Drill",
			"dock.toggle": "dsh-purge",
			"dock.newSession": "dsh-purge",
			"dock.inSession": "dsh-purge",
			"dock.redteam": "Red team",
			"dock.full": "Full view",
			"dock.close": "Collapse",
			"dock.unauthorized": "Unauthorized",
			"welcome.title": "User notice",
			"welcome.lead": "Please read this on first install. After you confirm, it will not appear again.",
			"welcome.warn": "This plugin is free and open source. Anyone who sells, resells, or profits from it behind the author's back may face legal action.",
			"welcome.body": "dsh-purge is a local DeepSeek Harness plugin for security evaluation and cleaning: adjust prompts and patches on a machine you control, and use the drill console only within authorized scope. It is free and non-profit. Repository:",
			"welcome.repo": "https://github.com/YuJunZhiXue/dsh-purge",
			"welcome.ban1": "Do not use this project for unauthorized attacks, intrusion, data theft, sabotage, or any illegal activity.",
			"welcome.ban2": "Do not commercially sell, resell, or profit from gray-market use, or redistribute for profit without the author.",
			"welcome.ban3": "You must follow local law and platform rules; illegal use is solely your responsibility.",
			"welcome.bans": "Prohibitions",
			"welcome.check": "I have read and understand this notice and will use the plugin lawfully.",
			"welcome.ok": "I understand — continue",
			"auth.title": "Drill console authorization",
			"auth.lead": "Cleaning does not need this step. Opening Drill or Full view the first time requires this dialog.",
			"auth.warn": "Warning: the drill console is only for hosts you manage, offline targets, or written authorized exercises. Unauthorized intrusion, attack, theft, or sabotage is forbidden.",
			"auth.hint.wait": "Read the notice. You can check the boxes in {n}s.",
			"auth.hint.scroll": "Countdown finished. Scroll to the end, then check the boxes.",
			"auth.hint.check": "Countdown finished. Check all three boxes.",
			"auth.check.read": "I have read the Safety and Anti-Abuse Notice and accept every clause.",
			"auth.check.scope": "I will only use authorized local hosts, offline targets, or compliant exercises.",
			"auth.check.ban": "I will not use this for any illegal purpose. Without this authorization the drill console stays closed.",
			"auth.no": "Not now",
			"auth.ok": "Authorize",
			"auth.ok.tab": "Authorize and open Drill",
			"auth.ok.full": "Authorize and open Full view",
			"auth.ok.env": "Authorize and open Env adapt",
			"envGate.title": "Environment is not ready",
			"envGate.lead": "Red team mode needs local tools before you send. If none are available, open Env adapt or confirm you will continue without them.",
			"envGate.kaliHint": "When Kali is detected, local tools are used directly and paths are optional. Otherwise set each tool path in Env adapt, or pick one toolkit folder to assign them.",
			"envGate.skip": "Skip for now",
			"envGate.skipConfirm": "You can keep chatting after this. Scan and exploit skills stay unavailable until the tools are installed. You can add paths later under dsh-purge → Env adapt.",
			"envGate.skipNo": "Back",
			"envGate.skipYes": "Continue without tools",
			"envGate.go": "Open Env adapt",
			"theme.aria": "Appearance",
			"theme.white": "Light",
			"theme.ink": "Ink",
			"purge.title": "Patches",
			"override.title": "Prompt",
			"metric.purged": "Written",
			"metric.activationPending": "Full restart required to activate",
			"activation.pending": "Patches are written to the extracted directory, but DSH still starts from app.asar. A plain quit-and-reopen does not move the archive: use Restart here to finish the swap.",
			"metric.lost": "Patches are inactive; apply them again",
			"metric.purged.skip": "Written. Skipped {n}; those files are not on this install",
			"metric.pendingShort": "Pending {n}",
			"metric.unmatchedShort": "No match {n}",
			"metric.skipShort": "Skipped {n}",
			"metric.unlocated.count": "—",
			"metric.shim": "shim",
			"metric.shim.na": "Not needed here",
			"metric.bak.yes": "Backup",
			"metric.bak.no": "No backup",
			"metric.bak.hint": "Backup",
			"table.patch": "Item",
			"table.status": "Status",
			"status.applied": "Applied",
			"status.off": "Off",
			"status.pending": "Pending",
			"status.unmatched": "No match",
			"status.skipped": "Skipped",
			"apply.hint": "Apply writes patches and hangs the current default prompt. A stale plugin default in the box is refreshed from the sealed slot; a separate save is unnecessary. Only a prompt you wrote yourself is kept from the box. Pending = original text still present. Skipped = not needed for this version or the component is not installed.",
			"warn.noRoot": "Could not find this host’s @deepseek-ai tree, so Apply will not patch anything. Fully quit and reopen this host, then Apply here. Desktop may live on any drive; folder names like DeepseekHarnessDesktop or DeepSeek Harness are fine.",
			"warn.noRoot.desktop": "Official Harness keeps its code in app.asar. Apply unpacks it and restarts the app. If this page stays “not found”, fully quit the client, reopen it, then Apply again. Third-party DSH Desktop: just Apply.",
			"unpack.restarting": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.fullQuit": "Restarting. The client will open again by itself.",
			"warn.noInject": "Official mode always uses the default prompt. Red team uses only the active rule set; otherwise it uses the default prompt without the CTF section, then the red team steps. If both are empty you will be asked to add a prompt.",
			"need.prompt": "Both the prompt and the rule set are empty. Add a prompt, or enable a rule that has content.",
			"btn.restoreInject": "Reset default",
			"saved.restoreInject": "Default prompt restored",
			"skip": "Skipped",
			"unknown": "Unknown",
			"delete": "Delete",
			"btn.apply": "Apply",
			"btn.apply.busy": "Working…",
			"btn.revert": "Restore",
			"btn.uninstall": "Uninstall",
			"btn.uninstall.busy": "Uninstalling…",
			"uninstall.title": "Uninstall dsh-purge",
			"uninstall.body": "Uninstall? This restores the original Harness and removes this plugin completely.",
			"uninstall.confirm": "Uninstall",
			"uninstall.cancel": "Cancel",
			"uninstall.applying": "Uninstalling and restoring…",
			"uninstall.done": "Uninstalled and restored. Restarting…",
			"uninstall.done.desktop": "Uninstalled and restored. Restarting the desktop app…",
			"uninstall.fail": "Uninstall failed: {error}",
			"btn.checkUpdate": "Check update",
			"btn.checkUpdate.busy": "Checking…",
			"btn.doUpdate": "Update",
			"btn.doUpdate.busy": "Updating…",
			"channel.title": "Channel",
			"channel.stable": "Stable",
			"channel.beta": "Beta",
			"channel.useStable": "Switch to stable",
			"channel.useBeta": "Switch to beta",
			"channel.local": "This copy",
			"update.checking": "Checking for updates…",
			"update.applying": "Updating…",
			"update.switching": "Switching version…",
			"update.latest": "Up to date ({version})",
			"update.available": "Update {remote} available (now {local})",
			"update.pinned": "Pinned at {version}; channel latest is {remote}",
			"operation.waiting": "Waiting for restart and activation verification...",
			"operation.verified": "Patch activation verified",
			"operation.rolledBack": "Update failed; the previous version was restored. See the operation log.",
			"update.done": "Updated to {version}.",
			"update.restarting": "Restored the old patches, wrote the new ones, and restarting…",
			"update.fullQuit": "Patches are written. Click Restart and the client opens again by itself.",
			"restart.official.title": "Restart required",
			"restart.official.body": "Patches are written. Restart ends this client, moves app.asar aside, then reopens it; a plain quit-and-reopen does not move the archive.",
			"update.switched": "Switched to {version}.",
			"update.autoDone": "Auto-updated to {version}.",
			"update.reloading": "Refreshing settings…",
			"update.dirty": "Update available; local edits were not overwritten.",
			"update.fail": "Update failed: {error}",
			"update.timeout": "Check timed out. Click Check update again.",
			"update.needRestart": "Update API is not loaded. Restart dsh, then check again.",
			"update.noBeta": "No beta build yet",
			"update.switch": "Switch to this version",
			"update.pick": "Select version",
			"update.tip": "latest",
			"update.current": "current",
			"update.confirmSwitch": "Switch to {version}? You can switch back later. Local edits stop the update.",
			"update.confirmChannel": "Switch to {version}? The plugin will be reinstalled from that channel. Local edits stop the update.",
			"metric.version": "Version",
			"action.apply": "Apply",
			"action.revert": "Restore",
			"action.uninstall": "Uninstall",
			"ok.done": "Done",
			"err.action": "Failed: {error}",
			"err.status": "Read failed: {error}",
			"err.override": "Read failed: {error}",
			"err.rules": "Read failed: {error}",
			"err.read": "Read failed: {error}",
			"err.save": "Save failed: {error}",
			"btn.saveInject": "Save",
			"saved.override": "Saved",
			"rules.title": "Rule sets",
			"rules.none": "None",
			"rules.reset": "Restore",
			"rules.reset.confirm": "Restore global instruction files? The rule library is kept.",
			"rules.empty": "No rules",
			"rules.pick": "Select a rule",
			"policy.title": "Workspace policy",
			"policy.strict": "Strict",
			"policy.fallback": "Fallback",
			"policy.always": "Always on",
			"policy.hint": "Strict: always strip AGENTS.md / CLAUDE.md. Fallback: use workspace files only when the prompt box is empty. Always on: keep DSH default behavior.",
			"cwd.title": "Local rules (current folder)",
			"cwd.empty": "No AGENTS.md / CLAUDE.md in this folder",
			"cwd.rescan": "Rescan",
			"cwd.hint": "Checked files are injected only when the prompt box is empty. A non-empty prompt box always wins.",
			"cwd.scope.cwd": "cwd",
			"cwd.scope.ancestor": "ancestor",
			"cwd.scope.root": "project root",
			"cwd.no.workspace": "DSH has not opened a workspace yet. Start a task in DSH first, then come back.",
			"pill.current": "On",
			"btn.use": "Enable",
			"btn.inUse": "On",
			"confirm.delete": "Delete {id}?",
			"ph.id": "id",
			"ph.alias": "Name",
			"ph.alias.short": "Name",
			"btn.create": "New",
			"need.id": "id required",
			"ph.content": "",
			"btn.saveRule": "Save",
			"skills.title": "Skills",
			"skills.hint": "After import, DSH calls it: type /name in chat to load now; the model calls the skill tool when the task matches description or whenToUse. Writing「激活」in the body does nothing.",
			"skills.hint.desktop": "This desktop host’s official skill catalog. Type /name in chat to load; the model calls the skill tool when the task matches the description.",
			"skills.empty": "No user skills",
			"btn.importZip": "Import zip",
			"btn.importFolder": "Import folder",
			"skills.importing": "Importing…",
			"saved.import": "Imported {count} skill(s)",
			"need.import": "Choose a zip or folder",
			"err.import.folder": "No files were read. Select the skill folder itself (it must contain SKILL.md).",
			"skills.pick": "Select a skill",
			"skills.invalid": "Official catalog will ignore this: invalid format",
			"skills.call.slash": "Type {cmd} in chat",
			"skills.call.model": "Model can load",
			"skills.call.modelOff": "Hidden from model",
			"skills.call.userOff": "/name disabled",
			"ph.skill.desc": "description (when to use)",
			"btn.saveSkill": "Save",
			"need.skill.id": "id must be kebab-case, e.g. code-review",
			"confirm.delete.skill": "Delete {id} from official $DSH_HOME/skills? The host will drop it from the catalog.",
			"err.skills": "Read failed: {error}",
			"err.skills.needRestart": "Skill API is not loaded. Restart this host first.",
			"btn.restart": "Restart",
			"btn.restart.busy": "Restarting…",
			"restarting": "Restarting…",
			"restarting.desktop": "Restarting the desktop app…",
			"restart.timeout": "Timed out; refresh",
			"restart.fail": "Failed: {error}",
			"restart.notStarted": "Restart did not start. This client is still open, and it will not try again by itself.",
			"restart.already": "This restart already started. It will not restart again.",
			"restart.confirm": "Apply finished. Restart to take effect.",
			"restart.confirm.desktop": "Apply finished. Restart the desktop app to take effect.",
			"restart.ask.title": "Restart now?",
			"restart.ask.body": "It is written. It takes effect in this client after a restart.",
			"restart.now": "Restart now",
			"restart.notNow": "Later",
			"restart.asarSwap": "Patches are on disk. Quitting the desktop app and moving app.asar aside; it will reopen when done. If behavior is unchanged, fully quit Harness (including tray) and Apply again.",
			"surface.web": "Web",
			"surface.desktop": "Desktop",
			"surface.gui": "GUI",
			"surface.tui": "TUI",
			"restart.incomplete": "The prompt is in. {detail}",
			"restart.incomplete.patches": "{failed} code patch(es) did not match this host (#{ids}). The prompt is unaffected",
			"restart.incomplete.flash": "CMD silence not pinned ({entry})",
			"restart.later": "Later",
			"group.prompt": "Prompt",
			"group.code": "Code",
			"group.engine": "Engine",
			"group.tools": "Tools",
			"group.compat": "0.1.5 compat",
			"group.dsh20": "0.2.0",
			"patch.1": "Global disclaimer → mandate",
			"patch.2": "Replacement disclaimer → mandate",
			"patch.3": "Scope disclaimer → mandate",
			"patch.4": "Persona session mandate",
			"patch.5": "Approval copy → full access",
			"patch.6": "Sandbox deny → allow write",
			"patch.7": "Sandbox default full access",
			"patch.8": "Approval default never",
			"patch.9": "Approval gate auto-grant",
			"patch.10": "Approval config default never",
			"patch.11": "never copy → auto-grant",
			"patch.12": "ask copy → auto-grant",
			"patch.13": "Escalation ladder exempt",
			"patch.14": "Escalation unconditional grant",
			"patch.15": "Sandbox confine passthrough",
			"patch.16": "Filesystem fence off",
			"patch.17": "Observation policy allow R/W",
			"patch.18": "Repeat-call guard off",
			"patch.19": "Tool-result pruner off",
			"patch.21": "Restore plugin-raised bash wait",
			"patch.22": "read cap raised",
			"patch.23": "subagent depth 3 → 10",
			"patch.24": "preset fetch on",
			"patch.25": "Strip official default identity (keep feature prompts)",
			"patch.26": "minimal: strip identity, open inject",
			"patch.28": "dsh-liangshen: keep dsh-purge / dshpg in phase-1",
			"patch.70": "Minimal shell drops the no-network line",
			"patch.71": "Liangshen drops the stock identity line",
			"patch.29": "dsh-tool-web: untrusted framing → usable data",
			"patch.30": "dsh-hooks-claude-code: deny→allow",
			"patch.31": "dsh-hooks-codex: deny→allow",
			"patch.32": "Web surface identity neutral",
			"patch.33": "Shell denial prompt → executable",
			"patch.34": "Sandbox hint neutralized",
			"patch.35": "Escalation never-reject",
			"patch.36": "FS escalation schema opened",
			"patch.37": "Subagent scope lock neutralized",
			"patch.38": "persona text→prefix (0.1.2 presets)",
			"patch.39": "session v0 plugin summary (mnemon)",
			"patch.40": "Keep inject when a complete prompt is set",
			"patch.42": "Settings legacy API",
			"patch.43": "Strip identity from web presets",
			"patch.45": "Official desktop update handoff",
			"patch.46": "Official update script stays ASCII",
			"patch.47": "OAuth no longer inserts Claude identity",
			"patch.48": "Shell drops extra delete caution",
			"patch.49": "OAuth no longer mimics claude-cli",
			"patch.50": "Session references are not marked untrusted",
			"patch.51": "Fresh session stays on full access",
			"patch.52": "Session log upload off by default",
			"patch.53": "Web prompt drops do-not-start",
			"patch.54": "Deliverable prompt drops extra prohibition",
			"patch.55": "Replace the first system prompt every step",
			"patch.56": "Rewind hides only the cut range",
			"patch.57": "developer role for openai/azure only, third-party gateways use system",
			"patch.58": "Rewind markers stay off the model request",
			"patch.59": "Official Auto Review no longer denies tools",
			"patch.60": "Official run_code drops approval teaching",
			"patch.61": "Official sandbox policy no longer teaches refusal",
			"patch.62": "Fail-open without approval channel (user reject kept)",
			"patch.63": "Plan mode no longer soft-blocks execution",
			"patch.64": "Stop hook no longer steers fake user text",
			"patch.65": "UserPromptSubmit deny no longer rejects turn",
			"patch.66": "Empty system section no longer ends the turn as an internal error",
			"patch.67": "A missing messages list no longer ends the turn",
			"patch.68": "Missing content after rewind no longer ends the turn",
			"patch.69": "deepseek-flash keeps the official in-history flag",
			"patch.72": "Messages system field uses the current system prompt",
			"patch.73": "Minimal preset drops stray mirror sentence",
			"patch.74": "Hang default prompt before first assemble",
			"patch.75": "Rewind resets completed todos to pending",
			"patch.76": "Unrestricted preset: strip identity sentence",
			"patch.77": "Rewind marker drops already-sent messages",
			"patch.78": "Restore missing overlay from .bak backup",
			"patch.80": "Restore official minimal tool plugins",
			"patch.82": "Fallback DSH_PROFILE=desktop in main process",
			"patch.83": "Don't fail on signal kill (no crash dialog)",
			"patch.84": "Don't fail on code=0 clean exit (no stopped dialog)",
			"status.na": "Not for this host",
			"metric.sealed": "Official client found. Apply to unpack",
			"metric.sealed.count": "Sealed",
			"metric.lost": "Patches lost — Apply again",
			"metric.lost.count": "Lost",
			"status.unlocated": "Not located",
			"metric.unlocated": "This install was not found yet",
			"rewind.label": "Undo",
			"rewind.aria": "Undo",
			"rewind.busy": "Undoing…",
			"rewind.empty": "Nothing to undo",
			"rewind.fail": "Undo failed: {error}",
			"rewind.once": "Undo last step",
			"rewind.once.hint": "Withdraw the last step into a new session that keeps earlier context; the line returns to the box",
			"rewind.round": "Undo last turn",
			"rewind.round.hint": "Withdraw the last turn (and its subagents) into a new session that keeps earlier context; the line returns to the box",
			"hooksDeny.title": "Hook interception",
			"hooksDeny.bypass": "Bypass hook deny / ask (patches 30 / 31 / 64 / 65)",
			"hooksDeny.hint": "When off, your own PreToolUse / UserPromptSubmit / Stop hook deny runs as the official host wrote it. The official ask branch is a no-op; turning this off will not show an approval dialog. Click Apply and restart to write the host files.",
			"saved.hooksDeny": "Saved",
			"continue.title": "Retry / Continue",
			"continue.hint": "Failed requests auto-retry. After an abnormal stop or interrupt, use Continue or auto-resume. A manual stop never auto-continues. Counts reset after a completed turn.",
			"continue.autoRetry": "Auto-retry on failure",
			"continue.retryMax": "Retry count",
			"continue.autoContinue": "Auto-continue after interrupt",
			"continue.continueMax": "Continue count",
			"continue.text": "Continue text",
			"saved.continue": "Saved",
			"continue.label": "Continue",
			"continue.aria": "Continue after an abnormal stop",
			"continue.busy": "Continuing…",
			"continue.ready": "Continue ({left} left)",
			"continue.limit": "Continue limit reached",
			"continue.fail": "Continue failed: {error}",
		};

		const PURGE_CSS = `
.dshp-root{--dshp-display:"Songti SC","Noto Serif SC","Iowan Old Style",Palatino,"Palatino Linotype",Georgia,serif;--dshp-sans:"Yu Gothic UI","Hiragino Sans GB","Source Han Sans SC",system-ui,sans-serif;--dshp-mono:"Cascadia Mono","Sarasa Mono SC",ui-monospace,monospace;--dshp-ease:cubic-bezier(.16,1,.3,1);max-width:920px;display:flex;flex-direction:column;gap:18px;padding:16px;border-radius:12px;background:var(--dshp-bg);color:var(--dshp-ink);font-family:var(--dshp-sans)}
.dshp-root{--dshp-bg:transparent;--dshp-paper:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#f6f4ef) 74%,transparent);--dshp-ink:var(--dsw-alias-label-primary,#1a1916);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1916) 74%,var(--dsw-alias-label-secondary,#5c564c));--dshp-line:color-mix(in srgb,var(--dsw-alias-border-l1,#c8c2b6) 78%,transparent);--dshp-fill:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 14%,transparent);--dshp-accent:var(--dsw-alias-brand-primary,#3f6b52);--dshp-accent-soft:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 18%,transparent);--dshp-ok:#1f7a45;--dshp-warn:#8a5a12;--dshp-bad:#9a3434}
.dshp-root[data-theme="white"]{color-scheme:light}
.dshp-root[data-theme="dusk"]{color-scheme:dark;--dshp-ok:#8fd0a8;--dshp-warn:#e4c48a;--dshp-bad:#f0b4b4}
.dshp-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dshp-switch{display:inline-flex;border:1px solid var(--dshp-line);border-radius:999px;overflow:hidden;background:var(--dshp-paper)}
.dshp-switch button{appearance:none;border:0;background:transparent;color:var(--dshp-mute);font:12px/1 var(--dshp-sans);padding:6px 14px;cursor:pointer}
.dshp-switch button.is-on{background:var(--dshp-accent-soft);color:var(--dshp-ink)}
.dshp-switch button:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-panel{border:1px solid var(--dshp-line);background:var(--dshp-paper);border-radius:10px;padding:18px 18px 16px}
.dshp-kicker{font-family:var(--dshp-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dshp-mute);margin:0 0 4px}
.dshp-title{font-family:var(--dshp-display);font-size:20px;font-weight:500;letter-spacing:.02em;line-height:1.3;margin:0;color:var(--dshp-ink)}
.dshp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.dshp-sub{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:20px 0 10px}
.dshp-sub h4{margin:0;font-family:var(--dshp-display);font-size:15px;font-weight:500}
.dshp-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px}
.dshp-metric{border:1px solid var(--dshp-line);background:var(--dshp-bg);padding:12px;min-height:68px;display:flex;flex-direction:column;gap:4px;border-radius:8px}
.dshp-metric b{font-family:var(--dshp-display);font-size:18px;font-weight:500;line-height:1.2}
.dshp-metric span{font-size:11px;color:var(--dshp-mute)}
.dshp-bar{height:3px;border-radius:99px;background:var(--dshp-line);overflow:hidden;margin:8px 0 14px}
.dshp-bar>i{display:block;height:100%;background:var(--dshp-accent);width:0;transition:width .4s var(--dshp-ease)}
.dshp-group{border:1px solid var(--dshp-line);margin:0 0 8px;background:var(--dshp-bg);border-radius:8px;overflow:hidden}
.dshp-group-h{width:100%;display:flex;align-items:center;gap:10px;padding:9px 12px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}
.dshp-group-h:hover{background:var(--dshp-fill)}
.dshp-group-h:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:-2px}
.dshp-group-h strong{font-family:var(--dshp-display);font-size:14px;font-weight:500}
.dshp-group-h em{font-style:normal;font-size:12px;color:var(--dshp-mute);flex:1}
.dshp-count{font-family:var(--dshp-mono);font-size:12px;color:var(--dshp-mute)}
.dshp-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dshp-table th{text-align:left;font-weight:500;font-size:11px;letter-spacing:.06em;color:var(--dshp-mute);padding:7px 12px;border-bottom:1px solid var(--dshp-line)}
.dshp-table td{padding:8px 12px;border-bottom:1px solid var(--dshp-line);vertical-align:middle}
.dshp-table tr:last-child td{border-bottom:0}
.dshp-table tr.is-on td{background:var(--dshp-accent-soft)}
.dshp-id{font-family:var(--dshp-mono);opacity:.75;width:42px}
.dshp-actions{text-align:right;white-space:nowrap}
.dshp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshp-row+.dshp-row{margin-top:10px}
.dshp-pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--dshp-mono);font-size:11px;padding:2px 8px;border:1px solid var(--dshp-line);border-radius:99px;line-height:1.6;background:var(--dshp-bg)}
.dshp-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.dshp-pill.is-ok{color:var(--dshp-ok);border-color:color-mix(in srgb,var(--dshp-ok) 30%,var(--dshp-line))}
.dshp-pill.is-wait{color:var(--dshp-warn);border-color:color-mix(in srgb,var(--dshp-warn) 30%,var(--dshp-line))}
.dshp-pill.is-miss{color:var(--dshp-mute)}
.dshp-pill.is-bad{color:var(--dshp-bad)}
.dshp-btn{appearance:none;font-family:var(--dshp-sans);font-size:13px;font-weight:500;min-height:34px;padding:0 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;transition:background .15s var(--dshp-ease),opacity .15s var(--dshp-ease)}
.dshp-btn:disabled{opacity:.45;cursor:not-allowed}
.dshp-btn:focus-visible{outline:2px solid var(--dshp-accent);outline-offset:2px}
.dshp-btn-primary{background:var(--dshp-accent-soft);color:var(--dshp-ink);border-color:color-mix(in srgb,var(--dshp-accent) 35%,var(--dshp-line))}
.dshp-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dshp-accent) 22%,var(--dshp-bg))}
.dshp-btn-ghost{background:transparent;color:var(--dshp-ink);border-color:var(--dshp-line)}
.dshp-btn-danger{background:transparent;color:var(--dshp-bad);border-color:color-mix(in srgb,var(--dshp-bad) 40%,var(--dshp-line))}
.dshp-btn-solid-danger{background:color-mix(in srgb,var(--dshp-bad) 16%,var(--dshp-bg));color:var(--dshp-bad);border-color:color-mix(in srgb,var(--dshp-bad) 30%,var(--dshp-line))}
.dshp-btn-tiny{min-height:28px;padding:0 10px;font-size:12px}
.dshp-field,.dshp-area{width:100%;box-sizing:border-box;font:13px/1.55 var(--dshp-mono);padding:8px 10px;background:var(--dshp-bg);color:var(--dshp-ink);border:1px solid var(--dshp-line);border-radius:8px}
.dshp-field{width:auto;min-width:140px}
.dshp-cr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 0;font-size:13px}
.dshp-cr-row label{display:inline-flex;align-items:center;gap:6px;color:var(--dshp-ink)}
.dshp-cr-num{width:64px;min-width:64px;height:28px;padding:0 8px}
.dshp-cr-text{width:120px;min-width:88px;height:28px;padding:0 8px}
.dshp-ver{width:100%;min-width:0;max-width:none;height:32px;padding:0 10px;font-size:12px}
.dshp-rel{margin:0 0 14px}
.dshp-now{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 4px}
.dshp-now-label{font-family:var(--dshp-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dshp-mute)}
.dshp-now-ver{font-family:var(--dshp-display);font-size:20px;font-weight:500;letter-spacing:.01em}
.dshp-now-mark{display:inline-flex;align-items:center;margin-left:6px;padding:1px 7px;border-radius:99px;font-family:var(--dshp-mono);font-size:11px;font-style:normal;font-weight:500;line-height:1.5;color:var(--dshp-ok);border:1px solid color-mix(in srgb,var(--dshp-ok) 38%,var(--dshp-line));background:color-mix(in srgb,var(--dshp-ok) 14%,var(--dshp-bg))}
.dshp-editions{display:flex;flex-direction:column;margin:10px 0 0;border-top:1px solid var(--dshp-line)}
.dshp-edition{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--dshp-line)}
.dshp-edition-name{display:inline-flex;align-items:center;gap:0;font-family:var(--dshp-display);font-size:15px;font-weight:500;white-space:nowrap}
.dshp-edition.is-on .dshp-edition-name{color:var(--dshp-ink)}
.dshp-edition:not(.is-on) .dshp-edition-name{color:var(--dshp-mute)}
.dshp-edition .dshp-btn{min-width:118px}
.dshp-rel .dshp-notice{display:block;margin-top:8px;min-height:16px}
@media (max-width:560px){.dshp-edition{grid-template-columns:1fr auto;grid-template-areas:"name btn" "sel sel"}.dshp-edition-name{grid-area:name}.dshp-edition .dshp-ver{grid-area:sel}.dshp-edition .dshp-btn{grid-area:btn}}
.dshp-area{min-height:220px;resize:vertical}
.dshp-field:focus,.dshp-area:focus{outline:none;border-color:var(--dshp-accent);box-shadow:0 0 0 3px var(--dshp-accent-soft)}
.dshp-field:disabled,.dshp-area:disabled{opacity:.5}
.dshp-ask{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding:10px 12px;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);font-size:13px}
.dshp-modal-bg{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:color-mix(in srgb,var(--dshp-ink) 28%,transparent)}
.dshp-modal{width:min(420px,100%);background:var(--dshp-paper);color:var(--dshp-ink);border:1px solid var(--dshp-line);border-radius:12px;padding:20px 20px 16px;box-shadow:0 16px 40px color-mix(in srgb,var(--dshp-ink) 18%,transparent)}
.dshp-modal h4{margin:0 0 8px;font-family:var(--dshp-display);font-size:18px;font-weight:500}
.dshp-modal p{margin:0 0 16px;font-size:13.5px;line-height:1.55}
.dshp-modal-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-restart-mask{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62);font-family:"Yu Gothic UI","Hiragino Sans GB","Source Han Sans SC","Microsoft YaHei UI",system-ui,sans-serif}
.dshp-restart-card{width:min(420px,100%);box-sizing:border-box;padding:22px 22px 18px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fffcf7);color:var(--dsw-alias-label-primary,#16140f);border:1px solid var(--dsw-alias-border-l1,#c9c3b6);box-shadow:0 18px 50px rgba(0,0,0,.35)}
.dshp-restart-card h4{margin:0 0 10px;font-family:inherit;font-size:20px;font-weight:650;line-height:1.35;color:inherit}
.dshp-restart-card p{margin:0 0 18px;font-size:16px;font-weight:500;line-height:1.65;color:inherit}
.dshp-restart-card .dshp-modal-ops{display:flex;justify-content:flex-end;gap:10px}
.dshp-restart-card .dshp-btn{min-height:38px;padding:0 16px;font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary,#16140f);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#c9c3b6)}
.dshp-restart-card .dshp-btn-primary,.dshp-restart-card .dshp-btn-primary:hover:not(:disabled){color:#fff;background:#2f6b4f;border-color:#2f6b4f}
body[data-ds-dark-theme] .dshp-restart-card,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card{background:#1c1e24;color:#f4f1ea;border-color:#5a5e68}
body[data-ds-dark-theme] .dshp-restart-card .dshp-btn,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn{color:#f4f1ea;background:#2a2d34;border-color:#5a5e68}
body[data-ds-dark-theme] .dshp-restart-card .dshp-btn-primary,body[data-ds-dark-theme] .dshp-restart-card .dshp-btn-primary:hover:not(:disabled),.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn-primary,.dshp-restart-mask[data-theme="dusk"] .dshp-restart-card .dshp-btn-primary:hover:not(:disabled){color:#fff;background:#3d8f68;border-color:#3d8f68}
.dshp-notice{font-size:12.5px;line-height:1.4}
.dshp-notice.is-ok{color:var(--dshp-ok)}
.dshp-notice.is-bad{color:var(--dshp-bad)}
.dshp-skel{height:12px;border-radius:6px;background:linear-gradient(90deg,var(--dshp-fill),var(--dshp-line),var(--dshp-fill));background-size:200% 100%;animation:dshp-pulse 1.2s ease-in-out infinite}
.dshp-active{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;margin-bottom:12px;border:1px solid var(--dshp-line);background:var(--dshp-bg);border-radius:8px}
.dshp-active b{font-family:var(--dshp-display);font-weight:500}
.dshp-empty{padding:28px 12px;font-size:13px;color:var(--dshp-mute);text-align:center}
.dshp-split{display:flex;flex-direction:column;gap:12px}
.dshp-rulelist{display:flex;flex-direction:column;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);overflow:hidden}
.dshp-rulebody{max-height:240px;overflow:auto}
.dshp-ruleitem{display:flex;align-items:center;gap:12px;width:100%;padding:10px 12px;border:0;border-bottom:1px solid var(--dshp-line);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshp-ruleitem:hover{background:var(--dshp-fill)}
.dshp-ruleitem.is-edit{background:var(--dshp-accent-soft)}
.dshp-rule-main{flex:1;min-width:0}
.dshp-rule-name{display:flex;align-items:center;gap:8px;font-family:var(--dshp-display);font-size:14px;line-height:1.35}
.dshp-rule-meta{display:block;margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute)}
.dshp-rule-ops{display:flex;flex-direction:row;align-items:center;gap:6px;flex-shrink:0}
.dshp-create{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-top:1px solid var(--dshp-line);background:var(--dshp-paper)}
.dshp-create-row{display:flex;gap:6px;align-items:center}
.dshp-create .dshp-field{flex:1;min-width:0;width:auto}
.dshp-editor{display:flex;flex-direction:column;gap:10px;min-width:0;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);padding:12px;min-height:320px}
.dshp-editor .dshp-area{flex:1;min-height:240px}
.dshp-editor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dshp-mute);font-size:13px;min-height:160px}
.dshp-block{padding:14px 0;border-top:1px solid var(--dshp-line)}
.dshp-block-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}
.dshp-block-head h4{margin:0;font-family:var(--dshp-display);font-size:14px;font-weight:500;flex:1;color:var(--dshp-ink)}
.dshp-block-hint{margin:8px 0 0;font-size:12px;line-height:1.55;color:var(--dshp-mute)}
.dshp-policy-row{display:flex;align-items:center;gap:10px}
.dshp-policy-row>label{font-size:12px;color:var(--dshp-mute);flex:0 0 auto}
.dshp-cwd-path{margin:0 0 8px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all;line-height:1.5}
.dshp-cwd-list{display:flex;flex-direction:column;border:1px solid var(--dshp-line);border-radius:8px;background:var(--dshp-bg);overflow:hidden}
.dshp-cwd-item{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dshp-line);cursor:pointer;margin:0}
.dshp-cwd-item:last-child{border-bottom:0}
.dshp-cwd-item:hover{background:var(--dshp-fill)}
.dshp-cwd-item.is-on{background:var(--dshp-accent-soft)}
.dshp-cwd-item input{margin:3px 0 0;flex:0 0 auto}
.dshp-cwd-main{flex:1;min-width:0}
.dshp-cwd-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-family:var(--dshp-display);font-size:13.5px;line-height:1.35;color:var(--dshp-ink)}
.dshp-cwd-badge{font-family:var(--dshp-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:99px;border:1px solid var(--dshp-line);color:var(--dshp-mute);line-height:1.6}
.dshp-cwd-size{font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute)}
.dshp-cwd-sub{margin-top:3px;font-family:var(--dshp-mono);font-size:11px;color:var(--dshp-mute);word-break:break-all}
.dshp-cwd-prev{margin-top:4px;font-size:11px;line-height:1.5;color:var(--dshp-mute);max-height:34px;overflow:hidden}
@keyframes dshp-pulse{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (max-width:640px){.dshp-metrics{grid-template-columns:1fr}.dshp-ruleitem{flex-wrap:wrap}.dshp-rule-ops{width:100%;justify-content:flex-end}}
@media (prefers-reduced-motion:reduce){.dshp-btn,.dshp-bar>i{transition:none}.dshp-skel{animation:none}}

.dshp-dock{position:fixed;top:12px;right:12px;z-index:10050;display:flex;flex-direction:column;width:var(--dshp-dock-w,620px);height:var(--dshp-dock-h,72vh);min-width:380px;min-height:320px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,var(--dshp-paper,#1c1c1c)) 52%,transparent);backdrop-filter:blur(22px) saturate(1.35);-webkit-backdrop-filter:blur(22px) saturate(1.35);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 65%,transparent);border-radius:12px;box-shadow:0 18px 48px color-mix(in srgb,#000 30%,transparent),0 0 0 1px color-mix(in srgb,#fff 6%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));overflow:visible}
.dshp-dock[data-open="0"]{display:none}
.dshp-launch{position:fixed;right:16px;bottom:16px;z-index:10040;appearance:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 55%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 72%,transparent);color:var(--dsw-alias-label-primary,#f2f2f2);cursor:pointer;font:13px/1 inherit;box-shadow:0 8px 22px color-mix(in srgb,#000 28%,transparent);pointer-events:auto}
.dshp-launch:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-launch[data-open="1"]{display:none}
.dshp-dock-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 55%,transparent);background:transparent;cursor:grab;user-select:none;touch-action:none;color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));border-radius:12px 12px 0 0}
.dshp-dock-head:active{cursor:grabbing}
.dshp-dock-head b{font-size:14px;font-weight:600;color:inherit;text-shadow:0 1px 0 color-mix(in srgb,#000 18%,transparent)}
.dshp-dock-head button{cursor:pointer;color:inherit;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18)) 55%,transparent)}
.dshp-dock-tabs{display:flex;gap:4px;padding:0 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,var(--dshp-line,#555)) 55%,transparent);background:transparent}
.dshp-dock-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,var(--dshp-mute,#b8b4ac));border-radius:0;padding:10px 14px 8px;margin-bottom:-1px;cursor:pointer;font:13px/1.2 inherit;text-shadow:0 1px 0 color-mix(in srgb,#000 12%,transparent)}
.dshp-dock-tab:hover{color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2))}
.dshp-dock-tab.on{color:var(--dsw-alias-label-primary,var(--dshp-ink,#f2f2f2));font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c);background:transparent}
.dshp-dock-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;background:transparent;border-radius:0 0 12px 12px}
.dshp-dock-body .dshp-root{max-width:none;height:100%;flex:1;min-height:0;overflow:auto;background:transparent!important;--dshp-bg:transparent;--dshp-paper:color-mix(in srgb,var(--dshp-ink) 7%,transparent);--dshp-fill:color-mix(in srgb,var(--dshp-ink) 6%,transparent);--dshp-line:color-mix(in srgb,var(--dshp-ink) 20%,transparent);--dshp-accent-soft:color-mix(in srgb,var(--dshp-accent) 22%,transparent)}
.dshp-dock-body .dshp-panel,.dshp-dock-body .dshp-metric,.dshp-dock-body .dshp-group,.dshp-dock-body .dshp-editor,.dshp-dock-body .dshp-active,.dshp-dock-body .dshp-ask,.dshp-dock-body .dshp-create,.dshp-dock-body .dshp-rulelist,.dshp-dock-body .dshp-table,.dshp-dock-body .dshp-ruleitem,.dshp-dock-body .dshp-cwd-list,.dshp-dock-body .dshp-cwd-item{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#f7f4ee) 74%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 32%,transparent)!important;color:var(--dshp-ink)!important;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 32%,transparent);backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3)}
.dshp-dock-body .dshp-field,.dshp-dock-body .dshp-area{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent)!important;color:var(--dshp-ink)!important;border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#8a8478) 72%,transparent)!important}
.dshp-dock-body select.dshp-field,.dshp-dock-body .dshp-field.dshp-ver{background:var(--dsw-alias-bg-layer-1,#fff)!important;color:var(--dshp-ink)!important;color-scheme:inherit}
.dshp-dock[data-theme="white"] select.dshp-field option,.dshp-dock[data-theme="white"] .dshp-field.dshp-ver option{background:#fff;color:#16140f}
.dshp-dock[data-theme="dusk"] select.dshp-field option,.dshp-dock[data-theme="dusk"] .dshp-field.dshp-ver option{background:#1b1d22;color:#f4f1ea}
.dshp-dock-body .dshp-title,.dshp-dock-body .dshp-sub h4,.dshp-dock-body .dshp-group-h strong,.dshp-dock-body .dshp-metric b,.dshp-dock-body .dshp-rule-name{font-family:inherit;font-weight:650;letter-spacing:0;color:var(--dshp-ink)!important;text-shadow:none}
.dshp-dock-body .dshp-mute,.dshp-dock-body .dshp-kicker,.dshp-dock-body .dshp-metric span,.dshp-dock-body .dshp-group-h em,.dshp-dock-body .dshp-count,.dshp-dock-body .dshp-rule-meta,.dshp-dock-body .dshp-hint{color:var(--dshp-mute)!important;font-weight:500;text-shadow:none}
.dshp-dock-body .rt-dock{position:relative;inset:auto;width:100%!important;height:100%;max-width:none!important;flex:1;min-height:0;min-width:0;display:flex!important;flex-direction:column;box-shadow:none;border:0;transform:none!important;opacity:1!important;pointer-events:auto!important;background:transparent!important}
.dshp-dock-body .rt-grip{display:none!important}
.dshp-dock-body .rt-embedded>.rt-head,.dshp-dock-body .rt-tabs,.dshp-dock-body .rt-foot{flex:none}
.dshp-dock-body .rt-body{flex:1;min-height:0;overflow:hidden!important;background:transparent!important}
.dshp-dock-body .rt-main{min-height:0;flex:1;overflow:hidden}
.dshp-dock-body .rt-pane{min-height:0;overflow:auto!important}
.dshp-dock-body .rt-embedded>.rt-head{padding:8px 12px}
.dshp-dock-body .rt-embedded>.rt-head .rt-title{font-size:14px;letter-spacing:0}
.dshp-dock-body .rt-tabs{gap:2px;padding:6px 10px 0;flex-wrap:wrap}
.dshp-dock-body .rt-tab{border-radius:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 9px 7px;background:transparent;font-size:14px}
.dshp-dock-body .rt-tab.on{border-bottom-color:var(--dsw-alias-brand-primary,#6d8f78);background:transparent;font-weight:650}
.dshp-dock-body .rt-row:hover,.dshp-dock-body .rt-item:hover,.dshp-dock-body .rt-item.on,.dshp-dock-body .rt-seg:hover,.dshp-dock-body .rt-seg.on,.dshp-dock-body .rt-vrow:hover,.dshp-dock-body .rt-score-row:hover{background:var(--rt-surf-2)!important}
body:not([data-ds-dark-theme]) .dshp-auth-modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fffcf7) 92%,transparent);color:var(--dsw-alias-label-primary,#1a1916);border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#c9c3b6) 80%,transparent);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3)}
body:not([data-ds-dark-theme]) .dshp-auth-legal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#f3f0e8) 90%,transparent);color:var(--dsw-alias-label-primary,#1a1916);border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#c9c3b6) 80%,transparent)}
body:not([data-ds-dark-theme]) .dshp-auth-warn{background:color-mix(in srgb,#f5e6c8 88%,transparent);color:#6b4a10}
body:not([data-ds-dark-theme]) .dshp-auth-ops button{border-color:var(--dsw-alias-border-l1,#c9c3b6);color:var(--dsw-alias-label-primary,#1a1916);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent)}
body:not([data-ds-dark-theme]) .dshp-auth-ops button.primary{background:var(--dsw-alias-brand-primary,#3f6b52);border-color:var(--dsw-alias-brand-primary,#3f6b52);color:#fff}
.dshp-dock-resize,.dshp-dock-resize-l,.dshp-dock-resize-r,.dshp-dock-resize-b{position:absolute;z-index:60;pointer-events:auto;touch-action:none}
.dshp-dock-resize{right:0;bottom:0;width:22px;height:22px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 46%,color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 75%,transparent) 46%);border-radius:0 0 12px 0;opacity:.95}
.dshp-dock-resize-l{left:-2px;top:0;bottom:0;width:10px;cursor:ew-resize;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-dock-resize-l:hover,.dshp-dock-resize-r:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 42%,transparent)}
.dshp-dock-resize-r{right:-2px;top:0;bottom:22px;width:10px;cursor:ew-resize;background:transparent}
.dshp-dock-resize-b{left:10px;right:22px;bottom:-2px;height:10px;cursor:ns-resize;background:transparent}
.dshp-dock-resize-b:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 35%,transparent)}
.dshp-auth-mask{position:fixed;inset:0;z-index:10100;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto}
.dshp-env-gate{z-index:10200}
.dshp-auth-modal{width:min(680px,100%);max-height:min(88vh,820px);display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1a1a1a);color:var(--dsw-alias-label-primary,#eee)}
.dshp-auth-modal h2{margin:0;font-size:16px;font-weight:600}
.dshp-auth-warn{padding:8px 10px;border-radius:8px;background:#3a2e18;color:#f0d48a;font-size:13px}
.dshp-auth-legal{overflow:auto;height:300px;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#333);border-radius:8px;background:#121212;font-size:13px;line-height:1.55}
.dshp-auth-legal h3{margin:14px 0 4px;font-size:13px}
.dshp-auth-legal h3:first-child{margin-top:0}
.dshp-auth-legal p{margin:0 0 8px}
.dshp-auth-checks{display:flex;flex-direction:column;gap:8px;font-size:13px}
.dshp-auth-checks label{display:flex;gap:8px;align-items:flex-start}
.dshp-auth-checks label.locked{opacity:.45}
.dshp-auth-ops{display:flex;justify-content:flex-end;gap:8px}
.dshp-auth-ops button,.dshp-dock-head button{appearance:none;border:1px solid var(--dsw-alias-border-l1,#444);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.dshp-auth-ops button.primary{background:#2a4033;border-color:#8fbf9a}
.dshp-auth-ops button:disabled{opacity:.45;cursor:default}
.dshp-icon-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 45%,transparent);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:13px/1 inherit;white-space:nowrap;flex:0 0 auto}
.dshp-icon-btn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-icon-btn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 16%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 28%,transparent)}
.dshp-hbtn{appearance:none;display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 55%,transparent);background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:12px/1 inherit;padding:5px 10px;border-radius:8px;white-space:nowrap}
.dshp-hbtn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 12%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
.dshp-hbtn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent)}
.dshp-live-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-brand-primary,#6dbf8c);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 28%,transparent)}
.dshp-hero-chip{display:inline-flex;align-items:center;margin-left:6px;flex:0 0 auto}
.dshp-hero-chip-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 50%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 10%,transparent);color:var(--dsw-alias-label-primary,currentColor);cursor:pointer;font:12.5px/1 inherit;white-space:nowrap}
.dshp-hero-chip-btn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent)}
.dshp-hero-chip-btn.on{border-color:var(--dsw-alias-brand-primary,#6dbf8c);color:var(--dsw-alias-brand-primary,#6dbf8c);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 18%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#6dbf8c) 32%,transparent)}
.dshp-tab-chip{display:inline-flex;align-items:flex-end;flex:0 0 auto}
.dshp-tab-btn{appearance:none;position:relative;border:none;background:transparent;cursor:pointer;padding:0 0 9px;font:500 13px/16px inherit;color:var(--dsw-alias-label-tertiary,currentColor);white-space:nowrap}
.dshp-tab-btn:hover{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-tab-btn.on{color:var(--dsw-alias-brand-primary,#6dbf8c)}
.dshp-tab-btn.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 上游 #169：宿主工具条按钮常继承图标字体 / font-size:0 / color:transparent，
   字在 DOM 里但看不见。这里只强制「看得见」的几项，颜色仍走本项目自己的变量。 */
.dshp-hero-chip-btn,.dshp-tab-btn,.dshp-launch,.dshp-icon-btn,.dshp-hbtn,.dshp-btn,.dshp-dock-tab,.dshp-dock-head button,.dshp-auth-ops button,.dshp-switch button,.rt-btn{
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif!important;
-webkit-text-fill-color:currentColor!important;
text-indent:0!important;
letter-spacing:normal!important;
overflow:visible!important;
text-overflow:clip!important;
width:auto!important;
max-width:none!important;
}
.dshp-hero-chip-btn,.dshp-launch{min-width:max-content!important}
/* 玻璃跟随宿主颜色。字重和底的不透明度分开：壳透，字坐在更实的一层上。 */
.dshp-dock{font-family:"Segoe UI","Microsoft YaHei UI","PingFang SC","Noto Sans SC",system-ui,sans-serif;font-size:14px;line-height:1.6;font-weight:500;-webkit-font-smoothing:antialiased;text-shadow:none}
.dshp-dock[data-theme="white"],.dshp-dock[data-theme="dusk"]{background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 50%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 18%,transparent) 46%,color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 28%,transparent))!important;backdrop-filter:blur(26px) saturate(1.45)!important;-webkit-backdrop-filter:blur(26px) saturate(1.45)!important;color:var(--dshp-ink)!important;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 36%,transparent)!important;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 42%,transparent),0 18px 44px color-mix(in srgb,#000 18%,transparent)!important}
.dshp-dock[data-theme="dusk"]{--dshp-ink:var(--dsw-alias-label-primary,#f4f1ea);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#f4f1ea) 84%,var(--dsw-alias-label-secondary,#c9c3b8))}
.dshp-dock[data-theme="white"]{--dshp-ink:var(--dsw-alias-label-primary,#16140f);--dshp-mute:color-mix(in srgb,var(--dsw-alias-label-primary,#16140f) 76%,var(--dsw-alias-label-secondary,#3c362e))}
.dshp-dock .dshp-dock-head,.dshp-dock .dshp-dock-tabs{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,transparent) 28%,transparent)!important;color:var(--dshp-ink)!important}
.dshp-dock .dshp-dock-head,.dshp-dock .dshp-dock-head b,.dshp-dock .dshp-dock-head button,.dshp-dock .dshp-dock-tab,.dshp-dock .dshp-dock-tab.on{color:var(--dshp-ink)!important;text-shadow:none!important;font-weight:600}
.dshp-dock .dshp-dock-tab{font-size:14px}
.dshp-dock .dshp-dock-tab.on{border-bottom-color:var(--dsw-alias-brand-primary,#6d8f78)!important}
.dshp-dock-body .rt-dock{font-size:14px!important;line-height:1.6!important;font-weight:500!important;color:var(--dshp-ink)!important;--rt-ink:var(--dshp-ink);--rt-mute:var(--dshp-mute);--rt-surf:color-mix(in srgb,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff)) 40%,transparent);--rt-surf-2:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 62%,transparent);--rt-line:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 30%,transparent)}
.dshp-dock-body .rt-title,.dshp-dock-body .rt-tab,.dshp-dock-body .rt-tab.on,.dshp-dock-body .rt-card,.dshp-dock-body .rt-card h4,.dshp-dock-body .rt-row,.dshp-dock-body .rt-vrow,.dshp-dock-body .rt-kv,.dshp-dock-body .rt-kv b,.dshp-dock-body .rt-kv span,.dshp-dock-body .rt-mono,.dshp-dock-body .rt-empty,.dshp-dock-body .rt-foot,.dshp-dock-body .rt-tag,.dshp-dock-body .rt-item,.dshp-dock-body .rt-item-name,.dshp-dock-body .rt-item-desc,.dshp-dock-body .rt-sec-sub,.dshp-dock-body .rt-kb-sub,.dshp-dock-body .rt-seg-cidr,.dshp-dock-body .rt-seg-meta,.dshp-dock-body .rt-section,.dshp-dock-body .rt-note,.dshp-dock-body .rt-hint{color:var(--dshp-ink)!important;text-shadow:none!important;opacity:1!important}
.dshp-dock-body .rt-tab,.dshp-dock-body .rt-foot,.dshp-dock-body .rt-empty,.dshp-dock-body .rt-item-desc,.dshp-dock-body .rt-kb-sub,.dshp-dock-body .rt-kv span,.dshp-dock-body .rt-tag,.dshp-dock-body .rt-sec-sub{color:var(--dshp-mute)!important}
.dshp-dock-body .rt-card,.dshp-dock-body .rt-pane,.dshp-dock-body .rt-side,.dshp-dock-body .rt-table,.dshp-dock-body .rt-toolbar,.dshp-dock-body .rt-embedded>.rt-head,.dshp-dock-body .rt-tabs{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 72%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#6d8f78) 28%,transparent)!important;color:var(--dshp-ink)!important;box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 26%,transparent)!important;backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3)}
.dshp-dock-body .rt-btn,.dshp-dock-body .rt-input,.dshp-dock-body .rt-eng-select,.dshp-dock-body textarea.rt-input{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 90%,transparent)!important;color:var(--dshp-ink)!important;border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#888) 70%,transparent)!important}
.dshp-dock-body .rt-btn-primary{background:var(--dsw-alias-brand-primary,#3f6b52)!important;border-color:var(--dsw-alias-brand-primary,#3f6b52)!important;color:#fff!important}
.dshp-dock[data-theme="white"] .dshp-dock-body .rt-eng-select option,.dshp-dock[data-theme="white"] .dshp-dock-body .rt-input option{background:#fff;color:#16140f}
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-eng-select option,.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-input option{background:#1b1d22;color:#f4f1ea}
.dshp-dock-body .rt-err{font-weight:650}
.dshp-dock[data-theme="white"] .dshp-dock-body .rt-err{color:#9a3434!important}
.dshp-dock[data-theme="dusk"] .dshp-dock-body .rt-err{color:#f0b4b4!important}
.dshp-dock-body .rt-rep-http,.dshp-dock-body pre{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 84%,transparent)!important;color:var(--dshp-ink)!important;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#888) 60%,transparent)!important}
`;

		function formatSize(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "0 B";
			if (bytes < 1024) return bytes + " B";
			const kb = bytes / 1024;
			return (kb >= 100 ? Math.round(kb) : kb.toFixed(1)) + " KB";
		}

		function statusKind(st) {
			if (st === "applied" || st === "already") return "ok";
			if (st === "pending") return "wait";
			if (st === "unmatched") return "bad";
			if (st === "na") return "ok";
			if (st === "missing_file" || st === "skipped" || st === "unlocated" || st === "off") return "miss";
			return "bad";
		}

		function statusLabel(st, t) {
			if (st === "applied" || st === "already") return t("status.applied");
			if (st === "off") return t("status.skipped");
			if (st === "pending") return t("status.pending");
			if (st === "unmatched") return t("status.unmatched");
			if (st === "skipped") return t("status.skipped");
			if (st === "missing_file") return t("skip");
			if (st === "unlocated") return t("status.unlocated");
			if (st === "na") return t("status.na");
			return st || t("unknown");
		}

		function shimKind(v) {
			if (v === "patched" || v === "n/a") return "ok";
			if (v === "original") return "wait";
			if (v === "missing" || !v) return "miss";
			return "bad";
		}

		function noticeNode(notice) {
			if (!notice || notice.kind === "idle" || !notice.text) return null;
			return h("span", { className: "dshp-notice " + (notice.kind === "error" ? "is-bad" : "is-ok") }, notice.text);
		}

		function Btn(props) {
			const { kind, tiny, children, className, type, ...rest } = props;
			const cls = ["dshp-btn", kind ? "dshp-btn-" + kind : "dshp-btn-ghost", tiny ? "dshp-btn-tiny" : "", className || ""].filter(Boolean).join(" ");
			return h("button", Object.assign({ type: type || "button", className: cls }, rest), children);
		}

		function Pill({ value, label }) {
			const t = useT();
			return h("span", { className: "dshp-pill is-" + statusKind(value) }, label || statusLabel(value, t));
		}

		const LAYER_GROUP = {
			"提示词": "prompt",
			"代码": "code",
			"工具": "tools",
			"0.1.5 兼容": "compat",
			"0.2.0 兼容": "dsh20",
		};
		const GROUP_ORDER = ["prompt", "code", "tools", "compat", "dsh20"];

		function patchRowsOf(state) {
			if (!state || !state.ai_base) return [];
			const fromList = Array.isArray(state.patches) ? state.patches : null;
			const rows = fromList
				? fromList.map((p) => ({
					id: Number(p.id),
					st: p.status || "missing_file",
					layer: p.layer || "",
				}))
				: Object.keys(state.patch_status || {}).map((id) => ({
					id: Number(id),
					st: state.patch_status[id],
					layer: "",
				}));
			return rows.filter((r) => r.st && r.st !== "na" && Number.isFinite(r.id));
		}

		function tallyPatches(rows) {
			const out = { applied: 0, pending: 0, unmatched: 0, skipped: 0, total: 0 };
			for (const row of rows || []) {
				out.total += 1;
				if (row.st === "applied" || row.st === "already") out.applied += 1;
				else if (row.st === "pending") out.pending += 1;
				else if (row.st === "unmatched") out.unmatched += 1;
				else out.skipped += 1;
			}
			return out;
		}

		function PatchGroups({ state }) {
			const t = useT();
			const [open, setOpen] = useState({});
			if (!state || !state.patch_status) return h("div", { className: "dshp-skel", style: { height: 120 } });
			const located = !!state.ai_base;
			if (!located) return null;
			const grouped = new Map();
			for (const row of patchRowsOf(state)) {
				const key = LAYER_GROUP[row.layer] || "code";
				if (!grouped.has(key)) grouped.set(key, []);
				grouped.get(key).push(row);
			}
			return GROUP_ORDER.filter((key) => grouped.has(key)).map((key) => {
				const rows = grouped.get(key).slice().sort((a, b) => a.id - b.id);
				if (!rows.length) return null;
				const tally = tallyPatches(rows);
				const notes = [];
				if (tally.pending) notes.push(t("metric.pendingShort", { n: tally.pending }));
				if (tally.unmatched) notes.push(t("metric.unmatchedShort", { n: tally.unmatched }));
				if (tally.skipped) notes.push(t("metric.skipShort", { n: tally.skipped }));
				const expanded = !!open[key];
				return h("div", { key: key, className: "dshp-group" },
					h("button", {
						type: "button",
						className: "dshp-group-h",
						"aria-expanded": expanded ? "true" : "false",
						onClick: () => setOpen((prev) => Object.assign({}, prev, { [key]: !prev[key] })),
					},
						h("strong", null, t("group." + key)),
						h("span", { className: "dshp-count" }, tally.applied + "/" + tally.total + (notes.length ? " · " + notes.join(" · ") : "")),
					),
					expanded ? h("table", { className: "dshp-table" },
						h("thead", null, h("tr", null,
							h("th", null, "#"),
							h("th", null, t("table.patch")),
							h("th", null, t("table.status")),
						)),
						h("tbody", null, rows.map((r) => h("tr", { key: r.id },
							h("td", { className: "dshp-id" }, "#" + r.id),
							h("td", null, t("patch." + r.id)),
							h("td", null, h(Pill, { value: r.st })),
						))),
					) : null,
				);
			});
		}

		function HooksDenySection({ onSaved }) {
			const t = useT();
			const [cfg, setCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				apiJson("/dsh-purge/hooks-deny")
					.then((d) => { if (d && d.ok) setCfg({ hooksDenyBypass: d.hooksDenyBypass !== false }); })
					.catch(() => {});
			}, []);

			const save = (hooksDenyBypass) => {
				if (!cfg || busy) return;
				setCfg({ hooksDenyBypass });
				setBusy(true);
				apiJson("/dsh-purge/hooks-deny", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ hooksDenyBypass }),
				})
					.then((d) => {
						if (d && d.ok) {
							setCfg({ hooksDenyBypass: d.hooksDenyBypass === true });
							setNotice({ kind: "ok", text: t("saved.hooksDeny") });
							if (typeof onSaved === "function") onSaved();
						} else {
							setNotice({ kind: "error", text: t("err.save", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save", { error: e.message }) }))
					.finally(() => setBusy(false));
			};

			if (!cfg) return null;
			return h("div", { className: "dshp-cr", style: { marginTop: 12 } },
				h("div", { className: "dshp-sub" },
					h("h4", null, t("hooksDeny.title")),
					noticeNode(notice),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 4px", color: "var(--dshp-mute)", fontSize: 12 } }, t("hooksDeny.hint")),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: cfg.hooksDenyBypass === true,
							disabled: busy,
							onChange: (e) => save(e.target.checked),
						}),
						t("hooksDeny.bypass"),
					),
				),
			);
		}

		function ContinueRetrySection() {
			const t = useT();
			const [cfg, setCfg] = useState(null);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				apiJson("/dsh-purge/continue/settings")
					.then((d) => { if (d && d.ok) setCfg(d); })
					.catch(() => {});
			}, []);

			const save = (patch) => {
				if (!cfg || busy) return;
				const next = { ...cfg, ...patch };
				if (next.autoRetry && !(Number(next.retryMax) > 0)) next.retryMax = 3;
				if (next.autoContinue && !(Number(next.continueMax) > 0)) next.continueMax = 3;
				setCfg(next);
				setBusy(true);
				apiJson("/dsh-purge/continue/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(next),
				})
					.then((d) => {
						if (d && d.ok) {
							setCfg(d);
							setNotice({ kind: "ok", text: t("saved.continue") });
						} else {
							setNotice({ kind: "error", text: t("err.save", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.save", { error: e.message }) }))
					.finally(() => setBusy(false));
			};

			if (!cfg) return null;
			return h("div", { className: "dshp-cr" },
				h("div", { className: "dshp-sub" },
					h("h4", null, t("continue.title")),
					noticeNode(notice),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 4px", color: "var(--dshp-mute)", fontSize: 12 } }, t("continue.hint")),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: Boolean(cfg.autoRetry),
							disabled: busy,
							onChange: (e) => save({ autoRetry: e.target.checked }),
						}),
						t("continue.autoRetry"),
					),
					h("label", null,
						t("continue.retryMax"),
						h("input", {
							className: "dshp-field dshp-cr-num",
							type: "number",
							min: 0,
							max: 20,
							value: cfg.retryMax,
							disabled: busy,
							onChange: (e) => save({ retryMax: Number(e.target.value) }),
						}),
					),
				),
				h("div", { className: "dshp-cr-row" },
					h("label", null,
						h("input", {
							type: "checkbox",
							checked: Boolean(cfg.autoContinue),
							disabled: busy,
							onChange: (e) => save({ autoContinue: e.target.checked }),
						}),
						t("continue.autoContinue"),
					),
					h("label", null,
						t("continue.continueMax"),
						h("input", {
							className: "dshp-field dshp-cr-num",
							type: "number",
							min: 0,
							max: 20,
							value: cfg.continueMax,
							disabled: busy,
							onChange: (e) => save({ continueMax: Number(e.target.value) }),
						}),
					),
					h("label", null,
						t("continue.text"),
						h("input", {
							className: "dshp-field dshp-cr-text",
							type: "text",
							value: cfg.continueText || "",
							disabled: busy,
							onChange: (e) => save({ continueText: e.target.value }),
						}),
					),
				),
			);
		}

		function RestartAsk(props) {
			const node = h("div", {
				className: "dshp-restart-mask",
				"data-theme": props.theme === "dusk" ? "dusk" : "white",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "dshp-restart-title",
				onClick: (e) => { if (e.target === e.currentTarget && props.onLater) props.onLater(); },
			},
				h("div", { className: "dshp-restart-card" },
					h("h4", { id: "dshp-restart-title" }, props.t("restart.ask.title")),
					h("p", null, props.t("restart.ask.body")),
					h("div", { className: "dshp-modal-ops" },
						h(Btn, { onClick: props.onLater }, props.t("restart.notNow")),
						h(Btn, { kind: "primary", onClick: props.onRestart }, props.t("restart.now")),
					),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					return rd.createPortal(node, document.body);
				}
			} catch { /* host 可能没暴露 react-dom */ }
			return node;
		}

		function PurgifySection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [state, setState] = useState(null);
			const [override, setOverride] = useState("");
			const [defaultOverride, setDefaultOverride] = useState("");
			const [overrideLoaded, setOverrideLoaded] = useState(false);
			const [patchBusy, setPatchBusy] = useState(false);
			const [updateBusy, setUpdateBusy] = useState(false);
			const [canApplyUpdate, setCanApplyUpdate] = useState(false);
			const [updateJob, setUpdateJob] = useState(null);
			const [askRestart, setAskRestart] = useState(false);
			const suppressRestartAsk = useRef(false);
			const [askUninstall, setAskUninstall] = useState(false);
			const [uninstallBusy, setUninstallBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [updateNotice, setUpdateNotice] = useState({ kind: "idle", text: "" });
			const [updateInfo, setUpdateInfo] = useState(null);
			const [channel, setChannel] = useState("stable");
			const [pick, setPick] = useState({ stable: "", beta: "" });
			const actionTicket = useRef(0);
			const overrideRef = useRef("");
			const defaultOverrideRef = useRef("");
			const promptSeededRef = useRef(false);
			const promptAreaRef = useRef(null);
			overrideRef.current = override;
			defaultOverrideRef.current = defaultOverride;

			const readPromptBox = () => {
				const node = promptAreaRef.current;
				const live = node && typeof node.value === "string" ? node.value : overrideRef.current;
				overrideRef.current = live || "";
				return overrideRef.current;
			};

			const syncPicks = (d) => {
				const versions = (d && d.versions) || [];
				const ceiling = listedCeiling(versions, d && d.localVersion);
				const next = { stable: "", beta: "" };
				for (const id of ["stable", "beta"]) {
					const list = versions.filter((item) => item.channel === id && keepListedVersion(item, ceiling));
					const hit = preferListed(list, d && d.localVersion, d && d.pin);
					next[id] = (hit && hit.ref) || "";
				}
				setPick(next);
			};

			const updateErrorText = (tr, e) => {
				const msg = String((e && e.message) || e || "");
				if (msg === "timeout" || /aborted|abort|超时/i.test(msg)) return tr("update.timeout");
				if (/\b404\b/.test(msg) || /non-json/.test(msg)) return tr("update.needRestart");
				return tr("update.fail", { error: msg });
			};

			const applyUpdateInfo = useCallback((d, tr, kind) => {
				if (d.channel) setChannel(d.channel);
				setUpdateInfo((prev) => {
					const versions = (d.versions && d.versions.length) ? d.versions : ((prev && prev.versions) || []);
					return Object.assign({}, prev || {}, d, { versions });
				});
				if (d.versions && d.versions.length) syncPicks(d);
				if (kind === "check") setCanApplyUpdate(Boolean(d.hasUpdate) && !d.error);
				else if (kind === "done" || kind === "switched" || kind === "channel") setCanApplyUpdate(false);
				const version = d.localVersion || d.localSha || "—";
				const remote = d.remoteVersion || d.remoteSha || "—";
				let text = tr("update.latest", { version });
				if (d.hasUpdate) text = tr("update.available", { remote, local: version });
				if (d.pinned && d.hasUpdate) text = tr("update.pinned", { version, remote });
				if (kind === "switched" || kind === "channel") text = tr("update.switched", { version: d.localVersion || d.remoteVersion || "—" });
				if (kind === "done" && !d.verification_pending) text = tr("update.done", { version: d.localVersion || d.remoteVersion || "—" });
				if (d.verification_pending) text = tr("operation.waiting");
				if (d.error) text = d.error;
				setUpdateNotice({ kind: d.ok === false || d.error ? "error" : "ok", text });
			}, []);

			const checkUpdate = useCallback((id) => {
				setUpdateBusy(true);
				setUpdateJob({ id: id || "", kind: "check" });
				const tr = tRef.current;
				setUpdateNotice({ kind: "ok", text: tr("update.checking") });
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d || (!d.ok && !d.channel)) throw new Error((d && d.error) || "check failed");
						applyUpdateInfo(d, tr, "check");
					})
					.catch((e) => setUpdateNotice({ kind: "error", text: updateErrorText(tr, e) }))
					.finally(() => {
						setUpdateBusy(false);
						setUpdateJob(null);
					});
			}, [applyUpdateInfo]);

			const postUpdate = useCallback((body, kind, id) => {
				setUpdateBusy(true);
				setUpdateJob({ id: id || "", kind });
				const tr = tRef.current;
				setUpdateNotice({ kind: "ok", text: kind === "switched" || kind === "channel" ? tr("update.switching") : tr("update.applying") });
				return apiJson("/dsh-purge/update", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
				})
					.then((d) => {
						if (!d || (d.ok === false && d.error)) throw new Error((d && d.error) || "update failed");
						applyUpdateInfo(d, tr, kind);
						if (d.verification_pending) return d;
						if (d.needsFullQuit) {
							suppressRestartAsk.current = false;
							setAskRestart(true);
							setUpdateNotice({ kind: "ok", text: tr("restart.official.body") });
							return d;
						}
						if (d.restartAfter) {
							setUpdateNotice({ kind: "ok", text: tr("update.restarting") });
							return d;
						}
						if (d.applied && d.reloadClient !== false) {
							setUpdateNotice({ kind: "ok", text: tr("update.reloading") });
							setTimeout(() => {
								try { window.location.reload(); } catch { /* ignore */ }
							}, 280);
						} else if (d.needRestart) {
							setAskRestart(true);
						}
						return d;
					})
					.catch((e) => {
						setUpdateNotice({ kind: "error", text: updateErrorText(tr, e) });
						throw e;
					})
					.finally(() => {
						setUpdateBusy(false);
						setUpdateJob(null);
					});
			}, [applyUpdateInfo]);

			const doUpdate = useCallback((id) => {
				const lane = id === "beta" ? "beta" : "stable";
				postUpdate({ op: "apply", ref: lane === "beta" ? "beta" : "stable", channel: lane }, "done", id).catch(() => {});
			}, [postUpdate]);

			const changeChannel = useCallback((next) => {
				if (!next) return;
				const tr = tRef.current;
				if (!window.confirm(tr("update.confirmChannel", { version: tr("channel." + next) }))) return;
				const prevChannel = channel;
				const prevInfo = updateInfo;
				setChannel(next);
				setUpdateInfo((cur) => Object.assign({}, cur || {}, { channel: next }));
				postUpdate({ op: "channel", channel: next }, "channel", next).catch(() => {
					setChannel(prevChannel);
					setUpdateInfo(prevInfo);
				});
			}, [channel, postUpdate, updateInfo]);

			const switchSelected = useCallback((id) => {
				const tr = tRef.current;
				const ref = pick[id];
				const versions = ((updateInfo && updateInfo.versions) || []).filter((item) => item.channel === id);
				const hit = versions.find((item) => item.ref === ref);
				const label = (hit && (hit.label || hit.version)) || ref;
				if (!ref) return;
				if (!window.confirm(tr("update.confirmSwitch", { version: label }))) return;
				const prevChannel = channel;
				const prevInfo = updateInfo;
				if (hit && hit.channel) {
					setChannel(hit.channel);
					setUpdateInfo((cur) => Object.assign({}, cur || {}, { channel: hit.channel }));
				}
				postUpdate({ op: "switch", ref }, "switched", id).catch(() => {
					setChannel(prevChannel);
					setUpdateInfo(prevInfo);
				});
			}, [channel, pick, postUpdate, updateInfo]);

			const loadAll = useCallback(() => {
				const tr = tRef.current;
				apiJson("/dsh-purge/status")
					.then((d) => {
						if (d && d.ok) {
							setState(d);
							if (d.channel) setChannel(d.channel);
							if (d.update && d.update.ok && !d.update.error) setUpdateInfo(d.update);
							if (d.boot_full_quit && !suppressRestartAsk.current) setAskRestart(true);
						} else {
							setState({ ok: false, patches_total: 0, patches_applied: 0, patch_status: {}, shim_cmd: "n/a", shim_ps1: "n/a", shim_bin: "n/a", has_backup: false });
							setNotice({ kind: "error", text: tr("err.status", { error: (d && d.error) || "bad response" }) });
						}
					})
					.catch((e) => {
						setState({ ok: false, patches_total: 0, patches_applied: 0, patch_status: {}, shim_cmd: "n/a", shim_ps1: "n/a", shim_bin: "n/a", has_backup: false });
						setNotice({ kind: "error", text: tr("err.status", { error: e.message }) });
					});
				apiJson("/dsh-purge/update")
					.then((d) => {
						if (!d) return;
						if (d.channel) setChannel(d.channel);
						setUpdateInfo(d);
						syncPicks(d);
					})
					.catch(() => {});
				apiJson("/dsh-purge/override")
					.then((d) => {
						if (d && d.ok) {
							const packed = typeof d.defaultContent === "string" ? d.defaultContent : "";
							const shown = typeof d.content === "string" ? d.content : packed;
							if (packed) setDefaultOverride(packed);
							if (!promptSeededRef.current) {
								promptSeededRef.current = true;
								setOverride(shown || packed);
							}
							setOverrideLoaded(true);
						}
						else setNotice({ kind: "error", text: tr("err.override", { error: (d && d.error) || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: tr("err.override", { error: e.message }) }));
			}, []);

			useEffect(() => {
				loadAll();
				const timer = setTimeout(() => { loadAll(); }, 5000);
				return () => clearTimeout(timer);
			}, [loadAll]);
			const operationId = (state && state.operation && state.operation.operation_id) || (updateInfo && updateInfo.operation_id);
			useEffect(() => {
				if (!operationId) return;
				let disposed = false, inflight = false;
				const poll = () => {
					if (disposed || inflight) return;
					inflight = true;
					apiJson("/dsh-purge/status").then((data) => {
						if (disposed || !data || !data.ok) return;
						setState(data);
						const op = data.operation;
						if (op && ["verified", "rolled_back", "failed"].includes(op.phase)) clearInterval(timer);
					}).catch(() => {}).finally(() => { inflight = false; });
				};
				const timer = setInterval(poll, 2000); poll();
				return () => { disposed = true; clearInterval(timer); };
			}, [operationId]);

			const rejectNeedPrompt = useCallback((tr) => {
				setAskRestart(false);
				setNotice({ kind: "error", text: tr("need.prompt") });
				setTimeout(() => window.alert(tr("need.prompt")), 0);
			}, []);

			const doAction = useCallback((action, actionKey) => {
				const tr = tRef.current;
				const label = tr(actionKey);
				const ticket = ++actionTicket.current;
				const run = () => {
					setPatchBusy(true);
					setAskRestart(false);
					setNotice({ kind: "idle", text: "" });
					const applyContent = action === "apply" ? readPromptBox() : "";
					fetch("/dsh-purge/" + action, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(action === "apply" ? { content: applyContent } : {}),
					})
						.then((r) => r.json())
						.then((d) => {
							if (ticket !== actionTicket.current) return;
							if (responseNeedsPrompt(d)) {
								rejectNeedPrompt(tr);
								return;
							}
							if (!d.ok) {
								setNotice({ kind: "error", text: tr("err.action", { action: label, error: d.error || "" }) });
								return;
							}
							if (action === "apply") {
								if (typeof d.defaultContent === "string") setDefaultOverride(d.defaultContent);
								if (typeof d.override_content === "string") {
									setOverride(d.override_content);
									setOverrideLoaded(true);
								}
							}
							if (action === "apply" && d.complete === false) {
								const parts = [];
								if (d.failed > 0) {
									const ids = (d.failed_items || [])
										.map((x) => x.id)
										.filter((id) => id != null)
										.join(",");
									parts.push(
										tr("restart.incomplete.patches", {
											failed: String(d.failed || 0),
											ids: ids || "?",
										}),
									);
								}
								if (d.cmd_flash && d.cmd_flash.ok === false) {
									parts.push(
										tr("restart.incomplete.flash", {
											entry: String(d.cmd_flash.entry || "fail"),
										}),
									);
								}
								if (parts.length === 0) parts.push(tr("restart.incomplete.flash", { entry: "unknown" }));
								setNotice({
									kind: "error",
									text: tr("restart.incomplete", { detail: parts.join("；") }),
								});
								loadAll();
								if (d.restarting || d.needs_full_quit) {
									suppressRestartAsk.current = false;
									setAskRestart(true);
								}
								return;
							}
							if (action === "apply") {
								setNotice({ kind: "ok", text: tr("ok.done") });
								loadAll();
								if (d.restarting || d.needs_full_quit) {
									suppressRestartAsk.current = false;
									setAskRestart(true);
								} else {
									setAskRestart(false);
								}
								return;
							}
							setNotice({ kind: "ok", text: tr("ok.done") });
							loadAll();
						})
						.catch((e) => {
							if (ticket !== actionTicket.current) return;
							setNotice({ kind: "error", text: tr("err.action", { action: label, error: e.message }) });
						})
						.finally(() => {
							if (ticket === actionTicket.current) setPatchBusy(false);
						});
				};
				run();
			}, [loadAll, rejectNeedPrompt, state]);

			const saveOverride = useCallback(() => {
				const tr = t;
				const ticket = ++actionTicket.current;
				const go = () => {
					setPatchBusy(true);
					setAskRestart(false);
					setNotice({ kind: "idle", text: "" });
					const content = readPromptBox();
					fetch("/dsh-purge/override", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ content: content }),
					})
						.then((r) => r.json())
						.then((d) => {
							if (ticket !== actionTicket.current) return;
							if (!d.ok || responseNeedsPrompt(d)) {
								rejectNeedPrompt(tr);
								return;
							}
							if (typeof d.content === "string") setOverride(d.content);
							setNotice({ kind: "ok", text: t("saved.override") });
						})
						.catch((e) => {
							if (ticket !== actionTicket.current) return;
							setNotice({ kind: "error", text: t("err.save", { error: e.message }) });
						})
						.finally(() => {
							if (ticket === actionTicket.current) setPatchBusy(false);
						});
				};
				bothInjectEmpty(readPromptBox(), defaultOverrideRef.current).then((empty) => {
					if (ticket !== actionTicket.current) return;
					if (empty) {
						rejectNeedPrompt(tr);
						return;
					}
					go();
				});
			}, [t, rejectNeedPrompt]);

			const restoreOverride = useCallback(() => {
				if (!defaultOverride) return;
				const tr = t;
				const ticket = ++actionTicket.current;
				overrideRef.current = defaultOverride;
				setOverride(defaultOverride);
				setPatchBusy(true);
				setNotice({ kind: "idle", text: "" });
				apiJson("/dsh-purge/override", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content: defaultOverride }),
				})
					.then((d) => {
						if (ticket !== actionTicket.current) return;
						if (!d || !d.ok) {
							setNotice({ kind: "error", text: tr("err.save", { error: (d && d.error) || "" }) });
							return;
						}
						if (typeof d.content === "string") {
							overrideRef.current = d.content;
							setOverride(d.content);
						}
						setNotice({ kind: "ok", text: tr("saved.restoreInject") });
					})
					.catch((e) => {
						if (ticket !== actionTicket.current) return;
						setNotice({ kind: "error", text: tr("err.save", { error: e.message }) });
					})
					.finally(() => {
						if (ticket === actionTicket.current) setPatchBusy(false);
					});
			}, [defaultOverride, t]);

			const waitHostAfterUninstall = useCallback((tr) => {
				const started = Date.now();
				const ping = () => {
					fetch("/", { cache: "no-store", credentials: "same-origin" })
						.then((r) => {
							if (r.ok) {
								try {
									window.localStorage.removeItem("dshp-theme");
									window.localStorage.removeItem("dshp-theme-mode");
								} catch { /* ignore */ }
								window.location.reload();
								return;
							}
							retry();
						})
						.catch(retry);
				};
				const retry = () => {
					if (Date.now() - started > 90000) {
						setNotice({ kind: "error", text: tr("restart.timeout") });
						setUninstallBusy(false);
						return;
					}
					setTimeout(ping, 500);
				};
				setTimeout(ping, 800);
			}, []);

			const doUninstall = useCallback(() => {
				setUninstallBusy(true);
				setAskUninstall(false);
				setAskRestart(false);
				const tr = tRef.current;
				setNotice({ kind: "ok", text: tr("uninstall.applying") });
				apiJson("/dsh-purge/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "uninstall failed");
						setNotice({ kind: "ok", text: (d && d.note) || hostText(tr, "uninstall.done", d.surface || hostSurfaceOf(state)) });
						if ((d && d.surface) === "desktop" || (d && d.fullApp) || hostSurfaceOf(state) === "desktop") return;
						waitHostAfterUninstall(tr);
					})
					.catch((e) => {
						const msg = String((e && e.message) || e || "");
						if (/failed to fetch|networkerror|load failed/i.test(msg)) {
							setNotice({ kind: "ok", text: hostText(tr, "uninstall.done", hostSurfaceOf(state)) });
							if (hostSurfaceOf(state) === "desktop" || clientGuessSurface() === "desktop") return;
							waitHostAfterUninstall(tr);
							return;
						}
						setNotice({ kind: "error", text: tr("uninstall.fail", { error: msg }) });
						setUninstallBusy(false);
					});
			}, [state, waitHostAfterUninstall]);

			const s = state;
			const located = !!(s && s.ai_base);
			const hostSurface = hostSurfaceOf(s);
			const desktopLikely = hostSurface === "desktop" || clientGuessSurface() === "desktop";
			const sealedReady = !located && desktopLikely && !!(s && (s.sealed_install || s.asar_still_sealed || s.desktop_exe || s.desktop_install));
			const patchesLost = !!(s && s.patches_lost);
			const activationPending = !!(s && (s.activation_pending || (located && s.asar_still_sealed)));
			const operation = s && s.operation;
			const operationText = operation ? (operation.phase === "rolled_back" ? t("operation.rolledBack") : operation.error || (operation.phase === "verified" ? t("operation.verified") : t("operation.waiting"))) : "";
			const tally = located ? tallyPatches(patchRowsOf(s)) : { applied: 0, pending: 0, unmatched: 0, skipped: 0, total: 0 };
			const total = tally.total;
			const applied = tally.applied;
			// 分母去掉「本机没有这些文件 / 明确跳过」的行：否则健康机器永远显示 67/69，
			// 看着像没打全（#8）。真正有问题的是 pending / unmatched，它们仍在分子外并单独提示。
			const actionable = Math.max(total - tally.skipped, 0) || total;
			const pct = located && actionable ? Math.round((applied / actionable) * 100) : 0;
			const metricNotes = [];
			if (tally.pending) metricNotes.push(t("metric.pendingShort", { n: tally.pending }));
			if (tally.unmatched) metricNotes.push(t("metric.unmatchedShort", { n: tally.unmatched }));
			if (tally.skipped) metricNotes.push(t("metric.skipShort", { n: tally.skipped }));

			const versions = (updateInfo && updateInfo.versions) || [];
			const channelNow = (updateInfo && updateInfo.channel) || channel || "stable";
			const localVer = (s && s.plugin_version) || (updateInfo && updateInfo.localVersion) || "";
			const renderEdition = (id) => {
				const lane = (updateInfo && updateInfo.lanes && updateInfo.lanes[id]) || {};
				const ceiling = listedCeiling(versions, localVer || (updateInfo && updateInfo.localVersion));
				const list = versions.filter((item) => item.channel === id && keepListedVersion(item, ceiling));
				const selectedRef = pick[id] || "";
				const hit = list.find((item) => item.ref === selectedRef) || preferListed(list, localVer, updateInfo && updateInfo.pin);
				const onLane = channelNow === id;
				const noBeta = id === "beta" && Array.isArray(updateInfo && updateInfo.versions) && !list.length;
				const pickedOther = Boolean(hit && selectedRef && !hit.current);
				const thisJob = updateJob && updateJob.id === id ? updateJob : null;
				let actionLabel = t("btn.checkUpdate");
				let actionKind;
				let actionClick = () => checkUpdate(id);
				let actionDisabled = updateBusy || Boolean(noBeta);
				if (noBeta) {
					actionLabel = t("update.noBeta");
					actionClick = () => {};
				} else if (pickedOther) {
					actionLabel = t("update.switch");
					actionKind = "primary";
					actionClick = () => switchSelected(id);
				} else if (!onLane) {
					actionLabel = id === "beta" ? t("channel.useBeta") : t("channel.useStable");
					actionKind = "primary";
					actionClick = () => changeChannel(id);
				} else if (canApplyUpdate && lane.hasUpdate) {
					actionLabel = t("btn.doUpdate");
					actionKind = "primary";
					actionClick = () => doUpdate(id);
				}
				if (thisJob) {
					if (thisJob.kind === "check") actionLabel = t("btn.checkUpdate.busy");
					else if (thisJob.kind === "done") actionLabel = t("btn.doUpdate.busy");
					else actionLabel = t("update.switching");
				}
				return h("div", {
					className: "dshp-edition" + (onLane ? " is-on" : ""),
					"aria-label": t("channel." + id),
				},
					h("span", { className: "dshp-edition-name" },
						t("channel." + id),
						onLane ? h("em", { className: "dshp-now-mark" }, t("update.current")) : null,
					),
					h("select", {
						className: "dshp-field dshp-ver",
						value: list.length ? ((hit && hit.ref) || "") : "",
						disabled: updateBusy || !list.length,
						onChange: (e) => setPick((prev) => Object.assign({}, prev, { [id]: e.target.value })),
						"aria-label": t("update.pick"),
					},
						list.length
							? list.map((item) => h("option", {
								key: item.ref + (item.sha || ""),
								value: item.ref,
							}, versionChoiceLabel(item, t)))
							: h("option", { value: "" }, noBeta ? t("update.noBeta") : t("update.pick")),
					),
					h(Btn, { tiny: true, kind: actionKind, disabled: actionDisabled, onClick: actionClick }, actionLabel),
				);
			};
			return h("section", { className: "dshp-panel", "aria-label": t("purge.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("purge.title")),
					h("span", { className: "dshp-pill" }, t("surface." + hostSurface)),
				),
				h("div", { className: "dshp-rel" },
					h("div", { className: "dshp-now" },
						h("span", { className: "dshp-now-label" }, t("channel.local")),
						h("b", { className: "dshp-now-ver" }, localVer ? "v" + localVer : "—"),
						h("em", { className: "dshp-now-mark" }, t("update.current")),
					),
					h("div", { className: "dshp-editions" },
						renderEdition("stable"),
						renderEdition("beta"),
					),
					noticeNode(updateNotice),
				),
				s ? h("div", { className: "dshp-metrics" },
					h("div", { className: "dshp-metric" },
						h("b", null, located ? (applied + " / " + actionable) : (patchesLost ? t("metric.lost.count") : (sealedReady ? t("metric.sealed.count") : t("metric.unlocated.count")))),
						h("span", null, activationPending ? t("metric.activationPending") : patchesLost ? t("metric.lost") : !located ? (sealedReady ? t("metric.sealed") : t("metric.unlocated")) : (metricNotes.length ? metricNotes.join(" · ") : t("metric.purged"))),
					),
					h("div", { className: "dshp-metric" },
						h("b", { style: { fontSize: 13, fontFamily: "var(--dshp-mono)", fontWeight: 500 } },
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_cmd) }, "cmd"),
							" ",
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_ps1) }, "ps1"),
							" ",
							h("span", { className: "dshp-pill is-" + shimKind(s.shim_bin || "missing") }, "unix"),
						),
						h("span", null, (s.shim_cmd === "n/a" && s.shim_ps1 === "n/a" && (s.shim_bin === "n/a" || !s.shim_bin)) ? t("metric.shim.na") : t("metric.shim")),
					),
					h("div", { className: "dshp-metric" },
						h("b", null, s.has_backup ? t("metric.bak.yes") : t("metric.bak.no")),
						h("span", null, t("metric.bak.hint")),
					),
				) : h("div", { className: "dshp-metrics" },
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
					h("div", { className: "dshp-metric" }, h("div", { className: "dshp-skel" }), h("div", { className: "dshp-skel", style: { width: "40%" } })),
				),
				h("div", { className: "dshp-bar", "aria-hidden": "true" }, h("i", { style: { width: pct + "%" } })),
				activationPending ? noticeNode({ kind: "error", text: t("activation.pending") }) : null,
				operationText ? noticeNode({ kind: operation.error ? "error" : "ok", text: operationText }) : null,
				h(PatchGroups, { state: s }),
				h(HooksDenySection, { onSaved: loadAll }),
				h("div", { className: "dshp-row", style: { marginTop: 14 } },
					h(Btn, { kind: "primary", disabled: patchBusy || uninstallBusy || !overrideLoaded, onClick: () => doAction("apply", "action.apply") }, patchBusy ? t("btn.apply.busy") : t("btn.apply")),
					h(Btn, { kind: "danger", disabled: patchBusy || uninstallBusy, onClick: () => doAction("revert", "action.revert") }, t("btn.revert")),
					h(Btn, { kind: "solid-danger", disabled: patchBusy || uninstallBusy, onClick: () => setAskUninstall(true) }, uninstallBusy ? t("btn.uninstall.busy") : t("btn.uninstall")),
					noticeNode(notice),
				),
				askUninstall ? h("div", {
					className: "dshp-modal-bg",
					role: "dialog",
					"aria-modal": "true",
					"aria-labelledby": "dshp-uninstall-title",
					onClick: (e) => { if (e.target === e.currentTarget && !uninstallBusy) setAskUninstall(false); },
				},
					h("div", { className: "dshp-modal" },
						h("h4", { id: "dshp-uninstall-title" }, t("uninstall.title")),
						h("p", null, t("uninstall.body")),
						h("div", { className: "dshp-modal-ops" },
							h(Btn, { disabled: uninstallBusy, onClick: () => setAskUninstall(false) }, t("uninstall.cancel")),
							h(Btn, { kind: "solid-danger", disabled: uninstallBusy, onClick: doUninstall }, t("uninstall.confirm")),
						),
					),
				) : null,
				h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-mute)", fontSize: 12 } }, t("apply.hint")),
				s && !s.ai_base && !sealedReady ? h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-danger, #c44)", fontSize: 12 } }, hostText(t, "warn.noRoot", hostSurface)) : null,
				s && s.ai_base && s.override_status === "missing" ? h("p", { className: "dshp-hint", style: { margin: "8px 0 0", color: "var(--dshp-mute)", fontSize: 12 } }, t("warn.noInject")) : null,
				askRestart ? h(RestartAsk, {
					t: t,
					theme: detectHostTheme(),
					onLater: () => {
						suppressRestartAsk.current = true;
						setAskRestart(false);
						// 落盘：重开设置页 / 刷新后不再重复弹（#8）。
						fetch("/dsh-purge/restart-dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
							.catch(() => {});
					},
					onRestart: () => {
						suppressRestartAsk.current = true;
						setAskRestart(false);
						restartDsh(setNotice, function () {}, t, hostSurface);
					},
				}) : null,
				// h(ContinueRetrySection, null),
				h("div", { className: "dshp-sub" },
					h("h4", null, t("override.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } },
						h(Btn, { kind: "primary", tiny: true, disabled: patchBusy || !overrideLoaded, onClick: saveOverride }, t("btn.saveInject")),
						h(Btn, { tiny: true, disabled: patchBusy || !overrideLoaded || !defaultOverride, onClick: restoreOverride }, t("btn.restoreInject")),
					),
				),
				h("textarea", {
					className: "dshp-area",
					ref: promptAreaRef,
					value: override,
					onChange: (e) => {
						overrideRef.current = e.target.value;
						setOverride(e.target.value);
					},
					spellCheck: false,
					placeholder: "",
				}),
				promptBoxEmpty(override) ? h("p", {
					className: "dshp-hint",
					style: { margin: "8px 0 0", color: "var(--dshp-danger, #c44)", fontSize: 12 },
				}, t("need.prompt")) : null,
			);
		}

		function ruleLabel(r) {
			if (!r) return "";
			if (r.name !== r.id) return r.name + " (" + r.id + ")";
			return r.id;
		}

		function RulesSection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [st, setSt] = useState(null);
			const [editId, setEditId] = useState(null);
			const [editName, setEditName] = useState("");
			const [editTarget, setEditTarget] = useState("AGENTS.md");
			const [content, setContent] = useState("");
			const [newId, setNewId] = useState("");
			const [newName, setNewName] = useState("");
			const [newTarget, setNewTarget] = useState("AGENTS.md");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });

			const loadStatus = useCallback(() => {
				const tr = tRef.current;
				let cwd = "";
				try { cwd = clientCurrentCwd(); } catch { /* ignore */ }
				rulesApi("status", cwd ? { cwd: cwd } : undefined)
					.then((d) => {
						if (d && d.ok) setSt(d);
						else {
							setSt({ ok: false, rules: [], active: null });
							setNotice({ kind: "error", text: tr("err.rules", { error: (d && d.error) || "bad response" }) });
						}
					})
					.catch((e) => {
						setSt({ ok: false, rules: [], active: null });
						setNotice({ kind: "error", text: tr("err.rules", { error: e.message }) });
					});
			}, []);

			useEffect(() => { loadStatus(); }, [loadStatus]);

			const doPost = useCallback((action, payload, after) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				rulesApi(action, payload)
					.then((d) => {
						if (d && d.ok) {
							setNotice({ kind: "ok", text: t("ok.done") });
							if (action === "save" || action === "activate") warnNeedPrompt(d, t);
							loadStatus();
							if (after) after();
						} else {
							warnNeedPrompt(d, t);
							setNotice({ kind: "error", text: t("err.action", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.action", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [loadStatus, t]);

			const openRule = useCallback((id) => {
				setBusy(true);
				rulesApi("read", { id: id })
					.then((d) => {
						if (d.ok) {
							setEditId(id);
							setEditName(d.name || id);
							setEditTarget(d.target || "AGENTS.md");
							setContent(typeof d.content === "string" ? d.content : "");
						} else setNotice({ kind: "error", text: t("err.read", { error: d.error || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.read", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [t]);

			const clearEditor = () => {
				setEditId(null);
				setEditName("");
				setEditTarget("AGENTS.md");
				setContent("");
			};

			let list;
			if (!st) {
				list = h("div", { className: "dshp-skel", style: { height: 80, margin: 12 } });
			} else if (!st.rules || st.rules.length === 0) {
				list = h("p", { className: "dshp-empty" }, t("rules.empty"));
			} else {
				list = st.rules.map((r) => {
					const isActive = r.id === st.active;
					const isEdit = r.id === editId;
					return h("div", {
						key: r.id,
						className: "dshp-ruleitem" + (isEdit ? " is-edit" : ""),
						role: "button",
						tabIndex: 0,
						onClick: () => openRule(r.id),
						onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRule(r.id); } },
					},
						h("div", { className: "dshp-rule-main" },
							h("span", { className: "dshp-rule-name" },
								ruleLabel(r),
								isActive ? h("span", { className: "dshp-pill is-ok" }, t("pill.current")) : null,
							),
							h("span", { className: "dshp-rule-meta" }, r.target + " · " + formatSize(r.size)),
						),
						h("div", { className: "dshp-rule-ops" },
							h(Btn, {
								tiny: true,
								kind: isActive ? undefined : "primary",
								disabled: busy || isActive,
								onClick: (e) => {
									e.stopPropagation();
									if (!isActive) doPost("activate", { id: r.id });
								},
							}, isActive ? t("btn.inUse") : t("btn.use")),
							h(Btn, {
								tiny: true,
								kind: "danger",
								disabled: busy,
								onClick: (e) => {
									e.stopPropagation();
									if (!window.confirm(t("confirm.delete", { id: r.id }))) return;
									if (editId === r.id) clearEditor();
									doPost("delete", { id: r.id });
								},
							}, t("delete")),
						),
					);
				});
			}

			const policyValue = (st && typeof st.workspace_policy === "string") ? st.workspace_policy : "fallback";
			const policyOptions = (st && Array.isArray(st.workspace_policies) && st.workspace_policies.length) ? st.workspace_policies : ["fallback", "strict", "always"];
			const cwdCandidates = (st && Array.isArray(st.cwd_candidates)) ? st.cwd_candidates : [];
			const cwdValue = (st && typeof st.cwd === "string") ? st.cwd : "";
			return h("section", { className: "dshp-panel", "aria-label": t("rules.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("rules.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } },
						noticeNode(notice),
						h(Btn, {
							tiny: true,
							kind: "danger",
							disabled: busy,
							onClick: () => {
								if (!window.confirm(t("rules.reset.confirm"))) return;
								clearEditor();
								doPost("reset", {});
							},
						}, t("rules.reset")),
					),
				),
				h("div", { className: "dshp-block" },
					h("div", { className: "dshp-policy-row" },
						h("label", { htmlFor: "dshp-policy-select" }, t("policy.title")),
						h("select", {
							id: "dshp-policy-select",
							className: "dshp-field",
							value: policyValue,
							disabled: busy || !st,
							onChange: (e) => doPost("set-policy", { policy: e.target.value }),
						}, policyOptions.map((p) => h("option", { key: p, value: p }, t("policy." + p)))),
					),
					h("p", { className: "dshp-block-hint" }, t("policy.hint")),
				),
				h("div", { className: "dshp-block" },
					h("div", { className: "dshp-block-head" },
						h("h4", null, t("cwd.title")),
						h(Btn, {
							tiny: true,
							disabled: busy,
							onClick: () => {
								let cwd = cwdValue;
								if (!cwd) { try { cwd = clientCurrentCwd(); } catch { /* ignore */ } }
								doPost("scan-cwd", cwd ? { cwd: cwd } : {});
							},
						}, t("cwd.rescan")),
					),
					cwdValue ? h("p", { className: "dshp-cwd-path" }, cwdValue) : null,
					(!st || !cwdValue)
						? h("p", { className: "dshp-empty" }, t("cwd.no.workspace"))
						: (cwdCandidates.length === 0
							? h("p", { className: "dshp-empty" }, t("cwd.empty"))
							: h("div", { className: "dshp-cwd-list" }, cwdCandidates.map((item) => h("label", {
								key: item.path,
								className: "dshp-cwd-item" + (item.selected ? " is-on" : ""),
							},
								h("input", {
									type: "checkbox",
									checked: Boolean(item.selected),
									disabled: busy,
									onChange: (e) => doPost("toggle-cwd", { path: item.path, enabled: e.target.checked }),
								}),
								h("div", { className: "dshp-cwd-main" },
									h("div", { className: "dshp-cwd-name" },
										h("span", null, item.name),
										h("span", { className: "dshp-cwd-badge" }, t("cwd.scope." + (item.scope || "cwd"))),
										h("span", { className: "dshp-cwd-size" }, formatSize(item.size || 0)),
									),
									h("div", { className: "dshp-cwd-sub" }, item.path),
									item.preview ? h("div", { className: "dshp-cwd-prev" }, item.preview) : null,
								),
							)))),
					h("p", { className: "dshp-block-hint" }, t("cwd.hint")),
				),
				h("div", { className: "dshp-block" },
				h("div", { className: "dshp-split" },
					h("div", { className: "dshp-rulelist" },
						h("div", { className: "dshp-rulebody" }, list),
						h("div", { className: "dshp-create" },
							h("div", { className: "dshp-create-row" },
								h("input", { className: "dshp-field", placeholder: t("ph.id"), value: newId, onChange: (e) => setNewId(e.target.value) }),
								h("input", { className: "dshp-field", placeholder: t("ph.alias"), value: newName, onChange: (e) => setNewName(e.target.value) }),
								h("select", { className: "dshp-field", style: { minWidth: 120, flex: "0 0 auto" }, value: newTarget, onChange: (e) => setNewTarget(e.target.value) },
									TARGETS.map((x) => h("option", { key: x, value: x }, x))),
								h(Btn, {
									kind: "primary",
									tiny: true,
									disabled: busy,
									onClick: () => {
										const id = newId.trim();
										if (!id) { setNotice({ kind: "error", text: t("need.id") }); return; }
										const name = newName.trim() || id;
										const target = newTarget;
										doPost("save", { id, content: "", name, target }, () => {
											setEditId(id);
											setEditName(name);
											setEditTarget(target);
											setContent("");
										});
										setNewId(""); setNewName(""); setNewTarget("AGENTS.md");
									},
								}, t("btn.create")),
							),
						),
					),
					h("div", { className: "dshp-editor" },
						editId ? [
							h("div", { key: "meta", className: "dshp-row" },
								h("input", {
									className: "dshp-field", placeholder: t("ph.alias.short"), value: editName,
									onChange: (e) => setEditName(e.target.value),
								}),
								h("select", {
									className: "dshp-field", style: { minWidth: 120 }, value: editTarget,
									onChange: (e) => setEditTarget(e.target.value),
								}, TARGETS.map((x) => h("option", { key: x, value: x }, x))),
							),
							h("textarea", {
								key: "body",
								className: "dshp-area", value: content,
								onChange: (e) => setContent(e.target.value),
								placeholder: "",
							}),
							h("div", { key: "save", className: "dshp-row" },
								h(Btn, {
									kind: "primary",
									disabled: busy,
									onClick: () => doPost("save", { id: editId, content, name: editName, target: editTarget }),
								}, t("btn.saveRule")),
								noticeNode(notice),
							),
						] : h("div", { className: "dshp-editor-empty" }, t("rules.pick")),
					),
				),
				),
			);
		}

		function skillUiAllowed(d) {
			if (!d) return false;
			const ver = String(d.plugin_version || d.localVersion || "").replace(/^v/i, "");
			if (/^1\.1\.11(?:-|$)/.test(ver)) return false;
			const parts = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
			if (!parts) return false;
			if (+parts[1] !== 1) return +parts[1] > 1;
			if (+parts[2] !== 1) return +parts[2] > 1;
			return +parts[3] >= 12;
		}

		function splitListedVersion(raw) {
			const text = String(raw || "").trim().replace(/^v/i, "");
			const cut = text.split("-");
			const core = String(cut[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
			return { core: [core[0] || 0, core[1] || 0, core[2] || 0], pre: cut.slice(1).join("-") };
		}

		function listedVersionNewer(remote, local) {
			if (!remote || !local || String(remote) === String(local)) return false;
			const a = splitListedVersion(remote);
			const b = splitListedVersion(local);
			for (let i = 0; i < 3; i += 1) {
				if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
			}
			if (a.pre && !b.pre) return false;
			if (!a.pre && b.pre) return true;
			return a.pre > b.pre;
		}

		function listedCeiling(versions, localVer) {
			let best = "";
			const rows = (versions || []).slice();
			const local = String(localVer || "").replace(/^v/i, "");
			if (local && !/(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(local)) {
				rows.push({ channel: "stable", version: local });
			}
			for (const item of rows) {
				if (!item || item.channel === "beta") continue;
				const ver = String(item.version || "").replace(/^v/i, "");
				if (!/^\d+\.\d+\.\d+/.test(ver) || /(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(ver)) continue;
				if (!best || listedVersionNewer(ver, best)) best = ver;
			}
			return best;
		}

		function keepListedVersion(item, _ceiling) {
			const ver = String((item && (item.version || item.ref || item.id)) || "");
			if (!item) return false;
			if (item.ref === "beta" || item.id === "beta") return true;
			if (item.channel === "beta") return false;
			if (/(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(ver)) return false;
			return true;
		}

		function preferListed(list, localVer, pin) {
			const pinned = pin ? (list || []).find((item) => item.ref === pin) : null;
			if (pinned) return pinned;
			const ver = String(localVer || "").replace(/^v/i, "");
			const same = (list || []).filter((item) => ver && String(item.version || "").replace(/^v/i, "") === ver);
			if (same.length) {
				return same.find((item) => item.current)
					|| same.find((item) => item.latest)
					|| same[0];
			}
			return (list || []).find((item) => item.current)
				|| (list || []).find((item) => item.latest)
				|| (list || [])[0]
				|| null;
		}

		function versionChoiceLabel(item, tr) {
			const ver = String((item && item.version) || "").replace(/^v/i, "");
			const base = ver ? ("v" + ver) : ((item && (item.label || item.ref)) || "—");
			if (item && item.current) return base + " · " + tr("update.current");
			if (item && item.latest) return base + " · " + tr("update.tip");
			return base;
		}

		function SkillsSection() {
			const t = useT();
			const tRef = useRef(t);
			tRef.current = t;
			const [onBeta, setOnBeta] = useState(false);
			const [st, setSt] = useState(null);
			const [editId, setEditId] = useState(null);
			const [editDesc, setEditDesc] = useState("");
			const [content, setContent] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const zipRef = useRef(null);
			const folderRef = useRef(null);

			const loadStatus = useCallback(() => {
				const tr = tRef.current;
				const fail = (e) => {
					setSt({ ok: false, skills: [] });
					setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? tr("err.skills.needRestart") : tr("err.skills", { error: (e && e.message) || e || "bad response" }),
					});
				};
				const apply = (d) => {
					if (d && d.ok) setSt({ ok: true, skills: d.skills || [] });
					else fail({ message: (d && d.error) || "bad response" });
				};
				apiJson("/dsh-purge/status")
					.then((d) => {
						const allowed = skillUiAllowed(d);
						setOnBeta(allowed);
						if (!allowed) {
							setSt(null);
							return;
						}
						if (d.skills) {
							apply({ ok: true, skills: d.skills });
							return;
						}
						skillsApi("status").then(apply).catch(fail);
					})
					.catch(() => {
						setOnBeta(false);
						setSt(null);
					});
			}, []);

			useEffect(() => { loadStatus(); }, [loadStatus]);

			const doPost = useCallback((action, payload, after) => {
				setBusy(true);
				setNotice({ kind: "idle", text: "" });
				skillsApi(action, payload)
					.then((d) => {
						if (d && d.ok) {
							setNotice({ kind: "ok", text: t("ok.done") });
							loadStatus();
							if (after) after(d);
						} else {
							setNotice({ kind: "error", text: t("err.action", { error: (d && d.error) || "" }) });
						}
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			}, [loadStatus, t]);

			const openSkill = useCallback((id) => {
				setBusy(true);
				skillsApi("read", { id: id })
					.then((d) => {
						if (d.ok) {
							setEditId(id);
							setEditDesc(d.description || "");
							setContent(typeof d.content === "string" ? d.content : "");
						} else setNotice({ kind: "error", text: t("err.read", { error: d.error || "" }) });
					})
					.catch((e) => setNotice({ kind: "error", text: t("err.read", { error: e.message }) }))
					.finally(() => setBusy(false));
			}, [t]);

			const clearEditor = () => {
				setEditId(null);
				setEditDesc("");
				setContent("");
			};

			const readAsBase64 = (file) => new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const text = String(reader.result || "");
					const at = text.indexOf(",");
					resolve(at >= 0 ? text.slice(at + 1) : text);
				};
				reader.onerror = () => reject(new Error(t("need.import")));
				reader.readAsDataURL(file);
			});

			const importZip = (file) => {
				if (!file) {
					setNotice({ kind: "error", text: t("need.import") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				readAsBase64(file)
					.then((data) => skillsApi("import", { data, name: file.name }))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						loadStatus();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			const keepFolderFile = (file) => {
				const rel = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
				if (!rel || rel.includes("..")) return false;
				if (/(^|\/)(node_modules|\.git|__MACOSX|\.system)(\/|$)/i.test(rel)) return false;
				if (/(^|\/)\._/.test(rel) || /\/\.DS_Store$/i.test(rel)) return false;
				return true;
			};

			const importFolder = (list) => {
				const files = Array.from(list || []).filter(keepFolderFile);
				if (!files.length) {
					setNotice({ kind: "error", text: t("err.import.folder") });
					return;
				}
				setBusy(true);
				setNotice({ kind: "ok", text: t("skills.importing") });
				Promise.all(files.map((file) => readAsBase64(file).then((content) => ({
					path: file.webkitRelativePath || file.name,
					content,
					encoding: "base64",
				}))))
					.then((payload) => skillsApi("import", {
						files: payload,
						name: String(payload[0] && payload[0].path || "").split("/")[0],
					}))
					.then((d) => {
						if (!d || !d.ok) throw new Error((d && d.error) || "");
						setNotice({ kind: "ok", text: t("saved.import", { count: (d.imported || []).length || 1 }) });
						loadStatus();
					})
					.catch((e) => setNotice({
						kind: "error",
						text: skillsRouteMissing(e) ? t("err.skills.needRestart") : t("err.action", { error: e.message }),
					}))
					.finally(() => setBusy(false));
			};

			if (!onBeta) return null;

			let list;
			if (!st) {
				list = h("div", { className: "dshp-skel", style: { height: 80, margin: 12 } });
			} else if (!st.skills || st.skills.length === 0) {
				list = h("p", { className: "dshp-empty" }, t("skills.empty"));
			} else {
				list = st.skills.map((item) => {
					const isEdit = item.id === editId;
					return h("div", {
						key: item.id,
						className: "dshp-ruleitem" + (isEdit ? " is-edit" : ""),
						role: "button",
						tabIndex: 0,
						onClick: () => openSkill(item.id),
						onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSkill(item.id); } },
					},
						h("div", { className: "dshp-rule-main" },
							h("span", { className: "dshp-rule-name" }, item.id),
							h("span", { className: "dshp-rule-meta" },
								(item.valid ? item.description : t("skills.invalid")) + " · " + formatSize(item.size),
							),
							item.valid ? h("span", { className: "dshp-rule-meta" },
								[
									item.userInvocable ? t("skills.call.slash", { cmd: "/" + item.id }) : t("skills.call.userOff"),
									item.modelInvocable ? t("skills.call.model") : t("skills.call.modelOff"),
								].join(" · "),
							) : null,
						),
						h("div", { className: "dshp-rule-ops" },
							h(Btn, {
								tiny: true,
								kind: "danger",
								disabled: busy,
								onClick: (e) => {
									e.stopPropagation();
									if (!window.confirm(t("confirm.delete.skill", { id: item.id }))) return;
									if (editId === item.id) clearEditor();
									doPost("delete", { id: item.id });
								},
							}, t("delete")),
						),
					);
				});
			}

			return h("section", { className: "dshp-panel", "aria-label": t("skills.title") },
				h("div", { className: "dshp-head" },
					h("h3", { className: "dshp-title" }, t("skills.title")),
					h("div", { className: "dshp-row", style: { margin: 0 } }, noticeNode(notice)),
				),
				h("p", { className: "dshp-hint", style: { margin: "0 0 10px", color: "var(--dshp-mute)", fontSize: 12 } }, hostText(t, "skills.hint", hostSurfaceOf())),
				h("div", { className: "dshp-split" },
					h("div", { className: "dshp-rulelist" },
						h("div", { className: "dshp-rulebody" }, list),
						h("div", { className: "dshp-create" },
							h("div", { className: "dshp-create-row" },
								h("input", {
									ref: zipRef,
									type: "file",
									accept: ".zip,.tgz,.tar.gz,.tar,.skill",
									style: { display: "none" },
									onChange: (e) => {
										const file = e.target.files && e.target.files[0];
										e.target.value = "";
										importZip(file);
									},
								}),
								h("input", {
									ref: (el) => {
										folderRef.current = el;
										if (!el) return;
										el.setAttribute("webkitdirectory", "");
										el.setAttribute("directory", "");
										el.multiple = true;
									},
									type: "file",
									multiple: true,
									style: { display: "none" },
									onChange: (e) => {
										const files = Array.from((e.target && e.target.files) || []);
										e.target.value = "";
										importFolder(files);
									},
								}),
								h(Btn, {
									kind: "primary",
									tiny: true,
									disabled: busy,
									onClick: () => zipRef.current && zipRef.current.click(),
								}, t("btn.importZip")),
								h(Btn, {
									tiny: true,
									disabled: busy,
									onClick: () => folderRef.current && folderRef.current.click(),
								}, t("btn.importFolder")),
							),
						),
					),
					h("div", { className: "dshp-editor" },
						editId ? [
							h("div", { key: "meta", className: "dshp-row" },
								h("input", {
									className: "dshp-field",
									placeholder: t("ph.skill.desc"),
									value: editDesc,
									onChange: (e) => setEditDesc(e.target.value),
								}),
							),
							h("textarea", {
								key: "body",
								className: "dshp-area",
								value: content,
								onChange: (e) => setContent(e.target.value),
								spellCheck: false,
								placeholder: "",
							}),
							h("div", { key: "save", className: "dshp-row" },
								h(Btn, {
									kind: "primary",
									disabled: busy,
									onClick: () => doPost("save", { id: editId, content, description: editDesc }),
								}, t("btn.saveSkill")),
								noticeNode(notice),
							),
						] : h("div", { className: "dshp-editor-empty" }, t("skills.pick")),
					),
				),
			);
		}

		function reopenAfterRestart() {
			window.location.reload();
		}

		function waitForRestart(setNotice, setBusy, t) {
			const started = Date.now();
			// 必须先看到旧进程掉线，再等新进程就绪；否则同进程立刻 200 会被当成「重启成功」又弹重启。
			let sawDown = false;
			const ping = () => {
				fetch("/dsh-purge/status", { cache: "no-store", credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : Promise.reject()))
					.then((d) => {
						if (!sawDown) {
							retry();
							return;
						}
						if (d && d.ok && d.ready !== false) reopenAfterRestart();
						else retry();
					})
					.catch(() => {
						sawDown = true;
						retry();
					});
			};
			const retry = () => {
				if (Date.now() - started > 90000) {
					setNotice({ kind: "error", text: t("restart.timeout") });
					setBusy(false);
					return;
				}
				setTimeout(ping, 500);
			};
			setTimeout(ping, 800);
		}

		let restartOnce = false;

		/**
		 * 作业已在跑（already）：按 phase 轮询到终态，别把 already 当成「重启已完成」。
		 * 旧逻辑直接 return，作业如果早死了界面会永远显示“正在重启”。（#8）
		 */
		function watchOperation(setNotice, setBusy, t) {
			const started = Date.now();
			const tick = () => {
				if (Date.now() - started > 90000) {
					setNotice({ kind: "error", text: t("restart.timeout") });
					setBusy(false);
					return;
				}
				fetch("/dsh-purge/status", { headers: { accept: "application/json" } })
					.then((r) => r.json())
					.then((d) => {
						const op = (d && d.operation) || null;
						if (op && op.phase === "verified") {
							setNotice({ kind: "ok", text: t("operation.verified") });
							setBusy(false);
							return;
						}
						if (op && (op.phase === "failed" || op.phase === "rolled_back")) {
							setNotice({ kind: "error", text: t("restart.fail", { error: op.error || op.phase }) });
							setBusy(false);
							return;
						}
						setTimeout(tick, 2000);
					})
					.catch(() => setTimeout(tick, 2000));
			};
			setTimeout(tick, 1500);
		}

		function restartDsh(setNotice, setBusy, t, surface) {
			if (restartOnce) return;
			const surf = surface || clientGuessSurface() || "desktop";
			const desktop = surf === "desktop" || clientGuessSurface() === "desktop";
			restartOnce = true;
			setBusy(true);
			setNotice({ kind: "ok", text: hostText(t, "restarting", surf) });
			const stop = (error) => {
				restartOnce = false;
				setNotice({ kind: "error", text: error ? t("restart.fail", { error }) : t("restart.notStarted") });
				setBusy(false);
			};
			let sawDrop = false;
			const watch = setTimeout(() => {
				if (sawDrop) return;
				stop("");
			}, 25000);
			fetch("/dsh-purge/restart", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
				.then((r) => r.json())
				.then((d) => {
					if (!d.ok) throw new Error(d.error || "restart failed");
					const next = (d && d.surface) || surf;
					const full = next === "desktop" || (d && d.fullApp) || desktop;
					if (full && d.already) {
						clearTimeout(watch);
						setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
						watchOperation(setNotice, setBusy, t);
						return;
					}
					if (full && d.restarting === false) {
						clearTimeout(watch);
						stop(d.error || "not started");
						return;
					}
					setNotice({ kind: "ok", text: hostText(t, "restarting", next) });
					if (full) return;
					clearTimeout(watch);
					restartOnce = false;
					waitForRestart(setNotice, setBusy, t);
				})
				.catch((e) => {
					const msg = String((e && e.message) || e || "");
					const dropped = /failed to fetch|networkerror|load failed/i.test(msg) || e.name === "TypeError";
					if (dropped && desktop) {
						sawDrop = true;
						clearTimeout(watch);
						return;
					}
					clearTimeout(watch);
					stop(msg || "restart failed");
				});
		}

		function detectHostTheme() {
			try {
				if (typeof document !== "undefined") {
					const root = document.documentElement;
					if (document.body?.hasAttribute("data-ds-dark-theme") || root?.hasAttribute("data-ds-dark-theme")) return "dusk";
					const scheme = (root.style.colorScheme || getComputedStyle(root).colorScheme || getComputedStyle(root).getPropertyValue("color-scheme") || "").toLowerCase();
					if (scheme.includes("dark")) return "dusk";
					if (scheme.includes("light")) return "white";
				}
				if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
					return "dusk";
				}
			} catch { /* ignore */ }
			return "white";
		}

		function readTheme() {
			return detectHostTheme();
		}

		function SettingsRoot(props) {
			const t = typeof props.t === "function" ? props.t : ((key) => key);
			const [theme, setTheme] = useState(readTheme);
			useEffect(() => {
				let cancelled = false;
				let timer = 0;
				const syncFromHost = () => {
					if (!cancelled) setTheme(detectHostTheme());
				};
				const syncSoon = () => {
					if (timer) window.clearTimeout(timer);
					timer = window.setTimeout(syncFromHost, 50);
				};
				syncFromHost();
				let mq;
				try {
					mq = window.matchMedia?.("(prefers-color-scheme: dark)");
					mq?.addEventListener?.("change", syncFromHost);
				} catch { /* ignore */ }
				let obs;
				try {
					obs = new MutationObserver(syncSoon);
					if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
					obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				} catch { /* ignore */ }
				return () => {
					cancelled = true;
					if (timer) window.clearTimeout(timer);
					try { mq?.removeEventListener?.("change", syncFromHost); } catch { /* ignore */ }
					try { obs?.disconnect(); } catch { /* ignore */ }
				};
			}, []);
			translate = t;
			return h("div", { className: "dshp-root", "data-theme": theme },
				h("style", null, PURGE_CSS),
				h(PurgifySection, null),
				h(RulesSection, null),
				h(SkillsSection, null),
			);
		}

		const REWIND_CSS = `
.dshp-rewind-wrap{position:relative;display:inline-flex}
.dshp-rewind{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-rewind:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-rewind:disabled{opacity:.4;cursor:default}
.dshp-rewind svg{display:block}
.dshp-rewind-menu{position:fixed;z-index:2147483000;box-sizing:border-box;min-width:220px;padding:4px;border:0;border-radius:12px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));transform:translateY(-100%)}
body[data-ds-dark-theme] .dshp-rewind-menu{background:var(--dsw-specific-menu,#32312d);color:var(--dsw-alias-label-primary,#e6e2db);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,#3f3d38);box-shadow:var(--dsw-elevation-prominent,0 10px 28px rgba(0,0,0,.45))}
.dshp-rewind-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:12px/1.3 var(--ds-font-sans,system-ui,sans-serif)}
.dshp-rewind-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshp-rewind-item b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dshp-rewind-item span{color:var(--dsw-alias-label-tertiary,#9a958c);font-size:11px}
body[data-ds-dark-theme] .dshp-rewind-item span{color:var(--dsw-alias-label-tertiary,#a8a39a)}
.dshp-continue{appearance:none;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font:12px/1 var(--ds-font-sans,system-ui,sans-serif);cursor:pointer}
.dshp-continue:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue:disabled{opacity:.4;cursor:default}
.dshp-continue.is-ready{color:var(--dsw-alias-label-primary,currentColor)}
.dshp-continue svg{display:block}
`;
		const DRAFT_KEY = "dshp-rewind-draft:";
		const ARM_KEY = "dshp-rewind-arm:";
		const FILL_DELAYS = [0, 50, 180, 400, 800];
		const ARM_TTL_MS = 45 * 1000;
		let rewindSeenAt = 0;
		let rewindSessions = null;
		let rewindHost = null;
		let rewindWorkspace = null;
		let rewindConversation = null;
		let pendingComposer = { sessionId: "", text: "", at: 0 };
		let armedFill = { sessionId: "", text: "", at: 0 };

		function rewindText(t, key, fallback) {
			try {
				if (typeof t === "function") {
					const value = t(key);
					if (value && value !== key) return value;
				}
			} catch { /* ignore */ }
			return fallback;
		}

		function currentSessionId(sessions) {
			try {
				const selected = rewindWorkspace?.selection?.getSnapshot?.()?.sessionId;
				if (typeof selected === "string" && selected) return selected;
			} catch { /* ignore */ }
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (typeof snap?.current === "string" && snap.current) return snap.current;
			} catch { /* ignore */ }
			return "";
		}

		function sessionKnown(sessions, sessionId) {
			try {
				const snap = sessions?.list?.getSnapshot?.();
				if (!snap || !sessionId) return false;
				if (snap.byId && Object.prototype.hasOwnProperty.call(snap.byId, sessionId)) return true;
				if (Array.isArray(snap.ids) && snap.ids.includes(sessionId)) return true;
			} catch { /* ignore */ }
			return false;
		}

		function waitMs(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}

		function isPluginDraft(text) {
			const value = String(text || "").trim();
			if (!value) return false;
			return /^\[MNEMON\]/i.test(value)
				|| /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value)
				|| /^MNEMON VIEW TOOLS/im.test(value);
		}

		function writeDraft(sessionId, text) {
			if (!sessionId) return;
			const value = isPluginDraft(text) ? "" : (text || "");
			pendingComposer = { sessionId, text: value, at: Date.now() };
			try { sessionStorage.setItem(DRAFT_KEY + sessionId, value); } catch { /* ignore */ }
		}

		function peekDraft(sessionId) {
			if (!sessionId) return "";
			if (pendingComposer.sessionId === sessionId && pendingComposer.text) return pendingComposer.text;
			try { return sessionStorage.getItem(DRAFT_KEY + sessionId) || ""; } catch { return ""; }
		}

		function clearStoredDraft(sessionId) {
			if (!sessionId) return;
			if (pendingComposer.sessionId === sessionId) pendingComposer = { sessionId: "", text: "", at: 0 };
			try { sessionStorage.removeItem(DRAFT_KEY + sessionId); } catch { /* ignore */ }
			try { sessionStorage.removeItem(ARM_KEY + sessionId); } catch { /* ignore */ }
		}

		function armComposerFill(sessionId, text) {
			if (!sessionId || !text || isPluginDraft(text)) return;
			const at = Date.now();
			armedFill = { sessionId, text, at };
			writeDraft(sessionId, text);
			try { sessionStorage.setItem(ARM_KEY + sessionId, String(at)); } catch { /* ignore */ }
		}

		function takeArmedFill(sessionId) {
			if (!sessionId) return "";
			let text = "";
			let at = 0;
			if (armedFill.sessionId === sessionId && armedFill.text) {
				text = armedFill.text;
				at = armedFill.at;
			} else {
				text = peekDraft(sessionId);
				try { at = Number(sessionStorage.getItem(ARM_KEY + sessionId) || 0); } catch { at = 0; }
			}
			if (!text || !at || Date.now() - at > ARM_TTL_MS) {
				if (text && (!at || Date.now() - at > ARM_TTL_MS)) clearStoredDraft(sessionId);
				return "";
			}
			clearStoredDraft(sessionId);
			armedFill = { sessionId: "", text: "", at: 0 };
			return text;
		}

		function conversationFace() {
			if (rewindConversation) return rewindConversation;
			const host = rewindHost;
			if (host?.conversation) return host.conversation;
			if (typeof host?.get === "function") {
				try { return host.get("conversation"); } catch { return undefined; }
			}
			return undefined;
		}

		function conversationInput(sessionId) {
			try {
				const input = conversationFace()?.input;
				if (!input || !sessionId) return null;
				if (typeof input.shell === "function") {
					try { return input.shell(sessionId); } catch { /* session not retained yet */ }
				}
				const sessions = rewindHost?.sessions || rewindSessions;
				const actx = typeof sessions?.scope === "function" ? sessions.scope(sessionId) : undefined;
				if (typeof input.for === "function" && actx) return input.for(actx);
				return null;
			} catch {
				return null;
			}
		}

		function liveDraft(sessionId, inputActions) {
			try {
				const fromActions = inputActions?.state?.getSnapshot?.()?.draft;
				if (typeof fromActions === "string") return fromActions;
			} catch { /* ignore */ }
			try {
				const draft = conversationInput(sessionId)?.state?.getSnapshot?.()?.draft;
				if (typeof draft === "string") return draft;
			} catch { /* ignore */ }
			return "";
		}

		function hostSetDraft(sessionId, text) {
			if (!sessionId) return false;
			try {
				const input = conversationInput(sessionId);
				if (input && typeof input.setDraft === "function") {
					input.setDraft(text || "");
					return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function fillComposer(inputActions, text) {
			if (inputActions && typeof inputActions.setDraft === "function") {
				try { inputActions.setDraft(text || ""); } catch { /* ignore */ }
			}
		}

		function scheduleComposerFill(sessionId, text, inputActions) {
			if (!sessionId || !text || isPluginDraft(text)) return () => {};
			let stopped = false;
			let filled = false;
			const timers = [];
			const tryFill = () => {
				if (stopped) return;
				const current = liveDraft(sessionId, inputActions);
				if (filled && current !== text) {
					stopped = true;
					return;
				}
				if (current && current !== text) {
					stopped = true;
					return;
				}
				fillComposer(inputActions, text);
				hostSetDraft(sessionId, text);
				filled = true;
			};
			for (const ms of FILL_DELAYS) timers.push(window.setTimeout(tryFill, ms));
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		function scheduleEchoClear(sessionId, inputActions) {
			if (!sessionId) return () => {};
			let last = "";
			let stopped = false;
			const timers = [];
			const tryClear = () => {
				if (stopped || !last) return;
				const current = String(liveDraft(sessionId, inputActions) || "").trim();
				if (!current) {
					stopped = true;
					return;
				}
				if (current !== last) return;
				fillComposer(inputActions, "");
				hostSetDraft(sessionId, "");
				clearStoredDraft(sessionId);
				stopped = true;
			};
			apiJson("/dsh-purge/last-user?sessionId=" + encodeURIComponent(sessionId)).then((data) => {
				if (stopped) return;
				last = String(data?.text || "").trim();
				if (!last || isPluginDraft(last)) return;
				tryClear();
				for (const ms of [0, 50, 180, 400]) timers.push(window.setTimeout(tryClear, ms));
			}).catch(() => {});
			return () => {
				stopped = true;
				for (const t of timers) { try { window.clearTimeout(t); } catch { /* ignore */ } }
			};
		}

		async function dropInheritedQueue(sessions, sessionId) {
			if (!sessions || !sessionId) return;
			const drop = async () => {
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sessionId) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const queue = face?.getSnapshot?.()?.queue || [];
					for (const item of queue) {
						const id = item?.id || item?.itemId;
						if (!id) continue;
						try { await face.updateQueue?.(id, { kind: "remove" }); } catch { /* ignore */ }
					}
				} catch { /* ignore */ }
			};
			await drop();
			window.setTimeout(() => { drop(); }, 80);
		}

		async function openRewoundSession(sessions, sessionId) {
			if (!sessionId) return;
			const workspace = rewindWorkspace;
			let lastError = null;
			for (let attempt = 0; attempt < 25; attempt += 1) {
				if (sessions && typeof sessions.refresh === "function" && !sessionKnown(sessions, sessionId)) {
					try { await sessions.refresh(); } catch (error) { lastError = error; }
				}
				const known = sessionKnown(sessions, sessionId);
				if (known || typeof sessions?.open === "function") {
					try {
						if (workspace && typeof workspace.openSession === "function") {
							workspace.openSession(sessionId);
						} else if (typeof sessions?.open === "function") {
							sessions.open(sessionId);
						} else {
							throw new Error("无法打开回退后的会话");
						}
						const selected = workspace?.selection?.getSnapshot?.()?.sessionId;
						if (!workspace || selected === sessionId) {
							await dropInheritedQueue(sessions, sessionId);
							window.setTimeout(() => { dropInheritedQueue(sessions, sessionId); }, 250);
							return;
						}
					} catch (error) {
						lastError = error;
					}
				}
				await waitMs(120);
			}
			throw new Error((lastError && lastError.message) || "回退后的会话没有打开");
		}

		class RewindSafe extends Component {
			constructor(p) { super(p); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			componentDidCatch(error) { try { console.error("[dsh-purge] rewind slot:", error); } catch { /* ignore */ } }
			render() {
				if (this.state.failed) return h(RewindFallback, this.props);
				return h(RewindButton, this.props);
			}
		}

		class ContinueSafe extends Component {
			constructor(p) { super(p); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			componentDidCatch(error) { try { console.error("[dsh-purge] continue slot:", error); } catch { /* ignore */ } }
			render() {
				if (this.state.failed) {
					return h("button", {
						type: "button",
						className: "dshp-continue",
						title: rewindText(translate, "continue.label", "继续"),
						onMouseDown: (e) => e.preventDefault(),
						onClick: async () => {
							const sessionId = currentSessionId(rewindSessions);
							if (!sessionId) return;
							try {
								const data = await apiJson("/dsh-purge/continue", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ sessionId, force: true }),
								});
								if (!data || !data.ok) throw new Error((data && data.error) || "continue");
							} catch (e) {
								window.alert(rewindText(translate, "continue.fail", "继续失败: {error}").replace("{error}", String((e && e.message) || e)));
							}
						},
					}, rewindText(translate, "continue.label", "继续"));
				}
				return h(ContinueButton, this.props);
			}
		}

		function ContinueButton(props) {
			const t = props.t || translate;
			const sessions = rewindSessions;
			const sessionId = props.sessionId || currentSessionId(sessions);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [info, setInfo] = useState(null);

			useEffect(() => {
				if (!sessionId) {
					setInfo(null);
					return;
				}
				let cancelled = false;
				const tick = () => {
					apiJson("/dsh-purge/continue?sessionId=" + encodeURIComponent(sessionId))
						.then((data) => { if (!cancelled && data && data.ok) setInfo(data); })
						.catch(() => {});
				};
				tick();
				const timer = window.setInterval(tick, 1200);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, [sessionId]);

			const canContinue = Boolean(info && info.canContinue);
			const left = info ? Math.max(0, (info.continueMax || 0) - (info.continueUsed || 0)) : 0;
			const runContinue = async () => {
				if (!sessionId || busy || !canContinue) return;
				setBusy(true);
				setNotice("");
				try {
					const data = await apiJson("/dsh-purge/continue", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId }),
					});
					if (!data || !data.ok) throw new Error((data && data.error) || "continue");
					setInfo((prev) => prev ? { ...prev, ...data, canContinue: false, continueUsed: data.used } : data);
				} catch (e) {
					setNotice(rewindText(t, "continue.fail", "继续失败: {error}").replace("{error}", String((e && e.message) || e)));
				} finally {
					setBusy(false);
				}
			};

			const label = busy
				? rewindText(t, "continue.busy", "继续中…")
				: rewindText(t, "continue.label", "继续");
			const title = notice
				|| (canContinue
					? rewindText(t, "continue.ready", "继续（还可 {left} 次）").replace("{left}", String(left))
					: (info && info.reason && left <= 0
						? rewindText(t, "continue.limit", "已达继续上限")
						: rewindText(t, "continue.aria", "异常停止后继续")));
			return h("button", {
				type: "button",
				className: "dshp-continue" + (canContinue ? " is-ready" : ""),
				title,
				"aria-label": rewindText(t, "continue.aria", "异常停止后继续"),
				disabled: busy || !sessionId || !canContinue,
				onMouseDown: (e) => e.preventDefault(),
				onClick: (e) => {
					e.preventDefault();
					e.stopPropagation();
					runContinue();
				},
			},
				h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
					h("path", { fill: "currentColor", d: "M4.2 2.8v10.4L13 8 4.2 2.8z" }),
				),
				label,
			);
		}

		function rewindMenuNode(t, menuPos, menuRef, runRewind) {
			const menu = h("div", {
				className: "dshp-rewind-menu",
				role: "menu",
				ref: menuRef,
				style: menuPos ? { left: menuPos.left + "px", top: menuPos.top + "px" } : { left: "8px", bottom: "48px", transform: "none" },
			},
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("once"); },
				},
					h("b", null, rewindText(t, "rewind.once", "Undo last step")),
					h("span", null, rewindText(t, "rewind.once.hint", "Withdraw the last step into a new session that keeps earlier context; the line returns to the box")),
				),
				h("button", {
					type: "button",
					className: "dshp-rewind-item",
					onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); },
					onClick: (e) => { e.preventDefault(); e.stopPropagation(); runRewind("round"); },
				},
					h("b", null, rewindText(t, "rewind.round", "Undo last turn")),
					h("span", null, rewindText(t, "rewind.round.hint", "Withdraw the last turn (and its subagents) into a new session that keeps earlier context; the line returns to the box")),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined") {
					return rd.createPortal(menu, document.body);
				}
			} catch { /* 没有 portal 时菜单仍挂在按钮旁 */ }
			return menu;
		}

		class RewindFallback extends Component {
			constructor(p) {
				super(p);
				this.state = { menu: false, busy: false, notice: "", menuPos: null };
				this.wrap = null;
				this.menuEl = null;
				this.onDoc = (event) => {
					if (this.wrap && this.wrap.contains(event.target)) return;
					if (this.menuEl && this.menuEl.contains(event.target)) return;
					this.setState({ menu: false });
				};
			}
			componentDidMount() {
				document.addEventListener("mousedown", this.onDoc);
			}
			componentWillUnmount() {
				document.removeEventListener("mousedown", this.onDoc);
			}
			run(mode) {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				if (!sessionId || this.state.busy) return;
				this.setState({ busy: true, menu: false, notice: "" });
				apiJson("/dsh-purge/rewind", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, mode }),
				}).then(async (data) => {
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || "没有清掉之前发送的内容");
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(rewindSessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
					this.setState({ busy: false });
				}).catch((e) => {
					this.setState({
						busy: false,
						notice: "回退失败: " + String((e && e.message) || e),
					});
				});
			}
			openMenu() {
				const rect = this.wrap && this.wrap.getBoundingClientRect ? this.wrap.getBoundingClientRect() : null;
				this.setState({
					menu: !this.state.menu,
					notice: "",
					menuPos: rect ? { left: Math.max(8, rect.right - 228), top: Math.max(8, rect.top - 8) } : null,
				});
			}
			render() {
				const sessionId = this.props.sessionId || currentSessionId(rewindSessions);
				const t = this.props.t || translate;
				const label = this.state.busy ? "回退中…" : (this.state.notice ? this.state.notice.slice(0, 18) : "回退");
				return h("div", { className: "dshp-rewind-wrap", ref: (node) => { this.wrap = node; } },
					h("style", null, REWIND_CSS),
					h("button", {
						type: "button",
						className: "dshp-rewind",
						disabled: this.state.busy || !sessionId,
						onMouseDown: (e) => e.preventDefault(),
						onClick: (e) => { e.preventDefault(); this.openMenu(); },
					}, label),
					this.state.menu ? rewindMenuNode(t, this.state.menuPos, (node) => { this.menuEl = node; }, (mode) => this.run(mode)) : null,
				);
			}
		}

		function RewindButton(props) {
			const t = props.t || translate;
			const sessions = rewindSessions;
			const inputActions = props.inputActions;
			const sessionId = props.sessionId || currentSessionId(sessions);
			const wrapRef = useRef(null);
			const menuRef = useRef(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const [menu, setMenu] = useState(false);
			const [menuPos, setMenuPos] = useState(null);

			useEffect(() => {
				if (!sessionId) return;
				const armed = takeArmedFill(sessionId);
				if (armed) {
					scheduleComposerFill(sessionId, armed, inputActions);
					return;
				}
				scheduleEchoClear(sessionId, inputActions);
			}, [sessionId, inputActions]);

			useEffect(() => {
				if (!menu) return;
				const onDoc = (event) => {
					if (wrapRef.current && wrapRef.current.contains(event.target)) return;
					if (menuRef.current && menuRef.current.contains(event.target)) return;
					setMenu(false);
				};
				document.addEventListener("mousedown", onDoc);
				return () => document.removeEventListener("mousedown", onDoc);
			}, [menu]);

			const runRewind = async (mode) => {
				if (!sessionId || busy) return;
				setBusy(true);
				setMenu(false);
				setNotice("");
				try {
					const data = await apiJson("/dsh-purge/rewind", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, mode }),
					});
					if (!data || !data.ok || !data.sessionId || data.cleared === false) {
						throw new Error((data && data.error) || "没有清掉之前发送的内容");
					}
					if (data.at) rewindSeenAt = data.at;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch (e) {
					const message = rewindText(t, "rewind.fail", "回退失败: {error}").replace("{error}", String((e && e.message) || e));
					setNotice(message);
				} finally {
					setBusy(false);
				}
			};

			const onClick = (event) => {
				event?.preventDefault?.();
				event?.stopPropagation?.();
				if (!sessionId || busy) return;
				if (menu) {
					setMenu(false);
					return;
				}
				const rect = wrapRef.current?.getBoundingClientRect?.();
				if (rect) {
					setMenuPos({
						left: Math.max(8, rect.right - 228),
						top: Math.max(8, rect.top - 8),
					});
				}
				setNotice("");
				setMenu(true);
			};

			const failLabel = notice
				? (notice.length > 18 ? notice.slice(0, 18) + "…" : notice)
				: "";
			const label = busy
				? rewindText(t, "rewind.busy", "回退中…")
				: (failLabel || rewindText(t, "rewind.label", "回退"));
			const title = notice || rewindText(t, "rewind.aria", "回退");
			return h("div", { className: "dshp-rewind-wrap", ref: wrapRef },
				h("style", null, REWIND_CSS),
				h("button", {
					type: "button",
					className: "dshp-rewind",
					title,
					"aria-label": rewindText(t, "rewind.aria", "回退"),
					"aria-expanded": menu ? "true" : "false",
					disabled: busy || !sessionId,
					onMouseDown: (e) => e.preventDefault(),
					onClick,
				},
					h("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true },
						h("path", {
							fill: "currentColor",
							d: "M7.2 3.2 3.4 7l3.8 3.8V8.6c2.8 0 4.7.7 5.9 2.3-.2-2.8-1.9-5.2-5.9-5.6V3.2z",
						}),
					),
					label,
				),
				menu ? rewindMenuNode(t, menuPos, menuRef, runRewind) : null,
			);
		}

		function installRewindWatch(ctx) {
			const sessions = ctx.sessions;
			if (!sessions) return () => {};
			const tick = async () => {
				try {
					const data = await apiJson("/dsh-purge/rewind");
					if (!data || !data.sessionId || !data.at || data.at <= rewindSeenAt) return;
					rewindSeenAt = data.at;
					const current = currentSessionId(sessions);
					if (current && current !== data.parentId) return;
					const text = isPluginDraft(data.text) ? "" : (data.text || "");
					armComposerFill(data.sessionId, text);
					scheduleComposerFill(data.sessionId, text);
					await openRewoundSession(sessions, data.sessionId);
					scheduleComposerFill(data.sessionId, text);
				} catch { /* ignore */ }
			};
			const timer = window.setInterval(tick, 1200);
			return () => window.clearInterval(timer);
		}

		/* __DSH_PURGE_DRILL_BEGIN__ */
		// 内嵌演练台（源码在 lib/redteam，已并进本插件）
		const __dshPurgeDrill = (() => {
			var module = { exports: {} };
			var exports = module.exports;

    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /*
     * 演练台自己是一块浮动窗：position:fixed，用 left/top/width/height 放。
     * 不给官方 frame 加 padding，不改官方输入框的宽度。嵌在清洗面板里时走 .rt-embedded。
     */
    const CSS = `
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 52%,transparent);
  backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 70%,transparent);
  border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,#000 28%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 未读红点：该页签有新内容（新资产/新漏洞/新得分/新步骤…），点开看过就消失 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, #ef4444 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1c);color:var(--dsw-alias-label-primary,#f2f2f2)}
.rt-eng-select{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--dsw-alias-bg-layer-2,#2a2a2a)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}
/* 纪律提示条：不满足交付要求（非冰蝎/哥斯拉马、没有 suo5 隧道）时顶在区块最上方 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed #ef444488;background:#ef44440f;color:var(--dsw-alias-label-primary)}
.rt-hint b{color:#ef4444}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 图谱视图已移除（见 AssetsTab：资产关系由「域名维度」与 redteam_attack_path 工具承担） */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#2a2a2a) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-scope-testing{color:#5b21b6;background:#ddd6fe}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 得分目标按合并版的 8 个类别分组：类别头 + 组内按分值升序 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 会话与入口：每张卡片分「标题行 / 关键事实 / 可用命令 / 备注」四段，避免一行糊在一起 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 折叠层次体系 ─────────────────────────────────────────────────────────────
   L1 折叠头 .rt-sec   ：通栏、无圆角无边框、左色条、深底 —— 永远是"扁"的
   L2 内容卡 .rt-atest/.rt-hit/.rt-cred/.rt-evi：内缩、有边框、圆角 —— 立起来
   L3 详情/长文本 .rt-clip-body / .rt-evi-body ：无边框、最浅、等宽
   L4 子项容器 .rt-sec-body：左缩进 + 竖引导线，表明"属于上面那个头"
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:#8b5cf6}
.rt-sec.t-target{border-left-color:#0ea5e9}
.rt-sec.t-folder{border-left-color:#64748b}
.rt-sec.t-test{border-left-color:#10b981}
.rt-sec.t-queue{border-left-color:#f59e0b}
.rt-sec.t-past{border-left-color:#94a3b8}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 长文本折叠（L3）：默认预览 2 行并渐隐，展开后限高滚动 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:#10b981;color:#fff;font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:#94a3b8}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:#065f46;
  background:#a7f3d0;border:1px solid #10b98155;border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid #10b981;border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:#94a3b8;opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:#10b981;font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 报告里的「这一步怎么来的」：动作步骤 / 命令 / 凭据 / 隧道 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 全链路攻击路径图 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid #64748b;border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid #64748b;background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border:1px solid #10b98155;border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 按服务封顶/自建而不计分的命中：分值标灰（+0），避免看着像又加了分 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 横向路径图 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid #64748b;border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 资产与内容都自适应换行：长域名/长口令/长结果一律换行显示，不截断成省略号 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 自己注册/自建的账号：留痕但不计分，整行压暗 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid #ef444488}
/* 同一资产同一端口的重复账号/库权限：服务已拿满，不计分（只作留痕） */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid #f59e0b88}
.rt-hit-row.service-capped .rt-hit-idx{background:#f59e0b}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid #64748b;border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 折叠后仍要能一眼看到"这一阶段拿了多少分"，所以分数留在头上 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 知识库（POC/EXP） ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库归类总览：一行标签，点一下按该类筛选 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库分组标题（按归类分组时每组一条） */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 技能可用性徽章（技能库页签） */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-avail-broken{color:#ef4444;border-color:#ef444455;background:#ef44441a}
.rt-avail-unknown{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
/* 版本 / 更新弹窗 */
.rt-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:#fff;background:#64748b;flex:none}
.rt-kb-kind.k-exp{background:#ef4444}
.rt-kb-kind.k-poc{background:#f59e0b}
.rt-kb-kind.k-template{background:#8b5cf6}
.rt-kb-kind.k-script{background:#0ea5e9}
.rt-kb-kind.k-payload{background:#10b981}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 本机 nuclei 模板命中：路径要能完整看到（复制成命令直接跑） */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:#0b1020;
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}`    /* ---------------------------------------------------------- 桥接与状态 */
    /** 是否在「全面浏览」独立窗口里（URL hash 标记，复用同一套界面代码）。 */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then((res) => res.json())

    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      const snap = Object.assign({}, ui)
      for (const f of Array.from(subs)) {
        try { f(snap) } catch { /* ignore subscriber errors */ }
      }
    }
    /* 保留导出。面板尺寸只写在自己的元素上，不再改官方 frame 的宽度。 */
    let dockWidthTag = null
    const setDockWidth = () => {}
    const useUI = () => {
      const [st, setSt] = React.useState(() => Object.assign({}, ui))
      React.useEffect(() => {
        const f = (snap) => setSt(Object.assign({}, snap || ui))
        subs.add(f)
        setSt(Object.assign({}, ui))
        return () => { subs.delete(f) }
      }, [])
      return st
    }

    /* 知识库归类（与 core.js 的 POC_CATEGORIES 一致；面板按它分组） */
    const POC_CAT_NAME = {
      rce: 'Remote Code Execution', deserialization: 'Deserialization', 'file-upload': 'File Upload / WebShell',
      sqli: 'SQL Injection', unauthorized: 'Unauthorized Access', 'auth-bypass': 'Authentication Bypass / BOLA',
      'weak-password': 'Weak Password / Brute Force', ssrf: 'SSRF', xxe: 'XXE',
      'path-traversal': 'Directory Traversal / File Read', 'info-leak': 'Information Disclosure',
      privesc: 'Privilege Escalation / Lateral', tunnel: 'Tunnel / Proxy', other: 'Other',
    }
    const POC_CAT_ORDER = Object.keys(POC_CAT_NAME)
    /* 角色 code → 中文（报告/知识库都要标"谁发现的"） */
    const ROLE_LABEL = {
      plan: 'Main Session (Command)', recon: 'Reconnaissance', assess: 'Asset Inventory',
      'vuln-scan': 'Vulnerability Scanning', exploit: 'Exploitation', internal: 'Intranet Pivoting',
    }

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const shotCache = new Map()
    const shotLoading = new Map()
    const shotSrc = (eng, id) => shotCache.get(eng + ':' + id) || null
    const loadShot = (eng, id) => {
      const key = eng + ':' + id
      if (shotCache.has(key) || shotLoading.has(key)) return
      const p = api({ op: 'shotData', engagement: eng, id: id }).then((r) => {
        shotCache.set(key, r && r.base64 ? 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64 : '')
        shotLoading.delete(key)
        const snap = Object.assign({}, ui)
        for (const f of Array.from(subs)) {
          try { f(snap) } catch { /* ignore subscriber errors */ }
        }
      }).catch(() => { shotLoading.delete(key) })
      shotLoading.set(key, p)
    }
    const SHOT_KIND = { screenshot: 'Live Screenshot', card: 'Generated Evidence Card' }
    const ShotImage = ({ eng, shot, height }) => {
      const [zoom, setZoom] = React.useState(false)
      const src = shotSrc(eng, shot.id)
      if (src === null) { loadShot(eng, shot.id); }
      const card = shot.kind === 'card'
      return h('div', { className: 'rt-shot' },
        src === null
          ? h('div', { className: 'rt-shot-thumb rt-shot-loading', style: { height: (height || 96) + 'px' } }, 'Loading...')
          : h('img', {
              className: 'rt-shot-thumb', src: src, alt: shot.label || ('Evidence ' + shot.id),
              style: { height: (height || 96) + 'px', cursor: 'zoom-in' },
              onClick: () => setZoom(true),
            }),
        h('div', { className: 'rt-shot-cap' },
          h('span', { className: 'rt-tag ' + (card ? 'rt-tag-warn' : 'rt-tag-live'), title: card
            ? 'Excerpt generated from logs, not a live screenshot — noted as such in report'
            : 'Live Screenshot' }, SHOT_KIND[shot.kind] || shot.kind || 'Evidence'),
          h('span', { className: 'rt-shot-label', title: shot.label || shot.note || '' },
            shot.label || shot.target || ('#' + shot.id))),
        zoom
          ? h('div', { className: 'rt-shot-zoom', onClick: () => setZoom(false) },
              h('img', { src: src, alt: shot.label || '' }),
              h('div', { className: 'rt-shot-zoom-cap' }, (shot.label || shot.target || '')
                + (card ? ' · Generated from logs (not live screenshot)' : '')
                + (shot.captured_at ? '　·　' + fmt(shot.captured_at) : '')
                + ' · Click anywhere to close'))
          : null)
    }
    const ShotStrip = ({ eng, shots, total, title }) => {
      const list = shots || []
      if (list.length === 0) return null
      return h('div', { className: 'rt-shots' },
        h('div', { className: 'rt-shots-head' },
          h('b', null, title || 'Evidence Screenshots'),
          h('span', { className: 'rt-shots-n' }, 'Showing ' + list.length + ' images'
            + (total && total > list.length ? ' (' + total + ' total for this point, showing samples)' : ''))),
        h('div', { className: 'rt-shot-row' }, list.map((sh) => h(ShotImage, { key: 'sh' + sh.id, eng: eng, shot: sh }))))
    }
    /** 发现时间在列表里只留「月-日 时:分」：整行宽度紧张，完整时间进悬浮提示 */
    const fmtShort = (s) => {
      const t = String(s || '').replace('T', ' ')
      return t.length >= 16 ? t.slice(5, 16) : (t || '—')
    }
    const provLabel = (p) => (p === 'passive' ? 'Passive' : p === 'active' ? 'Active' : 'Unknown')

    /**
     * 给「可点击但不是 <button>」的元素补上键盘可达性，返回可直接展开进 props 的对象。
     *
     * 为什么需要：面板里大量用 div/span 当按钮（表格行、页签、结论条、C 段条目…），
     * 它们鼠标能点、键盘完全够不着 —— 而这类元素此前有 16 处是各写各的，
     * 写法还不一致（有的只有 role、有的漏了 Space 键）。
     * 统一到一个工厂后，新增可点击元素只要 `...clickable(fn, { label })` 就有完整语义。
     *
     * 注意：**不要**用它包真正的 `<button>`（原生按钮自带全部语义）。
     * @param onActivate - 激活回调（鼠标点击 / Enter / Space 都走它）。
     * @param options - `{ label?, expanded? }`：label 进 aria-label，expanded 进 aria-expanded。
     * @returns props 片段：role / tabIndex / onClick / onKeyDown / aria-*
     */
    const clickable = (onActivate, options = {}) => {
      const props = {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (e) => {
          /* Enter 与 Space 是按钮的标准激活键；Space 还要阻止页面滚动 */
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate(e)
          }
        },
      }
      if (options.label !== undefined) props['aria-label'] = String(options.label)
      if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false'
      return props
    }

    /**
     * 复制文本到剪贴板，**返回真实的成功与否**。
     *
     * clipboard API 在非安全上下文（http + 非 localhost）、页面失焦、权限被拒时都会
     * 返回被拒绝的 Promise —— 同步 try/catch 抓不到，于是界面会显示"已复制"而剪贴板是空的。
     * 这里 await 真实结果，并在不可用时退回 execCommand('copy')（老浏览器/非安全上下文仍可用）。
     * @param text - 要复制的文本。
     * @returns Promise<boolean>
     */
    const copyText = async (text) => {
      const value = text === undefined || text === null ? '' : String(text)
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch (e) { /* 落到下面的兜底方案 */ }
      /* 兜底：临时 textarea + execCommand —— 非安全上下文里唯一还能用的办法 */
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const okFlag = document.execCommand('copy')
        document.body.removeChild(ta)
        return okFlag === true
      } catch (e) { return false }
    }

    /**
     * 复制并给出**如实**的界面反馈（成功/失败文案统一）。
     * @param text - 要复制的文本。
     * @param label - 成功时提示里显示的名字。
     * @param onResult - 可选回调：`(ok, message) => void`；不传时返回 Promise<boolean>。
     */
    const copyWithFeedback = async (text, label, onResult) => {
      const okFlag = await copyText(text)
      const message = okFlag ? 'Copied: ' + label : 'Copy failed (clipboard not allowed) - please copy manually'
      if (typeof onResult === 'function') onResult(okFlag, message)
      return okFlag
    }

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, 'Unknown')
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: 'Untested', testing: 'Testing', tested: 'Tested', blocked: 'Blocked', abandoned: 'Abandoned', no_surface: 'No Surface' }
    const PRI_LABEL = { high: 'High', medium: 'Med', low: 'Low' }

    /** 资产易打性徽章。 */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, 'Unrated')
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** 资产测试状态徽章。 */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- 资产测绘 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      /* 左侧「外网 C 段 / 内网 C 段」两组各自折叠，状态按靶标记住 */
      const sideCollapse = useCollapse('assets-side:' + eng)
      const seq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || 'Query failed', total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* C 段/统计可能因本轮采集新增：让外层重新拉一次快照，左侧分类立即更新 */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])


      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', Object.assign({
        key: 'all', className: 'rt-seg' + (cidr === null && view !== 'testing' ? ' on' : ''),
      }, clickable(() => { setView('list'); setCidr(null) }, { label: 'All CIDRs', expanded: cidr === null && view !== 'testing' })),
        h('div', { className: 'rt-seg-cidr' }, 'All Subnets'),
        h('div', { className: 'rt-seg-meta' }, segs.length + ' Subnets')))
      sideChildren.push(h('div', Object.assign({
        key: 'testing', className: 'rt-seg' + (view === 'testing' ? ' on' : ''),
        title: 'Running scans and probes (auto-refreshes every 5s)',
      }, clickable(() => { setView('testing'); setCidr(null) }, { label: 'Current Testing', expanded: view === 'testing' })),
        h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
          h('span', { className: 'rt-scope rt-scope-testing', title: 'Active testing' }, 'Test'),
          h('span', { style: { flex: 1 } }, 'Current Testing')),
        h('div', { className: 'rt-seg-meta' }, 'Active scans & probes')))
      /* C 段按内外网分组：先外网（互联网可达，通常是入口）再内网（打进去之后才看得到） */
      const segBlock = (title, list, kind) => {
        /* 外网 / 内网两组各自可折叠（状态按靶标记住），默认展开 */
        const open = sideCollapse.isOpen('scope:' + kind, true)
        const toggle = sideCollapse.toggle('scope:' + kind, true)
        const out = [h('div', {
          key: 'h' + kind, className: 'rt-sidehead rt-sidehead-btn',
          role: 'button', tabIndex: 0, 'aria-expanded': open ? 'true' : 'false',
          title: (open ? 'Collapse group' : 'Expand group') + ' (switch to asset list)',
          onClick: () => { setView('list'); toggle() },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('list'); toggle(e) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? 'Intranet' : 'External'),
          h('span', null, title + ' · ' + list.length + ' CIDRs'),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + ' assets'))]
        if (!open) return out
        for (const s of list) {
          /* 一段一行：只给 C 段 + 资产数（端口数不再占位，归属与存活放进悬浮提示） */
          out.push(h('div', Object.assign({
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            title: (s.org || 'Unknown Org') + ' · Live ' + (s.live || 0) + '/' + (s.assets || 0) + ' hosts',
          }, clickable(() => { setView('list'); setCidr(s.cidr) },
            { label: 'Filter CIDR ' + s.cidr, expanded: cidr === s.cidr && view !== 'testing' })),
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? 'Int' : 'Ext'),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + ' hosts'))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock('External Assets', segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock('Internal Assets', segInternal, 'internal'))
      const side = h('div', { className: 'rt-side' }, sideChildren)

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 150px' }, placeholder: 'Search IP / Domain / Fingerprint (Enter)',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, 'Search'),
        h('input', {
          className: 'rt-input', style: { width: '78px' }, placeholder: 'Service',
          value: service, onChange: (e) => setService(e.target.value),
        }),
        h('input', {
          className: 'rt-input', style: { width: '60px' }, placeholder: 'Port',
          value: port, onChange: (e) => setPort(e.target.value),
        }),
        h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
          h('option', { value: '' }, 'All Networks'),
          h('option', { value: 'external' }, 'External Assets Only'),
          h('option', { value: 'internal' }, 'Internal Assets Only')),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: 'Filter by port discovery source' },
          h('option', { value: '' }, 'All Sources'),
          h('option', { value: 'passive' }, 'Passive Only'),
          h('option', { value: 'active' }, 'Active Only')),
        h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
          h('option', { value: '' }, 'All Exploitability'),
          h('option', { value: 'high' }, 'High Exploitability'),
          h('option', { value: 'medium' }, 'Medium Exploitability'),
          h('option', { value: 'low' }, 'Low Exploitability')),
        h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
          h('option', { value: '' }, 'All Statuses'),
          h('option', { value: 'untested' }, 'Untested'),
          h('option', { value: 'testing' }, 'Testing'),
          h('option', { value: 'tested' }, 'Tested'),
          h('option', { value: 'blocked' }, 'Blocked'),
          h('option', { value: 'abandoned' }, 'Abandoned'),
          h('option', { value: 'no_surface' }, 'No Attack Surface')),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn', title: 'Refresh snapshot and current view data', onClick: () => { if (onRefresh) onRefresh() } }, 'Refresh'),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, 'List'),
        h('button', { className: 'rt-btn' + (view === 'timeline' ? ' rt-btn-primary' : ''), title: 'View assets by discovery timeline', onClick: () => setView('timeline') }, 'Timeline'),
        h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), onClick: () => setView('domain') }, 'Domains'),
        h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), onClick: () => setView('web') }, 'Web'))

      /* ── 结论行：一屏看清家底，数字点一下就是筛选 ───────────────────── */
      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: 'Click to filter / click again to clear',
      }, clickable(onClick, { label: 'Filter by "' + label + '" (' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl' },
        conclItem('all', 'Assets', snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', 'Live', snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', 'Untested', tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', 'Testing', tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', 'Tested', tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', 'Abandoned', (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: 'Sort order',
        },
          h('option', { value: 'priority' }, 'Sort: Exploitability'),
          h('option', { value: 'todo' }, 'Sort: Pending First'),
          h('option', { value: 'discovered' }, 'Sort: Newest First'),
          h('option', { value: 'ports' }, 'Sort: Most Ports'),
          h('option', { value: 'ip' }, 'Sort: IP')))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, 'Exploitability'), h('span', null, 'Status'),
        h('span', null, 'Open Ports / Services'), h('span', null, 'Fingerprints'))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* 端口最多列 3 个，其余用 +N；主被动来源不再占列，进详情 */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', Object.assign({
          key: 'r' + it.id, className: 'rt-row',
        }, clickable(() => toggleRow(it.id), { label: 'Expand asset ' + it.ip, expanded: openId === it.id })),
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? 'Int' : 'Ext'),
            h('span', {
              title: it.state === 'live' ? 'Live' : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? '#10b981' : '#94a3b8',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip),
            /* 发现时间挂在 IP 下面一行：IP 列宽度有限，不另开列（列宽一改整表要跟着调） */
            h('span', {
              style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
              title: 'Discovered: ' + (it.discovered_at ? fmt(it.discovered_at) : 'Not recorded')
                + (it.last_seen ? '\nLast seen: ' + fmt(it.last_seen) : ''),
            }, it.discovered_at ? fmtShort(it.discovered_at) : 'Discovered: unknown')),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455', marginLeft: 4 } }, 'Block ' + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || 'Unknown Service'),
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '（' + f.evidence + '）' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || 'Unknown Tool') + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        /* 详情分三层：3 行必读 → 「展开全部」后才是溯源、原始记录与备注全文 */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* 必读三行 */
              h('div', { className: 'rt-kv' }, h('b', null, 'Test:'), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: '#ef4444', borderColor: '#ef444455' } }, 'Blocked ' + d.blocked_count + 'x') : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : 'Untested') + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, 'Exploitability:'), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || 'Unassessed'),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, 'Attack Surface:'), h('span', null,
                d.test_surface || (portRows.length ? 'Not recorded (see open ports below)' : 'No open ports'),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? 'Internal Asset' : 'External Asset') : null)),
              h('span', Object.assign({ className: 'rt-more' },
                clickable(() => setShowAll(all ? null : it.id), { label: all ? 'Collapse Details' : 'Expand Details', expanded: all })),
                all ? 'Collapse All ▲' : 'Expand All (Ports · Fingerprints · Provenance · Tests) ▼'),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, 'Hostnames:'), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, 'Discovered:'),
                  h('span', { title: 'Timestamp when asset was first recorded (repeated collection updates "last seen" only)' }, fmt(d.discovered_at)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, 'Last Seen:'), h('span', null, fmt(d.last_seen)),
                  h('b', { style: { minWidth: 0, marginLeft: 8 } }, 'First Seen:'), h('span', null, fmt(d.first_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, 'CIDR:'), h('span', null, d.segment_cidr)),
                h('div', { className: 'rt-kv' }, h('b', null, 'Exploitability:'), h('span', null,
                  (d.priority || 'Unassessed') + (d.potential ? ' · Expected: ' + d.potential : '')
                  + (d.assess_reason ? ' · Justification: ' + d.assess_reason : '')
                  + (d.assessed_at ? '（' + fmt(d.assessed_at) + '）' : ''))),
                h('div', { className: 'rt-kv' }, h('b', null, 'Source:'), h('span', null,
                  'Passive Ports ' + (d.passive || 0) + ' · Active Ports ' + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Open Ports / Services'),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Fingerprints'),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h(Clip, { key: 'notes', label: 'Test History (' + noteLines.length + ' items)', text: noteLines.join('\n') })
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, 'Provenance (Recent 8)'),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, 'Loading...')
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, 'No matching assets found') : null)

      /* 域名维度：域名 → 关联资产 */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, 'Loading...')
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + ' assets')),
              g.assets.map((a) => h('div', {
                key: String(g.domain) + '\u0000' + a.id + '\u0000' + a.ip, className: 'rt-row',
                style: { gridTemplateColumns: '150px 130px 70px 1fr', cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? 'Live' : a.state)),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? 'No domains under this CIDR (switch to All CIDRs)' : 'No domain data recorded (recon phase populates domains)'))

      /* Web 资产：标题 + 可直接点击的 URL */
      const webPane = h('div', { className: 'rt-table' },
        h('div', { className: 'rt-row head', style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px' } },
          h('span', null, 'URL (Clickable)'), h('span', null, 'Title'), h('span', null, 'Asset'), h('span', null, 'Service')),
        (web || []).map((w) => {
          const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
          return h('div', {
            key: 'w' + w.port_id, className: 'rt-row',
            style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px', cursor: 'default' },
          },
            h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
            h('span', { title: w.title || '' }, w.title || '—'),
            h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
            h('span', { style: { fontSize: 11 } }, [w.service, w.product, w.version].filter(Boolean).join(' ')))
        }),
        web === null ? h('div', { className: 'rt-empty' }, 'Loading...')
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? 'No web assets under this CIDR' : 'No web assets recorded (HTTP probing populates URLs and titles)') : null))


      let pane = listPane
      if (view === 'testing') pane = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      /* 发现时间视图自带滚动容器，直接放进 rt-main 的 flex 里 */
      else if (view === 'timeline') pane = h(DiscoveryView, { engagement: eng, refreshKey: refreshKey })

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, view === 'testing' ? null : toolbar,
          conclusion,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          pane))
    }

    /* ---------------------------------------------------------- 资产发现时间线 */
    /**
     * 资产发现时间线：什么时候发现了什么、哪天收了多少。
     * ⚠️ 这个组件曾在"移除图谱视图"时被连带删掉 —— 删除区间的结束标记选得太宽
     *    （图谱画布的收尾与它挨着），bundle 自检的 "client.js 有资产「发现时间」视图"
     *    因此变红。恢复时把插入点固定成"资产测绘注释块之前"，避免再被别的删除波及。
     */
    function DiscoveryView(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [day, setDay] = React.useState('')
      React.useEffect(() => {
        if (!eng) return
        setData(null)
        api({ op: 'discoveryTimeline', engagement: eng, limit: 200 })
          .then((r) => { if (!r || r.ok === false) setErr((r && r.error) || 'Failed to load'); else { setErr(null); setData(r) } },
            (e) => setErr(String((e && e.message) || e)))
      }, [eng, refreshKey])
      if (err) return h('div', { className: 'rt-pane' }, h('div', { className: 'rt-err' }, err))
      if (!data) return h('div', { className: 'rt-empty' }, 'Loading...')
      const recent = (data.recent || []).filter((a) => day === '' || String(a.discovered_at || '').slice(0, 10) === day)
      return h('div', { className: 'rt-pane', style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'rt-card' },
          h('h4', null, 'Asset Discovery Timeline'),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            'Total ' + ((data.span && data.span.total) || 0) + ' hosts · Earliest '
            + (data.span && data.span.first ? fmt(data.span.first) : '—')
            + ' · Latest ' + (data.span && data.span.last ? fmt(data.span.last) : '—')
            + ' (Discovery time = first seen in database; repeats update "last seen" only)')),
        (data.days || []).length === 0 ? h('div', { className: 'rt-empty' }, 'No assets discovered yet.') : null,
        h('div', { className: 'rt-card' },
          h('h4', null, 'Daily Statistics', day
            ? h('span', Object.assign({ className: 'rt-tag', style: { marginLeft: 6, cursor: 'pointer' } },
                clickable(() => setDay(''), { label: 'Clear daily filter: ' + day })), 'Clear Filter: ' + day)
            : null),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            (data.days || []).map((d) => h('div', Object.assign({
              key: d.day, className: 'rt-seg' + (day === d.day ? ' on' : ''), style: { marginBottom: 0, cursor: 'pointer' },
              title: d.day + ': Added ' + d.assets + ' hosts (Internal ' + d.internal + ' / External ' + d.external + ')',
            }, clickable(() => setDay(day === d.day ? '' : d.day),
              { label: 'Filter assets discovered on ' + d.day, expanded: day === d.day })),
              h('div', { className: 'rt-seg-cidr' }, d.day),
              h('div', { className: 'rt-seg-meta' }, d.assets + ' hosts · Int ' + d.internal + ' / Ext ' + d.external))))),
        h('div', { className: 'rt-card' },
          h('h4', null, day ? 'Assets Discovered on ' + day + ' (' + recent.length + ')' : 'Recently Discovered Assets (' + recent.length + ')'),
          recent.length === 0 ? h('div', { className: 'rt-empty' }, 'No new assets on this day.') : null,
          recent.map((a) => h('div', { key: a.id, className: 'rt-kv' },
            h('b', { className: 'rt-mono', style: { minWidth: 110 } },
              h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external'), style: { marginRight: 4 } },
                a.scope === 'internal' ? 'Int' : 'Ext'),
              a.ip),
            h('span', { style: { minWidth: 132, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
              a.discovered_at ? fmt(a.discovered_at) : 'Time unknown'),
            h('span', { style: { flex: 1 } }, (a.primary_name || '—') + (a.open_ports ? ' · ' + a.open_ports + ' ports' : '')),
            h(PriTag, { p: a.priority })))))
    }

    /* ---------------------------------------------------------- 智能体提示词 */
    function PromptsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        /* 无靶标也允许：服务端回内置默认，不再报 engagement required */
        api(eng ? { op: 'prompts', engagement: eng } : { op: 'prompts' }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to read' }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
          if (r.builtin) setMsg({ ok: 'Currently using built-in default prompts (custom prompts can be saved per engagement)' })
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        if (!eng) { setMsg({ err: 'Please create or select an engagement before saving prompts' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to save' }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: 'Saved successfully' })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 老靶标的提示词是旧版模板；这里可以把当前角色（或全部）恢复成内置最新版 */
      const reset = (all) => {
        if (!eng) { setMsg({ err: 'Please create an engagement before resetting prompts' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to restore' }); return }
          setMsg({ ok: 'Reset to built-in default: ' + (r.reset || []).join(', ') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', Object.assign({
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
      }, clickable(() => { setActive(r.role); setMsg(null) },
        { label: 'View "' + r.title + '" prompt', expanded: active === r.role })),
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '(Empty)')))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : 'Prompts'),
            h('span', { className: 'rt-tag' }, 'Updated ' + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: 'Reset current role to built-in default prompt',
              onClick: () => reset(false),
            }, 'Reset Current to Default'),
            h('button', {
              className: 'rt-btn', disabled: busy, title: 'Reset all roles to built-in default prompts',
              onClick: () => reset(true),
            }, 'Reset All to Default'),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? 'Saving...' : 'Save')),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: 'System prompt for this role (Markdown)',
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              'Saved to agents/' + (active || 'role') + '.md. Subagents mounting redteamRole: recon, assess, vuln-scan, exploit, or internal load this system prompt.'))))
    }

    /* ---------------------------------------------------------- 技能库（DSH 原生） */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [meta, setMeta] = React.useState({})
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [srcOnly, setSrcOnly] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [brokenOnly, setBrokenOnly] = React.useState(false)

      /* refresh=true 跳过后端 30 秒可用性缓存（技能正文/环境变量可能刚改过） */
      const load = (force) => {
        setBusy(true)
        api({ op: 'skillCatalog', refresh: force === true }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to load'); return }
          setErr(null)
          setMeta(r || {})
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const open = (skill) => {
        const name = skill && skill.name
        const key = (skill && skill.library ? skill.library : 'redteam') + ':' + name
        if (active === key) { setActive(null); setDetail(null); return }
        setActive(key)
        setDetail(null)
        api({ op: 'skillRead', name: name, library: skill.library || 'redteam' }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || 'Failed to load')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const needle = q.trim().toLowerCase()
      let filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      if (srcOnly) filtered = filtered.filter((s) => s.library !== 'official' && s.fromPlugin === true)
      if (brokenOnly) filtered = filtered.filter((s) => s.library !== 'official' && (s.availability === 'broken' || s.availability === 'unknown'))
      /* 目录聚合：一眼看出"这么多技能是哪来的"（本项目/别的插件/自带根…） */
      const dirs = (meta.byDir || []).filter((d) => d.n > 0).slice(0, 6)
      const availSummary = meta.availability ? meta.availability.summary : null
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0

      const renderSkill = (s) => h('div', Object.assign({
        key: (s.library || 'redteam') + ':' + s.name, className: 'rt-item' + (active === ((s.library || 'redteam') + ':' + s.name) ? ' on' : ''),
      }, clickable(() => open(s), { label: 'View skill ' + s.name, expanded: active === ((s.library || 'redteam') + ':' + s.name) })),
        h('div', { className: 'rt-item-name' }, s.name,
          s.modelInvocable === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, 'Manual Only') : null,
          s.library === 'official'
            ? h('span', { className: 'rt-tag', style: { marginLeft: 6 }, title: 'Official skill directory' }, 'Official')
            : h('span', {
              className: 'rt-avail rt-avail-' + (s.availability || 'unknown'),
              style: { marginLeft: 6 },
              title: (s.availability === 'available'
                ? 'Available: Skill prompt can be loaded. Missing tools or keys are noted in details without blocking execution.'
                : (s.problems || []).join('\n') || 'Unknown'),
            }, s.availability === 'available' ? 'Available' : s.availability === 'broken' ? 'Unavailable' : 'Unknown'),
        h('div', { className: 'rt-item-desc' }, s.description || '(No description)'),
        h('div', { className: 'rt-kb-sub' },
          [s.source ? 'Source: ' + s.source : null,
            s.fromPlugin ? 'Bundled' : null,
            s.provider ? s.provider : null,
            s.dir ? s.dir : null].filter(Boolean).join(' · ')),
        (s.problems || []).length > 0 && s.availability !== 'available' && s.library !== 'official'
          ? h('div', { className: 'rt-kb-sub', style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
              '⚠ ' + String(s.problems[0]).slice(0, 60))
          : null))
      const redteamRows = filtered.filter((s) => s.library !== 'official').map(renderSkill)
      const officialRows = filtered.filter((s) => s.library === 'official').map(renderSkill)
      const listItems = []
      if (redteamRows.length > 0) {
        listItems.push(h('div', { key: 'head-redteam', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, 'Red Team Skills'))
        listItems.push.apply(listItems, redteamRows)
      }
      if (officialRows.length > 0) {
        listItems.push(h('div', { key: 'head-official', className: 'rt-kb-sub', style: { margin: '8px 0 4px', fontWeight: 600 } }, 'Official Skills'))
        listItems.push.apply(listItems, officialRows)
      }

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
            placeholder: 'Filter skills', value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('label', { className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 6px' } },
            h('input', { type: 'checkbox', checked: srcOnly, onChange: (e) => setSrcOnly(e.target.checked) }),
            'Bundled only (' + (meta.fromPlugin || 0) + ')'),
          availSummary && (availSummary.broken > 0 || availSummary.unknown > 0)
            ? h('label', {
                className: 'rt-kb-check', style: { display: 'flex', margin: '0 0 8px' },
                title: 'View broken or unconfigured skills',
              },
                h('input', { type: 'checkbox', checked: brokenOnly, onChange: (e) => setBrokenOnly(e.target.checked) }),
                'Unavailable/Unknown (' + ((availSummary.broken || 0) + (availSummary.unknown || 0)) + ')')
            : null,
          availSummary
            ? h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 } },
                h('span', { className: 'rt-avail rt-avail-available' }, 'Available ' + (availSummary.available || 0)),
                availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, 'Unavailable ' + availSummary.broken) : null,
                availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, 'Unknown ' + availSummary.unknown) : null,
                h('span', Object.assign({
                  className: 'rt-tag', style: { cursor: 'pointer' },
                  title: 'Bypass cache and recheck skill availability',
                }, clickable(() => load(true), { label: 'Recheck skill availability' })), 'Recheck'))
            : null,
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
            'Red Team ' + ((meta.libraries && meta.libraries.redteam) || 0) + ' · Official ' + ((meta.libraries && meta.libraries.official) || 0),
            items.length > 100 ? h('div', { style: { marginTop: 3 } },
              ' (Skills are loaded from registered roots or your skills directory; plugin bundles ' + (meta.fromPlugin || 0) + ' skills)') : null),
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, detail ? detail.name : 'Skills Catalog (DSH Native)'),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn', disabled: busy, onClick: () => load(true) }, busy ? 'Refreshing...' : 'Refresh')),
          err
            ? (needRestart
                ? h('div', { className: 'rt-empty' }, 'Host code has been updated; please restart host application to apply changes')
                : h('div', { className: 'rt-err' }, err))
            : null,
          detail
            ? h('div', { className: 'rt-pane' },
                h('div', { className: 'rt-kv' }, h('b', null, 'Description:'), h('span', null, detail.description || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, 'When to Use:'), h('span', null, detail.whenToUse || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, 'Source:'), h('span', null, (detail.provider || '—') + ' / ' + (detail.source || '—'))),
                (() => {
                  const s2 = items.find((x) => ((x.library || 'redteam') + ':' + x.name) === active)
                  if (!s2) return null
                  if (s2.library === 'official') {
                    return h('div', { className: 'rt-kv' }, h('b', null, 'Type:'), h('span', null, 'Official skill. Invoked by host per task; bypassed red team path checks.'))
                  }
                  const avail = s2.availability || 'unknown'
                  return h('div', null,
                    h('div', { className: 'rt-kv' }, h('b', null, 'Availability:'),
                      h('span', { className: 'rt-avail rt-avail-' + avail },
                        avail === 'available' ? 'Available' : avail === 'broken' ? 'Unavailable (Dependencies Missing)' : 'Unknown')),
                    (s2.problems || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, avail === 'available' ? 'Missing External Tools' : 'Gaps'),
                          h('span', null, s2.problems.map((x, i) => h('div', { key: 'p' + i }, '· ' + x))))
                      : null,
                    (s2.needs_user || []).length > 0
                      ? h('div', { className: 'rt-kv' }, h('b', null, 'Required Configuration'),
                          h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
                            s2.needs_user.map((x, i) => h('div', { key: 'n' + i }, '· ' + x))))
                      : null)
                })(),
                detail.path ? h('div', { className: 'rt-kv' }, h('b', null, 'File:'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)) : null,
                h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '52vh' } }, detail.content || ' (Empty)'))
            : h('div', { className: 'rt-pane' },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                  meta.note || 'Skills are managed by the native skill framework and invoked by agents via skill tool.'),
                availSummary
                  ? h('div', { style: { fontSize: 12, marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { className: 'rt-avail rt-avail-available' }, 'Available ' + (availSummary.available || 0)),
                      availSummary.broken > 0 ? h('span', { className: 'rt-avail rt-avail-broken' }, 'Unavailable ' + availSummary.broken) : null,
                      availSummary.unknown > 0 ? h('span', { className: 'rt-avail rt-avail-unknown' }, 'Unknown ' + availSummary.unknown) : null,
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        '(' + (meta.availability && meta.availability.cached ? 'Cached at ' : 'Checked at ')
                        + (meta.availability && meta.availability.checked_at ? fmt(meta.availability.checked_at) : '—') + '）'))
                  : null,
                meta.availability && (meta.availability.broken || []).length > 0
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Skills currently unavailable:'),
                      meta.availability.broken.slice(0, 12).map((b) => h('div', { key: b.name },
                        '· ' + b.name + (b.problems && b.problems.length ? ' — ' + b.problems[0] : ''))))
                  : null,
                (meta.byDir || []).slice(0, 6).map((d) => h('div', { key: d.key, className: 'rt-mono', style: { fontSize: 11, marginBottom: 2, overflowWrap: 'anywhere' } },
                  d.n + ' skills · ' + d.key)),
                (meta.byDir || []).length > 6
                  ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                      '... and ' + ((meta.byDir || []).length - 6) + ' other directories (' + items.length + ' total skills)')
                  : null,
                h('div', { className: 'rt-empty' }, 'Select a skill on the left to view details')))
      )
    }

    /* ---------------------------------------------------------- 漏洞战果 */
    const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' }
    const STATUS_LABEL = { candidate: 'Candidate', confirmed: 'Confirmed', 'false-positive': 'False Positive', exploited: 'Exploited', fixed: 'Fixed' }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** 目标归并：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。 */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || '(Unspecified target)'
    }

    /* ---------------------------------------------------------- 证据渲染 */
    /** 把一段原始 HTTP 报文按「请求行/状态行 + 头 + 体」着色，便于人眼扫读。 */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** 漏洞详情里的证据区：结构化证据文本 + 该漏洞的原始 HTTP 请求/响应记录。 */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, 'Evidence Excerpt',
            h('span', { className: 'rt-tag' }, looksHttp ? 'Raw HTTP' : 'Text'),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => { e.stopPropagation(); copyText(evi) },
            }, 'Copy')),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || 'HTTP Evidence',
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at || e.created_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, '▸ Request (Replayable in Burp Repeater)'),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, '▸ Response'),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, 'Evidence'),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, 'Missing — Unverified findings excluded from reports; add via redteam_http_evidence_add')))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [files, setFiles] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* 子页签：漏洞 / 凭据 / 访问会话（凭据不再铺在漏洞页底部） */
      const [subTab, setSubTab] = React.useState('vulns')
      /* 默认按目标聚合：322 条平铺没法读，先看"哪台被打下什么" */
      const [grouped, setGrouped] = React.useState(true)
      const collapse = useCollapse('findings:' + eng)

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || 'Query failed', total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
        api({ op: 'attackFiles', engagement: eng }).then((r) => setFiles((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to update' }); return }
          setMsg({ ok: 'Updated to "' + (STATUS_LABEL[next] || next) + '"' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      const allFiles = (files || []).flatMap((g) => (g.files || []).map((f) => Object.assign({ target: g.target }, f)))
      const filesByVuln = new Map()
      const orphanFiles = []
      for (const f of allFiles) {
        const vid = f.vuln_id === null || f.vuln_id === undefined ? null : Number(f.vuln_id)
        if (vid === null) { orphanFiles.push(f); continue }
        if (!filesByVuln.has(vid)) filesByVuln.set(vid, [])
        filesByVuln.get(vid).push(f)
      }

      /* ── 结论行：只给结论，数字点一下就是筛选 ─────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', Object.assign({
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), title: 'Click to filter / click again to clear',
      }, clickable(onClick, { label: 'Filter by "' + label + '" (' + (value || 0) + ')', expanded: active })),
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', 'Confirmed', (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', 'Exploited', (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', 'Critical', (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', 'High', (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', 'Medium', (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', 'Access Gained', (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          'Aggregated by target · ' + (stats.targetGroups || 0) + ' targets'))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, 'Severity'), h('span', null, 'Vulnerability / CVE'), h('span', null, 'Target'),
        h('span', null, 'Gained'), h('span', null, 'Status'), h('span', null, 'Confidence'))

      /* 单条漏洞（行 + 展开详情），聚合视图与平铺视图共用 */
      const vulnRows = (v, compact) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)
        const open = openId === v.id
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow', role: 'button', tabIndex: 0,
          style: compact ? { cursor: 'pointer', gridTemplateColumns: '58px minmax(0,1fr) 104px 68px' } : { cursor: 'pointer' },
          onClick: () => setOpenId(open ? null : v.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : v.id) } },
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'), (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          compact ? null : h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          compact ? null : h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, 'Gained:'),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  'Not recorded — Record gained access via redteam_vuln_update (e.g. Server Shell, Intranet Tunnel, Admin Credentials)')),
          h('div', { className: 'rt-kv' }, h('b', null, 'Target:'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, v.target || '—')),
          h('div', { className: 'rt-kv' }, h('b', null, 'Asset:'), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, 'Source:'), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          (() => {
            const mine = filesByVuln.get(Number(v.id)) || []
            return h('div', { className: 'rt-kv' }, h('b', null, 'Attack Files:'),
              mine.length
                ? h('span', null, mine.map((f, fi) => h('div', { key: 'af' + fi, style: { marginBottom: 3 } },
                    '· ' + (f.kind ? '[' + f.kind + '] ' : '') + (f.name || '(Unnamed)')
                    + (f.description ? ' — ' + f.description : ''),
                    h('div', { className: 'rt-mono', style: { fontSize: 11, marginLeft: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, f.path || ''))))
                : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    '(None) Archive scripts/payloads/exploits via redteam_attack_file_add with vuln_id'))
          })(),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, 'Confirm'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, 'Exploited'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, 'False Positive'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, 'Fixed')))))
        return out
      }

      const rows = []
      if (grouped) {
        /* 按目标聚合成组：先看"哪台被打下什么"，再点进去看具体漏洞 */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const key = 'target:' + g.key
          const defOpen = false
          rows.push(h(Section, {
            key: 'sec:' + g.key, tone: 'target',
            title: g.key,
            count: g.vulns.length + ' vulns',
            sub: [
              SEV_LABEL[g.top.severity] || g.top.severity,
              g.exploited ? 'Exploited ' + g.exploited : null,
              g.top.asset_ip && g.top.asset_ip !== g.key ? 'Asset ' + g.top.asset_ip : null,
            ].filter(Boolean).join(' · '),
            right: g.gained.length
              ? g.gained.slice(0, 2).join(' / ') + (g.gained.length > 2 ? ' +' + (g.gained.length - 2) : '')
              : 'No access recorded',
            open: collapse.isOpen(key, defOpen),
            onToggle: collapse.toggle(key, defOpen),
          }, g.vulns.map((v) => vulnRows(v, true))))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, 'No vulnerabilities recorded'))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: 'Search title / CVE / target (Enter)',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, 'Search'),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, 'All Severities'),
          h('option', { value: 'critical' }, 'Critical'),
          h('option', { value: 'high' }, 'High'),
          h('option', { value: 'medium' }, 'Medium'),
          h('option', { value: 'low' }, 'Low'),
          h('option', { value: 'info' }, 'Info')),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, 'All Statuses'),
          h('option', { value: 'candidate' }, 'Candidate'),
          h('option', { value: 'confirmed' }, 'Confirmed'),
          h('option', { value: 'exploited' }, 'Exploited'),
          h('option', { value: 'false-positive' }, 'False Positive'),
          h('option', { value: 'fixed' }, 'Fixed')))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, 'Credentials · ' + creds.length + (creds.length ? ' (Plaintext visible; caution during screen sharing)' : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: (e) => { e.stopPropagation(); copyText(String(c.secret_value || '')) },
                }, 'Copy')),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: 'Click to select all' }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, 'Plaintext not recorded — Populate secret_value via redteam_credential_add to display'),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? 'Source: ' + c.source : null,
                  c.tool ? 'Tool: ' + c.tool : null,
                  c.secret_ref ? 'Evidence: ' + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, 'Note: ' + c.note) : null)))
          : h('div', { className: 'rt-empty' }, 'No credentials recorded (Record passwords/keys/hashes via redteam_credential_add)'))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, 'Access Sessions · ' + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr 110px 80px 80px 1fr' } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, 'None'))

      const subTabBtn = (key, label, n) => h('span', Object.assign({
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
      }, clickable(() => setSubTab(key), { label: label + '（' + n + '）', expanded: subTab === key })),
      label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', 'Vulnerabilities', state.total || 0),
          subTabBtn('files', 'Attack Files', allFiles.length),
          subTabBtn('creds', 'Credentials', creds.length),
          subTabBtn('access', 'Access Sessions', accesses.length),
          h('div', { className: 'rt-spacer' }),
          grouped ? h('button', {
            className: 'rt-btn', title: 'Expand all targets',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), true),
          }, 'Expand All') : null,
          grouped ? h('button', {
            className: 'rt-btn', title: 'Collapse all targets',
            onClick: () => collapse.setAll((state.items || []).map((v) => 'target:' + targetKeyOf(v)), false),
          }, 'Collapse All') : null,
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? 'Currently grouped by target' : 'Currently flat list',
            onClick: () => setGrouped((g) => !g),
          }, grouped ? 'Group by Target' : 'Flat List')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, 'Host code has been updated; please restart host application to apply changes') : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        subTab === 'files'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } },
              h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                'Attack files are organized per engagement directory; associated files can also be viewed under each vulnerability detail.'
                + (orphanFiles.length ? ' Currently ' + orphanFiles.length + ' files have no vuln_id linked.' : '')),
              h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey }))
          : subTab === 'creds'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, credSection)
          : subTab === 'access'
            ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, accessSection)
            : h('div', { className: 'rt-table' }, grouped ? null : head, rows,
                !state.loading && !state.items.length && !state.error ? h('div', { className: 'rt-empty' }, 'No vulnerability records found') : null))
    }

    /* ---------------------------------------------------------- 攻击链 */
    const STAGE_LABEL = { recon: 'Reconnaissance', vuln: 'Vulnerability Scanning', exploit: 'Exploitation', access: 'Access Gained', pivot: 'Intranet Pivot', data: 'Sensitive Data', other: 'Other' }

    /* ---------------------------------------------------------- 攻击链（五阶段） */
    /**
     * 按攻击面位置串成一条链：
     * ① 信息收集 → ② 互联网资产权限 → ③ 边界突破 → ④ 内网资产权限 → ⑤ 靶标权限。
     * 每阶段只讲两件事：这一步拿到多少分（累计多少）、涉及的资产/隧道是哪些。
     * A = 竖向链（详细）；B = 横向链（一屏看完）。
     */
    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [view, setView] = React.useState('A')
      const [openId, setOpenId] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to load'); return }
          setErr(null); setData(r)
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥']

      /* 单次得分的详情 */
      const hitDetail = (x) => h('div', { className: 'rt-flow-detail' },
        h('div', { className: 'rt-kv' }, h('b', null, 'Target:'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, x.target || '—')),
        x.asset_ip ? h('div', { className: 'rt-kv' }, h('b', null, 'Asset:'), h('span', { className: 'rt-mono' }, x.asset_ip)) : null,
        x.vuln_title ? h('div', { className: 'rt-kv' }, h('b', null, 'Exploited Vuln'), h('span', null, [x.vuln_cve, x.vuln_title].filter(Boolean).join(' '))) : null,
        h('div', { className: 'rt-kv' }, h('b', null, 'Hits'), h('span', null,
          'Hit #' + x.nth_of_point + ' · +' + (x.points || 0) + ' pts')),
        h('div', { className: 'rt-kv' }, h('b', null, 'Recorded At:'), h('span', null, fmt(x.recorded_at) + (x.recorded_by ? ' · ' + x.recorded_by : ''))),
        x.evidence ? h(Clip, { label: 'Result & Evidence', text: x.evidence }) : null)

      const hitRow = (x) => h('div', {
        key: 'h' + x.id,
        className: 'rt-ap-hit' + (openId === x.id ? ' open' : ''),
        role: 'button', tabIndex: 0,
        onClick: () => toggle(x.id),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(x.id) } },
      },
        h('div', { className: 'rt-ap-hit-head' },
          h('span', { className: 'rt-ap-pts' + (x.counted ? '' : ' uncounted'), title: x.capped_reason || undefined },
            '+' + (x.counted ? (x.points || 0) : 0)),
          h('span', { className: 'rt-ap-hit-name' }, x.point_name),
          x.capped ? h('span', { className: 'rt-tag rt-tag-warn', title: x.capped_reason || 'Same service/port capped; highest value hit counted' }, 'Service Capped · 0 pts') : null,
          x.nth_of_point > 1 ? h('span', { className: 'rt-ap-nth' }, 'Hit #' + x.nth_of_point) : null,
          h('span', { className: 'rt-ap-hit-target' }, x.target || x.asset_ip || '—')),
        x.action
          ? h('div', { className: 'rt-ap-act' + (x.action_inferred ? ' inferred' : '') },
              'Action: ' + (x.action.title || '(Unnamed action)') + (x.action_inferred ? ' (Inferred)' : ''))
          : null,
        openId === x.id ? hitDetail(x) : null)

      /* 资产行（信息收集阶段 / 各阶段涉及资产） */
      const assetRow = (a) => h('div', { key: 'a' + a.id, className: 'rt-ap-asset' },
        h('span', { className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? 'Int' : 'Ext'),
        h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, a.ip),
        a.segment_cidr ? h('span', { className: 'rt-ap-nth' }, a.segment_cidr) : null,
        h('span', { className: 'rt-ap-nth' }, 'Ports ' + (a.open_ports || 0)),
        a.vulns ? h('span', { className: 'rt-ap-nth' }, 'Vulns ' + a.vulns) : null,
        a.priority ? h('span', { className: 'rt-tag' }, 'Priority ' + a.priority) : null,
        h('div', { className: 'rt-spacer' }),
        h('span', { className: 'rt-ap-pts' }, '+' + (a.points || 0) + ' pts'),
        h('span', { className: 'rt-ap-nth' }, (a.hits || 0) + ' hits'))

      /* 攻击链只讲"打到哪了、拿了多少分"：不展示打法要点与工具清单，
         那些是执行细节，混在链路里会淹没得分与资产信息。 */

      /* ── A：竖向攻击链 ─────────────────────────────────────────── */
      const stageA = (st, i) => {
        const isRecon = st.code === 'recon'
        const body = []
        if (isRecon) {
          body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, 'Scoring Assets · ' + st.assetCount))
          body.push(h('div', { key: 'al', className: 'rt-ap-assets' },
            st.assets.length ? st.assets.map(assetRow) : h('div', { className: 'rt-ap-none' }, 'No scoring assets yet')))
        } else {
          body.push(h('div', { key: 'ht', className: 'rt-ap-sub' },
            'Hits in stage: ' + st.hits + (st.points ? ' · +' + st.points + ' pts' : '')))
          body.push(h('div', { key: 'hl', className: 'rt-ap-hits' },
            st.items.length ? st.items.map(hitRow) : h('div', { className: 'rt-ap-none' }, 'No score hits in this stage yet')))
          if (st.code === 'boundary') {
            const selfOnly = (st.tunnels_self_only || []).length
            body.push(h('div', { key: 'tt', className: 'rt-ap-sub' },
              'Boundary-crossing channels · ' + st.tunnels.length + (selfOnly ? ' (' + selfOnly + ' other tunnels on VPS/self-hosted excluded)' : '')))
            if (selfOnly && st.tunnels.length === 0) {
              body.push(h('div', { key: 'tw', className: 'rt-ap-none' },
                '⚠️ Existing tunnels reside on self-hosted servers and do not touch the target — not counted as boundary penetration. A target-side outbound channel is required (reverse shell, frp client on target, or suo5 over webshell).'))
            }
            body.push(h('div', { key: 'tl', className: 'rt-ap-tunnels' },
              st.tunnels.length
                ? st.tunnels.map((t) => h('div', { key: 't' + t.id, className: 'rt-ap-tunnel' },
                    h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
                    h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, t.listen || '—'),
                    h('span', {
                      className: 'rt-tag ' + (t.status === 'active' ? 'rt-tag-live' : ''),
                      style: t.status === 'active' ? {} : { opacity: .7 },
                    }, t.status === 'active' ? 'Active' : (t.status || 'Unknown')),
                    h('span', { className: 'rt-ap-nth', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      'Reaches ' + (t.reach || '—'))))
                : h('div', { className: 'rt-ap-none' }, 'No tunnels established yet (register via redteam_tunnel_add)')))
          }
          if (st.assets.length && st.code !== 'boundary') {
            body.push(h('div', { key: 'at', className: 'rt-ap-sub' }, 'Assets Involved · ' + st.assetCount))
            body.push(h('div', { key: 'al', className: 'rt-ap-assets' }, st.assets.map(assetRow)))
          }
        }

        return h('div', { key: 'st' + st.code, className: 'rt-ap-stage' },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-no', style: { background: st.color } }, CIRCLED[i] || ('0' + (i + 1))),
            h('span', { className: 'rt-ap-name' }, st.name),
            st.subtitle ? h('span', { className: 'rt-ap-en' }, st.subtitle) : null,
            h('div', { className: 'rt-spacer' }),
            st.points > 0 ? h('span', { className: 'rt-ap-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } }, '+' + st.points) : null,
            h('span', { className: 'rt-ap-cum' }, 'Cumulative ' + st.cumulative + ' pts')),
          h('div', { className: 'rt-ap-goal', style: { borderLeftColor: st.color } },
            h('span', { className: 'rt-ap-goal-tag', style: { color: st.color, borderColor: st.color + '66' } }, 'Stage Goal'),
            h('span', null, st.goal)),
          h('div', { className: 'rt-ap-result', style: { borderLeftColor: st.color } }, body),
          i < stages.length - 1
            ? h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                st.transition ? h('span', { className: 'rt-ap-trans-t' }, st.transition) : null,
                h('span', { className: 'rt-ap-trans-t', style: { marginLeft: 'auto' } }, 'Cumulative ' + st.cumulative + ' pts'))
            : h('div', { className: 'rt-ap-trans' },
                h('span', { className: 'rt-flow-arrow' }, '▼'),
                h('span', { className: 'rt-ap-trans-t' }, 'Total ' + ((summary && summary.points) || 0) + ' pts')))
      }

      /* ── B：横向攻击链（一屏看完） ─────────────────────────────── */
      const stageB = (st, i) => h('div', { key: 'c' + st.code, className: 'rt-ap-col' },
        i > 0 ? h('span', { className: 'rt-ap-col-arrow' }, '▶') : null,
        h('div', { className: 'rt-hcol', style: { borderTopColor: st.color } },
          h('div', { className: 'rt-ap-head', style: { borderLeftColor: st.color, padding: '5px 8px' } },
            h('span', { className: 'rt-ap-no', style: { background: st.color, width: 16, height: 16, fontSize: 10 } }, String(i + 1)),
            h('span', { className: 'rt-ap-name', style: { fontSize: 12 } }, st.name),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-ap-cum', style: { fontWeight: 700 } }, st.cumulative)),
          h('div', { className: 'rt-hcol-goal', title: st.goal }, st.goal),
          h('div', { className: 'rt-hcol-body' },
            st.code === 'boundary'
              ? h('div', null,
                  h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, 'Tunnels ' + st.tunnels.length)),
                  st.tunnels.slice(0, 3).map((t) => h('div', { key: 't' + t.id, className: 'rt-hcol-sub' }, '▸ ' + (t.kind || '') + ' ' + (t.listen || ''))))
              : st.code === 'recon'
                ? h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, st.assetCount), h('span', { className: 'rt-hcol-name' }, 'assets scored')),
                    st.assets.slice(0, 6).map((a) => h('div', { key: 'a' + a.id, className: 'rt-hcol-sub', title: a.ip + '  +' + a.points + ' pts' },
                      (a.scope === 'internal' ? 'Int ' : 'Ext ') + a.ip + '  +' + a.points + ' pts')))
                : h('div', null,
                    h('div', { className: 'rt-hcol-hit' }, h('span', { className: 'rt-hcol-pts' }, '+' + st.points), h('span', { className: 'rt-hcol-name' }, st.hits + ' hits')),
                    st.items.slice(0, 6).map((x) => h('div', { key: 'c' + x.id, className: 'rt-hcol-sub', title: x.point_name + '  ' + (x.target || '') },
                      h('span', { className: 'rt-hcol-pts' }, '+' + x.points), h('span', { className: 'rt-hcol-name' }, x.point_name))),
                    st.items.length > 6 ? h('div', { className: 'rt-hcol-none' }, '... and ' + (st.items.length - 6) + ' more') : null,
                    st.assetCount ? h('div', { className: 'rt-hcol-none' }, 'Involves ' + st.assetCount + ' assets') : null))))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Attack Chain'),
          h('span', { className: 'rt-tag', style: { fontSize: 10.5 } }, 'Recon → Internet Asset Access → Perimeter Breach → Intranet Pivot → Crown Jewels'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, 'Total ' + summary.points + ' pts') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (view === 'A' ? ' rt-btn-primary' : ''), title: 'Vertical attack chain view', onClick: () => setView('A') }, 'Chain A'),
          h('button', { className: 'rt-btn' + (view === 'B' ? ' rt-btn-primary' : ''), title: 'Horizontal multi-phase attack overview', onClick: () => setView('B') }, 'Chain B'),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? 'Loading...' : 'Refresh')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        !stages.length && !err && data !== null
          ? h('div', { className: 'rt-empty' }, 'No score hits recorded yet. Call redteam_score_hit to populate the attack chain.')
          : view === 'A'
            ? h('div', { className: 'rt-ap' }, stages.map(stageA))
            : h('div', { className: 'rt-ap-h' }, stages.map(stageB)))
    }

    /* ---------------------------------------------------------- 得分复现报告 */
    /**
     * 报告分组兜底：host 只给平铺条目时，用 scoreChain 的阶段信息把条目按攻击链顺序分组。
     * 依据是两边共同的 score_hit id —— scoreChain 的每条 item 都带 stage_code，
     * scoreReport 的每条 item 带同样的 id。这样即使 host 侧版本较旧或阶段行缺失，
     * 报告页也能正常显示，而不是误报"还没有可交付的成果"。
     */
    function groupByStage(reportItems, chain) {
      const byId = new Map((reportItems || []).map((x) => [x.id, x]))
      const groups = []
      const stageList = (chain && chain.stages) || []
      stageList.forEach((st, si) => {
        const items = (st.items || []).map((x) => byId.get(x.id)).filter(Boolean)
        if (items.length === 0) return
        groups.push({ code: st.code, name: st.name, color: st.color || '#64748b',
          ordinal: st.ordinal || si + 1, points: st.points || 0, cumulative: st.cumulative || 0, items })
      })
      /* scoreChain 完全没有阶段信息时，至少把得分归到「其他」，不要让条目凭空消失 */
      const grouped = new Set(groups.reduce((acc, g) => acc.concat(g.items.map((x) => x.id)), []))
      const rest = (reportItems || []).filter((x) => !grouped.has(x.id))
      if (rest.length > 0) {
        groups.push({ code: 'other', name: 'Other Scores', color: '#64748b', ordinal: groups.length + 1,
          points: rest.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
          cumulative: 0, items: rest })
      }
      return groups
    }

    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      /* 报告按阶段折叠：默认全开，折叠状态按靶标记住（阶段多时便于逐段交付） */
      const collapse = useCollapse('report:' + eng)

      const load = () => {
        if (!eng) return
        setBusy(true); setMsg(null)
        api({ op: 'scoreReport', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setBusy(false); setErr((r && r.error) || 'Generation failed'); return }
          /* 老 host 只给平铺条目、不给阶段分组（或阶段行缺失）：自己按攻击链分组，
             否则报告页会误报"还没有可交付的成果"。分组数据取自 scoreChain。 */
          if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
            api({ op: 'scoreChain', engagement: eng }).then((c) => {
              setBusy(false); setErr(null); setData(Object.assign({}, r, { stages: groupByStage(r.items, c) }))
            }, () => { setBusy(false); setErr(null); setData(r) })
            return
          }
          setBusy(false); setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* 复制结果必须是真实的：clipboard API 失败时（非安全上下文/失焦/被拒）要如实提示，
         否则用户以为复制成功、粘到 Yakit 里是空的。 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const download = (text, label) => {
        try {
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'
          a.click()
          URL.revokeObjectURL(url)
          setMsg({ ok: 'Downloaded: ' + label })
        } catch (e) { setMsg({ err: 'Download failed: ' + ((e && e.message) || e) }) }
      }

      const items = (data && data.items) || []
      const stages = (data && data.stages) || []
      const summary = (data && data.summary) || null
      const mdText = (data && data.markdown) || ''
      const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

      /* 每项一条，平铺不折叠：目标 → 拿到什么 → 复现请求（可直接粘进 Yakit）→ 响应 */
      const card = (x) => h('div', { key: 'r' + x.id, className: 'rt-rep' },
        h('div', { className: 'rt-rep-head' },
          h('span', { className: 'rt-rep-idx' }, String(x.seq)),
          h('span', { className: 'rt-rep-name' }, x.point_name),
          h('span', { className: 'rt-flow-pts' }, '+' + x.points + ' pts'),
          x.nth_of_point > 1 ? h('span', { className: 'rt-tag' }, '#' + x.nth_of_point + ' of point') : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => copy((x.requests || []).map((v) => v.request || '').filter(Boolean).join('\n\n'), 'Request #' + x.seq),
          }, 'Copy Request')),
        h('div', { className: 'rt-rep-meta' },
          h('span', null, h('b', null, 'Target: ')), h('span', { className: 'rt-mono' }, x.target || x.asset_ip || '—')),
        x.gained ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Gained: '), h('span', null, x.gained)) : null,
        x.vuln ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Exploit: '),
          h('span', null, [x.vuln.cve, x.vuln.title].filter(Boolean).join(' '))) : null,
        x.evidence ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Result: '),
          h('span', null, String(x.evidence).replace(/\n+/g, ' '))) : null,
        x.recorded_at ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Timestamp: '),
          h('span', null, fmt(x.recorded_at) + (x.recorded_by ? '（' + (ROLE_LABEL[x.recorded_by] || x.recorded_by) + '）' : ''))) : null,
        h(ShotStrip, { eng: eng, shots: x.shots, total: x.shot_total, title: 'Evidence Screenshots' }),
        /* ── 复现步骤：动作记录（含实际命令与回显）+ 凭据 + 隧道 + WebShell ─────
           报告的交付价值全在这块：账号密码怎么来的、隧道怎么搭的，用户照着就能复现。 */
        h('details', { className: 'rt-rep-trace', open: x.incomplete === true || (x.steps || []).length === 0 },
          h('summary', { className: 'rt-rep-trace-head', style: { cursor: 'pointer' } },
            h('span', { className: 'rt-rep-trace-title' }, 'Reproduction Steps (Click to expand)'),
            (x.steps || []).length ? h('span', { className: 'rt-tag' }, (x.steps || []).length + ' actions') : null,
            (x.credentials || []).length ? h('span', { className: 'rt-tag' }, (x.credentials || []).length + ' credentials') : null,
            (x.tunnels || []).length ? h('span', { className: 'rt-tag' }, (x.tunnels || []).length + ' tunnels') : null,
            x.incomplete ? h('span', { className: 'rt-tag rt-tag-warn' }, 'Incomplete Proof') : h('span', { className: 'rt-tag rt-tag-live' }, 'Reproducible')),
          h('div', { style: { paddingTop: 6 } },
          x.how ? h('div', { className: 'rt-rep-trace-how' }, x.how) : null,
          (x.steps || []).length === 0
            ? h('div', { className: 'rt-rep-missing' },
                '⚠️ No associated attack steps: Procedure details missing. Document actions via redteam_chain_add (title / detail / tool / result), or include point_code + evidence during scoring.')
            : (x.steps || []).map((s, si) => h('div', { key: 's' + s.id, className: 'rt-rep-step' },
                h('div', { className: 'rt-rep-step-head' },
                  h('span', { className: 'rt-rep-step-no' }, String(si + 1)),
                  h('span', { className: 'rt-rep-step-title' }, s.title || '(Unnamed action)'),
                  s.agent ? h('span', { className: 'rt-tag' }, ROLE_LABEL[s.agent] || s.agent) : null,
                  s.stage_code ? h('span', { className: 'rt-tag' }, s.stage_code) : null,
                  s.inferred ? h('span', { className: 'rt-tag' }, 'Inferred from Asset') : null,
                  h('div', { className: 'rt-spacer' }),
                  s.recorded_at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, fmt(s.recorded_at)) : null),
                s.detail ? h('div', { className: 'rt-rep-step-detail' }, s.detail) : null,
                h('div', { className: 'rt-rep-step-cmd' },
                  h('b', null, 'Exec '),
                  s.tool
                    ? h('span', { className: 'rt-mono' }, s.tool)
                    : h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } }, 'No command recorded (tool field in redteam_chain_add)')),
                s.tool ? h('div', { style: { marginTop: 3 } },
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                    onClick: () => copy(String(s.tool), 'Step #' + (si + 1) + ' command'),
                  }, 'Copy Command')) : null,
                s.result ? h('div', { className: 'rt-rep-step-result' }, h('b', null, 'Result '), String(s.result).replace(/\n+/g, ' ')) : null,
                s.evidence_ref ? h('div', { className: 'rt-rep-step-result' }, h('b', null, 'Evidence '), h('span', { className: 'rt-mono' }, s.evidence_ref)) : null)),
          /* 账号密码怎么来的：凭据的来源 + 取得方式 */
          (x.credentials || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'Acquired Credentials (Traceable)'),
                (x.credentials || []).map((c) => h('div', { key: 'c' + c.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, c.host || '—'),
                  h('span', null, (c.username || '(No username)') + ' / ' + (c.secret_type || 'password')
                    + (c.privilege ? ' · Privilege: ' + c.privilege : '')
                    + ' · Source: ' + (c.source || 'Unlabeled')
                    + (c.tool ? ' · Acquisition: ' + String(c.tool).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          /* 隧道怎么搭的 */
          (x.tunnels || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'Tunnels / Pivots Used'),
                (x.tunnels || []).map((t) => h('div', { key: 't' + t.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, (t.kind || 'socks5') + ' ' + (t.listen || '')),
                  h('span', null, 'Entry: ' + (t.entry || 'Unregistered')
                    + (t.reach ? ' · Reaches: ' + t.reach : '')
                    + ' · Target-Side: ' + (t.entry_kind || 'Undeclared')
                    + (t.legit === false ? ' · ⚠️ Does not cross target boundary' : '')
                    + (t.status ? ' · ' + t.status : '')
                    + (t.command ? ' · Command: ' + String(t.command).replace(/\n+/g, ' ').slice(0, 160) : '')))))
            : null,
          (x.webshells || []).length
            ? h('div', { className: 'rt-rep-src' },
                h('div', { className: 'rt-rep-src-title' }, 'WebShells Used'),
                (x.webshells || []).map((w) => h('div', { key: 'w' + w.id, className: 'rt-kv' },
                  h('b', { className: 'rt-mono', style: { minWidth: 120 } }, w.shell_type || 'shell'),
                  h('span', null, (w.url || '') + (w.pass_key ? ' · Password/Key: ' + w.pass_key : '')
                    + (w.privilege ? ' · Privilege: ' + w.privilege : '') + (w.status ? ' · ' + w.status : '')))))
            : null,
          (x.gaps || []).length ? h('div', { className: 'rt-rep-missing' }, '⚠️ Reproduction Gaps: ' + x.gaps.join('; ')) : null),
        (x.requests || []).length === 0
          ? h('div', { className: 'rt-rep-missing' }, '⚠️ No raw HTTP request recorded; cannot reproduce directly. Add evidence via redteam_http_evidence_add')
          : (x.requests || []).map((r, ri) => h('div', { key: 'q' + ri, className: 'rt-rep-req' },
              h('div', { className: 'rt-rep-req-head' },
                h('span', null, 'Reproduction Request ' + (ri + 1) + (r.source === 'auto' ? ' (Auto-matched by path, please verify)' : '')),
                h('span', { className: 'rt-tag' }, (r.method || 'GET') + ' ' + (r.status === null || r.status === undefined ? '' : r.status)),
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: () => copy(String(r.request || ''), 'Request #' + (ri + 1)),
                }, 'Copy Request')),
              h('pre', { className: 'rt-rep-http' }, r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')),
              r.response ? h('div', null,
                h('div', { className: 'rt-rep-req-head' }, h('span', null, 'Response Summary')),
                h('pre', { className: 'rt-rep-http', style: { maxHeight: 160 } }, String(r.response).slice(0, 1600))) : null)),
        x.note ? h('div', { className: 'rt-rep-meta' }, h('b', null, 'Note '), h('span', null, x.note)) : null))

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Attack Score Chain Reproduction Report'),
          summary ? h('span', { className: 'rt-tag rt-tag-live' }, 'Total ' + summary.points + ' pts') : null,
          summary ? h('span', { className: 'rt-tag' }, summary.count + ' score items') : null,
          summary ? h('span', { className: 'rt-tag' + (summary.missingRequests ? '' : ' rt-tag-live') },
            summary.withRequests + '/' + summary.count + ' with raw requests') : null,
          summary ? h('span', {
            className: 'rt-tag' + (summary.incomplete ? ' rt-tag-warn' : ' rt-tag-live'),
            title: 'Chain completeness: has attack steps, actual commands, and linked vulns/creds/tunnels',
          }, 'Reproducible ' + (summary.count - (summary.incomplete || 0)) + '/' + summary.count) : null,
          summary && summary.serviceCappedExcluded
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: (summary.serviceCapped || []).map((x) => (x.service || '') + '｜' + (x.point_name || '')).join('\n')
                  || 'Duplicate account/database permission hit on same asset & port: Service capped; not scored or reported',
              }, 'Capped duplicates excluded ' + summary.serviceCappedExcluded)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => copy(mdText, 'Full Report') }, 'Copy Markdown'),
          h('button', { className: 'rt-btn', disabled: busy || !mdText, onClick: () => download(mdText, (data && data.target) || eng) }, 'Download .md'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Generating...' : 'Regenerate')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          stages.length
            ? h('div', { className: 'rt-rep-list' },
                h('div', { className: 'rt-rep-tools' },
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), true) }, 'Expand All'),
                  h('button', { className: 'rt-btn', onClick: () => collapse.setAll(stages.map((s) => 'st:' + s.code), false) }, 'Collapse All')),
                stages.map((st) => {
                  const open = collapse.isOpen('st:' + st.code, true)
                  const toggle = collapse.toggle('st:' + st.code, true)
                  return h('div', { key: 'g' + st.code, className: 'rt-rep-group' },
                    h('div', {
                      className: 'rt-rep-stage', role: 'button', tabIndex: 0,
                      style: { borderLeftColor: st.color },
                      'aria-expanded': open ? 'true' : 'false',
                      onClick: toggle,
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
                    },
                      h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
                      h('span', { className: 'rt-rep-no', style: { background: st.color } }, CIRCLED[st.ordinal - 1] || st.ordinal),
                      h('span', { className: 'rt-rep-stage-name' }, st.name),
                      h('span', { className: 'rt-rep-stage-n' }, st.items.length + ' items'),
                      h('div', { className: 'rt-spacer' }),
                      h('span', { className: 'rt-rep-pts', style: { background: st.color + '22', color: st.color, borderColor: st.color + '66' } },
                        '+' + st.points + ' pts'),
                      h('span', { className: 'rt-ap-cum' }, 'Cumulative ' + st.cumulative + ' pts')),
                    open ? h('div', { className: 'rt-rep-body' }, st.items.map(card)) : null)
                }))
            : (data === null ? h('div', { className: 'rt-empty' }, 'Loading...')
                : h('div', { className: 'rt-empty' },
                    h('div', null, 'No deliverable score hits recorded yet.'),
                    h('div', { style: { marginTop: 6, fontSize: 12 } },
                      'This report includes scored findings only. Record hits via redteam_score_hit and attach evidence via redteam_http_evidence_add.')))),
        h('div', { className: 'rt-foot' },
          h('span', null, 'Scope: Scored findings only; each item includes raw HTTP requests ready for Yakit/Burp Repeater')))
    }

    /* ---------------------------------------------------------- 攻击文件 */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: 'Script', wordlist: 'Wordlist', other: 'Other' }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const collapse = useCollapse('files:' + eng)
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to load'); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || 'Failed to load')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const fKey = 'folder:' + folder.folder
        const fileNodes = []
        for (const f of folder.files) {
          fileNodes.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow', style: { gridTemplateColumns: '18px 1.2fr 60px 1.6fr', cursor: 'pointer' },
            role: 'button', tabIndex: 0,
            onClick: () => openFile(f),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(f) } },
          },
            h('span', { className: 'rt-sec-caret' }, detail && detail.id === f.id ? '▾' : '▸'),
            h('span', { className: 'rt-mono' }, f.name),
            h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          fileNodes.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-kv' }, h('b', null, 'Validation Evidence:'), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv' }, h('b', null, 'File Path:'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)),
            h('div', { className: 'rt-kv' }, h('b', null, 'Recorded At:'), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '40vh', padding: '10px 12px' } }, detail.content || ' (Empty)'))))
        }
        rows.push(h(Section, {
          key: 'sec:' + folder.folder, tone: 'folder', title: folder.folder + '/',
          count: folder.count + ' files',
          open: collapse.isOpen(fKey, true), onToggle: collapse.toggle(fKey, true),
        }, fileNodes.length ? fileNodes : h('div', { className: 'rt-atest-meta' }, ' (Empty)')))
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Attack Artifacts'),
          h('span', { className: 'rt-tag' }, folders.length + ' targets / ' + total + ' files'),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Refreshing...' : 'Refresh')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, 'No attack artifacts recorded (verified scripts/POCs appear here by target folder)') : null),
        h('div', { className: 'rt-foot' }, h('span', null, 'Directory: attack-files/<IP|Host|CIDR>/ | Effective files only')))
    }

    /* ---------------------------------------------------------- 知识库（POC/EXP，全局共享） */
    /**
     * 知识库页：打 Nday/1day 之前先在这里搜。检索框支持 CVE / 组件 / 关键字 / 正文关键词；
     * 命中就展开拿全文（可直接复制去用），没有就说明要去互联网找或自己搓，验证后回填。
     * 这里是**全局**的：不随靶标切换，一个靶标沉淀的通用 POC 后面所有靶标都能用。
     */
    const POC_KIND_LABEL = { poc: 'POC', exp: 'EXP', script: 'Script', template: 'Template', payload: 'Payload' }
    const POC_SOURCE_LABEL = { web: 'Web', self: 'Custom', manual: 'Manual', 'nuclei-template': 'Nuclei Template', kb: 'Knowledge Base' }

    function KnowledgeTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [kind, setKind] = React.useState('')
      const [category, setCategory] = React.useState('')
      const [engagement, setEngagement] = React.useState('')
      const [assetTarget, setAssetTarget] = React.useState('')
      const [grouped, setGrouped] = React.useState(true)
      const [verifiedOnly, setVerifiedOnly] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [detailBusy, setDetailBusy] = React.useState(false)
      const [tplOffset, setTplOffset] = React.useState(0)
      const tplPageSize = 40

      const query = (over) => {
        const extra = over || {}
        const offset = Object.prototype.hasOwnProperty.call(extra, 'templateOffset') ? extra.templateOffset : 0
        setTplOffset(offset)
        const params = Object.assign({
          q: q.trim() || undefined,
          kind: kind || undefined,
          category: category || undefined,
          engagement: engagement || undefined,
          asset_target: assetTarget.trim() || undefined,
          verified: verifiedOnly || undefined,
          templateOffset: offset || 0,
          templateLimit: tplPageSize,
        }, extra)
        setBusy(true); setMsg(null)
        api(Object.assign({ op: 'pocSearch' }, params)).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to load'); return }
          setErr(null); setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      /* 首次进入与刷新键变化时拉全量（检索是显式动作，避免边打字边打接口） */
      React.useEffect(() => { query({ q: undefined, kind: undefined, category: undefined, engagement: undefined, asset_target: undefined, verified: undefined }) }, [refreshKey])

      const open = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id); setDetail(null); setDetailBusy(true)
        api({ op: 'pocGet', id: id }).then((r) => {
          setDetailBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to read' }); return }
          setDetail(r)
        }, (e) => { setDetailBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 同报告页：await 真实结果再提示 */
      const copy = (text, label) => copyWithFeedback(text, label, (okFlag, message) => {
        setMsg(okFlag ? { ok: message } : { err: message })
      })
      const useIt = (row) => {
        api({ op: 'pocUse', id: row.id, used_on: 'Console manual mark' }).then(() => {
          setMsg({ ok: 'Recorded reuse: ' + row.title })
          query()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (data && data.stats) || { total: 0, verified: 0, reused: 0, byKind: [], bySource: [] }
      const items = (data && data.items) || []
      const tpl = (data && data.templates) || { dir: null, total: 0, matched: 0, offset: 0, items: [], byCategory: [] }
      const tplByCat = new Map((tpl.byCategory || []).map((c) => [c.code, c.n || 0]))
      const catShown = (c) => (c.n || 0) + (tplByCat.get(c.code) || 0)
      const tplItems = tpl.items || []
      const tplMatched = tpl.matched != null ? tpl.matched : tpl.total
      const tplStart = Number(tpl.offset) || 0
      const turnTpl = (next) => {
        const offset = Math.max(0, next)
        setTplOffset(offset)
        query({ templateOffset: offset })
      }

      const card = (x) => {
        const isOpen = openId === x.id
        const d = isOpen && detail && detail.id === x.id ? detail : null
        return h('div', { key: 'p' + x.id, className: 'rt-kb' + (isOpen ? ' open' : '') },
          h('div', {
            className: 'rt-kb-head', role: 'button', tabIndex: 0, 'aria-expanded': isOpen ? 'true' : 'false',
            onClick: () => open(x.id),
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(x.id) } },
          },
            h('span', { className: 'rt-sec-caret' }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-kb-kind k-' + (x.kind || 'poc') }, POC_KIND_LABEL[x.kind] || x.kind || 'POC'),
            h('span', { className: 'rt-kb-title' }, x.title),
            x.cve ? h('span', { className: 'rt-tag rt-tag-passive' }, x.cve) : null,
            x.component ? h('span', { className: 'rt-tag' }, x.component) : null,
            x.verified === 1
              ? h('span', { className: 'rt-tag rt-tag-live' }, 'Verified')
              : h('span', { className: 'rt-tag rt-tag-warn' }, 'Unverified'),
            h('div', { className: 'rt-spacer' }),
            h('span', { className: 'rt-tag' }, POC_SOURCE_LABEL[x.source] || x.source || '—'),
            x.hit_count ? h('span', { className: 'rt-tag' }, 'Reused ' + x.hit_count) : null),
          /* 来源行：归类 · 影响版本 · 建立时间 · 来源靶标 · 发现资产 —— 一条知识"什么时候、
             在哪个单位的哪台资产上发现的"一眼可见 */
          h('div', { className: 'rt-kb-sub' },
            [x.category ? 'Category: ' + (POC_CAT_NAME[x.category] || x.category) : null,
              x.versions ? 'Affected: ' + x.versions : null,
              x.language || null,
              x.tags || null,
              'Created: ' + fmt(x.created_at),
              (x.engagement_name || x.engagement_id) ? 'Engagement: ' + (x.engagement_name || x.engagement_id) : null,
              x.asset_target ? 'Asset: ' + x.asset_target : null,
              x.found_by_agent ? 'Discovered by: ' + (ROLE_LABEL[x.found_by_agent] || x.found_by_agent) : null,
              x.source_url ? 'Source: ' + x.source_url : null].filter(Boolean).join(' · ')),
          isOpen
            ? h('div', { className: 'rt-kb-body' },
                detailBusy && !d ? h('div', { className: 'rt-empty' }, 'Loading...') : null,
                d ? h('div', null,
                  d.usage ? h('div', { className: 'rt-kv' }, h('b', null, 'Usage:'), h('span', { className: 'rt-mono' }, d.usage)) : null,
                  d.description ? h('div', { className: 'rt-kv' }, h('b', null, 'Description:'), h('span', null, d.description)) : null,
                  d.verified_note ? h('div', { className: 'rt-kv' }, h('b', null, 'Verification:'), h('span', null, d.verified_note)) : null,
                  d.used_on ? h('div', { className: 'rt-kv' }, h('b', null, 'Last Used:'), h('span', null, d.used_on)) : null,
                  d.path ? h('div', { className: 'rt-kv' }, h('b', null, 'Path:'), h('span', { className: 'rt-mono' }, d.path)) : null,
                  h('div', { className: 'rt-kb-actions' },
                    h('button', { className: 'rt-btn', disabled: !d.content, onClick: () => copy(d.content || '', 'POC Content') }, 'Copy Content'),
                    h('button', { className: 'rt-btn', onClick: () => useIt(x) }, 'Record Reuse'),
                    d.source_url ? h('button', { className: 'rt-btn', onClick: () => copy(d.source_url, 'Source URL') }, 'Copy Source') : null),
                  d.content
                    ? h('pre', { className: 'rt-rep-http' }, d.content.length > 12000 ? d.content.slice(0, 12000) + '\n... (Truncated; see on-disk file for full content)' : d.content)
                    : h('div', { className: 'rt-empty' }, 'Metadata only; no content. Update content via redteam_poc_update'))
                : null)
            : null)
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Knowledge Base · POC / EXP'),
          h('span', { className: 'rt-tag' }, stats.total + ' items'),
          h('span', { className: 'rt-tag rt-tag-live' }, 'Verified ' + stats.verified),
          h('span', { className: 'rt-tag' }, 'Reused ' + (stats.reused || 0)),
          (stats.uncategorized || 0) > 0 && (stats.uncategorized || 0) !== stats.total
            ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Uncategorized items: assign category via redteam_poc_add' }, 'Uncategorized ' + stats.uncategorized)
            : null,
          tpl.total ? h('span', { className: 'rt-tag rt-tag-passive' }, 'Local Templates ' + tpl.total) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''), title: 'Toggle Grouped / Flat View', onClick: () => setGrouped(!grouped) }, grouped ? 'Group by Category' : 'Flat List'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: () => query() }, busy ? 'Searching...' : 'Refresh')),
        /* 归类总览：点一下就是按该类筛选，一眼看清"哪类武器攒了多少、哪类还是空的" */
        h('div', { className: 'rt-kb-cats' },
          (stats.byCategory || []).filter((c) => catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)).map((c) => h('span', {
            key: c.code,
            className: 'rt-concl-i' + (category === c.code ? ' on' : ''),
            title: (c.hint || POC_CAT_NAME[c.code] || c.code)
              + ' · Local Templates ' + (tplByCat.get(c.code) || 0)
              + ' · Knowledge Base ' + (c.n || 0)
              + (c.verified ? ' (Verified ' + c.verified + ')' : ''),
            onClick: () => {
              const next = category === c.code ? '' : c.code
              setCategory(next)
              query({ category: next || undefined })
            },
          },
            h('b', null, String(catShown(c))),
            h('span', null, (POC_CAT_NAME[c.code] || c.code) + (c.verified ? ' (Verified ' + c.verified + ')' : ''))))),
        h('div', { className: 'rt-kb-filter' },
          h('input', {
            className: 'rt-input', style: { flex: 1, minWidth: 140 }, placeholder: 'Search CVE / Component / Keyword',
            value: q, onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: category, onChange: (e) => { setCategory(e.target.value); query({ category: e.target.value || undefined }) } },
            h('option', { value: '' }, 'All Categories'),
            POC_CAT_ORDER.map((k) => h('option', { key: k, value: k }, POC_CAT_NAME[k]))),
          h('select', { className: 'rt-input', style: { maxWidth: 120 }, value: engagement, onChange: (e) => { setEngagement(e.target.value); query({ engagement: e.target.value || undefined }) } },
            h('option', { value: '' }, 'All Source Targets'),
            (stats.byEngagement || []).map((e) => h('option', { key: e.engagement, value: e.engagement }, e.engagement + '（' + e.n + '）'))),
          h('input', {
            className: 'rt-input', style: { width: 120 }, placeholder: 'Filter by asset',
            value: assetTarget, onChange: (e) => setAssetTarget(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') query() },
          }),
          h('select', { className: 'rt-input', style: { maxWidth: 110 }, value: kind, onChange: (e) => { setKind(e.target.value); query({ kind: e.target.value || undefined }) } },
            h('option', { value: '' }, 'All Types'),
            Object.keys(POC_KIND_LABEL).map((k) => h('option', { key: k, value: k }, POC_KIND_LABEL[k]))),
          h('label', { className: 'rt-kb-check' },
            h('input', { type: 'checkbox', checked: verifiedOnly, onChange: (e) => { setVerifiedOnly(e.target.checked); query({ verified: e.target.checked || undefined }) } }),
            'Verified only'),
          h('button', { className: 'rt-btn rt-btn-primary', onClick: () => query() }, 'Search')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' },
          /engagement required|unknown op/i.test(err)
            /* 老 host 还没有知识库接口：讲清怎么恢复，别让人对着 "engagement required" 发懵 */
            ? 'Knowledge base interface provided by host; please restart host application to apply changes.'
            : err) : null,
        !err && data && data.dbPath
          ? h('div', { className: 'rt-foot', style: { marginBottom: 6, fontSize: 11 } },
              'Knowledge Base: ' + data.dbPath
              + (data.root ? ' (Root: ' + data.root + ')' : ''))
          : null,
        h('div', { className: 'rt-table' },
          (() => {
            if (!grouped) return items.map(card)
            /* 分组渲染：按内置归类顺序，未知归类挂到末尾的「其它」 */
            const buckets = new Map()
            for (const x of items) {
              const code = POC_CAT_NAME[x.category] ? x.category : 'other'
              if (!buckets.has(code)) buckets.set(code, [])
              buckets.get(code).push(x)
            }
            const order = POC_CAT_ORDER.filter((c) => buckets.has(c))
            for (const code of buckets.keys()) if (!order.includes(code)) order.push(code)
            const out = []
            for (const code of order) {
              const list = buckets.get(code)
              out.push(h('div', { key: 'g' + code, className: 'rt-kb-cat' },
                h('span', { className: 'rt-kb-cat-name' }, POC_CAT_NAME[code] || code),
                h('span', { className: 'rt-tag' }, list.length + ' items'),
                h('span', { className: 'rt-tag rt-tag-live' }, 'Verified ' + list.filter((x) => x.verified === 1).length),
                h('span', { className: 'rt-spacer' }),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  'Latest: ' + fmt(list.map((x) => x.created_at).filter(Boolean).sort().pop()))))
              for (const x of list) out.push(card(x))
            }
            return out
          })(),
          tplItems.length
            ? h('div', { className: 'rt-kb-tpl' },
                h('div', { className: 'rt-ap-sub' },
                  'Local Nuclei Templates · ' + (tplStart + 1) + '-' + (tplStart + tplItems.length) + ' / ' + tplMatched
                  + ' (Run via `nuclei -t <path>`)'),
                tplItems.map((t, i) => h('div', { key: 't' + tplStart + '-' + i, className: 'rt-kb-tpl-row' },
                  h('span', { className: 'rt-tag' }, t.severity || '—'),
                  t.category ? h('span', { className: 'rt-tag' }, POC_CAT_NAME[t.category] || t.category) : null,
                  h('span', { className: 'rt-mono rt-kb-tpl-path', title: t.path }, t.path),
                  h('span', { className: 'rt-kb-tpl-name', title: t.name }, t.name || ''),
                  h('button', {
                    className: 'rt-btn', style: { padding: '0 6px', fontSize: 10.5 },
                    onClick: () => copy('nuclei -t ' + t.path + ' -u <target>', 'Template Command'),
                  }, 'Copy Command'))),
                h('div', { className: 'rt-kb-actions' },
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart <= 0,
                    onClick: () => turnTpl(tplStart - tplPageSize),
                  }, 'Previous'),
                  h('button', {
                    className: 'rt-btn', disabled: busy || tplStart + tplItems.length >= tplMatched,
                    onClick: () => turnTpl(tplStart + tplPageSize),
                  }, 'Next')),
                tpl.dir ? h('div', { className: 'rt-foot' }, h('span', null, 'Template Directory: ' + tpl.dir)) : null)
            : null,
          data === null ? h('div', { className: 'rt-empty' }, 'Loading...') : null,
          data !== null && !items.length && !tplItems.length
            ? h('div', { className: 'rt-empty' },
                h('div', null,
                  q || kind || verifiedOnly
                    ? 'No hits: Try different keywords, search external sources, or add custom templates.'
                    : (tpl.total
                      ? ('Knowledge base is empty. Found ' + tpl.total + ' local nuclei templates, but not listed here. Please restart client.')
                      : (tpl.dir
                        ? 'Knowledge base is empty (template directory exists but has no YAML; run `nuclei -update-templates`).'
                        : 'Knowledge base is empty and no local nuclei templates found. Run setup.sh or `nuclei -update-templates`.'))),
                h('div', { style: { marginTop: 6, fontSize: 12 } },
                  'Standard Nday/1day workflow: 1) Search here via redteam_poc_search (also queries local nuclei templates) -> 2) If not found, search external sources (web_search / GitHub / ExploitDB) or write custom -> 3) Verify on target and record via redteam_poc_add for reuse across engagements.'),
                data.dbPath ? h('div', { style: { marginTop: 6, fontSize: 11 }, className: 'rt-mono' }, 'Knowledge Base File: ' + data.dbPath) : null,
                tpl.dir ? h('div', { style: { marginTop: 6, fontSize: 11 }, className: 'rt-mono' }, 'Template Directory: ' + tpl.dir) : null)
            : null),
        h('div', { className: 'rt-foot' },
          h('span', null, 'Global Shared (Cross-engagement) | Disk: pocs/<code>/ | Stores generic reusable POC/EXP; target-specific scripts belong in Attack Files')))
    }

    /* ---------------------------------------------------------- 环境适配（Windows / 非 Kali） */
    /**
     * 借鉴 Z3r0 的「系统配置」思路：路径与密钥进集中配置，不靠 bash/ps1。
     * 落盘 $DSH_HOME/redteam/config.json —— 用户填工具绝对路径或整包搜索目录。
     */
    function EnvTab(props) {
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [folderPath, setFolderPath] = React.useState('')

      const applyDraftFrom = (r) => {
        const c = (r && r.config) || {}
        setDraft({
          platform: c.platform || 'auto',
          toolkitDir: c.toolkitDir || '',
          nucleiTemplatesDir: c.nucleiTemplatesDir || '',
          binDirsText: (c.binDirs || []).join('\n'),
          tools: Object.assign({}, c.tools || {}),
          env: Object.assign({ FOFA_KEY: '', REDTEAM_VPS_HOST: '', REDTEAM_VPS_KEY: '' }, c.env || {}),
          notes: c.notes || '',
        })
        if (c.toolkitDir) setFolderPath(c.toolkitDir)
      }

      const load = () => {
        setBusy(true); setMsg(null)
        api({ op: 'platformConfigGet' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to read'); return }
          setErr(null); setData(r)
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const save = () => {
        if (!draft) return
        setBusy(true); setMsg(null)
        const config = {
          platform: draft.platform,
          toolkitDir: draft.toolkitDir,
          nucleiTemplatesDir: draft.nucleiTemplatesDir,
          binDirs: String(draft.binDirsText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          tools: draft.tools,
          env: draft.env,
          notes: draft.notes,
          envAdaptConfigured: true,
          envAdaptSkip: false,
        }
        api({ op: 'platformConfigSave', config }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to save' }); return }
          setData(r)
          setMsg({ ok: 'Saved to ' + ((r.config && r.config.path) || '$DSH_HOME/redteam/config.json') })
          applyDraftFrom(r)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const assignFolder = () => {
        const dir = String(folderPath || (draft && draft.toolkitDir) || '').trim()
        if (!dir) { setMsg({ err: 'Please enter toolkit directory path' }); return }
        setBusy(true); setMsg(null)
        api({ op: 'platformAssignToolkit', dir }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Auto-assign failed' }); return }
          setData(r)
          applyDraftFrom(r)
          setMsg({
            ok: 'Auto-assigned ' + (r.assignedCount || 0) + ' tools from directory'
              + (r.nucleiTemplatesDir ? ', and detected nuclei-templates' : ''),
          })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const setTool = (id, value) => setDraft((d) => d ? Object.assign({}, d, { tools: Object.assign({}, d.tools, { [id]: value }) }) : d)
      const setEnv = (key, value) => setDraft((d) => d ? Object.assign({}, d, { env: Object.assign({}, d.env, { [key]: value }) }) : d)

      const runtime = (data && data.runtime) || {}
      const adapt = (data && data.adapt) || {}
      const tools = (data && data.tools && data.tools.items) || []
      const found = tools.filter((t) => t.path).length
      const defaultToolkit = (data && data.toolkitDir) || '$DSH_HOME/redteam/toolkit'
      const defaultNuclei = (data && data.nucleiTemplatesDir) || (defaultToolkit + '/nuclei-templates')

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Environment Adaptation'),
          h('span', { className: 'rt-tag' }, runtime.effective === 'windows' ? 'Windows' : 'Linux/Kali'),
          adapt.kali ? h('span', { className: 'rt-tag rt-tag-live' }, 'Kali') : null,
          h('span', { className: 'rt-tag' + (adapt.ready ? ' rt-tag-live' : ' rt-tag-warn') },
            adapt.ready ? ('Ready · ' + (adapt.reason || '')) : 'Pending'),
          h('span', { className: 'rt-tag' + (found ? ' rt-tag-live' : ' rt-tag-warn') }, 'Tools ' + found + '/' + tools.length),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Loading...' : 'Refresh'),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !draft, onClick: save }, 'Save')),
        h('div', { className: 'rt-pane', style: { minHeight: 0 } },
        err ? h('div', { className: 'rt-err' }, err) : null,
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          adapt.message
            || 'All fields optional: Blank uses default path/discovery. Overrides defaults if filled. Keys only needed for survey/reverse shells.'),
        h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Toolkit Directory -> Auto Assign Tools'),
          h('div', { style: { marginBottom: 8, opacity: 0.9 } },
            'When tools reside in a folder (including subdirectories), enter path and click "Auto Assign": sets toolkitDir and maps binaries (nmap, nuclei, fscan, etc.) below.'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              className: 'rt-input', style: { flex: 1 },
              placeholder: 'e.g. D:\\pentest-tools or /opt/toolkit',
              value: folderPath,
              onChange: (e) => setFolderPath(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') assignFolder() },
            }),
            h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: assignFolder,
            }, busy ? 'Scanning...' : 'Auto Assign'))),
        data && data.hint ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 } }, data.hint) : null,
        data && data.egress ? h('div', { className: 'rt-card', style: { margin: '0 0 8px', fontSize: 12, lineHeight: 1.55 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Egress Network Status (Read-only)'),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTP_PROXY=' + (data.egress.http_proxy || '(None)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'HTTPS_PROXY=' + (data.egress.https_proxy || '(None)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'ALL_PROXY=' + (data.egress.all_proxy || '(None)')),
          h('div', { className: 'rt-mono', style: { fontSize: 11 } }, 'NO_PROXY=' + (data.egress.no_proxy || '(None)')),
          h('div', { style: { marginTop: 6, opacity: 0.85 } }, data.egress.note || '')) : null,
        !draft ? h('div', { className: 'rt-empty' }, 'Loading...') : h('div', null,
          h('div', { className: 'rt-card' },
            h('h4', null, 'Platform & Directories'),
            h('div', { style: { display: 'grid', gap: 8 } },
              h('label', { style: { fontSize: 12 } }, 'Platform Mode',
                h('select', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  value: draft.platform,
                  onChange: (e) => setDraft(Object.assign({}, draft, { platform: e.target.value })),
                },
                  h('option', { value: 'auto' }, 'auto (Host default)'),
                  h('option', { value: 'windows' }, 'windows'),
                  h('option', { value: 'linux' }, 'linux'))),
              h('label', { style: { fontSize: 12 } }, 'Toolkit Directory toolkitDir (Blank = default)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: 'Default: ' + defaultToolkit,
                  value: draft.toolkitDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { toolkitDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, 'Nuclei Templates Directory (Blank = auto: toolkit/nuclei-templates)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  placeholder: 'Default: ' + defaultNuclei,
                  value: draft.nucleiTemplatesDir,
                  onChange: (e) => setDraft(Object.assign({}, draft, { nucleiTemplatesDir: e.target.value })),
                })),
              h('label', { style: { fontSize: 12 } }, 'Tool Search Directories binDirs (One per line; blank = toolkit + PATH)',
                h('textarea', {
                  className: 'rt-input', rows: 4, style: { display: 'block', width: '100%', marginTop: 4, fontFamily: 'var(--dsw-font-mono, monospace)' },
                  placeholder: 'Optional. e.g.:' + String.fromCharCode(10) + 'D:\\tools' + String.fromCharCode(10) + 'D:\\pentest-bin',
                  value: draft.binDirsText,
                  onChange: (e) => setDraft(Object.assign({}, draft, { binDirsText: e.target.value })),
                })))),
          h('div', { className: 'rt-card' },
            h('h4', null, 'API Keys & VPS (Blank = no override; process env takes precedence)'),
            h('div', { style: { display: 'grid', gap: 8 } },
              ['FOFA_KEY', 'REDTEAM_VPS_HOST', 'REDTEAM_VPS_KEY'].map((k) => h('label', { key: k, style: { fontSize: 12 } }, k + ' (Optional)',
                h('input', {
                  className: 'rt-input', style: { display: 'block', width: '100%', marginTop: 4 },
                  type: k === 'FOFA_KEY' ? 'password' : 'text',
                  placeholder: k === 'REDTEAM_VPS_KEY' ? 'Blank; absolute path to private key if needed' : (k === 'REDTEAM_VPS_HOST' ? 'Blank; user@host if needed' : 'Blank; provide when surveying'),
                  value: (draft.env && draft.env[k]) || '',
                  onChange: (e) => setEnv(k, e.target.value),
                }))))),
          h('div', { className: 'rt-card' },
            h('h4', null, 'Tool Executables (Blank = auto-discover)'),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              'Resolution order: Configured absolute path -> toolkitDir -> binDirs -> PATH. Blank uses default discovery.'),
            tools.map((t) => h('div', { key: t.id, style: { marginBottom: 8 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                h('span', { style: { fontWeight: 600, minWidth: 88 } }, t.label || t.id),
                t.path
                  ? h('span', { className: 'rt-tag rt-tag-live', title: t.path }, t.source + ' · Found')
                  : h('span', { className: 'rt-tag rt-tag-warn' }, 'Not found (leave blank until installed)')),
              h('input', {
                className: 'rt-input', style: { width: '100%' },
                placeholder: 'Blank for auto: ' + (t.names || []).slice(0, 3).join(' / '),
                value: (draft.tools && draft.tools[t.id]) || '',
                onChange: (e) => setTool(t.id, e.target.value),
              }),
              t.path ? h('div', { className: 'rt-mono', style: { fontSize: 10.5, marginTop: 2, opacity: 0.8 } }, t.path) : null))),
          h('div', { className: 'rt-card' },
            h('h4', null, 'Notes'),
            h('textarea', {
              className: 'rt-input', rows: 3, style: { width: '100%' },
              placeholder: 'Optional. e.g. Tools from custom toolkit pack',
              value: draft.notes,
              onChange: (e) => setDraft(Object.assign({}, draft, { notes: e.target.value })),
            })),
          h('div', { className: 'rt-foot' },
            h('span', null,
              'Configuration file: ' + ((data && data.config && data.config.path) || '$DSH_HOME/redteam/config.json')
              + ' | Blank fields use defaults')))))
    }

    /* ---------------------------------------------------------- 得分目标 */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to read'); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      /* builtin 要一路带到表单：内置得分点的分值/名称/口径由《得分规则》锁定，
         界面必须把输入框置灰并说明原因 —— 以前是「能改、提示已保存、刷新后变回去」，
         用户以为是 bug。 */
      const startEdit = (p) => setForm({
        id: p.id, name: p.name, category: p.category || '', points: p.points,
        description: p.description || '', enabled: p.enabled, builtin: p.builtin === true,
        src: p.src, cap: p.cap, rule: p.rule,
      })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true, builtin: false }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: 'Name cannot be empty' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to save' }); return }
          /* overridden === false 表示后端**没有采纳**提交的分值（内置点由规则锁定）。
             这时不能笼统说「已保存」 —— 那句话会让用户以为分值改成功了。 */
          if (r.overridden === false) {
            setMsg({ err: 'Saved enabled/disabled state. Points unchanged: Built-in score points are locked by Score Rules. To customize points, use "+ Add Score Point".' })
          } else {
            setMsg({ ok: r.note || 'Saved' })
          }
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to delete' }); return }
          setMsg({ ok: 'Deleted' })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { achievedPoints: 0, pointCount: 0, hitPointCount: 0, hitCount: 0, selfCreatedHits: 0, serviceCappedHits: 0 }
      const items = (data && data.items) || []

      /* 按合并版的 8 个类别分组渲染（后端 ruleGroups 已排好序、组内按分值升序）。
         兼容：后端没给 ruleGroups（老 host）时退回平铺。 */
      const groups = (data && data.ruleGroups && data.ruleGroups.length)
        ? data.ruleGroups
        : [{ key: 'all', name: '', capSum: 0, points: 0, counted: 0, tiers: items }]
      const rows = []
      for (const g of groups) {
        if (g.name) {
          rows.push(h('div', { key: 'g-' + g.key, className: 'rt-score-group' },
            h('span', null, g.name),
            h('span', { className: 'rt-sg-sub' },
              g.tiers.length + ' items'
              + (g.capSum > 0 ? ' · Combined tier caps ' + g.capSum + ' pts (independent tiers)' : '')),
            h('div', { className: 'rt-spacer' }),
            g.points > 0
              ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + g.points + ' pts')
              : null))
        }
        for (const p of g.tiers) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row', role: 'button', tabIndex: 0,
          onClick: () => setOpenId(open ? null : p.id),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(open ? null : p.id) } },
        },
          h('span', { className: 'rt-sec-caret' }, open ? '▾' : '▸'),
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + ' pts')),
          h('span', { title: p.description || '' },
            p.name,
            p.tier ? h('span', { className: 'rt-scope' }, '　' + p.tier) : null),
          /* 命中与上限：这一条计入几次、上限用了多少（G3 各项上限独立，到顶就不再累计） */
          h('span', { title: p.capped > 0
            ? 'Counted ' + p.counted + ' hits; ' + p.capped + ' excluded due to scope or reached cap'
            : (p.scope_label || '') },
            h('span', { className: 'rt-sec-count' }, p.hits.length > 0 ? p.counted + ' hits' : '0 hits'),
            p.cap > 0
              ? h('span', { className: 'rt-scope' }, '  Cap ' + (p.cap_used === null ? 0 : p.cap_used) + '/' + p.cap)
              : null),
          h('span', { style: { textAlign: 'right' } }, p.earned > 0
            ? h('span', { className: 'rt-tag rt-tag-active' }, '+' + p.earned + ' pts')
            : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—'))))
        if (!open) continue
        /* 命中记录：一行一条 —— 第一行给"序号 + 资产 + 时间 + 复制"，内容另起一行自适应换行 */
        const hitNodes = p.hits.map((hh, hi) => h('div', {
          key: 'h' + hh.id,
          className: 'rt-hit-row' + (hh.self_created ? ' self-created' : '') + (hh.capped ? ' service-capped' : ''),
        },
          h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
          h('span', { className: 'rt-hit-asset', title: hh.target || hh.asset_ip || '' },
            hh.asset_ip || hh.target || 'Unspecified asset'),
          hh.self_created ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Self-registered/created accounts do not score; kept for audit trail only' }, 'Self-Created · 0 pts') : null,
          hh.capped ? h('span', {
            className: 'rt-tag rt-tag-warn',
            title: hh.capped_reason || 'Same service/port capped; highest value hit counted; this hit excluded',
          }, 'Service Capped · 0 pts' + (hh.service ? ' (' + hh.service + ')' : '')) : null,
          hh.shot_count ? h('span', { className: 'rt-tag', title: 'This hit has evidence screenshots' }, 'Shots ' + hh.shot_count) : null,
          h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at)),
          h('button', {
            className: 'rt-btn', style: { padding: '0 5px', fontSize: 10.5 },
            title: 'Copy this hit',
            onClick: (e) => {
              e.stopPropagation()
              copyText((hh.asset_ip || hh.target || '') + '  ' + (hh.evidence || ''))
            },
          }, 'Copy'),
          hh.evidence
            ? h('span', { className: 'rt-hit-txt', title: hh.evidence }, String(hh.evidence).replace(/\n+/g, ' '))
            : h('span', { className: 'rt-hit-txt none' }, 'No credentials/results provided')))

        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, 'Criteria'), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, 'Status'),
            h('span', null, (p.enabled ? 'Enabled' : 'Disabled') + ' · ' + p.points + ' pts/hit · Hits: ' + p.hits.length +
              ' = ' + p.earned + ' pts' + (p.self_created ? ' (' + p.self_created + ' self-created excluded)' : '') +
              (p.capped ? ' (' + p.capped + ' capped duplicates excluded)' : ''))),
          p.capped
            ? h('div', { className: 'rt-kv' }, h('b', null, 'Service Cap'),
                h('span', null, p.service_summary + '; Account and database permissions on the same asset & port are counted once; highest privilege hit counts'))
            : null,
          p.hits.length
            ? h('div', null,
                h(ShotStrip, { eng: eng, shots: p.shots, total: p.shot_total,
                  title: 'Evidence Screenshots · ' + (p.shot_total || (p.shots || []).length) }),
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } },
                  'Hits · ' + p.hits.length + ' (Summary only; full reproduction in report)'),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, 'Hits'),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  'None yet — Record hits via redteam_score_hit: specify target asset and credentials/privilege gained')),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, 'Edit')))))
        }
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Score Targets'),
          /* 只显示已拿下的总分，不显示目标分数、不显示进度条 */
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, 'Total Score: '),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, 'pts'),
          h('span', { className: 'rt-tag' }, summary.pointCount + ' Score Points'),
          h('span', { className: 'rt-tag' }, summary.countedHits + ' Hits Counted'),
          summary.selfCreatedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: 'Self-registered/created accounts do not score; kept for audit trail only (0 pts, no cap usage, excluded from report)',
              }, 'Self-created (unscored) ' + summary.selfCreatedHits)
            : null,
          summary.serviceCappedHits
            ? h('span', {
                className: 'rt-tag rt-tag-warn',
                title: 'Duplicate account/database permissions on the same asset & port capped; duplicate hits excluded from scoring',
              }, 'Service cap reached ' + summary.serviceCappedHits)
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: startNew }, '+ Add Score Point'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Refreshing...' : 'Refresh')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          /* 内置得分点（builtin）：分值 / 名称 / 分类由《得分规则》锁定，输入框置灰。
             可改的只有「启用 / 停用」。这样界面上就不会再出现「改完提示已保存、刷新变回去」的困惑。 */
          form.builtin
            ? h('div', { className: 'rt-hint', style: { marginBottom: 8 } },
                h('b', null, 'Built-in Score Point (From Penetration & Intrusion Scoring Rules)'),
                h('div', { style: { marginTop: 3 } },
                  'Points, caps, scope, and name are locked by rules. Toggle Enabled/Disabled here; to customize points, use "+ Add Score Point".'),
                form.src !== null && form.src !== undefined
                  ? h('div', { style: { marginTop: 3, color: 'var(--dsw-alias-label-secondary)' } },
                      'Rule #' + form.src + (form.rule ? ' · Cap group rule=' + form.rule : '') + (form.cap > 0 ? ' · Cap: ' + form.cap + ' pts' : ' · No cap'))
                  : null)
            : null,
          h('div', { className: 'rt-score-form' },
            h('input', {
              className: 'rt-input', placeholder: 'Name (required)', value: form.name,
              readOnly: form.builtin === true,
              title: form.builtin ? 'Built-in score point name is locked by rules' : '',
              onChange: (e) => setField('name', e.target.value),
            }),
            h('input', {
              className: 'rt-input', placeholder: 'Category, e.g. Credentials', value: form.category,
              readOnly: form.builtin === true,
              title: form.builtin ? 'Built-in score point category is locked by rules' : '',
              onChange: (e) => setField('category', e.target.value),
            }),
            h('input', {
              className: 'rt-input', type: 'number', placeholder: 'Points per hit',
              readOnly: form.builtin === true,
              title: form.builtin
                ? 'Built-in score points are locked by rules and cannot be edited here' : 'Points per hit; accumulates up to the rule cap',
              value: form.points, onChange: (e) => setField('points', Number(e.target.value)),
            }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, 'Enabled'),
              h('option', { value: '0' }, 'Disabled'))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: 'Scoring criteria & conditions', value: form.description,
            readOnly: form.builtin === true,
            title: form.builtin ? 'Built-in score point description is locked by rules' : '',
            onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, 'Save'),
          form.id
            ? (form.builtin
                ? h('button', {
                    className: 'rt-btn', disabled: true,
                    title: 'Built-in score points cannot be deleted. To disable scoring, toggle to Disabled.',
                  }, 'Delete (Built-in Locked)')
                : h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, 'Delete'))
            : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, 'Cancel'))) : null,
        h('div', { className: 'rt-table' },
          h('div', { className: 'rt-score-row head' },
            h('span', null, ''), h('span', null, 'Points'), h('span', null, 'Score Point (Ascending)'),
            h('span', null, 'Hits / Cap'), h('span', { style: { textAlign: 'right' } }, 'Earned')),
          rows,
          !items.length ? h('div', { className: 'rt-empty' }, 'No score points configured. Click "+ Add Score Point"') : null))
    }

    /* ---------------------------------------------------------- 折叠底座 */
    /**
     * 折叠状态按「页签 + 靶标」持久化到 localStorage，切页签/刷新后保持不变。
     * 只记录用户显式点过的键；没点过的用调用方给的默认值。
     */
    const COLLAPSE_KEY = 'rt-collapse:'
    const collapseLoad = (prefix) => {
      try {
        const raw = window.localStorage.getItem(COLLAPSE_KEY + prefix)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (e) { return {} }
    }
    const collapseSave = (prefix, value) => {
      try { window.localStorage.setItem(COLLAPSE_KEY + prefix, JSON.stringify(value)) } catch (e) { /* 隐私模式等 */ }
    }

    /** 一个页签一个 hook：isOpen(key, defaultOpen) / toggle(key, defaultOpen) / setAll(keys, open) */
    function useCollapse(prefix) {
      const [state, setState] = React.useState(() => collapseLoad(prefix))
      React.useEffect(() => { setState(collapseLoad(prefix)) }, [prefix])
      const write = (next) => { collapseSave(prefix, next); setState(next) }
      const isOpen = (key, defaultOpen) => {
        const v = state[key]
        return v === undefined ? defaultOpen !== false : v === true
      }
      const toggle = (key, defaultOpen) => (e) => {
        if (e && e.stopPropagation) e.stopPropagation()
        write(Object.assign({}, state, { [key]: !isOpen(key, defaultOpen) }))
      }
      const setAll = (keys, open) => {
        const next = Object.assign({}, state)
        for (const k of keys) next[k] = open
        write(next)
      }
      return { isOpen: isOpen, toggle: toggle, setAll: setAll }
    }

    /**
     * 统一折叠头（L1）：▾ 固定在最左、标题加粗、计数紧跟、右侧放时间或操作，
     * 内容缩进 12px 并带一条竖引导线。always=true 表示"常显"（不可折叠）。
     */
    function Section(props) {
      const always = props.always === true
      const open = always || props.open === true
      const head = h('div', {
        className: 'rt-sec t-' + (props.tone || 'target') + (always ? ' flat' : ''),
        role: always ? undefined : 'button',
        tabIndex: always ? undefined : 0,
        'aria-expanded': always ? undefined : (open ? 'true' : 'false'),
        onClick: always ? undefined : props.onToggle,
        onKeyDown: always ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggle) props.onToggle(e) }
        },
      },
        h('span', { className: 'rt-sec-caret' }, always ? '▍' : (open ? '▾' : '▸')),
        props.title ? h('span', { className: 'rt-sec-title' }, props.title) : null,
        props.count !== undefined && props.count !== null ? h('span', { className: 'rt-sec-count' }, String(props.count)) : null,
        props.sub ? h('span', { className: 'rt-sec-sub' }, props.sub) : null,
        props.right ? h('span', { className: 'rt-sec-right' }, props.right) : null)
      return h('div', { className: 'rt-sec-wrap' }, head,
        open && props.children ? h('div', { className: 'rt-sec-body' }, props.children) : null)
    }

    /** 长文本折叠（L3）：固定预览高度 + 渐隐 + 展开/复制。 */
    function Clip(props) {
      const [open, setOpen] = React.useState(false)
      const text = String(props.text === undefined || props.text === null ? '' : props.text)
      if (text.trim() === '') return null
      return h('div', { className: 'rt-clip' + (open ? ' open' : '') },
        h('div', { className: 'rt-clip-head' },
          props.label ? h('span', { className: 'rt-clip-label' }, props.label) : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); copyText(text) },
          }, 'Copy'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: (e) => { e.stopPropagation(); setOpen((v) => !v) },
          }, open ? 'Collapse' : 'Expand')),
        h('div', { className: 'rt-clip-body' }, text))
    }

    /* ---------------------------------------------------------- 当前测试（实时） */
    const TEST_STATUS_LABEL = {
      untested: 'Untested', testing: 'Testing', tested: 'Tested',
      blocked: 'Blocked', abandoned: 'Abandoned', no_surface: 'No Attack Surface',
    }

    /**
     * 当前测试页：agent 正在打哪台、打到哪一步、还有什么在排队。
     * 5 秒轮询自动刷新；三个区块可折叠，其中「正在测」始终完整展开。
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* 折叠状态按「页签 + 靶标」记忆；正在测永远常显，不参与折叠 */
      const collapse = useCollapse('testing:' + eng)

      /* 5 秒轮询要有在途守卫：网络慢或后端卡住时，请求会越堆越多、
         而且旧响应回来会覆盖新状态（界面上表现为数字来回跳）。 */
      const inflight = React.useRef(false)
      const seq = React.useRef(0)
      const load = () => {
        if (!eng || inflight.current) return
        inflight.current = true
        const my = ++seq.current
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (my !== seq.current) return          /* 切了靶标：这条已经过期，丢掉 */
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to read'); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => { if (my === seq.current) setErr(String((e && e.message) || e)) })
          .finally(() => { if (my === seq.current) inflight.current = false })
      }
      React.useEffect(() => { seq.current += 1; load() }, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* 一台资产一张卡：一眼看清"打的是谁、打到哪、拿到什么" */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? 'Internal' : 'External'))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, 'Open: ' + a.open_ports + ' ports'))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, 'Confirmed Vulns: ' + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, 'Tunnels: ' + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, 'Priority: ' + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455' } }, 'Blocked: ' + a.blocked_count + ' times'))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, 'Attack Surface: ' + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, 'Potential Points: ' + a.potential) : null,
          noteLines.length ? h(Clip, { label: 'Test Logs', text: noteLines.join('\n') }) : null)
      }


      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('Testing', stats.testing, 'live'),
        concl('Untested', stats.untested, ''),
        concl('Tested', stats.tested, ''),
        concl('Abandoned', (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl('No Surface', stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          'Updated at ' + at.toLocaleTimeString('en-US', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: 'Expand recent and untested queues',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], true),
        }, 'Expand All'),
        h('button', {
          className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, title: 'Keep testing only',
          onClick: () => collapse.setAll(['testing:' + eng, 'recent:' + eng, 'queue:' + eng], false),
        }, 'Collapse All'),
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 7px', fontSize: 11 },
          title: 'Auto-refresh every 5s', onClick: () => setAuto((x) => !x),
        }, auto ? 'Live · 5s' : 'Paused'),
        h('button', { className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, onClick: load }, 'Refresh'))

      const body = []
      /* 正在测：常显，完整展开（不可折叠） */
      body.push(h(Section, {
        key: 'testing', tone: 'test', title: 'Testing',
        count: testing.length + ' assets',
        sub: testing.length ? 'Agents actively testing these assets' : 'Assets appear here when agents begin testing',
        open: collapse.isOpen('testing:' + eng, true),
        onToggle: collapse.toggle('testing:' + eng, true),
      }, testing.length
        ? testing.map((a) => card(a, false))
        : h('div', { className: 'rt-atest-meta', style: { paddingBottom: 4 } }, 'No assets currently under test')))


      /* 最近动过（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'recent', tone: 'past', title: 'Recently Active', count: recent.length + ' assets',
        sub: 'Previously tested assets',
        open: collapse.isOpen('recent:' + eng, false),
        onToggle: collapse.toggle('recent:' + eng, false),
      }, recent.length ? recent.map((a) => card(a, true)) : h('div', { className: 'rt-atest-meta' }, 'None')))


      /* 待测队列（默认折叠，可记忆） */
      body.push(h(Section, {
        key: 'queue', tone: 'queue', title: 'Pending Queue',
        count: (data ? (data.untested || 0) : 0) + ' assets',
        sub: 'Prioritized by exploitability and open ports',
        open: collapse.isOpen('queue:' + eng, false),
        onToggle: collapse.toggle('queue:' + eng, false),
      }, queue.length
        ? queue.map((a) => card(a, true)).concat([
            h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { paddingTop: 4 } },
              'Full inventory with filters available under "Assets" tab')])
        : h('div', { className: 'rt-atest-meta' }, 'No pending assets')))

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, 'Loading...') : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- 会话与入口（WebShell / 隧道） */
    /**
     * 打内网最容易出的问题：拿到 WebShell 或隧道之后忘了登记，过一会儿就"忘了还有入口可用"。
     * 这个页签把事实库里的 WebShell 与隧道集中展示，带连通状态，并可一键让 host 侧实测。
     */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to read'); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Probe failed' }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: 'Probe complete: WebShell online ' + on + '/' + (r.webshells || []).length + ', Tunnels active ' + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 只有真的写进剪贴板才把按钮点亮成「已复制」；失败时如实报错 */
      const copy = (key, text) => copyWithFeedback(text, text, (okFlag, message) => {
        if (!okFlag) { setMsg({ err: message }); return }
        setCopied(key)
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
      })

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: 'Console manual mark' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: 'Console manual mark' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const sessCollapse = useCollapse('sessions:' + eng)
      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })
      /* 卡片里统一用「标签 + 值」两列，长文本自动换行 —— 比一行点分隔好扫读 */
      const fact = (label, value) => h('div', { className: 'rt-sess-fact' }, h('b', null, label), h('span', null, value))
      /* 交付要求：马必须是冰蝎/哥斯拉加密马（用户才连得上），内网必须走 suo5 隧道 */
      const isEncryptedShell = (t) => /behinder|godzilla|冰蝎|哥斯拉/i.test(String(t || ''))
      const isSuo5 = (t) => /suo5/i.test(String(t || ''))
      /* 提示条：只留一句结论 + 可展开的做法（原来是把三段长解释平铺，正文全被淹掉） */
      const hint = (key, title, detail) => h('div', { key, className: 'rt-hint' },
        h('b', null, title),
        h('details', { className: 'rt-sess-fold', style: { marginTop: 3 } },
          h('summary', null, 'Instructions (Click to expand)'),
          h('div', { style: { marginTop: 4 } }, detail)))
      const hints = []
      const badShells = shells.filter((w) => !isEncryptedShell(w.shell_type))
      const legitTunnels = tunnels.filter((t) => t.legit === true)
      if (badShells.length > 0) {
        hints.push(hint('h1', badShells.length + ' WebShell(s) are not Behinder/Godzilla (users cannot connect; not deliverable)',
          'Re-upload Behinder or Godzilla webshell via webshell-toolkit skill and record shell_type + pass_key via redteam_webshell_add. Note in remarks if used as temporary pivot only.'))
      }
      if (tunnels.length > 0 && legitTunnels.length === 0) {
        hints.push(hint('h3', 'Existing ' + tunnels.length + ' tunnels do not cross target perimeter (not counted as perimeter/intranet breach)',
          'Proxies/socks5 running on your own VPS do not qualify as tunnels. A target-side outbound channel is required (reverse shell, frp client on target, or suo5 tunnel via webshell); specify entry_kind when registering.'))
      }
      const activeSuo5 = tunnels.filter((t) => isSuo5(t.kind) && t.status === 'active')
      if (shells.length > 0 && activeSuo5.length === 0) {
        hints.push(hint('h2', 'No active suo5 tunnel found (standard channel for intranet pivoting)',
          'Build a socks5 tunnel via suo5-tunnel skill through the webshell above, register via redteam_tunnel_add (kind=suo5, listen=127.0.0.1:1080, entry=WebShell URL, reach=reachable CIDR), and probe connectivity to confirm status=active.'))
      }

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          isEncryptedShell(w.shell_type) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, 'Unencrypted Implant'),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: '#10b981' } }, 'Copied')
            : h('button', {
                className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, 'Copy URL'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => markShell(w, 'offline'),
          }, 'Mark Inactive')),
        h('div', { className: 'rt-sess-facts' },
          fact('Type', (isEncryptedShell(w.shell_type) ? 'Encrypted Shell (Behinder/Godzilla, direct user access)' : 'Plaintext Shell — No user client; temporary pivot only')),
          w.pass_key ? fact('Password / Key', h('span', { className: 'rt-mono' }, w.pass_key)) : null,
          w.asset_ip ? fact('Asset', w.asset_ip) : null,
          w.privilege ? fact('Privilege', w.privilege) : null,
          w.secret_ref ? fact('Credential Ref', h('span', { className: 'rt-mono' }, w.secret_ref)) : null,
          fact('Last Checked', (w.last_check ? fmt(w.last_check) : 'Not checked')
            + (w.latency_ms !== null && w.latency_ms !== undefined ? '（' + w.latency_ms + 'ms）' : '')),
          w.check_note ? fact('Check Result', w.check_note) : null,
          w.note ? fact('Notes', w.note) : null)))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? './gogo -i <IntranetCIDR> -m ss --ping -p top2,win,db --proxy ' + proxy : ''
        const fscanCmd = t.listen ? './fscan -h <IntranetCIDR> -np -nobr -nopoc -socks5 ' + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || '(No listen address)'),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            isSuo5(t.kind) ? null : h('span', { className: 'rt-tag rt-tag-warn' }, 'Non-suo5 tunnel'),
            /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
            t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live', title: t.entry_kind_label || '' }, 'Target-Side Channel')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn', title: 'Proxy opened on self-hosted VPS only; did not touch target — not counted as perimeter breach' }, 'Excluded')
                  : h('span', { className: 'rt-tag', title: 'Undeclared entry_kind: specify target-side channel type' }, 'Pending')),
            t.reach ? h('span', { className: 'rt-tag' }, 'Reaches ' + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? 'Copied' : 'Copy Address'),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'down') }, 'Mark Down')
              : h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'active') }, 'Mark Active')),
          h('div', { className: 'rt-sess-facts' },
            fact('Target Entrypoint', t.entry || 'Unregistered'),
            fact('Boundary Cross', t.legit === true
              ? h('span', { className: 'rt-tag rt-tag-live' }, t.entry_kind_label || t.entry_kind || 'Target-Side Confirmed')
              : (t.legit === false
                  ? h('span', { className: 'rt-tag rt-tag-warn' }, 'Excluded (VPS proxy only)')
                  : h('span', { className: 'rt-tag' }, 'Pending entry_kind'))),
            t.reach ? fact('Reachable Segments', t.reach) : null,
            t.asset_ip ? fact('Asset', t.asset_ip) : null,
            fact('Last Checked', (t.last_check ? fmt(t.last_check) : 'Not checked')
              + (t.latency_ms !== null && t.latency_ms !== undefined ? '（' + t.latency_ms + 'ms）' : '')),
            t.check_note ? fact('Check Note', t.check_note) : null,
            t.note ? fact('Notes', t.note) : null),
          /* 命令默认折叠：卡片首要信息是"这条通道能不能用、通向哪"，命令按需展开 */
          t.command ? h('details', { className: 'rt-sess-fold' },
            h('summary', null, 'Setup Command (Click to expand / copy)'),
            h('div', Object.assign({ className: 'rt-code', title: 'Click to copy' }, clickable(() => copy('c' + t.id, t.command), { label: 'Copy command' })),
              copied === 'c' + t.id ? 'Copied' : t.command)) : null,
          t.status === 'active' && t.listen
            ? h('details', { className: 'rt-sess-fold' },
                h('summary', null, 'Scan via Tunnel (gogo / fscan)'),
                h('div', { className: 'rt-sess-cmd' },
                  h('div', Object.assign({ className: 'rt-code', title: 'Click to copy' }, clickable(() => copy('g' + t.id, gogoCmd), { label: 'Copy gogo command' })),
                    copied === 'g' + t.id ? 'Copied' : gogoCmd),
                  h('div', Object.assign({ className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: 'Click to copy' }, clickable(() => copy('f' + t.id, fscanCmd), { label: 'Copy fscan command' })),
                    copied === 'f' + t.id ? 'Copied' : fscanCmd)))
            : null)
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Sessions & Entrypoints'),
          h('span', { className: 'rt-tag' }, 'WebShells ' + (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' online'),
          h('span', { className: 'rt-tag' }, 'Tunnels ' + (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' active'),
          h('span', { className: 'rt-tag' }, 'Credentials ' + (totals.credentials || 0)),
          h('span', { className: 'rt-tag' }, 'Access Sessions ' + (totals.access || 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? 'Probing...' : 'Probe Connectivity'),
          h('button', { className: 'rt-btn', onClick: load }, 'Refresh')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          !shells.length && !tunnels.length
            ? h('div', { className: 'rt-empty' },
                h('div', null, 'No WebShells or tunnels registered yet.'),
                h('div', { style: { marginTop: 6, fontSize: 12 } },
                  'Register WebShells via redteam_webshell_add; register tunnels via redteam_tunnel_add (suo5 / socks5 / ssh -R); subagents query them via redteam_sessions.'))
            : null,
          hints.length ? h('div', { style: { padding: '8px 10px 0' } }, hints) : null,
          h(Section, {
            key: 'webshells', tone: 'queue', title: 'WebShell',
            count: (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' online',
            sub: 'Active access implants',
            open: sessCollapse.isOpen('shells', true), onToggle: sessCollapse.toggle('shells', true),
          }, shells.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, shellCards)
            : h('div', { className: 'rt-atest-meta' }, 'None (Register WebShells via redteam_webshell_add)')),
          h(Section, {
            key: 'tunnels', tone: 'test', title: 'Internal Tunnels',
            count: (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' active',
            sub: 'Proxy tunnels for downstream tools',
            open: sessCollapse.isOpen('tunnels', true), onToggle: sessCollapse.toggle('tunnels', true),
          }, tunnels.length
            ? h('div', { className: 'rt-sess-grid', style: { padding: 0 } }, tunnelCards)
            : h('div', { className: 'rt-atest-meta' }, 'None (Register tunnels via redteam_tunnel_add)'))))

    }

    /* ---------------------------------------------------------- 错误边界 */
    /**
     * 单个页签渲染出错时只降级该页签，不拖垮整个面板：面板与侧栏按钮保持可用，
     * 用户可一键回到资产测绘。（此前面板整块消失、按钮点不开就是缺了这层保护。）
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[redteam-ui] Page render error:', error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, 'Page render error: ' + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, 'Return to Assets'))
        }
        return this.props.children
      }
    }

    /**
     * 智能体页签：并发名额（最多 3 个）+ 六个角色与它们的提示词。
     * 主会话派活前先看这里的名额，用户也能一眼看到"现在还能拉起几个智能体"。
     */
    function AgentsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [concurrency, setConcurrency] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: eng ? 'prompts' : 'bootstrap', engagement: eng || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to read'); return }
          setErr(null)
          if (r.roles) setRoles(r.roles)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
        /* 并发名额按"当前跑着的子智能体"算；host 侧读 subagents 注册表 */
        api({ op: 'agentsStatus' }).then((r) => {
          if (r && r.ok !== false) setConcurrency(r)
        }, () => {})
      }
      React.useEffect(load, [eng, refreshKey])

      const used = concurrency ? concurrency.used : null
      const max = concurrency ? concurrency.max : 3
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, 'Operational Subagents'),
          h('span', { className: 'rt-tag rt-tag-passive' }, 'Max Concurrency ' + max),
          used === null
            ? h('span', { className: 'rt-tag' }, 'Usage Unknown')
            : h('span', { className: 'rt-tag' + (used >= max ? ' rt-tag-warn' : ' rt-tag-live') }, 'Running ' + used + ' / Remaining ' + Math.max(max - used, 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? 'Loading...' : 'Refresh')),
        h('div', { className: 'rt-pane' },
          err ? h('div', { className: 'rt-err' }, err) : null,
          h('div', { className: 'rt-card' },
            h('h4', null, 'Concurrency Rules (Hard Constraints)'),
            h('div', { style: { fontSize: 12, lineHeight: 1.7 } },
              '· Max **' + max + ' concurrent subagents** per engagement; Commander reserves slots via `redteam_agent_slot` and rejects if full.',
              h('br'),
              '· **Dispatch sequentially by default**; parallelize only strictly independent tasks.',
              h('br'),
              '· Each session has **its own engagement binding**; subagents inherit their parent engagement context.')),
          h('div', { className: 'rt-card' },
            h('h4', null, 'Six Agent Roles'),
            h('div', { style: { fontSize: 12, lineHeight: 1.8 } },
              '① Recon `recon` — Asset discovery: build comprehensive asset inventory (including perimeter & unindexed assets)', h('br'),
              '② Assess `assess` — Asset triage: evaluate exploitability and persist to database', h('br'),
              '③ Vuln Scan `vuln-scan` — Vuln discovery: dedup against DB -> prioritize 1day/Nday -> probe interfaces', h('br'),
              '④ Exploit `exploit` — Exploitation: gain server shell (Behinder/Godzilla) + setup suo5 tunnel before other goals', h('br'),
              '⑤ Intranet `internal` — Intranet pivoting: tunnel through perimeter and execute ①②③④ internally', h('br'),
              '⑥ Commander `plan` — Planning: task delegation, aggregation, reporting only')),
          h(ConcurrencyCard, { concurrency, onSaved: load }),
          h('div', { className: 'rt-card' },
            h('h4', null, 'Agent Role Prompts (Saved per engagement; editable here)'),
            h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
              'Agent Prompts are unified here. Edit below and click Save (applies to current engagement).'),
            h(PromptsTab, { engagement: eng, refreshKey: refreshKey }))))
    }

    function ConcurrencyCard(props) {
      const info = props.concurrency || {}
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      React.useEffect(() => { if (info.max) setDraft(String(info.max)) }, [info.max])

      const limit = info.limit || 10
      const used = typeof info.used === 'number' ? info.used : null
      const source = info.source === 'settings' ? 'Console Settings'
        : info.source === 'env' ? 'Env REDTEAM_MAX_AGENTS' : 'Default'
      const n = Number(draft)
      const invalid = !Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > limit
      const save = () => {
        if (invalid) return
        setBusy(true); setMsg(null)
        api({ op: 'setAgentsMax', max: n }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to save' }); return }
          setMsg({ ok: 'Saved: Max concurrency ' + r.max + ' (Active immediately, no restart needed)' })
          if (props.onSaved) props.onSaved()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      return h('div', { className: 'rt-card' },
        h('h4', null, 'Agent Concurrency'),
        h('div', { style: { fontSize: 12, lineHeight: 1.8, marginBottom: 8 } },
          'Maximum **concurrent subagents** per engagement. Active: **' + (info.max || '?') + '**'
          + (used === null ? '' : ' (Running ' + used + ', Remaining ' + Math.max((info.max || 0) - used, 0) + ')')
          + ', Source: ' + source + '. Changes take effect **immediately**.'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            className: 'rt-input', style: { width: 90 }, type: 'number', min: 1, max: limit,
            value: draft, onChange: (e) => setDraft(e.target.value),
          }),
          h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, 'Range: 1 - ' + limit),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || invalid, onClick: save },
            busy ? 'Saving...' : 'Save'),
          msg && msg.err ? h('span', { style: { fontSize: 12, color: 'var(--rt-danger, #d33)' } }, msg.err) : null,
          msg && msg.ok ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, msg.ok) : null),
        h('div', { className: 'rt-note', style: { marginTop: 8 } },
          '⚠️ Increasing concurrency does not guarantee higher throughput: API keys share rate limits. Running too many agents simultaneously causes queue delays, timeouts, truncation, and rate-limit errors. We recommend 2-3 concurrent agents unless your API quota is substantial and tasks are strictly independent.'))
    }

    /**
     * 版本显示 + 自动更新按钮。
     *
     * 行为：挂载时静默查一次最新版本（npm registry），有新版本就把按钮点亮成
     * 「有新版本 vX」；点击弹出确认框（当前版本 / 最新版本 / 安装位置 / 阻塞项），
     * 确认后由 host 侧执行 安装 → 重启 dsh web（页面会断开，重启后刷新即可）。
     */
    function VersionBar(props) {
      const [info, setInfo] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)

      const check = (silent) => {
        if (!silent) setBusy(true)
        api({ op: 'updateCheck' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) {
            /* 开发态或查不到 registry：只显示当前版本，不报错打扰用户 */
            if (!silent) setErr((r && r.error) || 'Check for updates failed')
            api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
            return
          }
          setErr(null)
          setInfo(r)
        }, (e) => {
          setBusy(false)
          if (!silent) setErr(String((e && e.message) || e))
          api({ op: 'version' }).then((v) => { if (v && v.ok !== false) setInfo(v) }, () => {})
        })
      }
      React.useEffect(() => { check(true) }, [])

      const apply = () => {
        setBusy(true)
        setMsg(null)
        api({ op: 'updateApply', target: (info && info.latest) || undefined }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || 'Failed to update' }); return }
          setMsg({ ok: 'Installed ' + (r.installed || '') + '; restarting host application...' })
          /* 重启会断开这个页面：倒计时提示用户稍后刷新 */
          setCountdown(6)
          const t = setInterval(() => {
            setCountdown((n) => {
              if (n <= 1) { clearInterval(t); window.location.reload(); return 0 }
              return n - 1
            })
          }, 1000)
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const current = info && info.current ? info.current : (info && info.plugin ? info.plugin.version : null)
      const latest = info && info.latest ? info.latest : null
      const hasNew = !!(info && info.updateAvailable)
      const blockers = (info && info.blockers) || []
      const notes = (info && info.notes) || []
      const mode = info && info.install ? info.install.mode : null

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', {
          className: 'rt-tag' + (hasNew ? ' rt-tag-warn' : ''),
          title: ('Current version: ' + (current || 'Unknown') + (latest ? '\nLatest version: ' + latest : '')
            + (mode === 'dev' ? '\nInstallation: Dev (symlink)' : mode === 'package' ? '\nInstallation: Package' : '')
            + (info && info.check_error ? '\nCheck failed: ' + info.check_error : '')),
        }, 'v' + (current || '?')),
        hasNew
          ? h('button', {
              className: 'rt-btn rt-btn-primary', disabled: busy,
              onClick: () => { setOpen(true); setMsg(null) },
              title: 'New version ' + latest + ' available: click to view and update',
            }, busy ? 'Checking...' : 'New Version v' + latest)
          : h('button', {
              className: 'rt-btn', disabled: busy, onClick: () => check(false),
              title: 'Check npm for latest version',
            }, busy ? 'Checking...' : 'Check Updates'),
        open
          ? h('div', { className: 'rt-modal', 'aria-hidden': 'true', onClick: () => setOpen(false) },
              h('div', { className: 'rt-modal-box', onClick: (e) => e.stopPropagation() },
                h('h4', { style: { marginTop: 0 } }, 'Update RedTeam Mode'),
                h('div', { className: 'rt-kv' }, h('b', null, 'Current Version'), h('span', null, current || 'Unknown')),
                h('div', { className: 'rt-kv' }, h('b', null, 'Latest Version'), h('span', null, latest || 'Unknown')),
                h('div', { className: 'rt-kv' }, h('b', null, 'Installation Mode'),
                  h('span', null, mode === 'dev' ? 'Dev (symlink)' : mode === 'package' ? 'Package (' + ((info.install && info.install.packageManager) || 'npm') + ')' : 'Unknown')),
                info && info.install && info.install.dir
                  ? h('div', { className: 'rt-kv' }, h('b', null, 'Install Path'), h('span', { className: 'rt-mono' }, info.install.dir))
                  : null,
                blockers.length
                  ? h('div', { className: 'rt-hint' },
                      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, 'Cannot update right now:'),
                      blockers.map((b, i) => h('div', { key: 'b' + i }, '· ' + b)))
                  : null,
                notes.length
                  ? h('div', { className: 'rt-foot', style: { padding: '4px 0' } }, notes.map((n, i) => h('div', { key: 'n' + i }, n)))
                  : null,
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' } },
                  'Update process: Install new version -> Automatically restart host (web/app; reconnects in 5-10 seconds). Active agents will block restarts until finished.'),
                msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
                countdown > 0
                  ? h('div', { className: 'rt-foot' }, 'Host is restarting; auto-refreshing in ' + countdown + 's...')
                  : null,
                h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
                  h('button', { className: 'rt-btn', onClick: () => setOpen(false) }, 'Close'),
                  h('button', {
                    className: 'rt-btn rt-btn-primary',
                    disabled: busy || blockers.length > 0 || mode === 'dev',
                    title: mode === 'dev' ? 'Dev installations must be updated via git' : blockers.length ? 'Resolve blocking items above first' : 'Install and Restart',
                    onClick: apply,
                  }, busy ? 'Updating...' : 'Update & Restart'))))
          : null)
    }

    /* ---------------------------------------------------------- 常驻面板主体 */
    /**
     * 「未读」状态：按靶标记在 localStorage 里，每 25 秒问一次 host 的 consoleDigest
     * （每个页签的条数 + 最近更新时间）。比本地记住的快照新 → 该页签点红点；
     * 用户点开那个页签就把当前值记成已读，红点消失。
     */
    const UNREAD_KEY = 'rt-unread:'
    const loadUnread = (eng) => {
      try {
        const raw = window.localStorage.getItem(UNREAD_KEY + eng)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    const saveUnread = (eng, value) => {
      try { window.localStorage.setItem(UNREAD_KEY + eng, JSON.stringify(value)) } catch (e) { /* 隐私模式等：不持久化也能用 */ }
    }
    /** 这个页签相对上次查看有没有新内容（条数变多，或最新一条比上次查看还新）。 */
    const digestHasNew = (prev, cur) => {
      if (!cur) return false
      if (!prev) return true
      const pc = Number(prev.count || 0)
      const cc = Number(cur.count || 0)
      if (cc > pc) return true
      const pa = prev.at || ''
      const ca = cur.at || ''
      return ca !== '' && ca !== pa && ca > pa
    }

    const RT_GEOM_KEY = 'rt-dock-geom-v1'
    function clampRtGeom(g) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      const w = Math.min(Math.max(320, Number(g && g.w) || 620), Math.max(320, vw))
      const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh))
      const x = Math.min(Math.max(0, Number(g && g.x) || 0), Math.max(0, vw - w))
      const y = Math.min(Math.max(0, Number(g && g.y) || 0), Math.max(0, vh - h))
      return { x: x, y: y, w: w, h: h }
    }
    function defaultRtGeom() {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800
      let w = 620
      try {
        const saved = Number(window.localStorage.getItem('rt-dock-width'))
        if (Number.isFinite(saved) && saved >= 320 && saved <= 1200) w = saved
      } catch (e) { /* 隐私模式 */ }
      const h = Math.max(240, Math.min(640, vh - 24))
      return clampRtGeom({ x: Math.max(0, vw - w - 12), y: 12, w: w, h: h })
    }
    function loadRtGeom() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(RT_GEOM_KEY) || 'null')
        if (raw && typeof raw === 'object') return clampRtGeom(raw)
      } catch (e) { /* 隐私模式或坏数据 */ }
      return defaultRtGeom()
    }

    function Panel(props) {
      /* embedded：嵌在 dsh-purge 外层 dock 里时，不再自带收起/全面浏览/拖拽条，避免与外层按钮重叠 */
      const embedded = !!(props && props.embedded)
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [geom, setGeom] = React.useState(loadRtGeom)
      const [creating, setCreating] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [digest, setDigest] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      React.useEffect(() => {
        if (embedded) return undefined
        try { window.localStorage.setItem(RT_GEOM_KEY, JSON.stringify(geom)) } catch (e) { /* 隐私模式 */ }
      }, [geom, embedded])
      React.useEffect(() => {
        if (embedded) return undefined
        const onResize = () => setGeom((g) => clampRtGeom(g))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [embedded])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Failed to load'); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || 'Cannot connect to asset database'); return }
          setEngagements(r.engagements || [])
          const id = r.current || (r.engagements && r.engagements[0] && r.engagements[0].id) || null
          if (id) { setEng(id); loadSnapshot(id) }
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || 'Creation failed'); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** 刷新：重新拉取名册/快照，并让当前页签重新取数。 */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
      }

      const trackPointer = (e, move) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,a,input,select,textarea,label')) return
        const sx = e.clientX
        const sy = e.clientY
        const ox = geom.x
        const oy = geom.y
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h })))
      }
      const startResizeLeft = (e) => {
        const sx = e.clientX
        const ox = geom.x
        const ow = geom.w
        trackPointer(e, (ev) => {
          const dx = ev.clientX - sx
          setGeom((g) => clampRtGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }))
        })
      }
      const startResizeRight = (e) => {
        const sx = e.clientX
        const ow = geom.w
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h })))
      }
      const startResizeBottom = (e) => {
        const sy = e.clientY
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) })))
      }
      const startResizeCorner = (e) => {
        const sx = e.clientX
        const sy = e.clientY
        const ow = geom.w
        const oh = geom.h
        trackPointer(e, (ev) => setGeom((g) => clampRtGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) })))
      }

      /* 切靶标：重新读该靶标的未读快照，并立刻取一次摘要 */
      React.useEffect(() => {
        if (!eng) { setDigest(null); setSeen(null); return undefined }
        setSeen(loadUnread(eng))
        let alive = true
        let digestInflight = false
        const tick = () => {
          if (digestInflight) return        /* 上一轮还没回来，跳过这一轮，别把请求堆起来 */
          digestInflight = true
          api({ op: 'consoleDigest', engagement: eng }).then((r) => {
            if (alive && r && r.ok !== false && r.sections) setDigest(r.sections)
          }, () => { /* 网络异常：不打断，等下一轮 */ })
            .finally(() => { digestInflight = false })
        }
        tick()
        const timer = window.setInterval(tick, 25000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [eng, refreshKey])

      /**
       * 打开某个页签 = 看过这个页签的内容：把当前摘要记成已读。
       * 没读过（第一次打开面板）不算新内容 —— 否则一进来满屏红点，反而看不出"哪里有新东西"。
       */
      const markTabSeen = React.useCallback((tab) => {
        if (!eng) return
        setSeen((prev) => {
          const base = prev || (() => {
            const fresh = {}
            for (const [k, v] of Object.entries((digest || {}))) fresh[k] = { count: Number(v.count || 0), at: v.at || null }
            return fresh
          })()
          const next = Object.assign({}, base)
          const cur = digest && digest[tab]
          if (cur) next[tab] = { count: Number(cur.count || 0), at: cur.at || null }
          saveUnread(eng, next)
          return next
        })
      }, [eng, digest])

      const unreadOf = (tab) => {
        if (!eng || !digest) return false
        if (!seen) return false
        return digestHasNew(seen[tab], digest[tab])
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [
        ['assets', 'Assets'], ['env', 'Environment'], ['agents', 'Agents'], ['sessions', 'Sessions & Tunnels'],
        ['findings', 'Findings'],
        ['chain', 'Attack Chain'], ['scores', 'Score Goals'], ['report', 'Report'],
        ['knowledge', 'Knowledge Base'],
        ['skills', 'Skill Library'],
      ]
      const full = isFullWindow()
      const openFull = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (e) { setErr('Failed to open new window: ' + ((e && e.message) || e)) }
      }
      const exitFull = () => {
        /* 优先关掉脚本打开的窗口；关不掉就退回带侧栏的普通界面 */
        try { window.close() } catch (e) { /* 非脚本打开的窗口无法关闭 */ }
        try {
          if (window.location.hash) {
            window.location.hash = ''
            window.location.reload()
          }
        } catch (e) { /* ignore */ }
      }
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (e) => { if (e.key === 'Escape') exitFull() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      /* 全局页：没有靶标也能看（知识库 / 环境适配 / 技能库 / 智能体概览） */
      else if (st.tab === 'knowledge') body = h(KnowledgeTab, { refreshKey: refreshKey })
      else if (st.tab === 'env') body = h(EnvTab, { refreshKey: refreshKey })
      else if (st.tab === 'skills') body = h(SkillsTab, { refreshKey: refreshKey })
      else if (st.tab === 'agents' || st.tab === 'prompts') body = h(AgentsTab, { engagement: eng, refreshKey: refreshKey })
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, 'No Target Selected'),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              'Enter target organization name to initialize red team engagement and asset discovery.'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: 'e.g. "Example Tech Corp"',
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? 'Creating...' : 'Create Target'))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'testing') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'attackfiles') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else body = h('div', { className: 'rt-empty' }, 'Unknown Tab')

      const shellProps = full
        ? { className: 'rt-full', style: { display: 'flex' } }
        : embedded
          ? { className: 'rt-dock rt-embedded', 'data-open': '1', style: { width: '100%', display: 'flex' } }
          : {
              className: 'rt-dock',
              'data-open': st.open ? '1' : '0',
              style: {
                left: geom.x + 'px',
                top: geom.y + 'px',
                right: 'auto',
                bottom: 'auto',
                width: geom.w + 'px',
                height: geom.h + 'px',
                display: st.open ? 'flex' : 'none',
              },
            }

      return h('div', shellProps,
        (full || embedded) ? null : h('div', { className: 'rt-grip', title: 'Drag to resize width', onMouseDown: startResizeLeft }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-r', title: 'Drag to resize width', onMouseDown: startResizeRight }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-b', title: 'Drag to resize height', onMouseDown: startResizeBottom }),
        (full || embedded) ? null : h('div', { className: 'rt-resize-c', title: 'Drag to resize', onMouseDown: startResizeCorner }),
        h('div', { className: 'rt-head', onMouseDown: (full || embedded) ? undefined : startDrag, title: (full || embedded) ? undefined : 'Hold to drag panel' },
          embedded ? null : h('div', { className: 'rt-title' }, h('span', { className: 'rt-dot' }),
            full ? 'Red Team Console · Full View' : 'Red Team Console',
            full ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, 'Standalone Window') : null),
          h('select', {
            className: 'rt-input rt-eng-select',
            style: { maxWidth: embedded ? '100%' : '170px', minWidth: embedded ? '160px' : undefined, flex: embedded ? '1 1 200px' : undefined },
            value: eng || '',
            onChange: (e) => {
              setEng(e.target.value)
              loadSnapshot(e.target.value)
              /* 同步「当前靶标」：原生 skill 目录按它解析技能根 */
              api({ op: 'activateEngagement', engagement: e.target.value }).catch(() => {})
            },
          },
            h('option', { value: '', disabled: true }, engagements.length ? 'Select Target' : 'No Targets'),
            engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id || 'Untitled')),
          ),
          h('div', { className: 'rt-spacer' }),
          embedded ? null : h(VersionBar, null),
          full ? h('button', { className: 'rt-btn', title: 'Return to normal dock view (or press Esc)', onClick: exitFull }, 'Exit Full View') : null,
          embedded ? null : h('button', { className: 'rt-btn', title: 'Refresh targets, snapshot, and active tab data', onClick: refreshAll }, 'Refresh'),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: 'Open full console in separate browser window', onClick: openFull }, 'Full View'),
          (full || embedded) ? null : h('button', { className: 'rt-btn', title: 'Collapse panel', onClick: () => setUI({ open: false }) }, 'Collapse')),
        /* 页签栏用标准 tablist/tab 角色：读屏软件据此播报「第几个页签、是否选中」。
           键盘用户 Tab 进来后可用 Enter/Space 切换（由 clickable 提供）。 */
        h('div', { className: 'rt-tabs', role: 'tablist' }, tabs.map((t) => {
          const activate = () => {
            markTabSeen(t[0])
            setUI({ tab: t[0] })
            /* 强制当前页重新取数，避免切页后仍显示上一页缓存视觉 */
            setRefreshKey((k) => k + 1)
          }
          return h('div', Object.assign({}, clickable(activate, { label: t[1] }), {
            key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
            role: 'tab',
            'aria-selected': st.tab === t[0] ? 'true' : 'false',
            title: unreadOf(t[0]) ? t[1] + ': Unread updates' : t[1],
          }), t[1], unreadOf(t[0])
            /* 红点是纯视觉信息，给读屏软件一个文字替代 */
            ? h('span', { className: 'rt-tab-dot', 'aria-label': 'Unread updates' })
            : null)
        })),
        h('div', { className: 'rt-body', key: 'body-' + st.tab }, h(RtBoundary, { key: st.tab }, body)),
        h('div', { className: 'rt-foot' },
          h('span', null, 'CIDRs ' + (stats.segments || 0)),
          h('span', null, 'Assets ' + (stats.assets || 0) + ' (Live ' + (stats.liveAssets || 0) + ')'),
          h('span', null, 'Ports ' + (stats.openPorts || 0)),
          h('span', null, 'Fingerprints ' + (stats.fingerprints || 0)),
          h('span', null, 'Vulnerabilities ' + (stats.vulns || 0)),
          h('span', null, 'Passive/Active ' + (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0)),
          h('div', { className: 'rt-spacer' }),
          full ? h('span', null, 'Press Esc or click Exit Full View to return to docked layout') : null,
          h('span', null, 'SQLite · ' + (snapshot && snapshot.engagement ? snapshot.engagement.name : ''))))
    }

    /* ---------------------------------------------------------- 入口按钮 */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: 'Red Team Console (Sidebar Panel)',
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: 'Red Team Console (Sidebar Panel)',
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    /** 侧栏「全面浏览」：在新浏览器窗口打开完整控制台（当前窗口不受影响）。 */
    function FullButton(props) {
      const open = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch { /* 被浏览器拦截 */ }
      }
      return h('button', {
        className: 'rt-icon-btn',
        title: 'Full View: Open console in new window (Esc to exit)',
        onClick: open,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, 'Full View') : null)
    }

    /* ---------------------------------------------------------- 插件入口 */
    /** 唯一硬依赖：槽位注册表。 */
    const inject = ['slots']

    /**
     * 注入样式 + 三处槽位。样式标签与宽度变量随 fiber 卸载一起移除。
     * @param ctx - 客户端根上下文。
     */
    function applyDrillParts() {
      return { CSS: CSS, Panel: Panel, setUI: setUI, useUI: useUI, isFullWindow: isFullWindow, setDockWidth: setDockWidth };
    }

    exports.inject = inject
			return applyDrillParts();
		})();
/* __DSH_PURGE_DRILL_END__ */

		const AUTH_KEY = "dsh-purge-drill-auth";
		const WELCOME_KEY = "dsh-purge-user-notice-v1";
		let drillGrantGen = 0;
		let drillGrantPosting = 0;
		let drillGrantState = { ready: false, granted: false };
		let drillSyncRetryTimer = null;
		const AUTH_LEGAL_HTML = "<h3>严正法律免责与合规使用声明</h3>\r\n    <p>本声明在进入演练台前必须全文阅读。本项目是非营利开源项目，遵守国家法律法规及所在平台的规范，仅供学习与研究、技术参考。严禁任何主体把本项目用于商业售卖、付费倒卖或黑灰产牟利。</p>\r\n    <p>开发者坚决反对并严禁任何形式的违法犯罪，绝不支持、不鼓励、不协助未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统，或生成违法违禁内容。任何将本项目用于违法犯罪的行为，均与开发者无关，由行为人依法独立承担全部法律责任。不得以科研、教学、测试、演示或内部学习为由规避下列条款。</p>\r\n    <h3>1. 本仓库不含违法内容</h3>\r\n    <p>dsh-purge 发布的代码、文档、补丁与默认提示词不是木马、后门、未授权渗透工具、勒索软件、撞库脚本，也不是针对公网或第三方系统的攻击载荷。项目不提供违法内容，也不教唆、组织、协助实施违法犯罪。</p>\r\n    <h3>2. 本机操作不构成对外授权</h3>\r\n    <p>应用补丁、写入、回滚、卸载，都在本机文件和本机进程内完成。这些操作不对任何公网主机或未授权系统进行扫描、探测、入侵或攻击发包，也不得把本机当作跳板。</p>\r\n    <p>插件若开启检测更新，仅可能访问本插件自己的 GitHub 仓库以核对版本。该访问与对第三方系统的网络攻击无关，不能被解释为对外渗透的授权。</p>\r\n    <h3>3. 允许使用的范围</h3>\r\n    <p>只允许用在你能证明有权处理的环境：本人有权管理的本机官方 Harness；离线的本地合成靶标；所有者已经出具合法书面授权的网络安全演练靶场；合规实验室里的受控环境。书面授权要能对应具体目标、时间和范围。只填写一个单位名称，或只有口头说法，不构成授权。</p>\r\n    <p>未经所有者合法书面授权的目标、公网在线系统、生产业务，以及能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施，都不得作为演练对象。</p>\r\n    <h3>4. 必须遵守的法律，按条、款</h3>\r\n    <p>《中华人民共和国刑法》第二百八十五条第一款：禁止违反国家规定，侵入国家事务、国防建设、尖端科学技术领域的计算机信息系统。</p>\r\n    <p>同条第二款：禁止侵入前款规定以外的计算机信息系统，或者用其他技术手段，获取该系统中存储、处理或者传输的数据，或者对该系统实施非法控制。</p>\r\n    <p>同条第三款：禁止提供专门用于侵入、非法控制计算机信息系统的程序、工具；明知他人实施侵入、非法控制而为其提供程序、工具，同样禁止。</p>\r\n    <p>第二百八十六条第一款：禁止对计算机信息系统功能进行删除、修改、增加、干扰，造成系统不能正常运行。</p>\r\n    <p>同条第二款：禁止对系统中存储、处理或者传输的数据和应用程序进行删除、修改、增加。</p>\r\n    <p>同条第三款：禁止故意制作、传播计算机病毒等破坏性程序，影响计算机系统正常运行。</p>\r\n    <p>第二百八十七条：禁止利用计算机实施金融诈骗、盗窃、贪污、挪用公款、窃取国家秘密或者其他犯罪。</p>\r\n    <p>第二百八十七条之一第一款第（一）项：禁止设立用于实施诈骗、传授犯罪方法、制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组。</p>\r\n    <p>同款第（二）项：禁止发布有关制作或者销售毒品、枪支、淫秽物品等违禁物品、管制物品或者其他违法犯罪的信息。</p>\r\n    <p>同款第（三）项：禁止为实施诈骗等违法犯罪活动发布信息。</p>\r\n    <p>第二百八十七条之二：禁止明知他人利用信息网络实施犯罪，仍为其提供技术支持，或者提供广告推广、支付结算等帮助。</p>\r\n    <p>第二百五十三条之一第一款、第三款：禁止向他人出售或者提供公民个人信息；禁止窃取或者以其他方法非法获取公民个人信息。</p>\r\n    <p>《中华人民共和国网络安全法》第十三条第二款：使用网络不得危害网络安全，不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视，传播暴力、淫秽色情信息，编造、传播虚假信息扰乱经济秩序和社会秩序，以及侵害他人名誉、隐私、知识产权和其他合法权益等活动。</p>\r\n    <p>第十四条：禁止利用网络从事危害未成年人身心健康的活动。</p>\r\n    <p>第二十九条：禁止非法侵入他人网络、干扰他人网络正常功能、窃取网络数据；禁止提供专门用于侵入网络、干扰网络正常功能及防护措施、窃取网络数据的程序、工具；明知他人从事危害网络安全的活动，禁止为其提供技术支持、广告推广、支付结算等帮助。</p>\r\n    <p>第三十三条：公共通信和信息服务、能源、交通、水利、金融、公共服务、电子政务等关键信息基础设施实行重点保护。未获合法授权，不得侵入、干扰或破坏。</p>\r\n    <p>第四十六条：禁止窃取或者以其他非法方式获取个人信息，禁止非法出售或者非法向他人提供个人信息。</p>\r\n    <p>第四十八条：禁止设立用于实施诈骗，传授犯罪方法，制作或者销售违禁物品、管制物品等违法犯罪活动的网站、通讯群组；禁止利用网络发布涉及上述违法犯罪活动的信息。</p>\r\n    <p>第五十条：发送的电子信息、提供的应用软件不得设置恶意程序，不得含有法律、行政法规禁止发布或者传输的信息。</p>\r\n    <p>《中华人民共和国数据安全法》第八条：开展数据处理活动，不得危害国家安全、公共利益，不得损害个人、组织的合法权益。</p>\r\n    <p>第三十二条第一款：收集数据应当采取合法、正当的方式，不得窃取或者以其他非法方式获取数据。</p>\r\n    <p>同条第二款：法律、行政法规对收集、使用数据的目的和范围有规定的，只能在该目的和范围内收集、使用。</p>\r\n    <p>第五十一条：窃取或者以其他非法方式获取数据，或者因此损害个人、组织合法权益的，依照有关法律、行政法规处罚。</p>\r\n    <p>《中华人民共和国个人信息保护法》第五条：处理个人信息应当合法、正当、必要、诚信，不得通过误导、欺诈、胁迫等方式处理。</p>\r\n    <p>第六条第一款、第二款：处理个人信息应当具有明确、合理的目的，并与该目的直接相关，采取对个人权益影响最小的方式；收集限于实现处理目的的最小范围，不得过度收集。</p>\r\n    <p>第十条：禁止非法收集、使用、加工、传输他人个人信息，禁止非法买卖、提供或者公开他人个人信息；禁止从事危害国家安全、公共利益的个人信息处理活动。</p>\r\n    <p>第十三条：没有取得个人同意，也不属于订立履行合同所必需、履行法定职责、应对突发、公共利益新闻舆论、处理本人已经合法公开的信息，以及法律行政法规规定的其他情形之一的，不得处理个人信息。</p>\r\n    <p>第二十八条、第二十九条：生物识别、医疗健康、金融账户、行踪轨迹，以及不满十四周岁未成年人的个人信息，属于敏感个人信息。没有特定目的、充分必要性和严格保护措施，并且没有取得个人单独同意的，不得处理。</p>\r\n    <p>此外还须遵守其他现行有效的法律、行政法规、监管规定，以及所使用模型的服务条款与滥用政策。</p>\r\n    <h3>5. 据此禁止的方向</h3>\r\n    <p>未授权进入。禁止把没有书面授权的单位、域名、地址、公网系统、生产业务或关键信息基础设施登记为靶标，禁止对其扫描、探测、侵入、控制或发包。对应刑法第二百八十五条第一款、第二款，网络安全法第二十九条、第三十三条。</p>\r\n    <p>破坏与恶意程序。禁止删除、修改、增加、干扰他人系统功能或其中的数据、应用程序；禁止制作、传播病毒、勒索程序或其他破坏性程序；禁止在信息或软件中设置恶意程序。对应刑法第二百八十六条第一款至第三款，网络安全法第五十条。</p>\r\n    <p>工具与帮助。禁止把本项目或本机提供给他人，用于侵入、非法控制或窃取数据；禁止明知对方在实施网络犯罪，仍提供程序、工具、技术支持、广告推广或支付结算。对应刑法第二百八十五条第三款、第二百八十七条之二，网络安全法第二十九条。</p>\r\n    <p>数据。禁止窃取、非法收集、超范围使用、泄露、出售或向他人提供业务数据、账号、口令和其他受保护数据。对应数据安全法第八条、第三十二条、第五十一条。</p>\r\n    <p>个人信息。禁止非法收集、使用、加工、传输、买卖、提供或公开他人个人信息；禁止过度收集；禁止以误导、欺诈、胁迫方式处理；禁止擅自处理生物识别、医疗健康、金融账户、行踪轨迹和儿童个人信息。对应刑法第二百五十三条之一第一款、第三款，网络安全法第四十六条，个人信息保护法第五条、第六条、第十条、第十三条、第二十八条、第二十九条。</p>\r\n    <p>诈骗与违法信息。禁止设立或利用网站、群组实施诈骗、传授犯罪方法、制作或销售违禁物品、管制物品；禁止发布此类信息；禁止利用计算机实施诈骗、盗窃、贪污、挪用公款、窃取国家秘密。对应刑法第二百八十七条、第二百八十七条之一第一款第（一）项至第（三）项，网络安全法第四十八条。</p>\r\n    <p>内容。禁止生成或传播危害国家安全、荣誉和利益的内容，禁止煽动颠覆、分裂，禁止恐怖主义、极端主义、民族仇恨，禁止暴力、淫秽色情、赌博，禁止编造虚假信息扰乱经济秩序和社会秩序，禁止侵害名誉、隐私、知识产权，禁止危害未成年人身心健康的内容。对应网络安全法第十三条第二款、第十四条。</p>\r\n    <p>结果扩散。演练中形成的记录、资产信息和文件，只留在书面授权写明的目标和期限里，不得交给无权获知的人，也不得改作授权以外的用途。</p>\r\n    <h3>6. 责任由使用者承担</h3>\r\n    <p>本项目依据 MIT 协议按现状提供。开发者不就完整性、安全性与适用性作保证。使用者对自己的下载、部署、运行、修改、传播，以及全部输入与输出，承担独立、完全的民事、行政及刑事法律责任。作者与贡献者不承担因滥用产生的直接、间接或连带责任。</p>\r\n    <p>勾选确认的是操作者本人，不能代替没有阅读本声明的人，也不能把别人的系统说成已经授权。</p>\r\n    <h3>7. 违约即终止授权</h3>\r\n    <p>一旦用于非法攻击、恶意活动或上述任一禁止方向，使用许可自该行为发生之日起自动终止，且不可撤销。必须立即停止使用，并销毁本项目的代码、脚本与衍生数据，依法承担责任。授权终止后，演练台不得继续打开或继续使用。</p>\r\n    <h3>8. 与 DeepSeek 官方的关系</h3>\r\n    <p>本项目是独立的开源项目，与 DeepSeek 官方或其关联主体没有隶属、商业合作、授权或官方背书。文中的「官方」只表示评测对象是使用者本机安装的官方 DeepSeek Harness 软件包，不代表 DeepSeek 官方开发、认可或担保本插件。</p>\r\n    <p>文末。倒计时结束、滚到这里并勾选全部三项，才表示你以本人身份认可本声明，并完成本次演练台授权。</p>";

		function readWelcomeAck() {
			try { return window.localStorage.getItem(WELCOME_KEY) === "1"; } catch { return false; }
		}
		function writeWelcomeAck() {
			try { window.localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
		}

		function readDrillAuth() {
			if (drillGrantState.ready) return drillGrantState.granted;
			try { return window.localStorage.getItem(AUTH_KEY) === "1"; } catch { return false; }
		}
		function setDrillAuthLocal(ok) {
			try {
				if (ok) window.localStorage.setItem(AUTH_KEY, "1");
				else window.localStorage.removeItem(AUTH_KEY);
			} catch { /* ignore */ }
			drillGrantState = { ready: true, granted: !!ok };
		}
		function writeDrillAuth(ok) {
			drillGrantGen += 1;
			const gen = drillGrantGen;
			setDrillAuthLocal(ok);
			if (!ok) return;
			drillGrantPosting += 1;
			fetch("/dsh-purge/drill-grant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}).then((r) => r.json()).then((saved) => {
				if (gen !== drillGrantGen) return;
				setDrillAuthLocal(!!(saved && saved.granted));
			}).catch(() => { /* 页面先记住，下次同步再写入当前安装目录 */ })
				.finally(() => { drillGrantPosting = Math.max(0, drillGrantPosting - 1); });
		}
		function syncDrillGrant(attempt) {
			const n = attempt || 0;
			const gen = drillGrantGen;
			/* 复位上一次调度的重试 timer,避免多次 writeDrillAuth 叠加链条 */
			if (drillSyncRetryTimer) { try { clearTimeout(drillSyncRetryTimer); } catch { /* ignore */ } drillSyncRetryTimer = null; }
			fetch("/dsh-purge/drill-grant", { method: "GET" })
				.then((r) => r.json())
				.then((r) => {
					if (gen !== drillGrantGen) return;
					if (!r || r.ok === false) throw new Error("grant");
					if (r.granted) {
						setDrillAuthLocal(true);
						if (dockBus.authOpen) setDock({ authOpen: false });
						return;
					}
					if (drillGrantPosting > 0) return;
					setDrillAuthLocal(false);
					if (dockBus.authOpen || dockBus.tab === "drill") {
						setDock({ open: true, tab: "drill", authOpen: true, pending: dockBus.pending || "tab" });
					}
				})
				.catch(() => {
					if (gen !== drillGrantGen) return;
					if (n < 5) {
						drillSyncRetryTimer = window.setTimeout(() => {
							drillSyncRetryTimer = null;
							syncDrillGrant(n + 1);
						}, 400);
					}
				});
		}

		let dockBus = { open: false, tab: "clean", authOpen: false, pending: "tab", listeners: new Set() };
		function getDock() { return dockBus; }
		function setDock(patch) {
			dockBus = Object.assign({}, dockBus, patch);
			dockBus.listeners.forEach((fn) => { try { fn(dockBus); } catch { /* ignore */ } });
		}
		function useDock() {
			const [st, setSt] = useState(dockBus);
			useEffect(() => {
				const fn = (next) => setSt(next);
				dockBus.listeners.add(fn);
				return () => { dockBus.listeners.delete(fn); };
			}, []);
			return st;
		}

		function requestDrill(kind) {
			const pending = kind || "tab";
			const openEnv = () => {
				try {
					if (__dshPurgeDrill && __dshPurgeDrill.setUI) {
						__dshPurgeDrill.setUI({ open: true, tab: "env" });
					}
				} catch { /* ignore */ }
			};
			if (readDrillAuth()) {
				setDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
				try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
				if (pending === "env") openEnv();
				if (pending === "full") {
					try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
				}
				return;
			}
			/* 未授权：直接切到演练台页签并弹出授权窗（不再停在清洗页，避免像「没触发」） */
			setDock({ open: true, tab: "drill", authOpen: true, pending: pending });
		}

		function requestDrillEnv() {
			requestDrill("env");
		}

		function openDockClean() {
			setDock({ open: true, tab: "clean", authOpen: false, pending: "tab" });
		}
		function toggleDock() {
			if (dockBus.open) setDock({ open: false, authOpen: false, pending: "tab" });
			else openDockClean();
		}
		syncDrillGrant();

		const DOCK_GEOM_KEY = "dsh-purge-dock-geom-v4";
		/* 默认停在右上，底边留在输入框上面。拖动之后停在用户松开的位置，只保证不拖出窗口。 */
		const DOCK_COMPOSER_CLEAR = 172;
		function defaultDockGeom() {
			const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			const w = Math.min(620, Math.max(380, vw - 16));
			const y = 48;
			const h = Math.max(240, Math.min(640, vh - y - DOCK_COMPOSER_CLEAR));
			return { x: Math.max(8, vw - w - 8), y: y, w: w, h: h };
		}
		function clampDockGeom(g) {
			const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
			const vh = typeof window !== "undefined" ? window.innerHeight : 800;
			const w = Math.min(Math.max(380, Number(g && g.w) || 620), Math.max(380, vw - 16));
			const h = Math.min(Math.max(240, Number(g && g.h) || 520), Math.max(240, vh - 16));
			const x = Math.min(Math.max(8, Number(g && g.x) || 8), Math.max(8, vw - w - 8));
			const y = Math.min(Math.max(8, Number(g && g.y) || 8), Math.max(8, vh - Math.min(h, vh - 16) - 8));
			return { x: x, y: y, w: w, h: h };
		}
		function loadDockGeom() {
			try {
				const raw = JSON.parse(window.localStorage.getItem(DOCK_GEOM_KEY) || "null");
				if (raw && typeof raw === "object") return clampDockGeom(raw);
			} catch { /* ignore */ }
			return clampDockGeom(defaultDockGeom());
		}
		function saveDockGeom(g) {
			try { window.localStorage.setItem(DOCK_GEOM_KEY, JSON.stringify(clampDockGeom(g))); } catch { /* ignore */ }
		}

		function WelcomeNotice() {
			const t = useT();
			const [open, setOpen] = useState(() => !readWelcomeAck());
			const [checked, setChecked] = useState(false);
			if (!open) return null;
			const repo = t("welcome.repo");
			const node = h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(560px,100%)" } },
					h("h2", null, t("welcome.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("welcome.lead")),
					h("div", { className: "dshp-auth-warn" }, t("welcome.warn")),
					h("div", { className: "dshp-auth-legal", style: { height: "auto", maxHeight: 280 } },
						h("p", null, t("welcome.body")),
						h("p", null,
							h("a", {
								href: repo,
								target: "_blank",
								rel: "noopener noreferrer",
								style: { color: "var(--dsw-alias-label-brand, #8fbf9a)", wordBreak: "break-all" },
							}, repo),
						),
						h("h3", null, t("welcome.bans")),
						h("p", null, t("welcome.ban1")),
						h("p", null, t("welcome.ban2")),
						h("p", null, t("welcome.ban3")),
					),
					h("div", { className: "dshp-auth-checks" },
						h("label", null,
							h("input", {
								type: "checkbox",
								checked: checked,
								onChange: (e) => setChecked(!!(e && e.target && e.target.checked)),
							}),
							h("span", null, t("welcome.check")),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", {
							type: "button",
							className: "primary",
							disabled: !checked,
							onClick: () => {
								if (!checked) return;
								writeWelcomeAck();
								setOpen(false);
							},
						}, t("welcome.ok")),
					),
				),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					return rd.createPortal(node, document.body);
				}
			} catch { /* ignore */ }
			return node;
		}

		function AuthGate(props) {
			const t = useT();
			const [left, setLeft] = useState(10);
			const [readEnd, setReadEnd] = useState(false);
			const [checks, setChecks] = useState({ read: false, scope: false, ban: false });
			const legalRef = useRef(null);
			useEffect(() => {
				const id = window.setInterval(() => {
					setLeft((n) => {
						if (n <= 1) { window.clearInterval(id); return 0; }
						return n - 1;
					});
				}, 1000);
				return () => window.clearInterval(id);
			}, []);
			useEffect(() => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollHeight <= el.clientHeight + 4) setReadEnd(true);
			}, []);
			const locked = left > 0 || !readEnd;
			const ready = !locked && checks.read && checks.scope && checks.ban;
			const hint = left > 0
				? t("auth.hint.wait").replace("{n}", String(left))
				: (readEnd ? t("auth.hint.check") : t("auth.hint.scroll"));
			const onScroll = () => {
				const el = legalRef.current;
				if (!el) return;
				if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setReadEnd(true);
			};
			const toggle = (id) => {
				if (locked) return;
				setChecks((prev) => Object.assign({}, prev, { [id]: !prev[id] }));
			};
			const okLabel = !ready
				? t("auth.ok")
				: (props.pending === "full"
					? t("auth.ok.full")
					: (props.pending === "env" ? t("auth.ok.env") : t("auth.ok.tab")));
			return h("div", { className: "dshp-auth-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal" },
					h("h2", null, t("auth.title")),
					h("div", { className: "muted", style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, t("auth.lead")),
					h("div", { className: "dshp-auth-warn" }, t("auth.warn")),
					h("div", {
						className: "dshp-auth-legal",
						ref: legalRef,
						onScroll,
						dangerouslySetInnerHTML: { __html: AUTH_LEGAL_HTML },
					}),
					h("div", { style: { color: "var(--dsw-alias-label-secondary,#999)", fontSize: 12 } }, hint),
					h("div", { className: "dshp-auth-checks" },
						[["read", "auth.check.read"], ["scope", "auth.check.scope"], ["ban", "auth.check.ban"]].map((row) =>
							h("label", { key: row[0], className: locked ? "locked" : "" },
								h("input", {
									type: "checkbox",
									checked: !!checks[row[0]],
									disabled: locked,
									onChange: () => toggle(row[0]),
								}),
								h("span", null, t(row[1])),
							),
						),
					),
					h("div", { className: "dshp-auth-ops" },
						h("button", { type: "button", onClick: () => setDock({ authOpen: false, tab: "clean", pending: "tab" }) }, t("auth.no")),
						h("button", {
							type: "button",
							className: "primary",
							disabled: !ready,
							onClick: () => {
								if (!ready) return;
								writeDrillAuth(true);
								const kind = props.pending || "tab";
								setDock({ authOpen: false, open: true, tab: "drill", pending: "tab" });
								try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
								if (kind === "env") {
									try { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true, tab: "env" }); } catch { /* ignore */ }
								}
								if (kind === "full") {
									try { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
								}
							},
						}, okLabel),
					),
				),
			);
		}

		function isRedteamPresetId(value) {
			const text = String(value || "").trim();
			if (!text) return false;
			if (text === "redteam") return true;
			if (/^red[\s_-]*team$/i.test(text)) return true;
			const label = text.replace(/不是红队/g, "").replace(/非红队/g, "");
			if (/红队/.test(label)) return true;
			return false;
		}

		function readSessionAgentPreset(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.agentPreset === "string") return pv.agentPreset;
			} catch { /* ignore */ }
			try {
				if (typeof sess.agentPreset === "string") return sess.agentPreset;
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.agentPreset === "string") return header.agentPreset;
			} catch { /* ignore */ }
			return "";
		}

		function readSessionCwd(sess) {
			if (!sess || typeof sess !== "object") return "";
			try {
				const pv = sess.projectionValues;
				if (pv && typeof pv.cwd === "string" && pv.cwd.trim()) return pv.cwd.trim();
			} catch { /* ignore */ }
			try {
				if (typeof sess.cwd === "string" && sess.cwd.trim()) return sess.cwd.trim();
			} catch { /* ignore */ }
			try {
				const header = sess.header;
				if (header && typeof header.cwd === "string" && header.cwd.trim()) return header.cwd.trim();
			} catch { /* ignore */ }
			return "";
		}

		function clientCurrentCwd() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				if (!sessions) return "";
				const sid = currentSessionId(sessions);
				if (!sid) return "";
				try {
					const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
					const sess = snap && snap.byId ? snap.byId[sid] : null;
					const found = readSessionCwd(sess);
					if (found) return found;
				} catch { /* ignore */ }
				try {
					const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
					const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
					const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
					const found = readSessionCwd(faceSnap);
					if (found) return found;
				} catch { /* ignore */ }
			} catch { /* ignore */ }
			return "";
		}

		function isRedteamModeActive() {
			try {
				const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
				const sid = currentSessionId(sessions);
				if (sid && sessions) {
					try {
						const snap = typeof sessions.list?.getSnapshot === "function" ? sessions.list.getSnapshot() : null;
						const sess = snap && snap.byId ? snap.byId[sid] : null;
						if (isRedteamPresetId(readSessionAgentPreset(sess))) return true;
					} catch { /* ignore */ }
					try {
						const actx = typeof sessions.scope === "function" ? sessions.scope(sid) : undefined;
						const face = typeof sessions.sessionOf === "function" ? sessions.sessionOf(actx) : undefined;
						const faceSnap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : face;
						if (isRedteamPresetId(readSessionAgentPreset(faceSnap))) return true;
					} catch { /* ignore */ }
				}
			} catch { /* ignore */ }
			/* 新会话：模式下拉里的「红队模式」chip（选好但还没写入 session）
			 * 优先走语义化 data-* 挂点,其次 class 子串模糊匹配 + 文本兜底;
			 * 不写死 CSS Module 哈希(HKgFRW_seat 这种每次构建都会变)。 */
			try {
				const semantic = document.querySelector(
					"[data-agent-preset='redteam'], [data-preset-id='redteam'], [data-mode='redteam']"
				);
				if (semantic) return true;
				const nodes = document.querySelectorAll(
					"[class*='seat' i][class*='label' i], [class*='seatLabel' i], button[class*='seat' i], [role='button'][class*='seat' i]"
				);
				for (const el of nodes) {
					const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
					if (/红队模式/.test(text) || /^RedTeam\b/i.test(text)) return true;
				}
			} catch { /* ignore */ }
			try {
				const labels = document.querySelectorAll(
					"[class*='label' i][class*='preset' i], [class*='presetLabel' i], [title*='红队'], [title*='RedTeam']"
				);
				for (const el of labels) {
					const text = String(el.textContent || "").trim();
					if (/红队模式/.test(text) || /^RedTeam\b/i.test(text)) return true;
					if (isRedteamPresetId(text)) return true;
				}
			} catch { /* ignore */ }
			return false;
		}

		function looksLikeSendControl(el) {
			if (!el || el.nodeType !== 1) return false;
			const btn = el.closest("button, [role='button']");
			if (!btn) return false;
			if (btn.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return false;
			const label = [
				btn.getAttribute("aria-label"),
				btn.getAttribute("title"),
				btn.getAttribute("data-testid"),
				btn.textContent,
			].filter(Boolean).join(" ");
			if (/停止|Stop/i.test(label) && !/发送|Send/i.test(label)) return false;
			if (/发送|Submit|Send(?!\s*feedback)/i.test(label)) return true;
			/* composer 主按钮：data-composer-card 内的 primary */
			try {
				const card = btn.closest("[data-composer-card], [data-composer-seat]");
				if (card) {
					const cls = String(btn.className || "");
					if (/primary/i.test(cls) && btn.querySelector("svg")) return true;
				}
			} catch { /* ignore */ }
			if (btn.type === "submit") {
				const form = btn.closest("form");
				if (form && form.querySelector("textarea, [contenteditable='true']")) return true;
			}
			return false;
		}

		function fetchEnvAdaptStatus() {
			return fetch("/redteam/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "platformEnvAdaptStatus" }),
			}).then((r) => r.json()).catch(() => null);
		}

		/** 同步探测的占位：不再做同步 XHR（会卡 UI 主线程、Chrome 已逐步弃用）。
		 * 调用方 mustBlockSubmit 在 cache 过期/缺失时按"未知→保守 block"处理,
		 * 同时 EnvAdaptSendGate 的 useEffect 轮询会异步 refresh,下次调用即可放行。 */
		function fetchEnvAdaptStatusSync() { return null; }

		/** 红队发送前门禁：未就绪 → 授权并打开环境适配；可确认跳过。 */
		function EnvAdaptSendGate() {
			const t = useT();
			const [open, setOpen] = useState(false);
			const [confirmSkip, setConfirmSkip] = useState(false);
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);
			const cacheRef = useRef({ at: 0, ready: false });
			const openRef = useRef(false);
			openRef.current = open;

			const refresh = useCallback(async () => {
				const r = await fetchEnvAdaptStatus();
				const ready = !!(r && r.ready);
				cacheRef.current = { at: Date.now(), ready: ready, skipped: !!(r && r.skipped) };
				setStatus(r);
				return r;
			}, []);

			const blockAndOpen = useCallback(() => {
				setConfirmSkip(false);
				refresh();
				/* 第一次：只走完整授权窗 → 授权后进环境适配页 */
				if (!readDrillAuth()) {
					setOpen(false);
					requestDrillEnv();
					return true;
				}
				/* 已授权过：只弹精简环境适配窗，不再自动拉开整块演练台 */
				setOpen(true);
				return true;
			}, [refresh]);

			const mustBlockSubmit = useCallback(() => {
				if (!isRedteamModeActive()) return false;
				const cached = cacheRef.current;
				/* cache 过期时触发异步刷新;本次调用按最后一次 cache 判断,未知保守 block */
				if (!cached.at || Date.now() - cached.at > 2500) {
					refresh().catch(() => {});
				}
				if (cached.ready) return false;
				blockAndOpen();
				return true;
			}, [blockAndOpen, refresh]);

			/* 挂住宿主 SessionInputShell.submit —— 比点按钮启发式可靠。
			 * patch 必须可逆:存 origSubmit 到 WeakMap,unmount / 依赖变更时恢复,
			 * 否则插件禁用后 shell.submit 还是我们的 wrapper,持死 mustBlockSubmit 闭包。 */
			useEffect(() => {
				const patched = new WeakMap();
				const patchedShells = [];
				const patchShell = (shell) => {
					if (!shell || patched.has(shell)) return;
					if (typeof shell.submit !== "function") return;
					const origSubmit = shell.submit;
					const origActionsSubmit = (shell.actions && typeof shell.actions.submit === "function")
						? shell.actions.submit
						: null;
					patched.set(shell, { origSubmit, origActionsSubmit });
					patchedShells.push(shell);
					const bound = origSubmit.bind(shell);
					shell.submit = function gatedSubmit(mode) {
						try {
							if (mustBlockSubmit()) return;
						} catch { /* 门禁异常时不吞掉发送 */ }
						return bound(mode);
					};
					if (shell.actions && typeof shell.actions === "object") {
						shell.actions.submit = () => shell.submit("queue");
					}
				};
				const tick = () => {
					try {
						const sessions = rewindSessions || (rewindHost && rewindHost.sessions);
						const sid = currentSessionId(sessions);
						if (!sid) return;
						patchShell(conversationInput(sid));
					} catch { /* ignore */ }
				};
				tick();
				const iv = window.setInterval(tick, 400);
				return () => {
					window.clearInterval(iv);
					for (const shell of patchedShells) {
						const info = patched.get(shell);
						if (!info) continue;
						try { shell.submit = info.origSubmit; } catch { /* ignore */ }
						if (info.origActionsSubmit && shell.actions) {
							try { shell.actions.submit = info.origActionsSubmit; } catch { /* ignore */ }
						}
					}
					patchedShells.length = 0;
				};
			}, [mustBlockSubmit]);

			useEffect(() => {
				let alive = true;
				const tick = () => {
					if (!alive) return;
					if (!isRedteamModeActive()) return;
					refresh();
				};
				tick();
				const iv = window.setInterval(tick, 5000);
				return () => { alive = false; window.clearInterval(iv); };
			}, [refresh]);

			useEffect(() => {
				const onPointer = (e) => {
					if (!looksLikeSendControl(e.target)) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				const onKey = (e) => {
					if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
					const inComposer = e.target && e.target.closest
						&& e.target.closest("[data-composer-card], [data-composer-seat], [contenteditable='true'], textarea");
					if (!inComposer) return;
					if (e.target.closest && e.target.closest(".dshp-dock, .dshp-auth-mask, .rt-dock, .dshp-env-gate")) return;
					if (!mustBlockSubmit()) return;
					e.preventDefault();
					e.stopPropagation();
					if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("click", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("click", onPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [mustBlockSubmit]);

			if (!open) return null;

			const message = (status && status.message) || t("envGate.lead");
			return h("div", { className: "dshp-auth-mask dshp-env-gate", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dshp-auth-modal", style: { width: "min(480px,100%)" } },
					h("h2", null, t("envGate.title")),
					h("div", { style: { fontSize: 13, lineHeight: 1.55 } }, message),
					h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary,#999)", lineHeight: 1.5 } }, t("envGate.kaliHint")),
					confirmSkip
						? h("div", { className: "dshp-auth-warn" }, t("envGate.skipConfirm"))
						: null,
					h("div", { className: "dshp-auth-ops" },
						confirmSkip
							? [
								h("button", {
									key: "no",
									type: "button",
									onClick: () => setConfirmSkip(false),
								}, t("envGate.skipNo")),
								h("button", {
									key: "yes",
									type: "button",
									className: "primary",
									disabled: busy,
									onClick: () => {
										setBusy(true);
										fetch("/redteam/api", {
											method: "POST",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({ op: "platformEnvAdaptSkip", skip: true }),
										}).then((r) => r.json()).then((r) => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setStatus(r);
											setOpen(false);
											setConfirmSkip(false);
										}).catch(() => {
											setBusy(false);
											cacheRef.current = { at: Date.now(), ready: true, skipped: true };
											setOpen(false);
										});
									},
								}, t("envGate.skipYes")),
							]
							: [
								h("button", {
									key: "skip",
									type: "button",
									onClick: () => setConfirmSkip(true),
								}, t("envGate.skip")),
								h("button", {
									key: "go",
									type: "button",
									className: "primary",
									onClick: () => {
										setOpen(false);
										requestDrillEnv();
									},
								}, t("envGate.go")),
							],
					),
				),
			);
		}

		function PurgeDock() {
			const t = useT();
			const st = useDock();
			const [geom, setGeom] = useState(() => loadDockGeom());
			const [dockTheme, setDockTheme] = useState(detectHostTheme);
			useEffect(() => {
				const sync = () => setDockTheme(detectHostTheme());
				sync();
				const obs = new MutationObserver(sync);
				if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
				const timer = window.setInterval(sync, 1500);
				return () => { obs.disconnect(); window.clearInterval(timer); };
			}, []);
			useEffect(() => {
				let uiTag = document.querySelector('style[data-dsh-purge-ui="1"]');
				if (!uiTag) {
					uiTag = document.createElement("style");
					uiTag.setAttribute("data-dsh-purge-ui", "1");
					uiTag.textContent = PURGE_CSS;
					document.head.append(uiTag);
				}
				if (!__dshPurgeDrill || !__dshPurgeDrill.CSS) return undefined;
				const styleTag = document.createElement("style");
				styleTag.setAttribute("data-dsh-purge-drill", "1");
				styleTag.textContent = __dshPurgeDrill.CSS;
				document.head.append(styleTag);
				const widthTag = document.createElement("style");
				widthTag.setAttribute("data-dsh-purge-dock-w", "1");
				widthTag.textContent = ":root{--dshp-dock-w:" + geom.w + "px;--dshp-dock-h:" + geom.h + "px}";
				document.head.append(widthTag);
				return () => { styleTag.remove(); widthTag.remove(); };
			}, []);
			useEffect(() => {
				saveDockGeom(geom);
				const tag = document.querySelector('style[data-dsh-purge-dock-w="1"]');
				if (tag) tag.textContent = ":root{--dshp-dock-w:" + geom.w + "px;--dshp-dock-h:" + geom.h + "px}";
			}, [geom]);
			useEffect(() => {
				const onResize = () => setGeom((g) => clampDockGeom(g));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);
			useEffect(() => {
				if (st.tab === "drill" && readDrillAuth() && __dshPurgeDrill && __dshPurgeDrill.setUI) {
					try { __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
				}
			}, [st.tab, st.open]);
			const onTab = (id) => {
				if (id === "drill") { requestDrill("tab"); return; }
				setDock({ tab: "clean", authOpen: false, pending: "tab" });
			};
			const startDrag = (e) => {
				if (e.button !== 0) return;
				if (e.target && e.target.closest && e.target.closest("button,a,input,select,textarea,label")) return;
				e.preventDefault();
				const sx = e.clientX;
				const sy = e.clientY;
				const ox = geom.x;
				const oy = geom.y;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy), w: g.w, h: g.h }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResize = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const sy = e.clientY;
				const ow = geom.w;
				const oh = geom.h;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: oh + (ev.clientY - sy) }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeLeft = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const ox = geom.x;
				const ow = geom.w;
				const move = (ev) => {
					const dx = ev.clientX - sx;
					setGeom((g) => clampDockGeom({ x: ox + dx, y: g.y, w: ow - dx, h: g.h }));
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeRight = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sx = e.clientX;
				const ow = geom.w;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: ow + (ev.clientX - sx), h: g.h }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const startResizeBottom = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				const sy = e.clientY;
				const oh = geom.h;
				const move = (ev) => setGeom((g) => clampDockGeom({ x: g.x, y: g.y, w: g.w, h: oh + (ev.clientY - sy) }));
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			};
			const body = st.tab === "clean"
				? h(SettingsRoot, { t })
				: (readDrillAuth() && __dshPurgeDrill.Panel
					? h(__dshPurgeDrill.Panel, { embedded: true })
					: h("div", { style: { padding: 16, color: "var(--dsw-alias-label-secondary)" } }, t("dock.unauthorized")));
			const panel = h("div", {
				className: "dshp-dock",
				"data-theme": dockTheme === "white" ? "white" : "dusk",
				"data-open": st.open ? "1" : "0",
				style: {
					left: geom.x + "px",
					top: geom.y + "px",
					right: "auto",
					bottom: "auto",
					width: geom.w + "px",
					height: geom.h + "px",
				},
			},
				h("div", { className: "dshp-dock-head", onMouseDown: startDrag, title: "按住拖动面板" },
					h("b", null, "dsh-purge"),
					h("span", { style: { flex: 1 } }),
					st.tab === "drill" && readDrillAuth()
						? h("button", { type: "button", onClick: () => requestDrill("full") }, t("dock.full"))
						: null,
					h("button", { type: "button", onClick: () => setDock({ open: false, authOpen: false, tab: "clean", pending: "tab" }) }, t("dock.close")),
				),
				h("div", { className: "dshp-dock-tabs", role: "tablist" },
					h("button", {
						type: "button",
						className: "dshp-dock-tab" + (st.tab === "clean" ? " on" : ""),
						role: "tab",
						"aria-selected": st.tab === "clean" ? "true" : "false",
						onClick: () => onTab("clean"),
					}, t("dock.clean")),
					h("button", {
						type: "button",
						className: "dshp-dock-tab" + (st.tab === "drill" ? " on" : ""),
						role: "tab",
						"aria-selected": st.tab === "drill" ? "true" : "false",
						onClick: () => onTab("drill"),
					}, t("dock.drill") + (readDrillAuth() ? "" : " · " + t("dock.unauthorized"))),
				),
				h("div", { className: "dshp-dock-body" }, body),
				h("div", { className: "dshp-dock-resize-l", title: "拖动调整宽度", onMouseDown: startResizeLeft }),
				h("div", { className: "dshp-dock-resize-r", title: "拖动调整宽度", onMouseDown: startResizeRight }),
				h("div", { className: "dshp-dock-resize-b", title: "拖动调整高度", onMouseDown: startResizeBottom }),
				h("div", { className: "dshp-dock-resize", title: "拖动调整大小", onMouseDown: startResize }),
			);
			let portal = null;
			let authPortal = null;
			const authNode = st.authOpen ? h(AuthGate, { pending: st.pending }) : null;
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
					portal = rd.createPortal(panel, document.body);
					if (authNode) authPortal = rd.createPortal(authNode, document.body);
				}
			} catch { /* host 可能没暴露 react-dom */ }
			return h(react.Fragment, null,
				portal || panel,
				authPortal || authNode,
			);
		}

		function PurgeLauncher() {
			const t = useT();
			const st = useDock();
			return h("button", {
				type: "button",
				className: "dshp-launch",
				"data-open": st.open ? "1" : "0",
				"data-testid": "dsh-purge-launch",
				title: t("dock.newSession"),
				onClick: () => toggleDock(),
			}, t("dock.newSession"));
		}

		/** 首页：模式旁挂「dsh-purge」→ 打开插件。红队模式走模式下拉（registry 声明）。 */
		function HeroNewSessionMount() {
			const t = useT();
			const st = useDock();
			const [host, setHost] = useState(null);
			useEffect(() => {
				let dead = false;
				let warnedMiss = false;
				const ensure = () => {
					if (dead || typeof document === "undefined") return;
					/* 多路挂点兜底:语义化 data-* 优先,class 子串模糊匹配兜底(不绑定具体 CSS Module 哈希) */
					const row =
						document.querySelector('[data-dsh-hero-workspace-row]') ||
						document.querySelector('[data-conversation-hero]') ||
						document.querySelector('[class*="heroWorkspaceRow" i]') ||
						document.querySelector('[class*="hero" i][class*="workspace" i][class*="row" i]');
					if (!row) {
						if (!warnedMiss) {
							warnedMiss = true;
							try { console.warn("[dsh-purge] HeroNewSessionMount: anchor row missing (host 可能改版)"); } catch { /* ignore */ }
						}
						setHost((prev) => (prev ? null : prev));
						return;
					}
					warnedMiss = false;
					let el = row.querySelector(":scope > .dshp-hero-chip");
					if (!el) {
						el = document.createElement("div");
						el.className = "dshp-hero-chip";
						el.setAttribute("data-testid", "dsh-purge-hero-chip");
						row.appendChild(el);
					}
					setHost((prev) => (prev === el ? prev : el));
				};
				ensure();
				const obs = typeof MutationObserver !== "undefined"
					? new MutationObserver(() => ensure())
					: null;
				if (obs) obs.observe(document.body, { childList: true, subtree: true });
				const iv = setInterval(ensure, 1000);
				return () => {
					dead = true;
					if (obs) obs.disconnect();
					clearInterval(iv);
				};
			}, []);
			if (!host) return null;
			const btn = h("button", {
				type: "button",
				className: "dshp-hero-chip-btn" + (st.open ? " on" : ""),
				title: t("dock.newSession"),
				onClick: () => toggleDock(),
			},
				st.open ? h("span", { className: "dshp-live-dot", "aria-hidden": "true" }) : null,
				t("dock.newSession"),
			);
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function") return rd.createPortal(btn, host);
			} catch { /* host 可能没暴露 react-dom */ }
			return null;
		}

		/** 挂在「对话 / 轨迹 / 上下文」这一排，紧挨上下文。 */
		function TabRowPurgeMount() {
			const t = useT();
			const st = useDock();
			const [host, setHost] = useState(null);
			useEffect(() => {
				let dead = false;
				let warnedMiss = false;
				const ensure = () => {
					if (dead || typeof document === "undefined") return;
					/* 多路挂点兜底:data-* 优先,ARIA / class 子串兜底 */
					const row =
						document.querySelector("[data-conversation-tabs]") ||
						document.querySelector("[data-conversation-tabrow]") ||
						document.querySelector("[role='tablist'][aria-label*='对话' i]") ||
						document.querySelector("[class*='conversation' i][class*='tab' i][class*='row' i]");
					if (!row) {
						if (!warnedMiss) {
							warnedMiss = true;
							try { console.warn("[dsh-purge] TabRowPurgeMount: tab row anchor missing"); } catch { /* ignore */ }
						}
						setHost((prev) => (prev ? null : prev));
						return;
					}
					warnedMiss = false;
					let el = row.querySelector(":scope > .dshp-tab-chip");
					if (!el) {
						el = document.createElement("div");
						el.className = "dshp-tab-chip";
						el.setAttribute("data-testid", "dsh-purge-tab-chip");
						row.appendChild(el);
					}
					setHost((prev) => (prev === el ? prev : el));
				};
				ensure();
				const obs = typeof MutationObserver !== "undefined"
					? new MutationObserver(() => ensure())
					: null;
				if (obs) obs.observe(document.body, { childList: true, subtree: true });
				const iv = setInterval(ensure, 1000);
				return () => {
					dead = true;
					if (obs) obs.disconnect();
					clearInterval(iv);
				};
			}, []);
			if (!host) return null;
			const btn = h("button", {
				type: "button",
				className: "dshp-tab-btn" + (st.open ? " on" : ""),
				title: st.open ? (t("dock.inSession") + " · 已开启") : (t("dock.inSession") + " · 点击打开"),
				onClick: () => toggleDock(),
			}, t("dock.inSession"));
			try {
				const rd = require("react-dom");
				if (rd && typeof rd.createPortal === "function") return rd.createPortal(btn, host);
			} catch { /* host 可能没暴露 react-dom */ }
			return null;
		}


		function installRewindUi(ctx) {
			rewindHost = ctx;
			rewindSessions = ctx.sessions;
			rewindWorkspace = ctx.uiWorkspace || null;
			rewindConversation = ctx.conversation || null;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-purge-rewind",
				order: 20,
				inject: (sessionId) => ({
					sessionId,
					t: ctx.locale.bind(NS),
				}),
			}, RewindSafe));
			// ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
			// 	name: "conversation.input.right",
			// 	id: "dsh-purge-continue",
			// 	order: 21,
			// 	inject: (sessionId) => ({
			// 		sessionId,
			// 		t: ctx.locale.bind(NS),
			// 	}),
			// }, ContinueSafe));
			ctx.effect(() => installRewindWatch(ctx), "dsh-purge: rewind watch");
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-purge: dictionaries");
			const t = ctx.locale.bind(NS);
			translate = t;
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-purge-dock",
				order: 50,
			}, () => h(react.Fragment, null, h(WelcomeNotice), h(PurgeLauncher), h(PurgeDock), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["sessions", "uiWorkspace", "workspaces", "conversation"], (host) => installRewindUi(host));
				} else if (ctx.sessions) {
					installRewindUi(ctx);
				}
			} catch (e) {
				try {
					if (typeof ctx.inject === "function") {
						ctx.inject(["sessions", "uiWorkspace", "conversation"], (host) => installRewindUi(host));
					}
				} catch (e2) {
					try { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
				}
			}
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
