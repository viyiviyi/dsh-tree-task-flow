/**
 * region.js 的折叠行为自测。
 *
 * 假 session 忠实复刻 DSH 的三条硬规则，否则测出来的东西不算数：
 *
 *   1. `replace` 用 `nodes.splice(startIdx, count, seq)` —— **保持位置**，
 *      所以 surface 的 seq 不递增。
 *   2. 起止 seq 必须都能在 surface 上按 `indexOf` 找到，且都在本次事件之前。
 *   3. `sourceEventSeqs` 必须覆盖每一个被遮蔽的 surface 节点，少一个就抛。
 *
 * 跑：node verify-region.mjs
 */

import { addChildren, addGoal, activePath, checkpointOf, complete, createPlan, dropNode } from "./lib/plan.js";
import { closedFrom, foldFinishedLevels, syncCursors } from "./lib/region.js";

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const warnings = [];
const ctx = { logger: { warn: (...parts) => warnings.push(parts.join(" ")) } };

/** 假 session：位置顺序的 surface + 与 DSH 一致的校验。 */
function makeSession(id = "session-test") {
  const events = [];
  const nodes = [];
  let next = 0;

  function append(type, data, opts) {
    const o = opts ?? {};
    const seq = next;
    next += 1;
    const op = o.surfaceOp;

    if (op === undefined) {
      events[seq] = { type, data };
      return { seq, type, data };
    }
    if (op === "append") {
      nodes.push(seq);
    } else {
      if (op.startSeq >= seq || op.endSeq >= seq) {
        throw new Error(`startSeq/endSeq must reference earlier events (seq ${seq})`);
      }
      const startIdx = nodes.indexOf(op.startSeq);
      if (startIdx === -1) throw new Error(`start seq ${op.startSeq} not found in surface`);
      const endIdx = nodes.indexOf(op.endSeq);
      if (endIdx === -1) throw new Error(`end seq ${op.endSeq} not found in surface`);
      if (startIdx > endIdx) throw new Error(`start ${op.startSeq} (index ${startIdx}) is after end ${op.endSeq} (index ${endIdx})`);
      const shadowed = nodes.slice(startIdx, endIdx + 1);
      const sources = new Set(o.sourceEventSeqs ?? []);
      const missing = shadowed.filter((s) => !sources.has(s));
      if (missing.length > 0) {
        throw new Error(`sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
      }
      nodes.splice(startIdx, endIdx - startIdx + 1, seq);
    }
    events[seq] = { type, data, surfaceOp: op, sourceEventSeqs: o.sourceEventSeqs };
    return { seq, type, data };
  }

  return {
    id,
    get surface() {
      return { nodes: [...nodes] };
    },
    eventAt(seq) {
      return events[seq];
    },
    append,
    /** 测试用：当前 surface 的 seq（位置顺序）。 */
    live: () => [...nodes],
    /** 测试用：把一个节点移出 surface，模拟压缩把它遮掉。 */
    shadowOut(seq) {
      const idx = nodes.indexOf(seq);
      if (idx === -1) throw new Error(`shadowOut: ${seq} not on surface`);
      nodes.splice(idx, 1);
    },
  };
}

function textOf(event) {
  if (!event) return "";
  const d = event.data ?? {};
  const message = d.message ?? d;
  return (message.content ?? []).map((block) => block.text ?? "").join("");
}

/** 落到 surface 上的摘要行，用来人工核对。 */
function surfaceLines(session) {
  return session.live().map((seq) => {
    const event = session.eventAt(seq);
    const text = textOf(event);
    const plugin = event?.data?.source?.plugin ?? event?.data?.message?.source?.plugin ?? "-";
    return `#${seq} ${event?.type} [${plugin}] ${text.slice(0, 40).replace(/\n/gu, " ")}`;
  });
}

/** 模拟一段执行过程：assistant 消息 + 工具结果。 */
function work(session, rounds) {
  for (let index = 0; index < rounds; index += 1) {
    session.append("assistant/message", { message: { content: [{ type: "text", text: `执行第 ${index} 轮` }] } }, { surfaceOp: "append" });
    session.append("tool/result", { message: { content: [{ type: "text", text: `工具结果 ${index}` }] } }, { surfaceOp: "append" });
  }
}

function newCursors(sessionId) {
  return { sessionId, goal: null, task: null, step: null, updatedAt: null };
}

function boot(session) {
  session.append("system/message", { message: { content: [{ type: "text", text: "系统提示词" }] } }, { surfaceOp: "append" });
  session.append("user/message", { content: [{ type: "text", text: "用户消息" }] }, { surfaceOp: "append" });
}

/** 造一棵三级齐全的树：目标 A / 任务1（子1 子2 子3）+ 任务2。 */
function makeTree() {
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }, { title: "任务2" }] }, 1000);
  const [goal] = plan.goals;
  const [task1, task2] = goal.tasks;
  addChildren(plan, task1.id, [{ title: "子1" }, { title: "子2" }, { title: "子3" }], 1000);
  const [step1, step2, step3] = task1.steps;
  return { plan, goal, task1, task2, step1, step2, step3 };
}

/** 走一次 pre-step：先折叠，再对齐游标。 */
function step(session, cursors, plan, now) {
  const active = activePath(plan);
  const folded = foldFinishedLevels(ctx, session, cursors, plan, active);
  const synced = syncCursors(session, cursors, active);
  if (folded || synced) cursors.updatedAt = now;
  return active;
}

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 同级折叠不碰上一条汇总");
{
  const { plan, step1, step2 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  // 进入子1：立游标
  step(session, cursors, plan, 1000);
  check("进入子1时三层游标都立在入口边界", cursors.goal?.cursor === 1 && cursors.task?.cursor === 1 && cursors.step?.cursor === 1,
    JSON.stringify({ goal: cursors.goal, task: cursors.task, step: cursors.step }));

  // 子1 干完活 → 完成 → 折叠
  work(session, 3);
  complete(plan, step1.id, "子1 的结果", 1100);
  step(session, cursors, plan, 1100);

  const afterFirst = session.live();
  const foldA = afterFirst[afterFirst.length - 1];
  check("子1 的执行过程被折叠成一条汇总", afterFirst.length === 3, `surface = ${JSON.stringify(afterFirst)}`);
  check("汇总报出子1已完成、过程已归档",
    textOf(session.eventAt(foldA)).includes("步骤「子1」") &&
      textOf(session.eventAt(foldA)).includes("已经完成，执行过程已归档"));
  check("游标停在刚落下的汇总上", cursors.step?.cursor === foldA, `cursor=${cursors.step?.cursor} fold=${foldA}`);
  check("任务级游标没有被推动", cursors.task?.cursor === 1, `task.cursor=${cursors.task?.cursor}`);

  // 子2 干完活 → 完成 → 折叠
  work(session, 2);
  complete(plan, step2.id, "子2 的结果", 1200);
  step(session, cursors, plan, 1200);

  const afterSecond = session.live();
  const foldB = afterSecond[afterSecond.length - 1];
  check("上一条汇总仍在 surface 上", afterSecond.includes(foldA), `surface = ${JSON.stringify(afterSecond)}`);
  check("子1的汇总没有被清空或改写", textOf(session.eventAt(foldA)).includes("步骤「子1」"));
  check("子2 的汇总另起一条",
    foldB !== foldA &&
      textOf(session.eventAt(foldB)).includes("步骤「子2」") &&
      textOf(session.eventAt(foldB)).includes("已经完成"));
  check("两次折叠后 surface 恰好是 入口 + 两条汇总", afterSecond.length === 4, `surface = ${JSON.stringify(afterSecond)}`);

  console.log("  surface:");
  for (const line of surfaceLines(session)) console.log(`    ${line}`);
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 三级边界各自正确");
{
  const { plan, task1, step1, step2, step3 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  const goalCursor = cursors.goal.cursor;

  // 三个子任务依次完成，每次折叠
  for (const [index, target] of [step1, step2, step3].entries()) {
    work(session, 1);
    complete(plan, target.id, `${target.title} 的结果`, 1100 + index);
    step(session, cursors, plan, 1100 + index);
  }

  const afterSteps = session.live();
  check("三条子任务汇总都在", afterSteps.length === 5, `surface = ${JSON.stringify(afterSteps)}`);
  check("任务级游标仍然停在入口边界", cursors.task?.cursor === 1, `task.cursor=${cursors.task?.cursor}`);

  // 任务1 完成 → 折叠任务层
  work(session, 2);
  complete(plan, task1.id, "任务1 的结果", 1300);
  step(session, cursors, plan, 1300);

  const afterTask = session.live();
  const taskFold = afterTask[afterTask.length - 1];
  check("任务折叠把三条子任务汇总一起收走", afterTask.length === 3, `surface = ${JSON.stringify(afterTask)}`);
  check("落下的是一条任务级通告",
    textOf(session.eventAt(taskFold)).includes("任务「任务1」") &&
      textOf(session.eventAt(taskFold)).includes("已经完成，执行过程已归档"));
  check("折叠掉的区间包含全部子任务汇总", !afterTask.some((seq) => textOf(session.eventAt(seq)).includes("步骤「子1」")));
  check("目标级游标没有被推动", cursors.goal?.cursor === goalCursor, `goal.cursor=${cursors.goal?.cursor} expected=${goalCursor}`);
  check("任务级游标更新为任务汇总", cursors.task?.cursor === taskFold, `task.cursor=${cursors.task?.cursor}`);

  console.log("  surface:");
  for (const line of surfaceLines(session)) console.log(`    ${line}`);
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 一次完成多个节点合并成一条");
{
  const { plan, step1, step2 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  work(session, 2);

  // 一轮里连着完成两个子任务
  complete(plan, step1.id, "子1 的结果", 1100);
  complete(plan, step2.id, "子2 的结果", 1101);
  step(session, cursors, plan, 1101);

  const after = session.live();
  check("两个子任务合成一条汇总", after.length === 3, `surface = ${JSON.stringify(after)}`);
  const merged = textOf(session.eventAt(after[after.length - 1]));
  check("合并的汇总同时报出两个步骤",
    merged.includes("步骤「子1」") && merged.includes("步骤「子2」") && merged.includes("已经完成"));
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 游标失效");
{
  const { plan, task1, step1 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  work(session, 2);
  complete(plan, step1.id, "子1 的结果", 1100);
  step(session, cursors, plan, 1100);

  const beforeStep4 = session.live();
  check("场景 4 前置：子1 已折叠", beforeStep4.length === 3, `surface = ${JSON.stringify(beforeStep4)}`);

  // 游标指向的节点被压缩遮掉
  const lost = cursors.step.cursor;
  session.shadowOut(lost);
  work(session, 1);
  complete(plan, task1.steps[1].id, "子2 的结果", 1200);
  step(session, cursors, plan, 1200);

  const after = session.live();
  const appended = after[after.length - 1];
  check("游标失效时仍落下一段通告",
    textOf(session.eventAt(appended)).includes("步骤「子2」") &&
      textOf(session.eventAt(appended)).includes("执行过程已归档"),
    `surface = ${JSON.stringify(after)}；末节点文本=${JSON.stringify(textOf(session.eventAt(appended)).slice(0, 60))}`);
  check("游标失效时不抛异常、不阻断会话", warnings.length === 0, `warnings=${JSON.stringify(warnings)}`);
  check("失效的游标被重新对齐到 surface 上", after.includes(cursors.step?.cursor), `cursor=${cursors.step?.cursor} surface=${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 汇总只报归档，「下一步」交给 tree_task_done 的结果");
{
  const { plan, task1, step1, step2, step3 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  const summaries = [];
  for (const [index, target] of [step1, step2, step3].entries()) {
    work(session, 1);
    complete(plan, target.id, `${target.title} 的结果`, 1100 + index);
    step(session, cursors, plan, 1100 + index);
    const live = session.live();
    summaries.push(textOf(session.eventAt(live[live.length - 1])));
  }

  check("汇总只报归档，不替 done 的结果说下一步",
    summaries[0].startsWith("tree_task消息：") &&
      summaries[0].includes(`步骤「${step1.title}」`) &&
      summaries[0].includes("执行过程已归档") &&
      !summaries[0].includes("接下来需要进行"),
    `第1条汇总=${JSON.stringify(summaries[0].slice(0, 160))}`);

  const lastText = summaries[summaries.length - 1];
  check("检查点不进汇总（它在 done 的返回里）",
    lastText.includes("步骤「子3」") && !lastText.includes("检查点"),
    `末条汇总=${JSON.stringify(lastText.slice(0, 160))}`);

  const checkpoint = checkpointOf(plan);
  check("检查点落在任务1上", checkpoint?.node?.id === task1.id, JSON.stringify(checkpoint?.node?.id));
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · 丢弃的节点与完成的节点合进同一条汇总");
{
  const { plan, step1, step2 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  work(session, 1);

  complete(plan, step1.id, "子1 的结果", 1100);
  dropNode(plan, step2.id, 1101);
  step(session, cursors, plan, 1101);

  const after = session.live();
  check("完成与丢弃合并成一条汇总", after.length === 3, `surface = ${JSON.stringify(after)}`);
  const text = textOf(session.eventAt(after[after.length - 1]));
  check("汇总同时记录完成与丢弃", text.includes("步骤「子1」") && text.includes("已被丢弃"),
    JSON.stringify(text.slice(0, 120)));
}

// ---------------------------------------------------------------- 场景 7

console.log("\n场景 7 · 刚调完的 tree_task_done 不被折叠卷走");
{
  const { plan, step1 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  work(session, 2);

  // 模拟一次 tree_task_done：assistant/message（里面是这次 tool-call）+ tool/result
  const callSeq = session.append(
    "assistant/message",
    {
      message: {
        content: [{ type: "tool-call", id: "call_1", name: "tree_task_done", arguments: "{}" }],
      },
    },
    { surfaceOp: "append" },
  ).seq;
  const resultSeq = session.append(
    "tool/result",
    {
      message: {
        content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "tree_task消息：接下来需要进行步骤：「子2」(s-2)。" }] }],
      },
    },
    { surfaceOp: "append" },
  ).seq;

  complete(plan, step1.id, "子1 的结果", 1100);
  step(session, cursors, plan, 1100);

  const after = session.live();
  const noticeSeq = after[after.indexOf(callSeq) - 1];
  check("done 调用与它的结果都留在表层上",
    after.includes(callSeq) && after.includes(resultSeq),
    `surface = ${JSON.stringify(after)}`);
  check("落下的通告排在 done 调用之前，且带着这次完成",
    noticeSeq !== undefined &&
      after.indexOf(noticeSeq) < after.indexOf(callSeq) &&
      textOf(session.eventAt(noticeSeq)).includes("步骤「子1」") &&
      textOf(session.eventAt(noticeSeq)).includes("已经完成，执行过程已归档"),
    `notice=${noticeSeq} call=${callSeq} surface=${JSON.stringify(after)}`);
  check("提示（done 的结果）还在表层上可读",
    JSON.stringify(session.eventAt(resultSeq)).includes("接下来需要进行步骤"));
  check("折叠后游标停在刚落下的通告上（不是末尾的 done 调用）",
    cursors.step?.cursor === noticeSeq,
    `cursor=${cursors.step?.cursor} notice=${noticeSeq} result=${resultSeq}`);
}

// ---------------------------------------------------------------- 场景 8

console.log("\n场景 8 · 全树完成后再开新树：不回头折叠旧对话");
{
  const old = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  // 走完整棵旧树
  step(session, cursors, old.plan, 1000);
  for (const [index, target] of [old.step1, old.step2, old.step3].entries()) {
    work(session, 1);
    complete(old.plan, target.id, `${target.title} 的结果`, 1100 + index);
    step(session, cursors, old.plan, 1100 + index);
  }
  work(session, 1);
  complete(old.plan, old.task1.id, "任务1 的结果", 1200);
  step(session, cursors, old.plan, 1200);
  work(session, 1);
  complete(old.plan, old.task2.id, "任务2 的结果", 1300);
  step(session, cursors, old.plan, 1300);
  work(session, 1);
  complete(old.plan, old.goal.id, "目标的结果", 1400);
  step(session, cursors, old.plan, 1400);

  check("整棵树结束后三层游标都清空",
    cursors.goal === null && cursors.task === null && cursors.step === null,
    JSON.stringify(cursors));

  const oldTail = session.live().at(-1);

  // 用户提新需求，模型建了一棵新树（tree_task_create 替换计划）
  const askSeq = session.append(
    "user/message",
    { content: [{ type: "text", text: "再加一件事" }] },
    { surfaceOp: "append" },
  ).seq;
  const createCall = session.append(
    "assistant/message",
    { message: { content: [{ type: "tool-call", id: "c2", name: "tree_task_create", arguments: "{}" }] } },
    { surfaceOp: "append" },
  ).seq;
  const createResult = session.append(
    "tool/result",
    { message: { content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "计划已建立。" }] }] } },
    { surfaceOp: "append" },
  ).seq;

  const fresh = createPlan({ title: "第二个目标", tasks: [{ title: "新任务" }] }, 2000);
  step(session, cursors, fresh, 2000);
  check("新目标的游标立在建树那一刻之后",
    cursors.goal?.cursor === createResult,
    `cursor=${cursors.goal?.cursor} want=${createResult}`);

  // 新目标里拆一步、做完，看这次折叠收的是哪一段
  const [newTask] = fresh.goals[0].tasks;
  addChildren(fresh, newTask.id, [{ title: "新步骤" }], 2000);
  work(session, 1);
  step(session, cursors, fresh, 2000);
  work(session, 1);
  complete(fresh, newTask.steps[0].id, "新步骤的结果", 2100);
  step(session, cursors, fresh, 2100);

  const after = session.live();
  const notice = after
    .filter((seq) => textOf(session.eventAt(seq)).includes("已经完成，执行过程已归档"))
    .at(-1);
  check("旧目标的收尾通告还在表层上", after.includes(oldTail), `surface = ${JSON.stringify(after)}`);
  check("用户的新需求还在表层上", after.includes(askSeq), `surface = ${JSON.stringify(after)}`);
  check("新建树的那次调用也还在", after.includes(createCall) && after.includes(createResult));
  check("新折叠只报新目标这一段的完成",
    notice !== undefined &&
      textOf(session.eventAt(notice)).includes("步骤「新步骤」") &&
      !textOf(session.eventAt(notice)).includes("验证"),
    `notice=${notice} text=${JSON.stringify(textOf(session.eventAt(notice ?? -1)).slice(0, 90))}`);
}

// ---------------------------------------------------------------- 场景 9

console.log("\n场景 9 · 目标层的兄弟折叠");
{
  const old = makeTree();
  const second = addGoal(old.plan, { title: "第二个目标", tasks: [{ title: "新任务" }] }, 2000);

  complete(old.plan, old.step1.id, "子1 的结果", 1100);
  complete(old.plan, old.step2.id, "子2 的结果", 1101);
  complete(old.plan, old.step3.id, "子3 的结果", 1102);
  complete(old.plan, old.task1.id, "任务1 的结果", 1200);
  complete(old.plan, old.task2.id, "任务2 的结果", 1300);
  complete(old.plan, old.goal.id, "第一个目标的结果", 1400);

  const closed = closedFrom(old.plan, "goal", old.goal.id);
  check("收的是已经结束的那个目标", closed.length === 1 && closed[0].id === old.goal.id,
    JSON.stringify(closed.map((each) => each.id)));
  check("后面还开着的目标不在里面", !closed.some((each) => each.id === second.id));
  check("目标层用同一套兄弟逻辑", closedFrom(old.plan, "goal", second.id).length === 0);
}

// ---------------------------------------------------------------- 场景 10

console.log("\n场景 10 · 折叠范围只覆盖刚结束的那一段");
{
  const plan = createPlan(
    { title: "目标", tasks: [{ title: "任务甲" }, { title: "任务乙" }, { title: "任务丙" }] },
    1000,
  );
  const [taskA, taskB] = plan.goals[0].tasks;
  addChildren(plan, taskA.id, [{ title: "A1" }], 1000);
  addChildren(plan, taskB.id, [{ title: "B1" }], 1000);

  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);
  step(session, cursors, plan, 1000);

  // 任务甲：先做完 A1，再收尾甲
  work(session, 2);
  complete(plan, taskA.steps[0].id, "A1 的结果", 1100);
  step(session, cursors, plan, 1100);
  const foldA1 = session.live().at(-1);
  const maskedA1 = session.eventAt(foldA1).sourceEventSeqs ?? [];

  work(session, 2);
  complete(plan, taskA.id, "甲的结果", 1200);
  step(session, cursors, plan, 1200);
  const foldTaskA = session.live().at(-1);
  const maskedA = session.eventAt(foldTaskA).sourceEventSeqs ?? [];

  // 任务乙：做完 B1
  work(session, 2);
  complete(plan, taskB.steps[0].id, "B1 的结果", 1300);
  step(session, cursors, plan, 1300);
  const foldB1 = session.live().at(-1);
  const maskedB = session.eventAt(foldB1).sourceEventSeqs ?? [];

  check("收尾任务甲时，只收甲这一段（含 A1 的汇总）",
    maskedA.includes(foldA1),
    JSON.stringify({ masked: maskedA, foldA1 }));
  check("甲汇总自己的那次折叠不含它自己（游标留在范围外）",
    !maskedA1.includes(foldA1) && maskedA1.length > 0,
    JSON.stringify({ masked: maskedA1, foldA1 }));
  check("轮到任务乙时，甲的汇总不在遮蔽清单里",
    !maskedB.includes(foldTaskA),
    JSON.stringify({ masked: maskedB, foldTaskA }));
  check("甲的汇总仍然留在表层上", session.live().includes(foldTaskA));
  check("乙的这次只收乙这一段（不含自己刚落下的通告）",
    maskedB.length > 0 && !maskedB.includes(foldB1) && !maskedB.includes(foldTaskA),
    JSON.stringify({ masked: maskedB, foldB1, foldTaskA }));
}

// ---------------------------------------------------------------- 场景 11

console.log("\n场景 11 · 留着的那次 done 调用，下一轮就被收走");
{
  const { plan, step1, step2 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);
  step(session, cursors, plan, 1000);

  /** 做一次 tree_task_done：假调用 + 完成 + 走一次 pre-step。 */
  const doneOnce = (id, text, now) => {
    work(session, 1);
    const call = session.append(
      "assistant/message",
      { message: { content: [{ type: "tool-call", id: "call_1", name: "tree_task_done", arguments: "{}" }] } },
      { surfaceOp: "append" },
    ).seq;
    const result = session.append(
      "tool/result",
      { message: { content: [{ type: "tool-result", toolCallId: "call_1", content: [] }] } },
      { surfaceOp: "append" },
    ).seq;
    complete(plan, id, text, now);
    step(session, cursors, plan, now);
    return { call, result };
  };

  const first = doneOnce(step1.id, "子1 的结果", 1100);
  check("第一次折叠后，这次调用与它的返回都还在",
    session.live().includes(first.call) && session.live().includes(first.result),
    `surface=${JSON.stringify(session.live())}`);

  const second = doneOnce(step2.id, "子2 的结果", 1200);
  const live = session.live();
  const notice = live[live.indexOf(second.call) - 1];
  const masked = session.eventAt(notice).sourceEventSeqs ?? [];
  check("第二次折叠把上一轮留着的那次调用收走了",
    masked.includes(first.call) && masked.includes(first.result),
    JSON.stringify({ masked, first }));
  check("当次这次调用仍然留在表层上",
    session.live().includes(second.call) && session.live().includes(second.result),
    `surface=${JSON.stringify(session.live())}`);
  check("所以它们不会一轮轮累积下去",
    !session.live().includes(first.call) && !session.live().includes(first.result));
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
