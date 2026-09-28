/**
 * `/task-tree` 斜杠命令：给人用的入口。
 *
 * 命令**不经过模型**——`handler` 直接执行、直接返回文本。所以它是查看和管理
 * 任务树最直接的方式，也是"暂停自动执行"的那个开关：
 * 任务自动执行必须是**受控**的，人得有一句话就能接管的手段。
 *
 * @module dsh-tree-task-flow/commands
 */

import { activePath, checkpointOf, complete, dropNode, levelLabel, renderTree } from "./plan.js";

/** 用法说明，status 和 help 都会带上。 */
const USAGE = [
  "/task-tree                     查看本会话的任务树与检查点状态",
  "/task-tree done <id> <结果>     提交某个节点的结果并完成它",
  "/task-tree drop <id>           丢弃某个节点",
  "/task-tree pause               暂停：当前工具跑完后停住，不再往下推进",
  "/task-tree resume              继续：从停住的地方接着跑，不插消息",
  "/task-tree reset               清掉本会话的计划树",
].join("\n");

/** 未启用时唯一要说的话：装了，但没开，以及怎么开。 */
const DISABLED_NOTE =
  "dsh-tree-task-flow 已装载但**未启用**（config 里 enabled 不是 true）：它没有注册工具，" +
  "也不会折叠任何上下文。要启用请在 profile 的 cordis.patch.yml 里把 enabled 设为 true。";

/**
 * 把检查点那句话拼出来。措辞与 `plan.js` 的检查点提示一致。
 *
 * @param checkpoint - `checkpointOf(plan)` 的结果。
 * @returns 两行文本。
 */
function checkpointLines(checkpoint) {
  const label = levelLabel(checkpoint.level);
  return [
    `检查点：${label}「${checkpoint.node.title}」(${checkpoint.node.id}) 的子节点已全部结束。`,
    `此刻轮到你的判断：用 tree_task_plan 继续给 ${checkpoint.node.id} 拆子节点，` +
      `或者用 tree_task_done(id="${checkpoint.node.id}", result="…") 提交这个${label}的结果并完成它。`,
  ];
}

/**
 * 注册命令。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, cfg, pause, enabled }`；`pause` 是 `registerPause`
 *   返回的控制接口，未启用时是 null。
 */
export function registerCommands(ctx, { store, cfg, pause = null, enabled = false }) {
  // 和 tools 一样，命令服务不是每个部署都有；用 get 探测而不是写进 inject。
  const commands = ctx.get?.("commands");
  if (commands === undefined || commands === null) {
    ctx.logger?.debug?.("dsh-tree-task-flow: 没有 commands 服务，/task-tree 未注册");
    return;
  }

  commands.register({
    name: "task-tree",
    description: "查看与管理任务树：status / done <id> <结果> / drop <id> / pause / resume / reset",
    input: { hint: "status | done <id> <结果> | drop <id> | pause | resume | reset" },
    handler: (invocation) => {
      const sessionId = invocation?.agent?.session?.id;
      if (sessionId === undefined) {
        return { kind: "error", text: "拿不到当前会话。" };
      }

      const raw = String(invocation?.rawInput ?? "").trim();
      const [verb = "status", ...rest] = raw === "" ? [] : raw.split(/\s+/u);

      if (verb === "help") {
        return { kind: "success", text: enabled === true ? USAGE : `${DISABLED_NOTE}\n\n${USAGE}` };
      }

      // 未启用时插件没有注册工具，也就不会有计划树；除了查看"装了但没开"，
      // 其余动词一概不执行——启用的插件一个字节都不该碰会话。
      if (enabled !== true && verb !== "status") {
        return {
          kind: "error",
          text: `${DISABLED_NOTE}\n\n未启用时只有 /task-tree status 与 /task-tree help 可用。`,
        };
      }

      // `stop` 是旧写法，含义与 `pause` 完全一样，留着免得习惯改不过来。
      if (verb === "pause" || verb === "stop") {
        pause?.pause?.(sessionId);
        return {
          kind: "success",
          text:
            "已暂停本会话：正在执行的那个工具会正常跑完，之后不再往下推进。" +
            "任务树的进度没有变，点继续就从停住的地方接着跑。",
        };
      }

      if (verb === "resume") {
        pause?.resume?.(sessionId);
        return {
          kind: "success",
          text:
            cfg.autoContinue === true
              ? "已继续：停在岔口上的那一步已经放行，自动续行也重新允许了。"
              : "已继续：停在岔口上的那一步已经放行。配置里 autoContinue 是 false，所以模型自己停下后不会再被自动拉起。",
        };
      }

      if (verb === "reset") {
        store.writePlan(sessionId, null);
        return { kind: "success", text: "已清掉本会话的计划树。" };
      }

      if (verb === "done") {
        const id = rest[0];
        const result = rest.slice(1).join(" ").trim();
        if (id === undefined) {
          return { kind: "error", text: `用法：/task-tree done <节点 id> <结果>\n\n${USAGE}` };
        }
        if (result === "") {
          return {
            kind: "error",
            text:
              "完成必须提交结果：请写清这个节点产出了什么。" +
              "插件会用它顶替这个节点从开始到现在的整段执行过程，所以要写成能独立看懂的样子。",
          };
        }
        const plan = store.readPlan(sessionId);
        if (plan === null) return { kind: "error", text: "本会话还没有计划。" };
        const outcome = complete(plan, id, result);
        if (!outcome.ok) return { kind: "error", text: `没有完成：${outcome.reason}` };
        store.writePlan(sessionId, plan);
        // `complete` 已经把检查点提示放进 events 了，这里只补上折叠后的树。
        return { kind: "success", text: [...outcome.events, "", renderTree(plan)].join("\n") };
      }

      if (verb === "drop") {
        const id = rest[0];
        if (id === undefined) {
          return { kind: "error", text: `用法：/task-tree drop <节点 id>\n\n${USAGE}` };
        }
        const plan = store.readPlan(sessionId);
        if (plan === null) return { kind: "error", text: "本会话还没有计划。" };
        const result = dropNode(plan, id);
        if (!result.ok) return { kind: "error", text: `没有丢弃：${result.reason}` };
        store.writePlan(sessionId, plan);
        return {
          kind: "success",
          text: [`已丢弃：${result.dropped.join("、")}`, "", renderTree(plan)].join("\n"),
        };
      }

      if (verb !== "status") {
        return { kind: "error", text: `不认识的子命令：${verb}\n\n${USAGE}` };
      }

      const plan = store.readPlan(sessionId);
      const lines = [renderTree(plan)];

      if (enabled !== true) {
        lines.push("", DISABLED_NOTE);
      } else if (plan === null) {
        lines.push("", "本会话还没有计划。用 tree_task_create 建立目标与任务。");
      } else {
        // 检查点优先于"当前节点"：那一刻要推进的不是某个子任务，
        // 而是"这一层到底做完了没有"这个判断。
        const checkpoint = checkpointOf(plan);
        const active = activePath(plan);
        if (checkpoint !== null) {
          lines.push("", ...checkpointLines(checkpoint));
        } else if (active === null) {
          lines.push("", "计划树上的所有节点都已结束。请向用户汇报最终结果。");
        } else if (active.step !== null) {
          lines.push("", `当前子任务：${active.step.id}「${active.step.title}」`);
        } else if (active.task !== null) {
          lines.push(
            "",
            `当前任务：${active.task.id}「${active.task.title}」（还没有子任务 → tree_task_plan）`,
          );
        } else {
          lines.push(
            "",
            `当前目标：${active.goal.id}「${active.goal.title}」（还没有任务 → tree_task_plan）`,
          );
        }
      }

      lines.push("", USAGE);
      return { kind: "success", text: lines.join("\n") };
    },
  });
}
