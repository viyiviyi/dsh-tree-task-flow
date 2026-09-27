/**
 * dsh-tree-task-flow —— 三级任务树：完成时提交结果，同时把执行过程折叠掉。
 *
 * 与 DSH 内置任务系统的差别在于**上下文的收放方式**：
 *
 * ```
 * 一个节点的上下文 =
 *     ① 节点 0：会话级稳定前缀（身份 / 工具 / 静态说明）   ← 永不变化
 *   + ② 这一层已有的汇总消息                                ← 同级逐条累积，不被卷走
 *   + ③ 当前节点的执行过程                                  ← 完成时整段折叠成一条汇总
 * ```
 *
 * ② 与 ③ 的分工是「留给后面的」与「用完就扔的」。节点完成时一次
 * `surfaceOp: replace` 把 `[当前节点的全部执行过程]` 换成 `[一条携带提交结果的汇总消息]`，
 * 汇总落在同级上一条汇总之后，因此下一条汇总的折叠范围够不到它。
 *
 * @module dsh-tree-task-flow
 */

import { registerAutoContinue } from "./auto-continue.js";
import { registerCommands } from "./commands.js";
import { registerHttp } from "./http.js";
import { DEFAULT_ORDER, registerPromptSection } from "./prompt.js";
import { registerRegion } from "./region.js";
import { createStore, defaultRoot } from "./store.js";
import { registerTools } from "./tools.js";

/** Cordis 插件名。 */
export const name = "dsh-tree-task-flow";

/**
 * 依赖的服务。
 *
 * `tools` **必须写进 inject**：cordis 在访问一个没有 inject 的服务属性时会直接抛错
 * （`cannot get property "tools" without inject`），整个插件加载失败、dsh 起不来。
 * 反过来，也只有 inject 了才拿得到 `ctx.tools`。
 */
export const inject = ["systemPrompt", "tools"];

/** 本行没给 config 时使用的默认值。 */
export const DEFAULT_CONFIG = {
  /**
   * 总开关。
   *
   * ★ **默认关闭**。装上插件 ≠ 启用插件：一启用，它就会往**每个会话**的系统提示词里
   * 加一段说明、并在节点完成时改上下文。这种事不该在用户没点头的时候发生。
   * 要启用见 README（在 profile 的 cordis.patch.yml 里打开）。
   */
  enabled: false,
  /**
   * 是否允许在模型停下时自动续行。
   *
   * ★ **默认关闭**。开着它意味着：用户按下停止、agent 回到 idle，
   * 插件立刻又把它拉起来——会话就停不下来了。任务自动执行必须是**受控**的，
   * 要开也得由用户显式打开。
   */
  autoContinue: false,
  /** 连续自动续行的轮次上限，达到就停。 */
  maxAutoRounds: 5,
  /** 静态说明段落的排序。 */
  promptOrder: DEFAULT_ORDER,
  /** 状态目录；null 表示 $DSH_HOME/dsh-task-tree。 */
  rootDir: null,
};

/**
 * 挂载插件。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param config - 本行的 config；未提供或字段缺失时按默认值兜底。
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const root = cfg.rootDir ?? defaultRoot();
  const store = createStore(root);

  // 总开关默认**关**。未启用时一个字节都不碰会话：不注册工具、不加提示词段落、
  // 不折叠上下文、不续行——只留一条命令，让人能确认"装了但没开"以及怎么开。
  if (cfg.enabled !== true) {
    registerCommands(ctx, { store, cfg, autoContinue: null, enabled: false });
    // 面板接口照挂：设置页要能显示"装了但没启用"以及启用后的影响。
    // 只读自己的状态目录，不碰任何会话。
    registerHttp(ctx, { store, cfg, autoContinue: null });
    ctx.logger?.warn?.(
      "dsh-tree-task-flow: 已装载但**未启用**（enabled=false）。要启用请在 profile 的 cordis.patch.yml 里设为 true。",
    );
    return;
  }

  // 静态说明段。必须包在 effect 里，否则热更新后会重复注册而抛错。
  ctx.effect(registerPromptSection(ctx, cfg.promptOrder), "dsh-tree-task-flow.section");

  // 六个工具，以及检查点上的工具闸门。tools 已在 inject 里声明，这里必定就绪。
  registerTools(ctx, { store, cfg });

  // 节点完成时把它的执行过程折叠成一条携带结果的汇总消息。
  registerRegion(ctx, { store });

  // 模型停下来时的续行兜底。返回的控制接口交给 /task-tree 命令，
  // 让人随时能一句话停下来。
  const autoContinue = registerAutoContinue(ctx, { store, cfg });

  // /task-tree 命令：查看与管理任务树，也是"停止自动执行"的开关。
  registerCommands(ctx, { store, cfg, autoContinue, enabled: true });

  // 任务树条目与设置页要用的 HTTP 接口。
  registerHttp(ctx, { store, cfg, autoContinue });

  ctx.logger?.info?.(`dsh-tree-task-flow: 已启用（状态目录 ${root}）`);
}
