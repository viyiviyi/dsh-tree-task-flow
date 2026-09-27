/**
 * 折叠：把一个节点的执行过程从上下文里收起来，换成一条携带它结果的汇总消息。
 *
 * 上下文按固定三级排成这样：
 *
 *     [节点 0] 系统提示词
 *     [用户消息]
 *     [目标级汇总]                     ← goal.cursor
 *       [任务级汇总]                   ← task.cursor
 *         [子任务汇总] [子任务汇总] …  ← step.cursor 逐条往前推
 *       [任务级汇总]
 *         [子任务汇总] …
 *
 * 每层一个游标，记着"这一层总结到哪儿了"。折叠时**从游标之后**替换到末尾：
 *
 *     子任务完成 → replace([上个游标之后, 末尾]) → 本子任务的汇总
 *     任务完成   → replace([进任务时的末尾之后, 末尾]) → 本任务的汇总
 *     目标完成   → replace([进目标时的末尾之后, 末尾]) → 目标的汇总
 *
 * 游标自己留在替换范围之外，所以**同级上一次的汇总消息不会被这一次折叠卷走**：
 * 新一层开始时游标正好停在它上面。
 *
 * 游标有两个来源：新开一层时是"进入那一刻 surface 的末尾节点"，折叠之后就变成
 * 刚落下的那条汇总消息。前者可能指向别的生产者留下的节点，所以判定游标是否可用
 * 只看"它还在不在 surface 上"，不要求它是本插件放的。
 *
 * 游标一旦失效——被压缩遮掉了，或它之后本来就什么都没有——就没有可替换的区间。
 * 这一次折叠**降级为纯追加**：执行过程收不起来，但提交的结果照样进上下文。
 * 屏蔽是尽力而为，落下结果是必须做到的。
 *
 * 时机是 `agent/pre-step`：上一轮已结束、下一个请求还没构造。工具执行中途不能折叠
 * ——那一刻 surface 还在增长，替换会把自己卷进去。
 *
 * @module dsh-task-tree/region
 */

import { activePath, checkpointOf, findNode, renderContinue } from "./plan.js";

/** 本插件放下的消息都带这个身份。 */
const PLUGIN = "dsh-task-tree";

/** 三层固定的名字，顺序就是折叠必须遵守的顺序：外层的折叠会吃掉内层的一切。 */
const LEVELS = ["goal", "task", "step"];

/** 层级的显示名。 */
const LEVEL_LABEL = { goal: "目标", task: "任务", step: "子任务" };

/** 折叠消息的编号，保证同一毫秒内连折两次也不会撞 id。 */
let foldSeq = 0;

function foldId() {
  foldSeq += 1;
  return `tt-fold-${Date.now().toString(36)}-${foldSeq.toString(36)}`;
}

/** 一个节点是否已经结束（完成或丢弃）。两种都值得把执行过程收起来。 */
function isClosed(node) {
  return node.status === "done" || node.status === "dropped";
}

/** 取当前 surface 的最后一个节点 seq；surface 为空时返回 null。 */
export function tailSeq(session) {
  const nodes = session.surface?.nodes;
  return nodes !== undefined && nodes.length > 0 ? nodes[nodes.length - 1] : null;
}

/**
 * 定位「游标之后到末尾」这一段，也就是这一步要折叠掉的东西。
 *
 * surface 是**位置顺序**、不是 seq 顺序：`replace` 会把新节点放回被替换的位置
 * （`nodes.splice(startIdx, count, seq)`），所以节点的 seq 并不递增——系统提示词
 * 被重写过之后，它的 seq 可能比它后面的用户消息大得多。
 *
 * 因此起止都必须按**位置索引**取，与 DSH 自己算 `nodes.slice(startIdx, endIdx + 1)`
 * 的方式一致。按 seq 区间筛选会在这种乱序下漏掉节点，而 `sourceEventSeqs`
 * 少列一个就会被 `session.append` 直接拒绝。
 *
 * 起点落在游标之后（`cursorIdx + 1`），游标本身因此永远留在 surface 上。
 *
 * @param session - 当前会话。
 * @param cursorSeq - 该层的游标 seq。
 * @returns `{ startIdx, endIdx, startSeq, endSeq, shadowed }`；
 *   游标不在 surface 上、或它已经是末尾（这一层还没产生任何可折叠的东西）时返回 null，
 *   调用方据此降级为追加。
 */
export function foldRange(session, cursorSeq) {
  const nodes = session.surface?.nodes ?? [];
  if (!Number.isInteger(cursorSeq)) return null;
  const cursorIdx = nodes.indexOf(cursorSeq);
  if (cursorIdx === -1) return null;
  const startIdx = cursorIdx + 1;
  if (startIdx >= nodes.length) return null;
  const endIdx = nodes.length - 1;
  return {
    startIdx,
    endIdx,
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    shadowed: nodes.slice(startIdx),
  };
}

/**
 * 把三层游标对齐到当前的节点路径。
 *
 * 一层的 key 变了（换节点了）就重建这个槽，游标落在**进入这一层那一刻的末尾节点**上；
 * 那一刻的末尾后面就是这个节点将要产生的全部内容，正是下一次折叠要收走的东西。
 *
 * 上层重建会顺带清空下层：上层一折叠，下层的一切就已经不在上下文里了，
 * 留着它的游标只会指向一个不存在的边界。
 *
 * @param session - 当前会话。
 * @param cursors - `store.readSurfaces()` 读出来的游标对象，**就地修改**。
 * @param active - `activePath(plan)` 的结果；`null` 表示整棵树已结束。
 * @returns 是否有改动（调用方据此决定要不要写盘）。
 */
export function syncCursors(session, cursors, active) {
  const tail = tailSeq(session);
  let changed = false;
  let outerRebuilt = false;

  for (const level of LEVELS) {
    const key = active?.[level]?.id ?? null;
    const slot = cursors[level] ?? null;
    // `Object.hasOwn` 同时挡住旧格式留下的槽：那种槽没有 cursor 字段，
    // 直接当成没对齐、重建一次就好，不必迁移磁盘上的文件。
    const aligned =
      slot !== null && key !== null && slot.key === key && Object.hasOwn(slot, "cursor");
    if (aligned && !outerRebuilt) continue;

    // 外层一旦重建（或清空），内层的边界就已经并进外层了，无论 key 是否相同都要重来。
    outerRebuilt = true;
    if (key === null) {
      if (slot !== null) {
        cursors[level] = null;
        changed = true;
      }
      continue;
    }
    cursors[level] = { key, cursor: tail };
    changed = true;
  }

  return changed;
}

/**
 * 造一条汇总消息：它取代的是一段执行过程，携带的是那段过程提交的结果。
 *
 * 形态是 `notice` + `summary`：界面把它渲染成一行可读的说明，展开才是正文。
 * 刻意**不用** `snapshot`——那个形态是"运行时上下文快照"的专属标签，
 * 借用它会让任务汇总在界面上冒充系统提示词/运行环境快照。
 */
export function summaryMessage(id, text, summary) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      plugin: PLUGIN,
      form: "notice",
      summary,
    },
  };
}

/**
 * 这一层从 `fromKey` 起、连续已结束的节点。
 *
 * 一个 key 和下一个 key 之间可能挤着好几个节点——模型一轮里连着完成两个子任务，
 * 或者中间那个被丢弃了。它们同属一段执行过程，收成一条汇总就够。
 *
 * 只在**同一父节点下按树里的顺序**往后数，遇到第一个还没结束的节点就停：
 * 那正是这一层现在的活跃节点。
 *
 * @param plan - 计划树。
 * @param level - `goal` / `task` / `step`。
 * @param fromKey - 这一层上一次的活跃节点 id。
 * @returns 已结束的节点，按树里的顺序；没有就返回空数组。
 */
export function closedFrom(plan, level, fromKey) {
  const goal = plan?.goal;
  if (goal === undefined || goal === null) return [];

  if (level === "goal") {
    return goal.id === fromKey && isClosed(goal) ? [goal] : [];
  }

  const list =
    level === "task" ? (goal.tasks ?? []) : (findNode(plan, fromKey)?.task?.steps ?? []);
  const start = list.findIndex((node) => node.id === fromKey);
  if (start === -1) return [];

  const out = [];
  for (let index = start; index < list.length; index += 1) {
    if (!isClosed(list[index])) break;
    out.push(list[index]);
  }
  return out;
}

/**
 * 汇总消息的正文：这些节点各自提交了什么。
 *
 * 正处在检查点上时，把检查点提示一并附上——那一刻模型正需要知道"这一层只剩
 * 拆子节点和提交结果两条路"，而这条消息就是它接下来唯一会读到的说明。
 */
function renderSummary(level, nodes, plan) {
  const label = LEVEL_LABEL[level];
  const parts = [];

  for (const node of nodes) {
    parts.push(
      node.status === "done"
        ? `${label}「${node.title}」(${node.id}) 已完成，它的执行过程已从上下文里收起。`
        : `${label}「${node.title}」(${node.id}) 已丢弃。`,
    );
    const result = node.result?.text;
    if (typeof result === "string" && result !== "") parts.push(`结果：\n${result}`);
  }

  if (checkpointOf(plan) !== null) parts.push(renderContinue(plan));
  return parts.join("\n\n");
}

/** 汇总消息的一行摘要，给界面折叠标题用。 */
function summaryLine(level, nodes) {
  const label = LEVEL_LABEL[level];
  if (nodes.length === 1) return `任务树 · ${label}「${nodes[0].title}」已完成`;
  return `任务树 · ${nodes.length} 个${label}已完成`;
}

/**
 * 把刚结束那一层折起来。
 *
 * 判定只有一条：某一层的 key 和 `activePath` 对不上，就说明这一层换节点了，
 * 刚过去的那个节点（连同它后面连续结束的兄弟）已经做完。
 *
 * 从外往里走，**碰到第一层换了就停**：外层的折叠范围一直覆盖到末尾，
 * 内层的一切本来就在里面，再折一次只会把外层刚落下的汇总又卷走。
 * 剩下的交给 `syncCursors` 重建游标。
 *
 * 折叠失败或无从折叠时降级为追加，见 `foldRange` 的说明。
 *
 * 折叠必须用**换节点之前**的游标，所以这一步要跑在 `syncCursors` 前面。
 *
 * @param ctx - 挂载本行的 Cordis 上下文，只用来记日志。
 * @param session - 当前会话。
 * @param cursors - 游标状态，**就地修改**。
 * @param plan - 计划树。
 * @param active - `activePath(plan)`；`null` 表示整棵树已结束。
 * @returns 是否有改动。
 */
export function foldFinishedLevels(ctx, session, cursors, plan, active) {
  let changed = false;

  for (const level of LEVELS) {
    const key = active?.[level]?.id ?? null;
    const slot = cursors[level] ?? null;

    // 还没有游标的层没有历史可折：第一次进入这一层由 syncCursors 立游标。
    if (slot === null || !Object.hasOwn(slot, "cursor")) continue;
    if (slot.key === key) continue;

    const finished = closedFrom(plan, level, slot.key);
    if (finished.length > 0) {
      const range = foldRange(session, slot.cursor);

      // 折得动就替换：执行过程从上下文里消失，换成一条携带结果的汇总。
      // 折不动（游标已被压缩遮掉，或游标之后本就没有节点）就**只追加**：
      // 那时没有可替换的区间，但提交的结果必须进上下文——否则模型再也看不到
      // 这个节点产出了什么。收不起来可以，丢掉结果不行。
      const intent =
        range === null
          ? { surfaceOp: "append" }
          : {
              surfaceOp: { op: "replace", startSeq: range.startSeq, endSeq: range.endSeq },
              sourceEventSeqs: range.shadowed,
            };

      try {
        const node = session.append(
          "user/message",
          summaryMessage(
            foldId(),
            renderSummary(level, finished, plan),
            summaryLine(level, finished),
          ),
          intent,
        );
        // 游标停在刚落下的汇总上：下一次同级折叠从它**之后**开始，
        // 所以这一条汇总不会被那一次卷走。
        cursors[level] = key === null ? null : { key, cursor: node.seq };
        changed = true;
      } catch (error) {
        // 注入失败不能拖垮会话，也不能把游标推走——推走了这段过程就再也折不掉。
        ctx.logger?.warn?.(
          `dsh-task-tree: 折叠 ${level} 失败，保留原区间：${String(error?.message ?? error)}`,
        );
      }
    }

    // 外层换了，内层的边界已经并进这一层，剩下的交给 syncCursors。
    break;
  }

  return changed;
}

/**
 * 注册折叠。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store }`。
 */
export function registerRegion(ctx, { store }) {
  ctx.on("agent/pre-step", async (payload, next) => {
    // 先让其余监听器跑完，此时本步的一切决定都已落定。
    const decision = await next();
    if (decision?.kind === "reject" || payload?.signal?.aborted) return decision;

    const session = payload?.agent?.session;
    if (session === undefined) return decision;

    const sessionId = session.id;
    const plan = store.readPlan(sessionId);
    if (plan === null) return decision;

    const cursors = store.readSurfaces(sessionId);
    const active = activePath(plan);

    // 顺序不能颠倒：折叠要读**换节点之前**的游标，而 syncCursors 一跑就把游标
    // 推到当前末尾，那时再也没有折叠的起点了。
    let changed = foldFinishedLevels(ctx, session, cursors, plan, active);
    if (syncCursors(session, cursors, active)) changed = true;

    if (changed) {
      cursors.sessionId = sessionId;
      cursors.updatedAt = Date.now();
      store.writeSurfaces(sessionId, cursors);
    }
    return decision;
  });
}
