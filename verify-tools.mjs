/**
 * tools.js 的工具层自测。
 *
 * 用假 ctx 与假 store 把工具层单独拎出来跑，覆盖三件事：
 *
 *   1. 六个工具都在，`schema` 与描述里再没有 `needs` 的痕迹，完成必须带 `result`。
 *   2. `tree_task_done` 缺 `result`、给空白 `result` 都被拒，且节点状态不变。
 *   3. 三级固定的约束：子任务不能再往下拆，目标下加的是任务、任务下加的是子任务。
 *
 * **工具层不拦任何别的工具。** 检查点只是给模型的提示，不再有 `tools/pre-execute`
 * 闸门，所以假 ctx 只需要 `tools.register`——多给的假件会掩盖真实耦合。
 *
 * 跑：node verify-tools.mjs
 */

import { addChildren, complete, createPlan } from "./lib/plan.js";
import { registerTools } from "./lib/tools.js";

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

/** 新模型下的六个工具，顺序无关，只用来核对集合。 */
const SIX_TOOLS = [
  "tree_task_status",
  "tree_task_create",
  "tree_task_plan",
  "tree_task_done",
  "tree_task_update",
  "tree_task_drop",
];

/** 已移除的记忆三工具——它们出现在注册表里就说明删漏了。 */
const REMOVED_TOOLS = ["tree_task_save", "tree_task_recall", "tree_task_forget"];

/** 假 ctx + 假 store。 */
function makeHarness() {
  const sessions = new Map();
  const tools = new Map();

  const ctx = {
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`重复注册工具 ${def.name}`);
        tools.set(def.name, def);
      },
    },
  };

  const store = {
    readPlan: (sessionId) => sessions.get(sessionId) ?? null,
    writePlan: (sessionId, plan) => {
      sessions.set(sessionId, plan);
    },
  };

  registerTools(ctx, { store, cfg: {} });
  return { tools, store, sessions };
}

/** 递归找某个键名，返回命中路径；用来证明 schema 里再没有 needs。 */
function findKey(value, key, path = "$") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...findKey(item, key, `${path}[${index}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const [name, inner] of Object.entries(value)) {
      if (name === key) hits.push(`${path}.${name}`);
      hits.push(...findKey(inner, key, `${path}.${name}`));
    }
  }
  return hits;
}

const execFor = (sessionId, name) => ({ name, agent: { session: { id: sessionId } } });

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 六个工具的注册表与 schema");
{
  const h = makeHarness();

  check("恰好注册六个工具", h.tools.size === 6, `实际 ${h.tools.size}：${[...h.tools.keys()].join(", ")}`);
  for (const name of SIX_TOOLS) check(`  ${name} 已注册`, h.tools.has(name));
  check(
    "记忆三工具已全部移除",
    REMOVED_TOOLS.every((name) => !h.tools.has(name)),
    REMOVED_TOOLS.filter((name) => h.tools.has(name)).join(", "),
  );

  const needsHits = [];
  for (const [name, def] of h.tools) {
    needsHits.push(...findKey(def.parameters, "needs").map((path) => `${name}:${path}`));
  }
  check("所有 parameters 都不含 needs 字段", needsHits.length === 0, needsHits.join(", "));

  const descHits = [...h.tools].filter(([, def]) => /needs/u.test(def.description ?? "")).map(([name]) => name);
  check("所有 description 都不提 needs", descHits.length === 0, descHits.join(", "));

  const done = h.tools.get("tree_task_done");
  check(
    "tree_task_done 把 result 列为必填",
    (done.parameters.required ?? []).includes("result"),
    JSON.stringify(done.parameters.required),
  );

  const created = h.tools.get("tree_task_create");
  check(
    "tree_task_create 只收 title / detail / tasks",
    JSON.stringify(Object.keys(created.parameters.properties).sort()) ===
      JSON.stringify(["detail", "tasks", "title"]),
    JSON.stringify(Object.keys(created.parameters.properties)),
  );

  const planTool = h.tools.get("tree_task_plan");
  check(
    "tree_task_plan 收 parentId + children",
    "parentId" in planTool.parameters.properties && "children" in planTool.parameters.properties,
    JSON.stringify(Object.keys(planTool.parameters.properties)),
  );

  check(
    "工具描述教了分层：任务是交付节点、子任务是步骤",
    /交付节点/u.test(created.description) && /步骤/u.test(planTool.description),
  );
  check(
    "tree_task_done 的 result 说明按两层分别写了写法",
    /验收/u.test(done.description) && /验收/u.test(done.parameters.properties.result.description),
  );

  for (const [name, def] of h.tools) {
    check(`  ${name} 的返回形状是 { text }`, def.output?.schema?.properties?.text?.type === "string");
  }
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 完成必须交出 result");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s2", plan);
  const [task1] = plan.goals[0].tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;
  const done = h.tools.get("tree_task_done");

  const missing = await done.execute({ id: step1.id }, execFor("s2", "tree_task_done"));
  check("缺 result 被拒", /必须提交结果/u.test(missing.text), missing.text);
  check("被拒时节点仍是 pending", step1.status === "pending", step1.status);
  check("被拒时没有落下结果", step1.result === null, JSON.stringify(step1.result));

  const blank = await done.execute({ id: step1.id, result: "   " }, execFor("s2", "tree_task_done"));
  check("空白 result 被拒", /必须提交结果/u.test(blank.text), blank.text);
  check("空白被拒时节点仍是 pending", step1.status === "pending", step1.status);

  const unknown = await done.execute({ id: "s-不存在", result: "随便" }, execFor("s2", "tree_task_done"));
  check("未知 id 被拒", /没有完成/u.test(unknown.text), unknown.text);

  const good = await done.execute({ id: step1.id, result: "子1 产出了 X" }, execFor("s2", "tree_task_done"));
  check(
    "正常提交被接受并记下结果",
    step1.status === "done" && step1.result?.text === "子1 产出了 X",
    JSON.stringify({ status: step1.status, result: step1.result }),
  );
  check(
    "完成时返回的就是下一步该干什么",
    good.text.startsWith("tree_task消息：") && good.text.includes("检查点"),
    JSON.stringify(good.text).slice(0, 160),
  );
  check(
    "返回里不重复提交内容",
    !good.text.includes("子1 产出了 X"),
    JSON.stringify(good.text).slice(0, 160),
  );
  check(
    "tree_task_done 的说明里讲了返回内容与调用会留下",
    /返回内容就是下一步/u.test(done.description) && /留在上下文里/u.test(done.description),
    done.description,
  );

  const twice = await done.execute({ id: step1.id, result: "再来一次" }, execFor("s2", "tree_task_done"));
  check("重复完成被拒", /已经是完成状态/u.test(twice.text), twice.text);
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 三级固定的约束");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s6", plan);
  const [task1] = plan.goals[0].tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;

  const planTool = h.tools.get("tree_task_plan");

  const deeper = await planTool.execute(
    { parentId: step1.id, children: [{ title: "更深一层" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("子任务不能再往下拆", /不能再拆/u.test(deeper.text), deeper.text);

  const onGoal = await planTool.execute(
    { parentId: plan.goals[0].id, children: [{ title: "任务2" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("目标下追加的是任务", /已添加 1 个任务/u.test(onGoal.text), onGoal.text);

  const onTask = await planTool.execute(
    { parentId: task1.id, children: [{ title: "子2" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("任务下追加的是子任务", /已添加 1 个子任务/u.test(onTask.text), onTask.text);

  const empty = await planTool.execute({ parentId: task1.id, children: [] }, execFor("s6", "tree_task_plan"));
  check("不给子节点被拒", /至少要给一个子节点/u.test(empty.text), empty.text);

  const noPlan = await planTool.execute(
    { parentId: "t-无", children: [{ title: "x" }] },
    execFor("s6-无计划", "tree_task_plan"),
  );
  check("没有计划时提示先建树", /还没有计划/u.test(noPlan.text), noPlan.text);
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 同一个会话里可以再立一个目标");
{
  const h = makeHarness();
  const create = h.tools.get("tree_task_create");

  const first = await create.execute(
    { title: "目标A", tasks: [{ title: "任务1" }] },
    execFor("s9", "tree_task_create"),
  );
  const plan1 = h.store.readPlan("s9");
  check("第一次调用建起计划", /计划已建立/u.test(first.text) && plan1.goals.length === 1, first.text.slice(0, 60));

  const second = await create.execute(
    { title: "目标B", tasks: [{ title: "任务2" }] },
    execFor("s9", "tree_task_create"),
  );
  const plan2 = h.store.readPlan("s9");
  check(
    "第二次调用是新增目标，不是替换整棵树",
    /已新增目标/u.test(second.text) && plan2.goals.length === 2,
    second.text.slice(0, 60),
  );
  check(
    "第一个目标原样留着",
    plan2.goals[0].id === plan1.goals[0].id && plan2.goals[0].title === "目标A",
    JSON.stringify({ before: plan1.goals[0].id, after: plan2.goals[0].id }),
  );
  check("两个目标的 id 不同", plan2.goals[0].id !== plan2.goals[1].id);
  check(
    "返回的树里两个目标都在",
    second.text.includes("目标A") && second.text.includes("目标B"),
    second.text.slice(0, 120),
  );
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
