/**
 * 计划树：目标 → 任务 → 子任务，固定三级。
 *
 * 纯逻辑模块——不碰 DSH、不碰磁盘。状态由调用方从 store 读出、改完写回。
 *
 * 节点状态只有三种：`pending` / `done` / `dropped`。
 * **谁是"当前节点"是推导出来的，不是存的**（`activePath`）——
 * 少一个需要同步的状态，就少一类 bug。
 *
 * 一个节点完成时必须提交 `result`（这个节点产出了什么）。插件据此把
 * 它的执行过程从上下文里折叠掉，换成一条携带该结果的汇总消息。
 *
 * **子节点全部结束时，父节点不自动完成。** 那一刻转入**检查点**：
 * 模型要么继续给父节点拆新的子节点，要么提交父节点的结果并完成它。
 * 这样"这一层到底做完没有"始终由模型判断，不会被一条计数规则抢先定死。
 *
 * @module dsh-tree-task-flow/plan
 */

/** 节点状态取值。 */
export const STATUS = {
  PENDING: "pending",
  DONE: "done",
  DROPPED: "dropped",
};

/** 一个节点是否还"活着"（未完成、未丢弃）。 */
export function isOpen(node) {
  return node !== undefined && node !== null && node.status === STATUS.PENDING;
}

/** 已结束（完成或丢弃）。 */
function isClosed(node) {
  return node.status === STATUS.DONE || node.status === STATUS.DROPPED;
}

/** 进程内自增，配合时间戳保证 id 唯一且短。 */
let seq = 0;

function newId(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 标题归一化：去空白，空标题给个占位。 */
function normalizeTitle(value, fallback) {
  return String(value ?? "").trim() || fallback;
}

/** 子任务节点（第三级，没有下级）。 */
function makeStep(input, now) {
  return {
    id: newId("s"),
    title: normalizeTitle(input?.title, "(未命名子任务)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
  };
}

/** 任务节点（第二级）。 */
function makeTask(input, now) {
  return {
    id: newId("t"),
    title: normalizeTitle(input?.title, "(未命名任务)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
    steps: [],
  };
}

/**
 * 建一棵全新的计划树。首版是单活动计划，所以这会替换掉原有的树。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 完整的计划树对象。
 */
/**
 * 建一个目标：它自己的字段 + 一批任务。
 *
 * 一个会话可以有**多个**目标，它们是最外层的兄弟，按创建顺序排。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 目标节点。
 */
export function createGoal(input, now = Date.now()) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  if (tasks.length === 0) {
    throw new Error("至少要有一个任务；请在 tasks 里给出");
  }
  return {
    id: newId("g"),
    title: normalizeTitle(input?.title, "(未命名目标)"),
    detail: String(input?.detail ?? ""),
    status: STATUS.PENDING,
    createdAt: now,
    completedAt: null,
    result: null,
    tasks: tasks.map((task) => makeTask(task, now)),
  };
}

/**
 * 建一棵全新的计划树：只含一个目标。
 *
 * @param input - `{ title, detail?, tasks: [{ title, detail? }] }`。
 * @param now - 注入的时间戳，便于测试。
 * @returns 完整的计划树对象。
 */
export function createPlan(input, now = Date.now()) {
  return {
    version: 2,
    createdAt: now,
    updatedAt: now,
    goals: [createGoal(input, now)],
  };
}

/**
 * 往计划里追加一个目标——同一个会话里再立一个目标走这里，不是重建整棵树。
 *
 * @param plan - 计划树。
 * @param input - 同 `createGoal`。
 * @param now - 时间戳。
 * @returns 新加的目标节点。
 */
export function addGoal(plan, input, now = Date.now()) {
  const goal = createGoal(input, now);
  if (!Array.isArray(plan.goals)) plan.goals = [];
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

/**
 * 计划里的全部目标。
 *
 * @param plan - 计划树。
 * @returns 目标数组；没有计划时是空数组。
 */
export function goalsOf(plan) {
  return Array.isArray(plan?.goals) ? plan.goals : [];
}

/**
 * 按 id 找节点，并给出它在树里的位置。
 *
 * @param plan - 计划树。
 * @param id - 节点 id（目标 / 任务 / 子任务都可以）。
 * @returns `{ level, goal, task, step, node }`，找不到返回 null。
 */
export function findNode(plan, id) {
  for (const goal of goalsOf(plan)) {
    if (goal.id === id) {
      return { level: "goal", goal, task: null, step: null, node: goal };
    }
    for (const task of goal.tasks ?? []) {
      if (task.id === id) {
        return { level: "task", goal, task, step: null, node: task };
      }
      for (const step of task.steps ?? []) {
        if (step.id === id) {
          return { level: "step", goal, task, step, node: step };
        }
      }
    }
  }
  return null;
}

/**
 * 推导"现在应该做哪个节点"。
 *
 * @param plan - 计划树。
 * @returns `null` 表示整棵树都结束了；否则 `{ goal, task, step }`，
 *   其中 `task` 为 `null` 表示目标下已没有未结束的任务，
 *   `step` 为 `null` 表示当前任务还没拆子任务（需要先 `tree_task_plan`）。
 */
export function activePath(plan) {
  const goal = goalsOf(plan).find(isOpen);
  if (!goal) return null;
  const task = (goal.tasks ?? []).find(isOpen);
  if (!task) return { goal, task: null, step: null };
  const step = (task.steps ?? []).find(isOpen);
  return { goal, task, step: step ?? null };
}

/**
 * 找出当前的检查点：一个**自己还没完成、但子节点已经全部结束**的节点。
 *
 * 只沿活动路径判断——模型一次推进一条路径，别的分支还没轮到。
 * 一个从没拆过子节点的节点不算检查点：它处于"待拆分"，不是"待拍板"。
 *
 * @param plan - 计划树。
 * @returns `{ level, goal, task, step, node }`，没有检查点时返回 null。
 */
export function checkpointOf(plan) {
  const active = activePath(plan);
  if (active === null) return null;
  const { goal } = active;

  if (active.task === null) {
    // 这个目标下已经没有未结束的任务，但目标自己还开着。
    const tasks = goal.tasks ?? [];
    return tasks.length > 0 ? { level: "goal", goal, task: null, step: null, node: goal } : null;
  }

  if (active.step !== null) return null;

  const steps = active.task.steps ?? [];
  if (steps.length === 0) return null;
  return { level: "task", goal, task: active.task, step: null, node: active.task };
}

/**
 * 给一个节点追加子节点。
 *
 * 目标接受任务（每个任务自带空的子任务列表），任务接受子任务。
 * 子任务是最低一级，不能再往下拆。
 *
 * @param plan - 计划树。
 * @param parentId - 父节点 id（目标或任务）。
 * @param items - `[{ title, detail? }]`。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, added? }`。
 */
export function addChildren(plan, parentId, items, now = Date.now()) {
  const found = findNode(plan, parentId);
  if (!found) return { ok: false, reason: `找不到节点 ${parentId}` };
  if (found.level === "step") {
    return { ok: false, reason: `子任务 ${parentId} 是最低一级，不能再拆` };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "至少要给一个子节点" };
  }

  const added =
    found.level === "goal"
      ? items.map((item) => makeTask(item, now))
      : items.map((item) => makeStep(item, now));
  if (found.level === "goal") {
    found.goal.tasks.push(...added);
  } else {
    found.task.steps.push(...added);
  }
  plan.updatedAt = now;
  return { ok: true, added, level: found.level };
}

/**
 * 把一个节点标为完成，并记录它提交的结果。
 *
 * 完成必须带结果——插件要用它替换掉这个节点的执行过程。
 * 子节点全部结束不会让父节点自动完成，只会让它进入检查点（见 `checkpointOf`）。
 *
 * @param plan - 计划树。
 * @param id - 要完成的节点 id。
 * @param result - 这个节点产出了什么的说明文本。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, events?, active?, checkpoint? }`。
 */
export function complete(plan, id, result, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };
  const { level, node } = found;

  if (node.status === STATUS.DONE) {
    return { ok: false, reason: `节点 ${id} 已经是完成状态` };
  }
  if (node.status === STATUS.DROPPED) {
    return { ok: false, reason: `节点 ${id} 已被丢弃，不能标记完成` };
  }

  const text = typeof result === "string" ? result.trim() : "";
  if (text === "") {
    return { ok: false, reason: `完成${levelLabel(level)}必须提交结果：请在 result 里写清它产出了什么` };
  }

  node.status = STATUS.DONE;
  node.completedAt = now;
  node.result = { text, at: now };
  plan.updatedAt = now;

  const events = [`${levelLabel(level)}「${node.title}」已完成`];
  const checkpoint = checkpointOf(plan);
  if (checkpoint !== null) {
    events.push(checkpointNote(checkpoint));
  }

  return {
    ok: true,
    events,
    active: activePath(plan),
    checkpoint: checkpoint === null ? null : { id: checkpoint.node.id, level: checkpoint.level },
  };
}

/**
 * 丢弃一个节点。丢弃目标会连同它下面的任务与子任务一起丢弃；丢弃任务会带上它的子任务。
 *
 * 改需求就用这个丢弃 + `tree_task_plan` 追加新子节点，旧节点留在树里可查。
 * 已经结束的子节点保持原样——丢的是"还要不要做"，不是改写历史。
 * 已经**完成**的节点不能丢（那会毁掉它交出的结果），丢过的也不能再丢一次。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, dropped?, active?, checkpoint? }`。
 */
export function dropNode(plan, id, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };

  if (found.node.status === STATUS.DONE) {
    return { ok: false, reason: `节点 ${id} 已经完成，丢弃会毁掉它的结果记录` };
  }
  if (found.node.status === STATUS.DROPPED) {
    return { ok: false, reason: `节点 ${id} 已经被丢弃` };
  }

  const dropped = [`${levelLabel(found.level)}「${found.node.title}」`];
  found.node.status = STATUS.DROPPED;

  // 目标是这一层唯一的"有孩子"的节点里最外那一层：丢它就把整支带走。
  const tasks = found.level === "goal" ? (found.node.tasks ?? []) : [found.node];
  for (const task of tasks) {
    if (task !== found.node && !isClosed(task)) {
      task.status = STATUS.DROPPED;
      dropped.push(`任务「${task.title}」`);
    }
    for (const step of task.steps ?? []) {
      if (!isClosed(step)) {
        step.status = STATUS.DROPPED;
        dropped.push(`子任务「${step.title}」`);
      }
    }
  }
  plan.updatedAt = now;

  const checkpoint = checkpointOf(plan);
  return {
    ok: true,
    dropped,
    active: activePath(plan),
    checkpoint: checkpoint === null ? null : { id: checkpoint.node.id, level: checkpoint.level },
  };
}

/**
 * 改一个节点的标题或说明。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param patch - `{ title?, detail? }` 的任意子集。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, changed? }`。
 */
export function updateNode(plan, id, patch, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };

  const changed = [];
  const { node } = found;
  if (typeof patch?.title === "string" && patch.title.trim() !== "") {
    node.title = patch.title.trim();
    changed.push("title");
  }
  if (typeof patch?.detail === "string") {
    node.detail = patch.detail;
    changed.push("detail");
  }
  if (changed.length === 0) {
    return { ok: false, reason: "没有给出任何要改的字段（title / detail）" };
  }
  plan.updatedAt = now;
  return { ok: true, changed };
}

/**
 * 层级的显示名。树渲染、检查点提示、命令回执都用它，保证几处称呼一致。
 *
 * @param level - `goal` / `task` / `step`。
 * @returns 中文称呼。
 */
export function levelLabel(level) {
  if (level === "goal") return "目标";
  if (level === "task") return "任务";
  return "子任务";
}

/**
 * 注入消息里的层级称呼。树渲染走 `levelLabel`（目标 / 任务 / 子任务），
 * 注入消息里 L3 一律叫"步骤"。
 */
const NOTICE_WORD = { goal: "目标", task: "任务", step: "步骤" };

/**
 * 节点在注入消息里的自称：目标不带标题，其余带「标题」。
 *
 * @param level - `goal` / `task` / `step`。
 * @param node - 节点。
 * @returns 自称文本。
 */
function subject(level, node) {
  return level === "goal" ? `目标${node.id}` : `${NOTICE_WORD[level]}「${node.title}」${node.id}`;
}

/**
 * 一条完成通告：这个节点做完了、过程归档了。
 *
 * 末尾**不带标点**——调用方按需要在后面接"，"或"。"再拼下一步提示。
 * 不重复提交内容：`result` 就在这次 `tree_task_done` 调用的参数里，再抄一遍是白占位置。
 *
 * @param level - `goal` / `task` / `step`。
 * @param node - 节点。
 * @returns 通告文本。
 */
export function doneNotice(level, node) {
  const self = subject(level, node);
  if (node.status !== STATUS.DONE) return `${self}已被丢弃`;
  return `${self}已经完成，执行过程已归档`;
}

/** 注入消息与 `tree_task_done` 结果共用的抬头。 */
export const NOTICE_PREFIX = "tree_task消息：";

/**
 * `tree_task_done` 的返回内容：下一步该干什么。
 *
 * 提示走工具结果本身，不再另外伪造一条用户消息；"哪个节点完成了、过程已归档"
 * 由折叠落下的那条通告负责。两者合起来才是一条完整的话，所以这里只给后半句。
 *
 * @param plan - 计划树。
 * @returns 返回文本。
 */
export function doneReply(plan) {
  return `${NOTICE_PREFIX}${renderContinue(plan)}`;
}

/**
 * 检查点那句话：这一层的下一级都结束了，是收尾还是再补几个。
 *
 * @param checkpoint - `checkpointOf(plan)` 的结果。
 * @returns 检查点文本。
 */
function checkpointNote(checkpoint) {
  const level = checkpoint.level;
  const childWord = level === "goal" ? "任务" : "步骤";
  const self = subject(level, checkpoint.node);
  return (
    `检查点：${self} 的${childWord}已全部结束，请确认${self} 是否完成，` +
    `如果完成请调用tree_task_done，如果还需继续，可使用 tree_task_plan 新增${childWord}继续。`
  );
}

/** 节点状态的中文短标记。 */
function mark(node) {
  if (node.status === STATUS.DONE) return "[x]";
  if (node.status === STATUS.DROPPED) return "[-]";
  return "[ ]";
}

/** 结果取首行，超长截断——树上只报"产出了什么"，全文在上下文里的汇总消息里。 */
function firstLine(text, limit = 120) {
  const line = String(text ?? "").split("\n")[0].trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * 把整棵树渲染成给模型看的文本。
 *
 * @param plan - 计划树；null 表示还没有计划。
 * @returns 多行文本。
 */
export function renderTree(plan) {
  const goals = goalsOf(plan);
  if (goals.length === 0) return "（还没有计划。先用 tree_task_create 建立目标与任务。）";
  const active = activePath(plan);
  const checkpoint = checkpointOf(plan);
  const lines = [];

  for (const goal of goals) {
    lines.push(`${mark(goal)} 目标  ${goal.id}  ${goal.title}`);
    if (goal.detail) lines.push(`       ${goal.detail}`);
    if (goal.result) lines.push(`       结果: ${firstLine(goal.result.text)}`);

    for (const task of goal.tasks ?? []) {
      const taskHere = active?.task?.id === task.id || checkpoint?.node?.id === task.id;
      lines.push(`  ${mark(task)} 任务  ${task.id}  ${task.title}${taskHere ? " ← 当前" : ""}`);
      if (task.result) lines.push(`        结果: ${firstLine(task.result.text)}`);
      const steps = task.steps ?? [];
      if (steps.length === 0 && isOpen(task)) {
        lines.push("        （还没有子节点 → 调用 tree_task_plan）");
      }
      for (const step of steps) {
        lines.push(`    ${mark(step)} 子任务  ${step.id}  ${step.title}${active?.step?.id === step.id ? " ← 当前" : ""}`);
        if (step.result) lines.push(`          结果: ${firstLine(step.result.text)}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * 注入消息里的收尾提示。它接在完成通告后面，所以自带前置标点（`lead`）。
 *
 * 三种落点：还有同级就报下一个；同级到头就进检查点；整棵树完了就让汇报。
 *
 * @param plan - 计划树。
 * @returns `{ lead, text }`；`lead` 是要接在通告末尾的标点。
 */
export function continueNote(plan) {
  const checkpoint = checkpointOf(plan);
  if (checkpoint !== null) return { lead: "。", text: checkpointNote(checkpoint) };

  const active = activePath(plan);
  if (active === null) return { lead: "，", text: "请汇报最终结果。" };

  if (active.step !== null) {
    return {
      lead: "，",
      text: `接下来需要进行步骤：「${active.step.title}」(${active.step.id})。`,
    };
  }

  if (active.task !== null) {
    return {
      lead: "，",
      text: `接下来需要进行任务：「${active.task.title}」(${active.task.id})。`,
    };
  }

  // 目标下面还没拆任务，或者刚从上一个目标轮到这一个。
  return {
    lead: "，",
    text: `接下来需要进行目标：「${active.goal.title}」(${active.goal.id})。`,
  };
}

/**
 * 同一句话独立成句。自动续行那边没有完成通告可接，直接用 `text`。
 *
 * @param plan - 计划树。
 * @returns 指令文本。
 */
export function renderContinue(plan) {
  return continueNote(plan).text;
}
