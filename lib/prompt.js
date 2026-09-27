/**
 * 系统提示词段落：**只有一段，静态，会话内逐字节不变**。
 *
 * 这里只说明"这组工具是什么、怎么配合用"。计划的当前状态由 `tree_task_status`
 * 现取；已完成节点的产出一部分在树上（首行），全文在完成时注入的那条汇总消息里
 * ——都不放进这里。
 *
 * 之所以坚持静态：提示词一变，DSH 就会往 surface 上追加一整份新副本
 * （默认 in-history 路由）；万一撞上归一化，还会重写节点 0，
 * 让整个上下文从第一个 token 起失去缓存。所以这里一个字都不动。
 *
 * @module dsh-task-tree/prompt
 */

/** 段落名。注册表要求全局唯一。 */
export const SECTION_NAME = "dsh-task-tree";

/** 默认排序。放在部署人设（0）、计划策略（500）之后，所有内置工具指引之前。 */
export const DEFAULT_ORDER = 2000;

/** 段落正文。 */
export const SECTION_TEXT = `## 任务树（tree_task_* 工具组）

一件事需要多步才能做完时，用 tree_task_* 这组工具把它组织成一棵树，
而不是把计划写在回复正文里。层级固定三级：**目标 → 任务 → 子任务**；
子任务是最低一级，不能再往下拆。

- **tree_task_create** —— 建立一个计划：一个目标 + 若干任务。会替换掉现有计划，只在开始新目标时用。
- **tree_task_plan** —— 给一个节点追加子节点：给目标追加任务，给任务追加子任务。
- **tree_task_status** —— 查看整棵树、各节点状态与已提交的结果，以及现在该推进哪个节点。
- **tree_task_done** —— 完成一个节点并提交它的结果。**result 必填。**
- **tree_task_update** —— 修改一个节点的标题或说明。
- **tree_task_drop** —— 丢弃一个节点；丢弃任务会连同它的子任务一起丢弃。改需求用它，不要重建整棵树。

三条规则：

1. **完成必须写 result。** 一个节点完成时，插件会把它从开始到现在的执行过程
   从上下文里折叠掉，换成一条只携带这段结果的汇总消息。所以 result 要写清它
   究竟产出了什么，写成能独立看懂的样子——过程会被丢掉，别写在里面。
2. **子任务全部结束，不会让父节点自动完成**，而是转入**检查点**。那一刻只剩两条路：
   用 tree_task_plan 继续给这个节点拆子节点，或者用 tree_task_done 提交它的结果。
   检查点期间其它工具一律被拒绝——"这一层到底做完没有"要由你判断，不能被计数规则替你定死。
3. 折叠只发生在完成的那一刻：已完成节点的执行过程不再可见，只留下它提交的结果，
   而同级节点各自的结果都会保留下来。需要看全貌——哪些做完了、各自产出了什么——
   调用 tree_task_status，不要凭印象猜。`;

/**
 * 注册段落。调用方必须包在 `ctx.effect()` 里，否则热更新后会重复注册而抛错。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param order - 段落排序。
 * @returns 注册返回的 disposer（由 ctx.effect 持有）。
 */
export function registerPromptSection(ctx, order) {
  return () => ctx.systemPrompt.section({ name: SECTION_NAME, order, text: SECTION_TEXT });
}
