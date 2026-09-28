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
export function createPlan(input, now = Date.now()) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  if (tasks.length === 0) {
    throw new Error("至少要有一个任务；请在 tasks 里给出");
  }
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    goal: {
      id: newId("g"),
      title: normalizeTitle(input?.title, "(未命名目标)"),
      detail: String(input?.detail ?? ""),
      status: STATUS.PENDING,
      createdAt: now,
      completedAt: null,
      result: null,
      tasks: tasks.map((task) => makeTask(task, now)),
    },
  };
}

/**
 * 按 id 找节点，并给出它在树里的位置。
 *
 * @param plan - 计划树。
 * @param id - 节点 id（目标 / 任务 / 子任务都可以）。
 * @returns `{ level, goal, task, step, node }`，找不到返回 null。
 */
export function findNode(plan, id) {
  const goal = plan?.goal;
  if (!goal) return null;
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
  const goal = plan?.goal;
  if (!goal || !isOpen(goal)) return null;
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
  const goal = plan?.goal;
  if (!goal || !isOpen(goal)) return null;

  const tasks = goal.tasks ?? [];
  const openTask = tasks.find(isOpen);

  if (openTask === undefined) {
    // 目标下已经没有未结束的任务，但目标自己还开着。
    return tasks.length > 0 ? { level: "goal", goal, task: null, step: null, node: goal } : null;
  }

  const steps = openTask.steps ?? [];
  if (steps.length === 0) return null;
  if (steps.some(isOpen)) return null;
  return { level: "task", goal, task: openTask, step: null, node: openTask };
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
 * 丢弃一个节点。丢弃任务会连同它的子任务一起丢弃。
 *
 * 改需求就用这个丢弃 + `tree_task_plan` 追加新子节点，旧节点留在树里可查。
 *
 * @param plan - 计划树。
 * @param id - 节点 id。
 * @param now - 时间戳。
 * @returns `{ ok, reason?, dropped?, active?, checkpoint? }`。
 */
export function dropNode(plan, id, now = Date.now()) {
  const found = findNode(plan, id);
  if (!found) return { ok: false, reason: `找不到节点 ${id}` };
  if (found.level === "goal") {
    return { ok: false, reason: "不能丢弃整个目标；请用 tree_task_create 重建计划" };
  }

  const dropped = [`${levelLabel(found.level)}「${found.node.title}」`];
  found.node.status = STATUS.DROPPED;
  for (const step of found.node.steps ?? []) {
    if (!isClosed(step)) {
      step.status = STATUS.DROPPED;
      dropped.push(`子任务「${step.title}」`);
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

/** 检查点那句话：把判断权交还给模型，不假装替它规定了出路。 */
function checkpointNote(checkpoint) {
  const label = levelLabel(checkpoint.level);
  return (
    `${label}「${checkpoint.node.title}」的子节点已全部结束，转入检查点。` +
    `此刻轮到你的判断：用 tree_task_plan 继续给 ${checkpoint.node.id} 拆子节点，` +
    `或者用 tree_task_done(id="${checkpoint.node.id}", result="…") 提交这个${label}的结果并完成它。`
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
  if (!plan?.goal) return "（还没有计划。先用 tree_task_create 建立目标与任务。）";
  const active = activePath(plan);
  const checkpoint = checkpointOf(plan);
  const lines = [];
  const goal = plan.goal;

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
  return lines.join("\n");
}

/**
 * 生成"接下来做什么"的指令文本，给自动续行用。
 *
 * @param plan - 计划树。
 * @returns 指令文本；整棵树已结束时说明已经做完。
 */
export function renderContinue(plan) {
  const checkpoint = checkpointOf(plan);
  if (checkpoint !== null) {
    const label = levelLabel(checkpoint.level);
    return [
      `检查点：${label}「${checkpoint.node.title}」(${checkpoint.node.id}) 的子节点已全部结束。`,
      `此刻轮到你的判断：用 tree_task_plan 继续给 ${checkpoint.node.id} 拆子节点，` +
        `或者用 tree_task_done(id="${checkpoint.node.id}", result="…") 提交这个${label}的结果并完成它。`,
    ].join("\n");
  }

  const active = activePath(plan);
  if (active === null) {
    return "计划树上的所有节点都已完成。请向用户汇报最终结果，不要再调用 tree_task_* 工具。";
  }

  if (active.task !== null && active.step === null) {
    return `当前任务「${active.task.title}」(${active.task.id}) 还没有子节点。请调用 tree_task_plan 为它列出子任务，然后开始执行第一个。`;
  }

  if (active.step !== null) {
    const step = active.step;
    return [
      `请继续执行下一个子任务。`,
      `当前子任务：${step.id}「${step.title}」${step.detail ? ` —— ${step.detail}` : ""}`,
      `做完之后调用 tree_task_done(id="${step.id}", result="…")，在 result 里写清它产出了什么。`,
    ].join("\n");
  }

  return `请继续推进任务「${active.task?.title ?? "(未知)"}」。`;
}
