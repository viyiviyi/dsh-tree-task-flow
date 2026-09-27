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

import { addChildren, activePath, checkpointOf, complete, createPlan, dropNode } from "./lib/plan.js";
import { foldFinishedLevels, syncCursors } from "./lib/region.js";

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
  const goal = plan.goal;
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
  check("汇总携带子1提交的结果", textOf(session.eventAt(foldA)).includes("子1 的结果"));
  check("游标停在刚落下的汇总上", cursors.step?.cursor === foldA, `cursor=${cursors.step?.cursor} fold=${foldA}`);
  check("任务级游标没有被推动", cursors.task?.cursor === 1, `task.cursor=${cursors.task?.cursor}`);

  // 子2 干完活 → 完成 → 折叠
  work(session, 2);
  complete(plan, step2.id, "子2 的结果", 1200);
  step(session, cursors, plan, 1200);

  const afterSecond = session.live();
  const foldB = afterSecond[afterSecond.length - 1];
  check("上一条汇总仍在 surface 上", afterSecond.includes(foldA), `surface = ${JSON.stringify(afterSecond)}`);
  check("子1的汇总没有被清空或改写", textOf(session.eventAt(foldA)).includes("子1 的结果"));
  check("子2 的汇总另起一条", foldB !== foldA && textOf(session.eventAt(foldB)).includes("子2 的结果"));
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
  check("落下的是一条任务级汇总", textOf(session.eventAt(taskFold)).includes("任务1 的结果"));
  check("折叠掉的区间包含全部子任务汇总", !afterTask.some((seq) => textOf(session.eventAt(seq)).includes("子1 的结果")));
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
  check("合并的汇总同时含两个结果", merged.includes("子1 的结果") && merged.includes("子2 的结果"));
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
  check("游标失效时仍落下一段汇总（结果不能丢）",
    textOf(session.eventAt(appended)).includes("子2 的结果"),
    `surface = ${JSON.stringify(after)}；末节点文本=${JSON.stringify(textOf(session.eventAt(appended)).slice(0, 60))}`);
  check("游标失效时不抛异常、不阻断会话", warnings.length === 0, `warnings=${JSON.stringify(warnings)}`);
  check("失效的游标被重新对齐到 surface 上", after.includes(cursors.step?.cursor), `cursor=${cursors.step?.cursor} surface=${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 检查点提示随汇总一起落下");
{
  const { plan, task1, step1, step2, step3 } = makeTree();
  const session = makeSession();
  boot(session);
  const cursors = newCursors(session.id);

  step(session, cursors, plan, 1000);
  for (const [index, target] of [step1, step2, step3].entries()) {
    work(session, 1);
    complete(plan, target.id, `${target.title} 的结果`, 1100 + index);
    step(session, cursors, plan, 1100 + index);
  }

  const after = session.live();
  const lastText = textOf(session.eventAt(after[after.length - 1]));
  check("最后一个子任务完成时，汇总里带检查点提示", lastText.includes("检查点") || lastText.includes("tree_task_plan"),
    `末条汇总=${JSON.stringify(lastText.slice(0, 120))}`);

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
  check("汇总同时记录完成与丢弃", text.includes("子1 的结果") && text.includes("已丢弃"),
    JSON.stringify(text.slice(0, 120)));
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
