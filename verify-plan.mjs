/**
 * plan.js 的纯逻辑自测。
 *
 * 计划树不碰 DSH、不碰磁盘，所以这一层可以在插件目录直接跑，不需要任何宿主包。
 * 覆盖：建树、activePath 推导、完成与结果、检查点判定、丢弃级联、修改、渲染。
 *
 * 跑法：`node verify-plan.mjs`。
 */

import { addChildren, addGoal, activePath, checkpointOf, complete, createPlan, doneNotice, doneReply, dropNode, findNode, goalsOf, levelLabel, renderContinue, renderTree, updateNode } from "./lib/plan.js";

let pass = 0;
const failures = [];

/**
 * 断言。`cond` 可以直接是布尔，也可以是个返回布尔的函数——这个文件里的断言
 * 都写成函数，好在里面建 fixture、调一串 API；早先这里只判断 `if (cond)`，
 * 函数对象本身永远为真，于是 53 条断言全在空转。现在函数会被调用，抛异常算失败。
 */
function check(name, cond, detail) {
  let value = cond;
  let note = detail;
  if (typeof cond === "function") {
    try {
      value = cond();
    } catch (error) {
      value = false;
      note = `断言抛异常：${String(error?.message ?? error)}`;
    }
  }
  if (value) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(note ? `${name} — ${note}` : name);
    console.log(`  FAIL  ${name}${note ? ` — ${note}` : ""}`);
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
  const [goal] = plan.goals;
  const [taskA, taskB] = goal.tasks;
  addChildren(plan, taskA.id, [{ title: "A1" }, { title: "A2" }], now);
  const [a1, a2] = taskA.steps;
  return { plan, goal, taskA, taskB, a1, a2, now };
}

console.log("场景 1 · 建树");

check("一个目标 + 若干任务，状态都是 pending", () => {
  const { plan, goal, taskA, taskB } = fixture();
  return (
    plan.version === 2 &&
    goal.tasks.length === 2 &&
    goal.status === "pending" &&
    taskA.status === "pending" &&
    taskB.status === "pending" &&
    taskA.steps.length === 2
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
  return plan.goals[0].title === "(未命名目标)" && plan.goals[0].tasks[0].title === "(未命名任务)";
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

check("子任务都做完但任务还没收尾时，activePath 停在任务上（step 为 null）", () => {
  const { plan, taskA, a1, a2 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  complete(plan, a2.id, "A2 的结果");
  const active = activePath(plan);
  return active.task.id === taskA.id && active.step === null;
});

check("任务收尾后，activePath 落到下一个任务", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  complete(plan, a2.id, "A2 的结果");
  complete(plan, taskA.id, "任务A 的结果");
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
  complete(plan, plan.goals[0].id, "目标的结果");
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
  complete(plan, plan.goals[0].id, "目标");
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

check("目标可以丢弃，整支一起走", () => {
  const { plan, goal, taskA, taskB, a1, a2 } = fixture();
  const r = dropNode(plan, goal.id);
  return (
    r.ok === true &&
    goal.status === "dropped" &&
    taskA.status === "dropped" &&
    taskB.status === "dropped" &&
    a1.status === "dropped" &&
    a2.status === "dropped" &&
    r.dropped.some((line) => line.includes("目标")) &&
    r.dropped.some((line) => line.includes("任务A"))
  );
});

check("丢弃目标不会改写已经结束的节点", () => {
  const { plan, goal, taskA, a1, a2 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  complete(plan, a2.id, "A2 的结果");
  complete(plan, taskA.id, "任务A 的结果");
  dropNode(plan, goal.id);
  return (
    a1.status === "done" &&
    taskA.status === "done" &&
    goal.status === "dropped" &&
    a1.result?.text === "A1 的结果"
  );
});

check("丢光所有目标后 activePath 为 null", () => {
  const { plan, goal } = fixture();
  dropNode(plan, goal.id);
  return activePath(plan) === null;
});

check("丢弃单个子任务只影响它自己", () => {
  const { plan, a1, a2 } = fixture();
  const r = dropNode(plan, a1.id);
  return r.ok === true && a1.status === "dropped" && a2.status === "pending";
});

check("已经完成的节点不能被丢弃", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  const r = dropNode(plan, a1.id);
  return r.ok === false && a1.status === "done" && a1.result?.text === "A1 的结果";
});

check("重复丢弃被拒", () => {
  const { plan, a1 } = fixture();
  dropNode(plan, a1.id);
  const again = dropNode(plan, a1.id);
  return again.ok === false && a1.status === "dropped";
});

check("已完成的目标也不能丢", () => {
  const { plan, goal, a1, a2, taskA, taskB } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, goal.id, "目标的结果");
  const r = dropNode(plan, goal.id);
  return r.ok === false && goal.status === "done";
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
    added.added[0].steps === undefined &&
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
  const { a1, a2, taskA } = { a1: plan.goals[0].tasks[0].steps[0], a2: plan.goals[0].tasks[0].steps[1], taskA: plan.goals[0].tasks[0] };
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  const text = renderTree(plan);
  return text.includes(taskB.id) && text.includes("tree_task_plan");
});

check("renderContinue 在检查点上给出收尾确认句", () => {
  const { plan, a1, a2, taskA } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  const text = renderContinue(plan);
  return (
    text.includes(`检查点：任务「${taskA.title}」${taskA.id} 的步骤已全部结束`) &&
    text.includes(`请确认任务「${taskA.title}」${taskA.id} 是否完成`) &&
    text.includes("请调用tree_task_done") &&
    text.includes("可使用 tree_task_plan 新增步骤继续")
  );
});

check("检查点落在目标上时，下一级的称呼换成任务", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  const text = renderContinue(plan);
  return (
    text.includes(`检查点：目标${plan.goals[0].id} 的任务已全部结束`) &&
    text.includes(`请确认目标${plan.goals[0].id} 是否完成`) &&
    text.includes("tree_task_plan 新增任务继续")
  );
});

check("完成通告说清归档，且不重复提交内容", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  const notice = doneNotice("step", a1);
  return (
    notice === `步骤「${a1.title}」${a1.id}已经完成，执行过程已归档` &&
    !notice.includes("A1 的结果")
  );
});

check("丢弃通告不带提交内容", () => {
  const { plan, a2 } = fixture();
  dropNode(plan, a2.id);
  return doneNotice("step", a2) === `步骤「${a2.title}」${a2.id}已被丢弃`;
});

check("目标层的自称不带标题", () => {
  const { plan } = fixture();
  complete(plan, plan.goals[0].id, "目标的结果");
  return doneNotice("goal", plan.goals[0]) === `目标${plan.goals[0].id}已经完成，执行过程已归档`;
});

check("done 的返回只给下一步，不重复通告", () => {
  const { plan, a1 } = fixture();
  complete(plan, a1.id, "A1 的结果");
  const reply = doneReply(plan);
  return (
    reply.startsWith("tree_task消息：") &&
    reply.includes("接下来需要进行步骤：") &&
    !reply.includes("已经完成")
  );
});

check("renderContinue 在整棵树结束后让汇报", () => {
  const { plan, taskA, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, plan.goals[0].id, "目标");
  const text = renderContinue(plan);
  return text.includes("请汇报最终结果");
});

check("renderContinue 报出下一个步骤", () => {
  const { plan, a1 } = fixture();
  const text = renderContinue(plan);
  return text.includes("接下来需要进行步骤：") && text.includes(`「${a1.title}」(${a1.id})`);
});

check("renderContinue 在没有下一个步骤时报同级任务", () => {
  const { plan, taskB, a1, a2 } = fixture();
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, plan.goals[0].tasks[0].id, "任务A");
  const text = renderContinue(plan);
  return text.includes("接下来需要进行任务：") && text.includes(`「${taskB.title}」(${taskB.id})`);
});

check("renderContinue 在没拆子节点的任务上只说该做这个任务", () => {
  const fresh = createPlan({ title: "目标", tasks: [{ title: "光杆任务" }] });
  const text = renderContinue(fresh);
  return text.includes("接下来需要进行任务：「光杆任务」") && !text.includes("tree_task_plan");
});

console.log("\n场景 10 · 一个会话多个目标");

check("addGoal 追加目标，不动已有的那个", () => {
  const { plan, goal } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] }, 1_700_000_001_000);
  return (
    plan.goals.length === 2 &&
    plan.goals[0] === goal &&
    plan.goals[1] === second &&
    second.tasks.length === 1 &&
    goalsOf(plan).length === 2
  );
});

check("新目标接在最后，初始状态是 pending", () => {
  const { plan } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  return second.status === "pending" && second.completedAt === null && second.result === null;
});

check("前一个目标没结束时，activePath 还停在它上面", () => {
  const { plan, goal } = fixture();
  addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  return activePath(plan).goal.id === goal.id;
});

check("前一个目标收尾后，activePath 落到下一个目标", () => {
  const { plan, goal, a1, a2, taskA, taskB } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, goal.id, "第一个目标的结果");
  const active = activePath(plan);
  return active.goal.id === second.id && active.task.id === second.tasks[0].id;
});

check("轮到新目标时，提示报的是它的第一个任务", () => {
  const { plan, goal, a1, a2, taskA, taskB } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, goal.id, "第一个目标的结果");
  const text = renderContinue(plan);
  return text.includes("接下来需要进行任务：") && text.includes(second.tasks[0].id);
});

check("两个目标都结束后，activePath 才是 null", () => {
  const { plan, goal, a1, a2, taskA, taskB } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  const [taskC] = second.tasks;
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, goal.id, "第一个目标的结果");
  complete(plan, taskC.id, "任务C");
  const midway = activePath(plan) !== null;
  complete(plan, second.id, "第二个目标的结果");
  return midway && activePath(plan) === null;
});

check("树渲染把两个目标都列出来", () => {
  const { plan, goal } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  const text = renderTree(plan);
  return (
    text.includes(`目标  ${goal.id}  ${goal.title}`) &&
    text.includes(`目标  ${second.id}  ${second.title}`) &&
    text.split("\n").filter((line) => line.includes("目标  ")).length === 2
  );
});

check("第二个目标也能成为检查点", () => {
  const { plan, goal, a1, a2, taskA, taskB } = fixture();
  const second = addGoal(plan, { title: "第二个目标", tasks: [{ title: "任务C" }] });
  complete(plan, a1.id, "A1");
  complete(plan, a2.id, "A2");
  complete(plan, taskA.id, "任务A");
  complete(plan, taskB.id, "任务B");
  complete(plan, goal.id, "第一个目标的结果");
  complete(plan, second.tasks[0].id, "任务C");
  const checkpoint = checkpointOf(plan);
  return checkpoint !== null && checkpoint.level === "goal" && checkpoint.node.id === second.id;
});

console.log("\n" + "─".repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
