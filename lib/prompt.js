/**
 * 系统提示词段落：**只有一段**，讲的是"什么时候用这组工具、完成时守什么规矩"。
 *
 * 工具清单**不在这里**——每个工具的用法由它自己的 `description` 承担。同一句话
 * 写在两处，只会让它在每一次请求里占两份位置，而模型真要调用时读的始终是
 * `description`。计划当前的状态同样不在这里，由 `tree_task_status` 现取。
 *
 * 写法与内置工具段落一致：`text` 是个函数，工具不在当前作用域里就输出空串。
 *
 * @module dsh-tree-task-flow/prompt
 */

/** 段落名。注册表要求全局唯一。 */
export const SECTION_NAME = "dsh-tree-task-flow";

/**
 * 默认排序。
 *
 * 落在 TOOL_PTY（1700）与 TOOL_WEB_SEARCH（2000）之间的空档：与内置工具指引同区，
 * 又不与任何已占用的号相撞。内置贡献方靠 `getSectionOrder` 取中央分配的位置，
 * 外部插件没有这个待遇，只能自己挑一个不冲突的有限值。
 */
export const DEFAULT_ORDER = 1800;

/** 段落正文。 */
export const SECTION_TEXT = `## 树形任务流（tree_task_* 工具组）

一件事需要多步才能做完时，用这组工具把它组织成**目标 → 任务 → 子任务**三级树，
而不是把计划写在回复正文里，也不要再用 todo_write 另记一份。层级固定三级，
子任务是最低一级，不能再往下拆。

- **完成必须提交能独立看懂的 result。** 这个节点从开始到现在的执行过程会被整段
  折叠掉，只留下这条结果；同级已完成的汇总不会被后来的折叠卷走。要看全貌就调
  tree_task_status，不要凭印象猜。
- **子任务全部结束后，父节点不会自动完成。** 那一刻轮到你的判断：继续用
  tree_task_plan 拆子节点，还是用 tree_task_done 提交结果收尾。插件不会替你决定
  这一层做完没有。`;

/**
 * 注册段落。调用方必须包在 `ctx.effect()` 里，否则热更新后会重复注册而抛错。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param order - 段落排序。
 * @returns 注册返回的 disposer（由 ctx.effect 持有）。
 */
export function registerPromptSection(ctx, order) {
  return () =>
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order,
      text: ({ scope }) =>
        ctx.tools.get("tree_task_status", scope) === undefined ? "" : SECTION_TEXT,
    });
}
