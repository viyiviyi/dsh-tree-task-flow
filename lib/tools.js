/**
 * 六个 `tree_task_*` 工具。
 *
 * 工具本身**只做状态读写**——不注入消息、不动 surface，也不拦任何别的工具。
 * 「完成时把这个节点的执行过程从上下文里折起来、换成一条携带它结果的汇总」
 * 那件事完全由 `agent/pre-step` 监听器负责（它比对游标与 `activePath` 就知道
 * 哪一层刚结束）。
 *
 * 工具能决定的只有一件事：**这个节点算不算做完了**。而它做完了就必须交出
 * `result`——插件正是拿这段文字去顶替它整段执行过程。没有结果的完成会让那段
 * 上下文白白消失，所以 `result` 是必填的。
 *
 * 所有工具共用同一套契约：
 * - `parameters` 用**原始 JSON Schema**（不能 import 宿主的 schemastery）
 * - 返回 `{ text }`，由 `output.render` 渲染成一个文本块
 *
 * @module dsh-tree-task-flow/tools
 */

import {
  addChildren,
  complete,
  createPlan,
  dropNode,
  renderContinue,
  renderTree,
  updateNode,
} from "./plan.js";

/** 所有工具统一的返回形状与渲染。 */
const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
  },
  render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
};

/** 统一包装返回值。 */
const ok = (text) => ({ text });

/**
 * 追加子节点时，父节点层级对应的子节点称呼。
 * @param level - `addChildren` 报回来的父节点层级。
 * @returns 中文称呼。
 */
function childLabel(level) {
  return level === "goal" ? "任务" : "子任务";
}

/**
 * 注册全部工具。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg }`。
 */
export function registerTools(ctx, { store, cfg }) {
  const sessionOf = (exec) => exec?.agent?.session?.id ?? null;

  // ---------------------------------------------------------------- 计划树

  ctx.tools.register({
    name: "tree_task_status",
    description:
      "查看当前计划树：目标、任务、子任务各自的状态与已提交的结果，以及现在该推进哪个节点。" +
      "任务开头、上下文被压缩之后、或者不确定下一步做什么时，调用它。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: OUTPUT,
    async execute(_args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      return ok(renderTree(plan));
    },
  });

  ctx.tools.register({
    name: "tree_task_create",
    description:
      "建立一个新计划：一个目标 + 若干任务。这会替换掉现有计划，所以只在开始一个新目标时调用。" +
      "建完记得用 tree_task_plan 给目标下的第一个任务拆子任务。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "目标：一句话说清最终要达成什么" },
        detail: { type: "string", description: "目标的补充说明" },
        tasks: {
          type: "array",
          description: "目标下的任务列表，按建议的执行顺序排列",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "任务标题" },
              detail: { type: "string", description: "任务的补充说明" },
            },
            required: ["title"],
          },
        },
      },
      required: ["title", "tasks"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      let plan;
      try {
        plan = createPlan(args);
      } catch (error) {
        return ok(`建立计划失败：${String(error?.message ?? error)}`);
      }
      store.writePlan(sessionOf(exec), plan);
      return ok(
        `计划已建立。\n\n${renderTree(plan)}\n\n下一步：调用 tree_task_plan 给目标下的第一个任务拆子任务。`,
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_plan",
    description:
      "给一个节点追加子节点：给目标追加任务，给任务追加子任务。子任务是最低一级，不能再往下拆。" +
      "子任务全部结束后父节点不会自动完成，而是转入检查点——那时再决定继续拆还是提交结果。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: { type: "string", description: "父节点 id（目标或任务），例如 t-abc123" },
        children: {
          type: "array",
          description: "要追加的子节点，按执行顺序；父节点是目标时是任务，是任务时是子任务",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "子节点标题" },
              detail: { type: "string", description: "补充说明" },
            },
            required: ["title"],
          },
        },
      },
      required: ["parentId", "children"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。先用 tree_task_create 建立目标与任务。");
      const result = addChildren(plan, args?.parentId, args?.children);
      if (!result.ok) return ok(`没有添加：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      return ok(
        [
          `已添加 ${result.added.length} 个${childLabel(result.level)}：`,
          ...result.added.map((node) => `  ${node.id}  ${node.title}`),
          "",
          renderTree(plan),
        ].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_done",
    description:
      "完成一个节点并提交它的结果（目标 / 任务 / 子任务都给它的 id）。**必须写 result**：" +
      "插件会把这个节点从开始到现在的执行过程从上下文里折叠掉，换成一条只携带这段结果的汇总消息，" +
      "所以 result 要写清它究竟产出了什么，写成能独立看懂的样子。" +
      "子任务全部结束后父节点不会自动完成，而是转入检查点；那时再决定继续拆子任务还是提交父节点的结果。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要完成的节点 id" },
        result: {
          type: "string",
          description: "这个节点产出了什么。它整段执行过程会被这条结果顶替，所以要能独立看懂。",
        },
      },
      required: ["id", "result"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = complete(plan, args?.id, args?.result);
      if (!result.ok) return ok(`没有完成：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      return ok(
        [...result.events, "", renderTree(plan), "", renderContinue(plan)].join("\n"),
      );
    },
  });

  ctx.tools.register({
    name: "tree_task_update",
    description: "修改一个节点的标题或说明。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "节点 id" },
        title: { type: "string", description: "新的标题" },
        detail: { type: "string", description: "新的说明" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = updateNode(plan, args?.id, args ?? {});
      if (!result.ok) return ok(`没有修改：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      return ok(`已更新 ${result.changed.join(" / ")}。\n\n${renderTree(plan)}`);
    },
  });

  ctx.tools.register({
    name: "tree_task_drop",
    description:
      "丢弃一个节点。丢弃任务会连同它的子任务一起丢弃。改需求用这个，不要重建整棵树——" +
      "已丢弃的节点会留在树里可查。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "要丢弃的节点 id" },
      },
      required: ["id"],
    },
    output: OUTPUT,
    async execute(args, exec) {
      const plan = store.readPlan(sessionOf(exec));
      if (!plan) return ok("还没有计划。");
      const result = dropNode(plan, args?.id);
      if (!result.ok) return ok(`没有丢弃：${result.reason}`);
      store.writePlan(sessionOf(exec), plan);
      return ok(
        [`已丢弃：${result.dropped.join("、")}`, "", renderTree(plan), "", renderContinue(plan)].join(
          "\n",
        ),
      );
    },
  });

  void cfg;
}
