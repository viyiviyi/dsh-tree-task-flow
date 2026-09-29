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
export const SECTION_TEXT = "`tree_task_*` 工具适用长线任务，当目标和资料分析完成后，如果用户要求或判断任务较为复杂，可以将任务执行计划分为目标、任务交付节点、任务执行步骤三级写入任务树，借助工具来推进项目；完成步骤或任务时提交后续步骤需要的 result，内容可以是：产物/结论/问题/有哪些需要注意的坑。";

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
