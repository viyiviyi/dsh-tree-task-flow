/**
 * 插件自有状态的读写。
 *
 * 两类状态，都**以 `sessionId` 为键**：
 *
 *   - `plans/<sessionId>.json`     计划树
 *   - `surfaces/<sessionId>.json`  三层的折叠游标
 *
 * 计划属于建立它的那个会话。放到会话无关的位置，任何一个会话的计划都会被
 * 所有会话的 `agent/pre-step` 读到——那等于把不相干的节点指派塞进别人的上下文，
 * 还会让别的会话顺手改掉这棵树。
 *
 * 上下文里唯一需要跨轮记住的东西，是"每一层总结到哪儿了"，
 * 那就是游标。
 *
 * **绝不直接写会话日志**。会话日志是后端内部格式（多帧 zstd、世代命名、lease），
 * 绕过去只会写坏它；会话里的东西一律走 `session.append()`。
 *
 * 写入一律走「临时文件 + rename」：同一文件系统内 rename 是原子的，
 * 所以进程崩在写入中途也不会留下半截 JSON。
 *
 * @module dsh-tree-task-flow/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 没有显式配置时的状态根目录。
 * @returns `$DSH_HOME/dsh-task-tree`，没有 DSH_HOME 时退回 `~/.dsh/dsh-task-tree`。
 *   目录名沿用插件改名前的标识，为的是不让既有的计划文件失联。
 */
export function defaultRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-task-tree");
}

/**
 * 读一个 JSON 文件，任何异常都退回 fallback。
 * 坏文件不能拖垮会话——当作空状态继续，下一次写入会覆盖它。
 */
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 原子写：临时文件 + rename。 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * 建一个 store。一个插件实例一个，所有路径都在 root 下。
 *
 * @param root - 状态根目录。
 * @returns 读写两类状态的接口：计划树 / 折叠游标。
 */
export function createStore(root) {
  const file = (...parts) => join(root, ...parts);

  return {
    /** 状态根目录。 */
    root,

    // ---- 计划树：**按会话**，每个会话一棵 ----
    // 按会话隔离是硬要求，理由见文件头注释。

    /**
     * @param sessionId - 会话 id。这个会话还没有计划时返回 null。
     * @returns 计划树对象。
     */
    readPlan(sessionId) {
      if (!sessionId) return null;
      return readJson(file("plans", `${sessionId}.json`), null);
    },

    /**
     * @param sessionId - 会话 id。
     * @param plan - 完整计划树。
     */
    writePlan(sessionId, plan) {
      if (!sessionId) return;
      writeJson(file("plans", `${sessionId}.json`), plan);
    },

    // ---- 折叠游标：按会话分文件；记三层各自"总结到哪儿了" ----

    /**
     * 层级固定为 目标 → 任务 → 子任务，每层一个槽。槽的形状是 `{ key, cursor }`：
     *
     *   - `key`    该层当前节点的 id。与上一轮不同就说明这一层换了节点。
     *   - `cursor` 该层折叠的起点：折叠时从它**之后**替换到末尾，它自己留在 surface 上。
     *              初值是**进入这一层那一刻 surface 的末尾节点**，之后每折叠一次就
     *              更新为刚落下的那条汇总消息。所以它指向的**不一定是本插件放下的
     *              汇总消息**——第一次折叠之前，它可能指向别的生产者留下的节点。
     *              也正因为它停在边界上，同级上一次的汇总消息才不会被这一次折叠卷走。
     *              为 null 表示进入这一层时 surface 还是空的，没有可保留的边界。
     *
     * 槽本身为 null 表示这一层还没开始，或整棵树已经结束。
     *
     * @param sessionId - 会话 id。
     * @returns `{ sessionId, goal, task, step, updatedAt }`。
     */
    readSurfaces(sessionId) {
      return readJson(file("surfaces", `${sessionId}.json`), {
        sessionId,
        goal: null,
        task: null,
        step: null,
        updatedAt: null,
      });
    },

    /** @param sessionId - 会话 id。 @param value - 完整游标状态。 */
    writeSurfaces(sessionId, value) {
      writeJson(file("surfaces", `${sessionId}.json`), value);
    },
  };
}
