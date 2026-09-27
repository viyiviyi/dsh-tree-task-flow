/**
 * plan.js 的纯逻辑自测。
 *
 * 计划树不碰 DSH、不碰磁盘，所以这一层可以在插件目录直接跑，不需要任何宿主包。
 * 覆盖：建树、activePath 推导、完成与结果、检查点判定、丢弃级联、修改、渲染。
 *
 * 跑法：`node verify-plan.mjs`。
 */

import { addChildren, activePath, checkpointOf, complete, createPlan, dropNode, findNode, levelLabel, renderContinue, renderTree, updateNode } from "./lib/plan.js";

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

/**
 * 一棵固定的树：目标 + 两个任务，任务 A 下两个子任务，任务 B 下还没拆。
 * 用固定的时间戳，断言时间字段时不必容忍抖动。
 */
function fixture(now = 1_700_000_000_000) {
  const plan = createPlan(
    { title: "目标", tasks: [{ title: "任务A" }, { title: "任务B" }] },
    now,
  );
  const [taskA, taskB] = plan.goal.tasks;
  addChildren(plan, taskA.id, [{ title: "A1" }, { title: "A2" }], now);
  const [a1, a2] = taskA.steps;
  return { plan, goal: plan.goal, taskA, taskB, a1, a2, now };
}

console.log("场景 1 · 建树");

check("一个目标 + 若干任务，状态都是 pending", () => {
  const { plan, goal, taskA, taskB } = fixture();
  return (
    plan.version === 1 &&
    goal.tasks.length === 2 &&
    goal.status === "pending" &&
    taskA.status === "pending" &&
    taskB.status === "pending" &&
    taskA.steps.length === 0
  );
});

check("tasks 为空时拒绝建树", () => {
  let threw = false;
  try {
    createPlan({ title: "目标", tasks: [] });
  } catch {
    threw = true;
  }
  return threw;
});

check("标题留空时给占位而不是空字符串", () => {
  const plan = createPlan({ title: "   ", tasks: [{ title: "" }] });
  return plan.goal.title === "(未命名目标)" && plan.goal.tasks[0].title === "(未命名任务)";
});

check("新节点都带 createdAt，result 为空", () => {
  const { taskA } = fixture();
  return (
    taskA.createdAt === 1_700_000_000_000 &&
    taskA.completedAt === null &&
    taskA.result === null
  );
});

console.log("\n场景 2 · activePath 推导");

check("推导出第一个待办的子任务", () => {
  const { plan, goal, taskA, a1 } = fixture();
  const active = activePath(plan);
  return active.goal.id === goal.id && active.task.id === taskA.id && active.step.id === a1.id;
});

check("当前任务还没拆子任务时，step 为 null", () => {
  const fresh = createPlan({ title: "目标", tasks: [{ title: "光杆任务" }] });
  const active = activePath(fresh);
  return active.goal !== null && active.task !== null && active.step === null;
});

check("目标下没有未结束的任务时，task 为 null", () => {
  const { plan, taskA, taskB, goal } = fixture();
  dropNode(plan, taskA.id);
  dropNode(plan, taskB.id);
  const active = activePath(plan);
  return active !== null && active.goal.id === goal.id && active.task === null;
});

check("一个子任务完成后，activePath 移到下一个", () => {
  const { plan, a1, a2 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  const active = activePath(plan);
  return active.step !== null && active.step.id === a2.id;
});

check("同一任务的两个子任务都完成后，activePath 落到下一个任务", () => {
  const { plan, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  complete(plan, a2.id, "A2 的结果");
  const active = activePath(plan);
  return active.task.id === taskB.id && active.step === null;
});

check("整棵树结束后 activePath 为 null", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A 的结果");
  const b1 = addChildren(plan, taskB.id, [{ title: "B1" }]).added[0];
  complete(plan, b1.id, "B1");
  complete(plan, taskB.id, "任务B 的结果");
  complete(plan, plan.goal.id, "目标的结果");
  return activePath(plan) === null;
});

console.log("\n场景 3 · 完成必须交出结果");

check("完成后记下 status / result / completedAt", () => {
  const { plan, a1, now } = fixture();
  const r = complete(plan, a1.id, "写完了", now + 5);
  return (
    r.ok === true &&
    a1.status === "done" &&
    a1.result.text === "写完了" &&
    a1.result.at === now + 5 &&
    a1.completedAt === now + 5
  );
});

check("result 前后空白被裁掉", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "  正文  ");
  return a1.result.text === "正文";
});

check("空白 result 被拒，且节点状态不变", () => {
  const { plan, a1 } = fixture();
  const r = complete(plan, a1.id, "   \n  ");
  return r.ok === false && a1.status === "pending" && a1.result === null;
});

check("非字符串 result 被拒", () => {
  const { plan, a1 } = fixture();
  return complete(plan, a1.id, { text: "x" }).ok === false && a1.status === "pending";
});

check("重复完成被拒，而不是静默改状态", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "第一次");
  const r = complete(plan, a1.id, "第二次");
  return r.ok === false && a1.result.text === "第一次";
});

check("完成一个已被丢弃的节点被拒", () => {
  const { plan, a1 } = fixture();
  dropNode(plan, a1.id);
  return complete(plan, a1.id, "试试").ok === false && a1.status === "dropped";
});

check("找不到节点时给出理由", () => {
  const { plan } = fixture();
  const r = complete(plan, "s-does-not-exist", "x");
  return r.ok === false && r.reason.includes("s-does-not-exist");
});

check("完成事件里带上层级的称呼", () => {
  const { plan, a1, taskA } = fixture();
  const r1 = complete(plan, a1.id, "x");
  const r2 = complete(plan, taskA.id, "y");
  return r1.events[0].includes("子任务") && r2.events[0].includes("任务");
});

console.log("\n场景 4 · 检查点");

check("从没拆过子节点的任务不是检查点", () => {
  const { plan } = fixture();
  // 活动路径在任务 A 的 A1 上，任务 B 没拆过子节点——但 A 还有待办，不是检查点。
  return checkpointOf(plan) === null;
});

check("子任务还有待办时不是检查点", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "A1");
  return checkpointOf(plan) === null;
});

check("子任务全部结束后转入任务级检查点", () => {
  const { plan, taskA, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  const cp = checkpointOf(plan);
  return cp !== null && cp.level === "task" && cp.node.id === taskA.id;
});

check("检查点只沿活动路径判断，不看后面还没轮到的分支", () => {
  const { plan, taskA } = fixture();
  const { a1, a2 } = { a1: taskA.steps[0], a2: taskA.steps[1] };
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  // 任务 B 还完全没开始，但它不是活动路径，不该影响判定。
  const cp = checkpointOf(plan);
  return cp !== null && cp.node.id === taskA.id;
});

check("目标下任务全结束、目标还开着时，转入目标级检查点", () => {
  const { plan, taskA, taskB, goal, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  dropNode(plan, taskB.id);
  const cp = checkpointOf(plan);
  return cp !== null && cp.level === "goal" && cp.node.id === goal.id;
});

check("整棵树都结束后没有检查点", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, plan.goal.id, "目标");
  return checkpointOf(plan) === null;
});

check("完成事件的末尾带上检查点提示", () => {
  const { plan, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  const r = complete(plan, a2.id, "A2");
  return r.ok === true && r.checkpoint !== null && r.events.some((e) => e.includes("检查点"));
});

console.log("\n场景 5 · 丢弃");

check("丢弃任务会连同它的子任务一起丢弃", () => {
  const { plan, taskA, a1, a2 } = fixture();
  const r = dropNode(plan, taskA.id);
  return (
    r.ok === true &&
    taskA.status === "dropped" &&
    a1.status === "dropped" &&
    a2.status === "dropped" &&
    r.dropped.length === 3
  );
});

check("已经完成的子任务不会被改成丢弃", () => {
  const { plan, taskA, a1 } = fixture();
  complete(plan, a1.id, "A1");
  dropNode(plan, taskA.id);
  return a1.status === "done";
});

check("不能丢弃整个目标", () => {
  const { plan, goal } = fixture();
  const r = dropNode(plan, goal.id);
  return r.ok === false && goal.status === "pending";
});

check("丢弃单个子任务只影响它自己", () => {
  const { plan, a1, a2 } = fixture();
  const r = dropNode(plan, a1.id);
  return r.ok === true && a1.status === "dropped" && a2.status === "pending";
});

check("丢弃后 activePath 跳过它", () => {
  const { plan, a1, a2 } = fixture();
  dropNode(plan, a1.id);
  return activePath(plan).step.id === a2.id;
});

console.log("\n场景 6 · 追加子节点");

check("给目标追加的是任务，给任务追加的是子任务", () => {
  const { plan, goal, taskB } = fixture();
  const added = addChildren(plan, taskB.id, [{ title: "B1" }]);
  const addedTask = addChildren(plan, goal.id, [{ title: "任务C" }]);
  return (
    added.ok === true &&
    added.level === "task" &&
    added.added[0].steps.length === 0 &&
    addedTask.ok === true &&
    addedTask.level === "goal" &&
    addedTask.added[0].steps !== undefined
  );
});

check("子任务是最低一级，不能再拆", () => {
  const { plan, a1 } = fixture();
  const r = addChildren(plan, a1.id, [{ title: "不该存在" }]);
  return r.ok === false && r.reason.includes("最低一级");
});

check("不给子节点时被拒", () => {
  const { plan, taskB } = fixture();
  return addChildren(plan, taskB.id, []).ok === false;
});

check("找不到父节点时被拒", () => {
  const { plan } = fixture();
  return addChildren(plan, "t-nope", [{ title: "x" }]).ok === false;
});

console.log("\n场景 7 · 修改节点");

check("改标题与说明", () => {
  const { plan, a1 } = fixture();
  const r = updateNode(plan, a1.id, { title: "新标题", detail: "新说明" });
  return r.ok === true && a1.title === "新标题" && a1.detail === "新说明" && r.changed.length === 2;
});

check("标题被裁掉前后空白", () => {
  const { plan, a1 } = fixture();
  updateNode(plan, a1.id, { title: "  收窄  " });
  return a1.title === "收窄";
});

check("只给空白标题被拒", () => {
  const { plan, a1 } = fixture();
  const r = updateNode(plan, a1.id, { title: "   " });
  return r.ok === false && a1.title === "A1";
});

check("什么都不给被拒", () => {
  const { plan, a1 } = fixture();
  return updateNode(plan, a1.id, {}).ok === false;
});

check("说明可以改成空字符串", () => {
  const { plan, a1 } = fixture();
  const r = updateNode(plan, a1.id, { detail: "" });
  return r.ok === true && a1.detail === "";
});

console.log("\n场景 8 · 查找与称呼");

check("findNode 给出层级与沿途节点", () => {
  const { plan, goal, taskA, a1 } = fixture();
  const g = findNode(plan, goal.id);
  const s = findNode(plan, a1.id);
  return (
    g.level === "goal" &&
    g.task === null &&
    s.level === "step" &&
    s.task.id === taskA.id &&
    s.step.id === a1.id
  );
});

check("找不到时返回 null", () => {
  const { plan } = fixture();
  return findNode(plan, "x-nope") === null && findNode(null, "x") === null;
});

check("层级称呼固定为 目标 / 任务 / 子任务", () => {
  return levelLabel("goal") === "目标" && levelLabel("task") === "任务" && levelLabel("step") === "子任务";
});

console.log("\n场景 9 · 渲染");

check("没有计划时给出引导而不是抛错", () => {
  const text = renderTree(null);
  return typeof text === "string" && text.includes("tree_task_create");
});

check("树里带上关键节点的 id 与标题", () => {
  const { plan, goal, taskA, a1 } = fixture();
  const text = renderTree(plan);
  return (
    text.includes(goal.id) &&
    text.includes(taskA.id) &&
    text.includes(a1.id) &&
    text.includes("A1") &&
    text.includes("[ ]")
  );
});

check("已完成与已丢弃用不同标记", () => {
  const { plan, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  dropNode(plan, a2.id);
  const text = renderTree(plan);
  return text.includes("[x]") && text.includes("[-]");
});

check("当前节点带「← 当前」标记", () => {
  const { plan, a1 } = fixture();
  const text = renderTree(plan);
  return text.includes(a1.id) && text.includes("← 当前");
});

check("结果只取首行", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "第一行\n第二行");
  const text = renderTree(plan);
  return text.includes("第一行") && !text.includes("第二行");
});

check("结果超长时截断", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "x".repeat(300));
  const text = renderTree(plan);
  return text.includes("…") && !text.includes("x".repeat(200));
});

check("还没拆子节点的任务给出提示", () => {
  const { plan, taskB } = fixture();
  // 让活动路径走到任务 B：把它前面的任务 A 整个收口。
  const { a1, a2, taskA } = { a1: plan.goal.tasks[0].steps[0], a2: plan.goal.tasks[0].steps[1], taskA: plan.goal.tasks[0] };
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  const text = renderTree(plan);
  return text.includes(taskB.id) && text.includes("tree_task_plan");
});

check("renderContinue 在检查点上给出两条路", () => {
  const { plan, a1, a2, taskA } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  const text = renderContinue(plan);
  return (
    text.includes("检查点") &&
    text.includes("tree_task_plan") &&
    text.includes("tree_task_done") &&
    text.includes(taskA.id)
  );
});

check("renderContinue 在整棵树结束后让汇报", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, plan.goal.id, "目标");
  const text = renderContinue(plan);
  return text.includes("已完成") && text.includes("不要再调用");
});

check("renderContinue 在当前子任务上让继续执行", () => {
  const { plan, a1 } = fixture();
  const text = renderContinue(plan);
  return text.includes("继续执行下一个子任务") && text.includes(a1.id);
});

check("renderContinue 在没拆子节点的任务上让先拆", () => {
  const fresh = createPlan({ title: "目标", tasks: [{ title: "光杆任务" }] });
  const text = renderContinue(fresh);
  return text.includes("tree_task_plan");
});

console.log("\n" + "─".repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
