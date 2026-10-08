/**
 * 压缩后提示：内置压缩把一大段历史收成一条检查点之后，提醒模型
 * 计划树没有被压缩，可以用 `tree_task_status` 取回来。
 *
 * 为什么需要它：内置压缩（`@deepseek-ai/dsh-compaction-basic`）在上下文用到
 * 窗口 `thresholdRatio`（默认 0.8）时触发，只保留最近 `retainRatio`
 * （默认 0.16）的原文，其余整段换成一条结构化的检查点消息。计划树的三层结构、
 * 各节点已提交的 result、当前推进到哪一步，只能指望摘要恰好把它们写进了
 * Pending Jobs / Current Work / Next Step——不保证写全。而压缩的摘要指令
 * 又明确要求"不要提及这次压缩"，模型不会自己想到去查。
 *
 * 怎么认：压缩留下的表层节点是一条 `user/message`，它的 `source` 由
 * `compactCheckpointSource()` 构造。**两个形状都要认**：
 *
 *   - v4 原生：`{ kind: "compact-checkpoint", compactionId, … }`
 *     （`COMPACT_CHECKPOINT_MARKER` 就是 `{ kind: "compact-checkpoint" }`）；
 *   - v3 老写法：`{ kind: "plugin", plugin: "compact" }`——它只在 v3 → v4 迁移里
 *     被改写成前者，迁移前的会话里仍是这个样子。
 *
 * 只认老写法，会让**已经迁到 v4 的会话彻底收不到压缩提示**（实测：本机
 * session-2083c383 在 v4 里连续压缩两次，一条提示都没有）。
 *
 * **不要认 `compaction/summary` 事件**：那是压缩自己的记录，不带 `surfaceOp`，
 * 因此根本不在表层里；真正替代被收走那段的是紧随其后那条带
 * `surfaceOp: { op: "replace", … }` 的消息。
 *
 * 时机与顺序：本模块在 `lib/index.js` 里比 `region` **先**注册，因此它是外层
 * 监听器——注入放在 `await next()` **之后**，那时暂停闸门与折叠都已经做完：
 * 被按住的会话收不到提示，这条提示自己也不会被同一轮折叠收走。
 *
 * 检出则**两头都看**，因为本行相对压缩实现坐在链的哪一层不是本插件能决定的：
 *
 *   - 坐在压缩外层：前置那次还没有新检查点，只有后置能看到；
 *   - 坐在压缩内层：前置那次就看到了，而后置时它可能已被这一轮折叠收走
 *     （实机复测里真出现过：三次压缩只提示了两次）。
 *
 * 取后置看到的优先——那是更新的一次压缩。
 *
 * @module dsh-tree-task-flow/compaction
 */

import { summaryMessage } from "./region.js";

/**
 * 压缩检查点的插件标记——**只有** v3 老写法用到它。
 *
 * 与 `@deepseek-ai/dsh-compaction` 的 V3 侧字面量保持一致。这里按形状判断而不是
 * import 那个包：插件不该为了认一个标记，就把一个 DSH 内部包写进自己的依赖里。
 */
const COMPACTION_PLUGIN = "compact";

/**
 * v4 原生压缩检查点的 source kind。
 *
 * 与 `@deepseek-ai/dsh-compaction` 的 `COMPACT_CHECKPOINT_MARKER` 一致
 * （`{ kind: "compact-checkpoint" }`）。
 */
const COMPACTION_KIND = "compact-checkpoint";

/**
 * 提示正文。
 *
 * 与折叠通告同形：`tree_task消息：` 开头，走 plugin/notice 形态落进表层，
 * 界面上显示成一条可展开的通知，而不是冒充用户说的话。
 */
const NOTICE_TEXT =
  "tree_task消息：上下文刚被压缩过，计划树没有被压缩。用 tree_task_status 取回当前进度、" +
  "各节点已提交的 result，以及下一步该推进哪个节点。";

/** 界面上的一行摘要。 */
const NOTICE_LINE = "树形任务流 · 上下文被压缩，计划树仍在";

/** 提示消息的编号，保证同一毫秒内连发两条也不撞 id。 */
let noticeSeq = 0;

function noticeId() {
  noticeSeq += 1;
  return `tt-compaction-${Date.now().toString(36)}-${noticeSeq.toString(36)}`;
}

/** 这条表层节点是不是压缩落下的检查点（v4 新写法与 v3 老写法都认）。 */
function isCompactionCheckpoint(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  if (source === undefined || source === null) return false;
  if (source.kind === COMPACTION_KIND) return true;
  return source.kind === "plugin" && source.plugin === COMPACTION_PLUGIN;
}

/**
 * 表层上最后一个压缩检查点的 seq；这个会话还没被压缩过就返回 null。
 *
 * @param session - 当前会话。
 * @returns 检查点节点的 seq，或 null。
 */
export function latestCompactionSeq(session) {
  const nodes = session?.surface?.nodes ?? [];
  if (typeof session?.eventAt !== "function") return null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (isCompactionCheckpoint(session.eventAt(nodes[index]))) return nodes[index];
  }
  return null;
}

/**
 * 注册压缩后提示。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store }`。
 */
export function registerCompactionNotice(ctx, { store }) {
  ctx.on("agent/pre-step", async (payload, next) => {
    const session = payload?.agent?.session;
    // 前置那次先记下来：如果本行坐在压缩内层，这就是唯一能看到新检查点的时机。
    const seqBefore = session === undefined ? null : latestCompactionSeq(session);

    // 注入在后：暂停闸门与折叠都已经做完。
    const decision = await next();
    if (decision?.kind === "reject" || payload?.signal?.aborted) return decision;
    if (session === undefined) return decision;

    // 后置看到的优先（那是更新的一次压缩），看不到再退回前置那次。
    const seq = latestCompactionSeq(session) ?? seqBefore;
    if (seq === null) return decision;

    const sessionId = session.id;
    // 没有计划树就没有可查的状态，一条都不注入。
    if (store.readPlan(sessionId) === null) return decision;

    const cursors = store.readSurfaces(sessionId);
    // 同一个检查点只提示一次；之后再被压缩，才会再提示一次。
    if (cursors.compactionNoticeAt === seq) return decision;

    try {
      // surface 事件必须显式声明 surfaceOp，否则 append 会直接抛错。
      session.append("user/message", summaryMessage(noticeId(), NOTICE_TEXT, NOTICE_LINE), {
        surfaceOp: "append",
      });
    } catch (error) {
      // 注入失败不改去重位置，下一轮还有机会。
      ctx.logger?.warn?.(
        `dsh-tree-task-flow: 压缩提示注入失败，下一轮再试：${String(error?.message ?? error)}`,
      );
      return decision;
    }

    cursors.compactionNoticeAt = seq;
    cursors.sessionId = sessionId;
    cursors.updatedAt = Date.now();
    store.writeSurfaces(sessionId, cursors);
    return decision;
  });
}
