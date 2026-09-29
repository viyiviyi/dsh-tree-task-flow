/**
 * 插件自有状态的读写。
 *
 * 三类状态，都**以 `sessionId` 为键**：
 *
 *   - `plans/<sessionId>.json`     计划树
 *   - `surfaces/<sessionId>.json`  三层的折叠游标（只给界面看，不参与折叠）
 *   - `held/<sessionId>.json`      「被按住」：暂停 / 停止，**要跨重启保留**
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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
 * 老结构（整棵树只有一个 `goal` 字段）读进来时升级成 `goals` 数组。
 *
 * 计划文件是插件自己的持久状态，换个版本不该让既有的树失联。
 *
 * @param plan - 磁盘上读到的对象，可能是 null。
 * @returns 归一化后的计划树。
 */
function normalizePlan(plan) {
  if (plan === null || typeof plan !== "object") return plan;
  if (Array.isArray(plan.goals)) return plan;
  if (plan.goal === undefined || plan.goal === null) return { ...plan, goals: [] };
  const { goal, ...rest } = plan;
  return { ...rest, version: 2, goals: [goal] };
}

/**
 * 建一个 store。一个插件实例一个，所有路径都在 root 下。
 *
 * @param root - 状态根目录。
 * @returns 读写两类状态的接口：计划树 / 折叠游标。
 */
export function createStore(root) {
  const file = (...parts) => join(root, ...parts);

  /** 「被按住」状态的文件路径。 */
  const heldFile = (sessionId) => file("held", `${sessionId}.json`);

  /** 读「被按住」状态；读不到或文件坏了，一律按"没被按住"处理。 */
  function readHeldState(sessionId) {
    if (!sessionId) return { paused: false, stopped: false, at: null };
    const value = readJson(heldFile(sessionId), null);
    if (value === null || typeof value !== "object") {
      return { paused: false, stopped: false, at: null };
    }
    return {
      paused: value.paused === true,
      stopped: value.stopped === true,
      at: typeof value.at === "number" ? value.at : null,
    };
  }

  /** 写「被按住」状态；两份都不是 true 就把文件删掉，不留空壳。 */
  function writeHeldState(sessionId, value) {
    if (!sessionId) return;
    const paused = value?.paused === true;
    const stopped = value?.stopped === true;
    if (!paused && !stopped) {
      rmSync(heldFile(sessionId), { force: true });
      return;
    }
    writeJson(heldFile(sessionId), { sessionId, paused, stopped, at: Date.now() });
  }

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
      return normalizePlan(readJson(file("plans", `${sessionId}.json`), null));
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
     *   - `cursor` 进入这一层那一刻 surface 的末尾节点。
     *
     * 槽本身为 null 表示这一层还没开始，或整棵树已经结束。
     *
     * 它**不参与折叠**：折叠区间由 `region.foldRange()` 在表层上现算（边界调用之间那
     * 一段过程）。这里记的只是"这一层走到哪儿了"，给界面和排查用。
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

    // ---- 「被按住」：暂停 / 停止。**要跨重启保留**，所以落盘 ----

    /**
     * 读「被按住」状态。
     *
     * 暂停闸门挂住的是进程里的一个 Promise，重启就把"挂住"这件事本身抹掉了，
     * 于是既没有 waiter 可放行、也没有标记可清。这份状态因此必须落盘——
     * 否则重启后条目看不到「继续」按钮，人连恢复的入口都没有。
     *
     * @param sessionId - 会话 id。
     * @returns `{ paused, stopped, at }`；`at` 是最后一次写入的时间，没有则为 null。
     */
    readHeld(sessionId) {
      return readHeldState(sessionId);
    },

    /**
     * 写「被按住」状态。
     *
     * @param sessionId - 会话 id。
     * @param value - `{ paused?, stopped? }`。
     */
    writeHeld(sessionId, value) {
      writeHeldState(sessionId, value);
    },

    /**
     * 只改某几个字段，其余保持磁盘上的原样。
     *
     * 暂停与停止分属两个模块，各自只知道自己那一半：谁都用整份覆盖写，
     * 就会把对方刚落下的那一半抹掉。所以两份状态一律走这里读改写。
     *
     * @param sessionId - 会话 id。
     * @param patch - `{ paused?, stopped? }`；没给的字段不动。
     * @returns 写入后的完整状态。
     */
    patchHeld(sessionId, patch) {
      const current = readHeldState(sessionId);
      writeHeldState(sessionId, {
        paused: patch?.paused ?? current.paused,
        stopped: patch?.stopped ?? current.stopped,
      });
      return readHeldState(sessionId);
    },
  };
}
