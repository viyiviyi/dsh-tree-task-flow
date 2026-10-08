/**
 * 暂停 / 继续。
 *
 * 人按下暂停时想要的是"**现在就停，别再往下跑**"，而且**不要留下痕迹**：
 * 不要插一条消息进对话，也不要凭空多出一轮模型请求。
 *
 * 能同时满足这两点的位置只有一个：**`agent/pre-step`**。
 *
 * 一个 step 走完、工具结果都已落盘之后，驱动循环会回到起点，向 `agent/pre-step`
 * 询问"下一步进不进、带哪些消息进去"（`agent-loop` 的 `turn()` 里那次
 * `await this.preStep(target, …)`）。此刻的状态恰好是：
 *
 *   - 正在执行的工具**已经正常跑完**，结果也在会话里了——不打断它；
 *   - 模型**还没**发起下一次请求——拦在这里就真的什么都不会发生；
 *   - 消息已被 claim 但尚未提交，轮次也还开着——放行后模型从原处接着请求，
 *     上下文里**零新增消息**。
 *
 * ★ **闸门只拦自动推进，不拦真人发言。** 暂停期间人自己发了消息，说明人要它跑，
 * 这时既不放闸也不该继续端着：直接放行，并顺手解除暂停。
 *
 * ## 重启之后（本模块与"零痕迹"的唯一分歧点）
 *
 * 闸门挂住的是进程里的一个 Promise。**重启会把"挂住"这件事本身抹掉**：
 * 没有 waiter 可放行，也没有标记可清，会话就停在 `idle` 上再也起不来。
 *
 * 所以"被按住"这件事**落盘**（`held/<sessionId>.json`，见 store）：
 *
 *   - 重启后 `isPaused` 依旧为真 → 条目上仍有「继续」按钮，人找得到入口；
 *   - 闸门也按落盘的 `paused` 判定 → 重启后若还有别的力量（比如自动续行）把会话
 *     推起来，它照样会在下一个岔口被按住；
 *   - 点继续时本进程里没有 waiter，就退一步用 `agent.followup()` 把会话从 `idle`
 *     唤醒。**这一次恢复会往会话里排一条续行消息**——常规暂停/继续仍然零新增消息，
 *     只有跨过重启的那一次不同，因为那是唯一能真正把它跑起来的手段。
 *
 * 唤醒要求该会话已被 DSH 加载成实时 agent（Web 界面打开这个会话就会触发按需
 * resume）。拿不到 agent 时不做任何事，只回一句"先打开它，或在其中发一条消息"。
 *
 * @module dsh-tree-task-flow/pause
 */

import { activePath, renderContinue } from "./plan.js";
import { pluginSource } from "./region.js";

/**
 * 注册暂停闸门。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, autoContinue }`：`store` 是状态读写端口；
 *   `autoContinue` 是自动续行兜底的控制接口，可为 null——暂停要同时压住它，
 *   否则模型刚停下、兜底就把会话又 followup 拉起来了。
 */
export function registerPause(ctx, { store = null, autoContinue = null } = {}) {
  /** 本进程内处于暂停态的会话。 */
  const paused = new Set();
  /**
   * 正挂在 pre-step 上的会话 → 唤醒它们的那些函数。
   *
   * 存成集合而不是单个函数：驱动循环虽然串行，一个会话同一时刻只会有一个
   * pre-step 在等，但"继续"必须是幂等且彻底的——万一有第二个挂上来，
   * 后一个把前一个的唤醒函数盖掉，先挂住的那次就永远醒不过来了。
   */
  const waiters = new Map();

  /** 这个会话是不是被按住：内存说是，或磁盘说是。 */
  function heldNow(sessionId) {
    return paused.has(sessionId) || store?.readHeld?.(sessionId)?.paused === true;
  }

  /** 只清"暂停"这一半；"停止"那一半归 auto-continue 管。 */
  function clearPaused(sessionId) {
    store?.patchHeld?.(sessionId, { paused: false });
  }

  /**
   * 取这个会话的实时 agent。
   *
   * 用 `ctx.get()` 反射式取，不写进 `inject`：拿不到可选服务时 cordis 会直接抛错，
   * 那会让整个插件加载失败。取不到就退回"提示用户自己发消息"。
   */
  function liveAgent(sessionId) {
    const agents = ctx.get?.("agents");
    return agents?.get?.(sessionId) ?? null;
  }

  /**
   * 挂起当前会话，直到有人点继续、或这一轮被取消。
   *
   * @param sessionId - 要挂起的会话。
   * @param signal - 本轮的取消信号。人在界面上按停止时它会 abort，
   *   必须跟着醒来——否则轮次会被永远挂住，连停都停不下来。
   * @returns 可以放行时兑现的 promise（不传递任何值）。
   */
  function waitForResume(sessionId, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        const pending = waiters.get(sessionId);
        if (pending !== undefined) {
          pending.delete(release);
          if (pending.size === 0) waiters.delete(sessionId);
        }
        signal?.removeEventListener?.("abort", release);
        resolve();
      };
      const pending = waiters.get(sessionId) ?? new Set();
      pending.add(release);
      waiters.set(sessionId, pending);
      if (signal?.aborted === true) {
        release();
        return;
      }
      signal?.addEventListener?.("abort", release, { once: true });
    });
  }

  /**
   * 重启之后的那次"继续"：本进程里没有 waiter 可放行，只能把 idle 的会话推起来。
   *
   * 只有"会话已被加载 + 停在 idle + 计划里还有**未结束的节点**"三条同时成立才推——
   * 正在跑的会话不需要推，整棵树已经收尾的会话不该被推。
   *
   * 注意别把"当前任务还没拆子任务"和"检查点"当成收尾：前者要模型去 `tree_task_plan`，
   * 后者要模型拍板这一层到底完成没有，两者都还是活的。只有 `activePath()` 返回 null
   * （整棵树都结束了）才真的没得跑。
   *
   * @param sessionId - 要唤醒的会话。
   * @returns `{ woke, reason, text }`：`text` 是给命令与界面看的一句话。
   */
  function wakeIdle(sessionId) {
    const agent = liveAgent(sessionId);
    if (agent === null) {
      return {
        woke: false,
        reason: "unloaded",
        text: "这个会话还没被加载：先在界面上打开它，或在其中发一条消息。",
      };
    }
    if (agent.status !== "idle") {
      return { woke: false, reason: "busy", text: "这个会话正在跑，不需要唤醒。" };
    }
    const plan = store?.readPlan?.(sessionId) ?? null;
    const active = activePath(plan);
    if (active === null) {
      return { woke: false, reason: "finished", text: "计划树上的节点都已结束，没有什么可以接着跑的。" };
    }
    try {
      agent.followup({
        id: `tt-resume-${sessionId}-${Date.now().toString(36)}`,
        role: "user",
        content: [{ type: "text", text: renderContinue(plan) }],
        source: pluginSource("恢复续行"),
      });
    } catch (error) {
      return {
        woke: false,
        reason: "error",
        text: `唤醒失败：${String(error?.message ?? error)}`,
      };
    }
    return {
      woke: true,
      reason: "woke",
      text: "已把会话从停住的地方推起来（跨重启的这次恢复会往会话里排一条续行消息）。",
    };
  }

  // waterfall：必须 await next() 并把它返回，否则会截断监听器链。
  // auto-continue.js 也注册了同一个事件（重置续行配额），两条互不干扰。
  ctx.on("agent/pre-step", async (payload, next) => {
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined || !heldNow(sessionId)) return next();

    // 真人发言 = 人要它继续跑。放行，并且不再端着暂停态。
    const fromHuman = (payload?.messages ?? []).some(
      (message) => message?.source?.kind === "user",
    );
    if (fromHuman) {
      paused.delete(sessionId);
      clearPaused(sessionId);
      return next();
    }

    await waitForResume(sessionId, payload?.signal);
    return next();
  });

  return {
    /**
     * 暂停某个会话：之后的每一次自动推进都停在 pre-step。
     * 正在执行的工具不受影响，它跑完才会走到这里。
     *
     * @param sessionId - 要暂停的会话。
     */
    pause(sessionId) {
      if (sessionId === undefined) return;
      paused.add(sessionId);
      store?.patchHeld?.(sessionId, { paused: true });
      autoContinue?.stop?.(sessionId);
    },
    /**
     * 继续某个会话。
     *
     * 分两种情况：
     *   - 本进程里真挂着（常规暂停）→ 放行那一步，**零新增消息**；
     *   - 没有挂着的 waiter（进程重启过）→ 退一步唤醒 idle 的会话，
     *     这一次会往会话里排一条续行消息。
     *
     * @param sessionId - 要放行的会话。
     * @returns `{ released, woke, reason, text }`。
     */
    resume(sessionId) {
      if (sessionId === undefined) {
        return { released: false, woke: false, reason: "no-session", text: "拿不到当前会话。" };
      }

      /** 真解除"被按住"：暂停与停止两半一起清，连自动续行的压住也放开。 */
      const clearHeld = () => {
        paused.delete(sessionId);
        store?.patchHeld?.(sessionId, { paused: false, stopped: false });
        autoContinue?.resume?.(sessionId);
      };

      // 本进程里真挂着：放行那一步——这是常规路径，**零新增消息**。
      const pending = waiters.get(sessionId);
      if (pending !== undefined && pending.size > 0) {
        clearHeld();
        for (const release of [...pending]) release();
        return { released: true, woke: false, reason: "released", text: "停在岔口上的那一步已经放行。" };
      }

      // 没有挂着的 waiter（进程重启过）：退一步唤醒 idle 的会话。
      //
      // **只有真把它推起来、或计划确实已经收尾，才解除"被按住"。** 没成功时
      // （会话没加载 / 正在跑 / 唤醒抛错）必须把状态留着：否则用户既没有「继续」
      // 可再点一次，也看不到为什么没动，只剩一个停在原地的会话。
      const outcome = wakeIdle(sessionId);
      if (outcome.woke === true || outcome.reason === "finished") clearHeld();
      return { released: false, ...outcome };
    },
    /**
     * 这个会话当前是不是被按住（暂停）。
     *
     * 读的是内存加磁盘的并集：重启后内存里的那份没了，磁盘上的还在，
     * 否则界面上连「继续」按钮都不会画出来。
     *
     * @param sessionId - 要查询的会话。
     * @returns 被按住为 true。
     */
    isPaused(sessionId) {
      return heldNow(sessionId);
    },
  };
}
