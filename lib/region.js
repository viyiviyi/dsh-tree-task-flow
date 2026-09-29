/**
 * 折叠：把一段执行过程从上下文里收起来，换成一条说明收走了什么的短消息。
 *
 * 规则只有一条，**只看表层，与计划树无关**：
 *
 *     从上一个边界调用之后，到下一个 `tree_task_done` 之前，中间那一段过程收走。
 *
 * 边界调用是 `tree_task_create` / `tree_task_plan` / `tree_task_done` 这三个工具。
 * 它们的调用与返回都留在表层上——那是模型看"计划是什么、下一步干什么"的地方，
 * 折叠只收它们**之间**的过程。
 *
 * 两条硬约束：
 *
 *   - 中间夹着真人消息就**整段不折**：往前折丢了需求，往后折丢了回应，两边都出事；
 *   - 中间没有过程（两次调用挨着）就**什么都不注入**，不追加、不留空消息。
 *
 * 于是上下文长成这样：
 *
 *     [节点 0] 系统提示词
 *     [用户消息]
 *     [tree_task_create 调用] [返回：计划已建立 + 整棵树]
 *     [tree_task_plan 调用]   [返回：已添加 2 个子任务 + 整棵树]
 *     [tree_task消息：隐藏了 12 条过程上下文。读取：… 写入：…]
 *     [tree_task_done 调用]   [返回：接下来需要进行步骤：「二」(s-4)。]
 *     [当前这一段执行过程]    ← 下一次折叠的对象
 *
 * 时机是 `agent/pre-step`：上一轮已结束、下一个请求还没构造。工具执行中途不能折叠
 * ——那一刻 surface 还在增长，替换会把自己卷进去。
 *
 * @module dsh-tree-task-flow/region
 */

import { activePath } from "./plan.js";

/** 本插件放下的消息都带这个身份。 */
const PLUGIN = "dsh-tree-task-flow";

/** 三层固定的名字。只给界面用的游标同步按这个顺序走。 */
const LEVELS = ["goal", "task", "step"];

/** 边界调用：这三个工具的调用与返回都不进替换区间，它们是折叠的起止点。 */
const BOUNDARY_TOOLS = new Set(["tree_task_create", "tree_task_plan", "tree_task_done"]);

/** 注入消息的抬头。 */
const NOTICE_PREFIX = "tree_task消息：";

/** 会改动文件的工具：它们的调用参数里带路径，算进"写入"列表。 */
const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

/** 只读取文件的工具：算进"读取"列表。 */
const READ_TOOLS = new Set(["read", "read_image"]);

/** 折叠消息的编号，保证同一毫秒内连折两次也不会撞 id。 */
let foldSeq = 0;

function foldId() {
  foldSeq += 1;
  return `tt-fold-${Date.now().toString(36)}-${foldSeq.toString(36)}`;
}

/** 取当前 surface 的最后一个节点 seq；surface 为空时返回 null。 */
export function tailSeq(session) {
  const nodes = session.surface?.nodes;
  return nodes !== undefined && nodes.length > 0 ? nodes[nodes.length - 1] : null;
}

/** 这条 assistant 消息里调用了哪些工具。 */
function toolNamesOf(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "tool-call").map((part) => part.name);
}

/** 这条 assistant 消息里有没有边界调用。 */
function isBoundaryCall(event) {
  return toolNamesOf(event).some((name) => BOUNDARY_TOOLS.has(name));
}

/** 这条 assistant 消息里有没有 `tree_task_done`。 */
function isDoneCall(event) {
  return toolNamesOf(event).includes("tree_task_done");
}

/** 这条消息是不是真人发的——插件注入的消息 source 是 plugin，不算。 */
function isHumanMessage(event) {
  return event?.type === "user/message" && event.data?.source?.kind === "user";
}

/** 这条消息是不是本插件自己落下的折叠通告。 */
function isPluginNotice(event) {
  return event?.type === "user/message" && event.data?.source?.plugin === PLUGIN;
}

/** 从一次工具调用的参数里取它指向的文件路径；不是文件类调用就返回 null。 */
function filePathOf(call) {
  if (typeof call?.arguments !== "string") return null;
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  const value = args?.file_path ?? args?.path;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * 被这次替换收走的那一段里，读过和写过哪些文件。
 *
 * 路径取自工具调用的 `file_path` / `path` 参数——界面列出文件变更用的是同一个来源。
 * 只认读写文件的工具：`pwsh` / `bash` 这类命令里碰过什么文件看不出来，不计入。
 *
 * @param session - 当前会话。
 * @param shadowed - 被收走的节点 seq，按位置顺序。
 * @returns `{ read, write }`，各是去重后的路径数组，按出现顺序。
 */
export function touchedFiles(session, shadowed) {
  const read = new Set();
  const write = new Set();
  for (const seq of shadowed) {
    const event = session.eventAt(seq);
    if (event?.type !== "assistant/message") continue;
    for (const part of event.data?.message?.content ?? []) {
      if (part?.type !== "tool-call") continue;
      const path = filePathOf(part);
      if (path === null) continue;
      if (WRITE_TOOLS.has(part.name)) write.add(path);
      else if (READ_TOOLS.has(part.name)) read.add(path);
    }
  }
  return { read: [...read], write: [...write] };
}

/**
 * 造一条汇总消息：它取代的是一段执行过程，携带的是"收走了什么"。
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
 * 汇总消息的正文：这一次收走了多少条过程上下文，以及那一段里读写过哪些文件。
 *
 * 文件列表是给后面用的——过程收走了，但"这活碰过哪些文件"得留下，
 * 否则模型要从头再找一遍。
 *
 * @param count - 被这次替换收走的节点条数。
 * @param files - `touchedFiles()` 的结果。
 * @returns 正文文本，可能多行。
 */
function renderSummary(count, files) {
  const lines = [`${NOTICE_PREFIX}隐藏了${count}条过程上下文。`];
  if (files.read.length > 0) lines.push(`读取：${files.read.join("、")}`);
  if (files.write.length > 0) lines.push(`写入：${files.write.join("、")}`);
  return lines.join("\n");
}

/**
 * 汇总消息的一行摘要，给界面折叠标题用。
 *
 * @param count - 被这次替换收走的节点条数。
 * @param files - `touchedFiles()` 的结果。
 * @returns 一行摘要。
 */
function summaryLine(count, files) {
  const touched = files.read.length + files.write.length;
  const base = `树形任务流 · 隐藏了${count}条过程上下文`;
  return touched === 0 ? base : `${base} · 涉及 ${touched} 个文件`;
}

/**
 * 找这一次要折叠的区间。
 *
 * 从末尾往前找两次边界调用：**最近的那次必须是 `tree_task_done`**（它就是这次完成的
 * 那一下），再往前那次（create / plan / done 都算）是起点。两次调用之间的过程才是要收的。
 * 起点那次调用自己的 `tool/result` 也算这次调用的一部分，一并跳过。
 *
 * 表层上找不到更早的边界调用时（比如它已经被压缩遮掉），起点退回表层第一个节点之后
 * ——那时区间多半会撞上真人消息，于是整段不折，这是安全的那一侧。
 *
 * @param session - 当前会话。
 * @returns `{ from, to, shadowed }`；这一轮不该折时返回 null。
 */
export function foldRange(session) {
  const nodes = session.surface?.nodes ?? [];
  if (typeof session.eventAt !== "function" || nodes.length === 0) return null;

  let endIdx = -1;
  let startIdx = -1;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (!isBoundaryCall(session.eventAt(nodes[index]))) continue;
    if (endIdx === -1) {
      // 末尾最近的那次边界调用不是 done：说明还没走到"完成"这一步，这一轮不折。
      if (!isDoneCall(session.eventAt(nodes[index]))) return null;
      endIdx = index;
      continue;
    }
    startIdx = index;
    break;
  }
  if (endIdx === -1) return null;

  // 起点：上一次边界调用之后。找不到就退回表层第一个节点之后（节点 0 是系统提示词，
  // 受 DSH 的重写保护，不能进替换区间）。
  //
  // 还要跳过紧邻的两样东西：那次调用自己的 `tool/result`，以及**上一次折叠落下的通告**
  // ——后者虽然夹在两次边界调用之间，却已经是收过的结果，再收一次就会一轮轮空折下去。
  let from = startIdx === -1 ? 1 : startIdx + 1;
  while (from < endIdx) {
    const event = session.eventAt(nodes[from]);
    if (event?.type === "tool/result" || isPluginNotice(event)) {
      from += 1;
      continue;
    }
    break;
  }
  const to = endIdx - 1;
  if (from > to) return null;

  return { from, to, shadowed: nodes.slice(from, to + 1) };
}

/**
 * 折一次：把边界调用之间那一段过程收走，换成一条说明收走了什么的短消息。
 *
 * 一轮最多折一次——折完这一段就已经不在上下文里了。
 *
 * @param ctx - 挂载本行的 Cordis 上下文，只用来记日志。
 * @param session - 当前会话。
 * @returns 是否真的替换了内容。
 */
export function foldOnce(ctx, session) {
  const range = foldRange(session);
  if (range === null) return false;

  // 中间夹着真人消息：整段不折。往前折丢了需求，往后折丢了回应。
  if (range.shadowed.some((seq) => isHumanMessage(session.eventAt(seq)))) return false;

  const nodes = session.surface.nodes;
  const files = touchedFiles(session, range.shadowed);
  try {
    session.append(
      "user/message",
      summaryMessage(
        foldId(),
        renderSummary(range.shadowed.length, files),
        summaryLine(range.shadowed.length, files),
      ),
      {
        surfaceOp: { op: "replace", startSeq: nodes[range.from], endSeq: nodes[range.to] },
        sourceEventSeqs: range.shadowed,
      },
    );
    return true;
  } catch (error) {
    // 注入失败不能拖垮会话，原区间原样留着，下一轮还有机会。
    ctx.logger?.warn?.(`dsh-tree-task-flow: 折叠失败，保留原区间：${String(error?.message ?? error)}`);
    return false;
  }
}

/**
 * 把三层游标对齐到当前的节点路径。
 *
 * 游标**不参与折叠区间的计算**（那由 `foldRange` 在表层上现算），它只记"这一层走到
 * 哪儿了"，给界面和排查用。一层的 key 变了（换节点了）就重建这个槽，游标落在
 * **进入这一层那一刻的末尾节点**上。
 *
 * 上层重建会顺带重建下层：上层一换，下层的边界就已经并进上层了。
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

    // 折叠只看表层：边界调用之间那一段过程。
    let changed = foldOnce(ctx, session);

    // 三层游标照旧维护，它是给界面看的，不参与上面那次判断。
    const cursors = store.readSurfaces(sessionId);
    if (syncCursors(session, cursors, activePath(plan))) changed = true;

    if (changed) {
      cursors.sessionId = sessionId;
      cursors.updatedAt = Date.now();
      store.writeSurfaces(sessionId, cursors);
    }
    return decision;
  });
}
