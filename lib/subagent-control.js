/**
 * 子代理审批接管（上游 1.1.84 引入，本 fork 1.1.82 起接线）。
 *
 * 宿主给子会话写死 approval/policy = "never"：
 *   dsh-subagent captureDelegatedPolicyOverrides → approvalPolicy: "never"
 *   dsh-user-approval decide() → `if (effectivePolicy === "never") return "rejected";`
 * 这一步发生在 approval/request 的 waterfall 之前，所以任何监听器都救不到。
 *
 * 顺序只能是：先把 policy 翻成 ask，waterfall 才会跑；再在 waterfall 里放行。
 * 只作用于子会话，主会话零影响。config.subagentControl === false 可整体关掉。
 *
 * 不 import 仓库内的识别函数 —— 上游与本树的函数名不同，这里自带判断（见 anchor.js）。
 */
import { isSubagentContext } from "./anchor.js";

/** 同一会话最多补几次 ask，防止异常会话里反复触发。 */
const MAX_FLIPS = 4;

export function installSubagentControl(ctx, config = {}) {
  if (config.subagentControl === false) return () => {};
  if (typeof ctx?.on !== "function") return () => {};

  const offs = [];
  const flips = new WeakMap();
  const isChild = (session) => isSubagentContext({ session });

  // P1：看到宿主写进来的 never，就补一条 ask。overrideOf 倒序取最后一条，后写者胜。
  try {
    offs.push(ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "approval/policy") return;
        if (event?.data?.policy !== "never") return;
        if (!isChild(session)) return;
        const n = flips.get(session) || 0;
        if (n >= MAX_FLIPS) return;
        // 同一 tick 多条 never 事件会读到同一个 n：先同步占位，append 失败再退回。
        flips.set(session, n + 1);
        // 不能在 append 的处理链里再 append。名额只在真正写成功时消耗：
        // 会话已关 / append 失败时退还，否则 4 次空转之后这个会话就永远不再补 ask。
        queueMicrotask(() => {
          try {
            session.append("approval/policy", { policy: "ask" });
          } catch {
            flips.set(session, n); /* 会话已关，退还名额 */
          }
        });
      } catch { /* 观察者不能抛 */ }
    }, { global: true }));
  } catch { /* 老宿主无 session/event */ }

  // P2：policy 变 ask 之后 waterfall 才会跑，这里对子会话放行一次。
  // 必须 global —— 宿主是 ctx.waterfall(scopeTarget(req.agent, req.agent), ...)，agent 作用域。
  try {
    offs.push(ctx.on("approval/request", (request, next) => {
      try {
        if (isChild(request?.agent?.session)) return "allowed-once";
      } catch { /* 落到 next */ }
      return typeof next === "function" ? next() : "unavailable";
    }, { global: true, prepend: true }));
  } catch { /* 老宿主无 approval/request */ }

  return () => {
    for (const off of offs) {
      try { off(); } catch { /* 已释放 */ }
    }
  };
}
