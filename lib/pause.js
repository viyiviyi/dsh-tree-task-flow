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
 * 所以本模块做的事只有一件：在这个岔口上挂住，等人点继续。
 *
 * 相比之下另外两个候选都不合适：
 *   - `agent/turn-stopping` 虽然也是被 await 的，但轮次紧接着就会关闭
 *     （`agent-loop` 里 `if (turnEnds && this.inbox.nextStep.length === 0) break;`），
 *     想让它继续跑就必须 `steer()` 一条消息进去——那就留下了痕迹。
 *   - 工具结果里的 `concludesTurn: true` 只是提前收尾，同样得靠新输入才能再启动。
 *
 * ★ **闸门只拦自动推进，不拦真人发言。** 暂停期间人自己发了消息，说明人要它跑，
 * 这时既不放闸也不该继续端着：直接放行，并顺手解除暂停。
 *
 * @module dsh-tree-task-flow/pause
 */

/**
 * 注册暂停闸门。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ autoContinue }`：自动续行兜底的控制接口，可为 null。
 *   暂停要同时压住它，否则模型刚停下、兜底就把会话又 followup 拉起来了。
 */
export function registerPause(ctx, { autoContinue = null } = {}) {
  /** 处于暂停态的会话。 */
  const paused = new Set();
  /**
   * 正挂在 pre-step 上的会话 → 唤醒它们的那些函数。
   *
   * 存成集合而不是单个函数：驱动循环虽然串行，一个会话同一时刻只会有一个
   * pre-step 在等，但"继续"必须是幂等且彻底的——万一有第二个挂上来，
   * 后一个把前一个的唤醒函数盖掉，先挂住的那次就永远醒不过来了。
   */
  const waiters = new Map();

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

  // waterfall：必须 await next() 并把它返回，否则会截断监听器链。
  // auto-continue.js 也注册了同一个事件（重置续行配额），两条互不干扰。
  ctx.on("agent/pre-step", async (payload, next) => {
    const sessionId = payload?.agent?.session?.id;
    if (sessionId === undefined || !paused.has(sessionId)) return next();

    // 真人发言 = 人要它继续跑。放行，并且不再端着暂停态。
    const fromHuman = (payload?.messages ?? []).some(
      (message) => message?.source?.kind === "user",
    );
    if (fromHuman) {
      paused.delete(sessionId);
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
      autoContinue?.stop?.(sessionId);
    },
    /**
     * 继续某个会话：放行挂在 pre-step 上的那一步。
     * 不推送任何消息——模型只是从它原本要请求的地方接着请求。
     *
     * @param sessionId - 要放行的会话。
     */
    resume(sessionId) {
      if (sessionId === undefined) return;
      paused.delete(sessionId);
      const pending = waiters.get(sessionId);
      if (pending !== undefined) for (const release of [...pending]) release();
      autoContinue?.resume?.(sessionId);
    },
    /**
     * 这个会话当前是不是暂停着。
     *
     * @param sessionId - 要查询的会话。
     * @returns 暂停中为 true。
     */
    isPaused(sessionId) {
      return paused.has(sessionId);
    },
  };
}
