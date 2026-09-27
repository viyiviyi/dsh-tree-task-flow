/**
 * tools.js 的工具层自测。
 *
 * 用假 ctx 与假 store 把工具层单独拎出来跑，覆盖三件事：
 *
 *   1. 六个工具都在，`schema` 与描述里再没有 `needs` 的痕迹，完成必须带 `result`。
 *   2. `tree_task_done` 缺 `result`、给空白 `result` 都被拒，且节点状态不变。
 *   3. 检查点闸门：放行 `tree_task_plan` / `tree_task_done`，其余一律拒；
 *      非检查点不拦；下游已经拒了的，闸门不越权改判；只对身处检查点的那个会话生效。
 *
 * 假 ctx 只实现 `tools.register` 与 `on`，因为工具层只用这两样，
 * 多给的假件会掩盖真实耦合。
 *
 * 跑：node verify-tools.mjs
 */

import { addChildren, checkpointOf, complete, createPlan } from "./lib/plan.js";
import { CHECKPOINT_ALLOWED, checkpointGate, registerTools } from "./lib/tools.js";

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

/** 假 ctx + 假 store；`registerTools` 一跑，注册表与闸门就都拿到了。 */
function makeHarness() {
  const sessions = new Map();
  const tools = new Map();
  const handlers = new Map();

  const ctx = {
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`重复注册工具 ${def.name}`);
        tools.set(def.name, def);
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  const store = {
    readPlan: (sessionId) => sessions.get(sessionId) ?? null,
    writePlan: (sessionId, plan) => {
      sessions.set(sessionId, plan);
    },
  };

  registerTools(ctx, { store, cfg: {} });
  return { tools, handlers, store, sessions };
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
const ALLOW = async () => ({ kind: "allow" });
const DOWNSTREAM_DENY = async () => ({ kind: "deny", reason: "审批拒绝" });

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
  const [task1] = plan.goal.tasks;
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
  check("回执里带上提交的结果", /子1 产出了 X/u.test(good.text), good.text.slice(0, 160));

  const twice = await done.execute({ id: step1.id, result: "再来一次" }, execFor("s2", "tree_task_done"));
  check("重复完成被拒", /已经是完成状态/u.test(twice.text), twice.text);
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 非检查点不拦");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s3", plan);
  const gate = h.handlers.get("tools/pre-execute")?.[0];

  check("注册了 tools/pre-execute 闸门", typeof gate === "function");

  for (const name of ["read", "bash", "tree_task_status", "tree_task_create", "tree_task_update", "tree_task_drop"]) {
    const decision = await gate(execFor("s3", name), ALLOW);
    check(`未拆子节点时放行 ${name}`, decision.kind === "allow", JSON.stringify(decision));
  }
  check("未拆子节点不算检查点", checkpointOf(plan) === null);

  const [task1] = plan.goal.tasks;
  addChildren(plan, task1.id, [{ title: "子1" }, { title: "子2" }], 1000);
  for (const name of ["read", "bash", "tree_task_status"]) {
    const decision = await gate(execFor("s3", name), ALLOW);
    check(`子任务进行中仍放行 ${name}`, decision.kind === "allow", JSON.stringify(decision));
  }

  const noPlan = await gate(execFor("s3-无计划", "read"), ALLOW);
  check("没有计划时不拦", noPlan.kind === "allow", JSON.stringify(noPlan));

  const noSession = await gate({ name: "read" }, ALLOW);
  check("取不到会话时不抛错、不拦", noSession.kind === "allow", JSON.stringify(noSession));
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 检查点只放行两个工具");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }, { title: "任务2" }] }, 1000);
  h.store.writePlan("s4", plan);
  const [task1] = plan.goal.tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;
  const gate = h.handlers.get("tools/pre-execute")?.[0];

  complete(plan, step1.id, "子1 的结果", 1100);
  const checkpoint = checkpointOf(plan);
  check("子任务全部结束后转入检查点", checkpoint?.node?.id === task1.id, JSON.stringify(checkpoint?.node?.id));

  check(
    "白名单恰好是这两个",
    CHECKPOINT_ALLOWED.length === 2 &&
      CHECKPOINT_ALLOWED.includes("tree_task_plan") &&
      CHECKPOINT_ALLOWED.includes("tree_task_done"),
    JSON.stringify(CHECKPOINT_ALLOWED),
  );

  for (const name of CHECKPOINT_ALLOWED) {
    const decision = await gate(execFor("s4", name), ALLOW);
    check(`检查点放行 ${name}`, decision.kind === "allow", JSON.stringify(decision));
  }

  for (const name of ["read", "bash", "tree_task_status", "tree_task_create", "tree_task_update", "tree_task_drop"]) {
    const decision = await gate(execFor("s4", name), ALLOW);
    check(`检查点拒绝 ${name}`, decision.kind === "deny", JSON.stringify(decision));
  }

  const denied = await gate(execFor("s4", "read"), ALLOW);
  check(
    "拒绝文案说清局面与两条出路",
    /检查点/u.test(denied.reason) &&
      /tree_task_plan/u.test(denied.reason) &&
      /tree_task_done/u.test(denied.reason),
    denied.reason,
  );
  check("拒绝文案点名被拒的工具", /"read"/u.test(denied.reason), denied.reason);

  const downstream = await gate(execFor("s4", "read"), DOWNSTREAM_DENY);
  check(
    "下游已拒绝时不越权改判",
    downstream.kind === "deny" && downstream.reason === "审批拒绝",
    JSON.stringify(downstream),
  );

  const other = createPlan({ title: "目标B", tasks: [{ title: "任务X" }] }, 1000);
  h.store.writePlan("s5", other);
  const elsewhere = await gate(execFor("s5", "read"), ALLOW);
  check("检查点只对身处其中的会话生效", elsewhere.kind === "allow", JSON.stringify(elsewhere));

  complete(plan, task1.id, "任务1 的结果", 1200);
  const afterTaskDone = checkpointOf(plan);
  check(
    "提交父节点结果后原检查点解除",
    afterTaskDone === null || afterTaskDone.node.id !== task1.id,
    JSON.stringify(afterTaskDone?.node?.id),
  );
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · checkpointGate 纯函数");
{
  const spot = { level: "task", node: { id: "t-x", title: "任务X" } };

  check("没有检查点时放行", checkpointGate("read", null).kind === "allow");
  check("检查点为 undefined 时放行", checkpointGate("read", undefined).kind === "allow");
  check("检查点放行 tree_task_plan", checkpointGate("tree_task_plan", spot).kind === "allow");
  check("检查点放行 tree_task_done", checkpointGate("tree_task_done", spot).kind === "allow");
  check("检查点拒绝 tree_task_status", checkpointGate("tree_task_status", spot).kind === "deny");
  check("检查点拒绝 read", checkpointGate("read", spot).kind === "deny");

  const reason = checkpointGate("read", spot).reason;
  check("纯函数的拒绝理由自带节点信息", /t-x/u.test(reason) && /任务X/u.test(reason), reason);

  const goalSpot = { level: "goal", node: { id: "g-y", title: "目标Y" } };
  check("目标检查点的拒绝理由用「目标」称呼", /目标/u.test(checkpointGate("read", goalSpot).reason), checkpointGate("read", goalSpot).reason);
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · 三级固定的约束");
{
  const h = makeHarness();
  const plan = createPlan({ title: "目标A", tasks: [{ title: "任务1" }] }, 1000);
  h.store.writePlan("s6", plan);
  const [task1] = plan.goal.tasks;
  addChildren(plan, task1.id, [{ title: "子1" }], 1000);
  const [step1] = task1.steps;

  const planTool = h.tools.get("tree_task_plan");

  const deeper = await planTool.execute(
    { parentId: step1.id, children: [{ title: "更深一层" }] },
    execFor("s6", "tree_task_plan"),
  );
  check("子任务不能再往下拆", /不能再拆/u.test(deeper.text), deeper.text);

  const onGoal = await planTool.execute(
    { parentId: plan.goal.id, children: [{ title: "任务2" }] },
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

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
