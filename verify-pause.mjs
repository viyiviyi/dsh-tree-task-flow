/**
 * pause.js 的暂停闸门自测。
 *
 * 闸门的全部作用就是在 `agent/pre-step` 上"挂住 / 放行"，而这两件事的**时机**
 * 才是它的价值所在，所以这里重点验的是时机，不是文案：
 *
 *   1. 没暂停时一次都不挂，直接把 next 的结果透传回去。
 *   2. 暂停后确实挂住（迟迟不结算），点继续才放行。
 *   3. 暂停期间真人发言 → 立刻放行，并且暂停态自动解除。
 *   4. 本轮被取消（signal abort）→ 立刻放行，绝不把轮次永远吊住。
 *   5. 暂停会顺手压住自动续行兜底，继续时再放开。
 *   6. 「被按住」落盘：暂停写 held/<sessionId>.json，重启（新进程、内存全空）
 *      之后 isPaused 仍为真，闸门照样拦得住。
 *   7. 跨重启的那次继续：进程里没有 waiter 可放行时，退一步用 `agent.followup()`
 *      把 idle 的会话推起来——拿到 agent、且计划里还有进行中的子任务时才推；
 *      常规（本进程内挂着的）继续**绝不**推消息。
 *
 * waterfall 的契约是"必须 await next() 并把它返回"，所以每个场景除了看有没有
 * 结算，还要看 next 有没有被调用、返回值有没有原样传出去。
 *
 * 跑：node verify-pause.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPause } from "./lib/pause.js";
import { createStore } from "./lib/store.js";

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

/** 等一小会儿，用来判断一个 promise 有没有结算。 */
function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 自动续行的假控制接口，只记下谁被叫过。 */
function makeAutoContinue() {
  const stopped = new Set();
  const calls = [];
  return {
    calls,
    stopped,
    stop(sessionId) {
      calls.push(`stop:${sessionId}`);
      stopped.add(sessionId);
    },
    resume(sessionId) {
      calls.push(`resume:${sessionId}`);
      stopped.delete(sessionId);
    },
    isStopped(sessionId) {
      return stopped.has(sessionId);
    },
  };
}

/**
 * 假 ctx：只需要 `on` 与反射式的 `get`。多给的假件会掩盖真实耦合。
 *
 * @param options - `{ store, agents }`。都不传时退化成"没有持久化、没有 agents 服务"
 *   的旧环境，上面那些只验闸门时机的场景照旧跑得动。
 */
function makeHarness({ store = null, agents = null } = {}) {
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get(name) {
      return name === "agents" ? agents : undefined;
    },
  };
  const autoContinue = makeAutoContinue();
  const pause = registerPause(ctx, { store, autoContinue });
  const gate = (handlers.get("agent/pre-step") ?? [])[0];
  return { handlers, autoContinue, pause, gate, store, agents };
}

/** 一个临时状态目录，跑完由调用方删掉。 */
function makeRoot() {
  return mkdtempSync(join(tmpdir(), "tt-verify-pause-"));
}

/** 一份"还有进行中的子任务"的计划，用来判断跨重启的继续该不该唤醒。 */
function makePlan() {
  return {
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    goals: [
      {
        id: "g-1",
        title: "目标",
        status: "pending",
        tasks: [
          {
            id: "t-1",
            title: "任务",
            status: "pending",
            steps: [{ id: "s-1", title: "步骤", status: "pending" }],
          },
        ],
      },
    ],
  };
}

/** 计划已收尾：所有节点都结束，这时不该再唤醒。 */
function makeFinishedPlan() {
  const plan = makePlan();
  plan.goals[0].status = "done";
  plan.goals[0].tasks[0].status = "done";
  plan.goals[0].tasks[0].steps[0].status = "done";
  return plan;
}

/**
 * 假 agents 服务：`get(sessionId)` 给出登记的假 agent，`followup` 记下推了什么。
 *
 * @param sessions - `{ [sessionId]: { status } }`；没登记的会话返回 undefined，
 *   模拟"这个会话还没被 DSH 加载成实时 agent"。
 */
function makeAgents(sessions) {
  const followed = [];
  return {
    followed,
    get(sessionId) {
      const spec = sessions[sessionId];
      if (spec === undefined) return undefined;
      return {
        id: sessionId,
        status: spec.status ?? "idle",
        followup(message) {
          followed.push({ sessionId, message });
        },
      };
    },
  };
}

/** 一次 pre-step 的调用现场；`next` 记下自己有没有被调用。 */
function makeStep(sessionId, { human = false } = {}) {
  const controller = new AbortController();
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return { kind: "enter", messages: [] };
  };
  const payload = {
    agent: { session: { id: sessionId } },
    messages: human
      ? [{ source: { kind: "user" } }]
      : [{ source: { kind: "plugin:dsh-tree-task-flow", form: "notice", summary: "计划续行" } }],
    turn: 1,
    step: 2,
    signal: controller.signal,
  };
  return { payload, next, nextCalls, controller };
}

// ---------------------------------------------------------------- 没暂停

console.log("\n没暂停：");

{
  const { pause, gate } = makeHarness();
  const step = makeStep("s-quiet");
  const decision = await gate(step.payload, step.next);
  check("一次都不挂，直接返回", decision?.kind === "enter");
  check("next 被调用了一次", step.nextCalls.length === 1);
  check("本来就没暂停", pause.isPaused("s-quiet") === false);
}

// ---------------------------------------------------------------- 挂住与放行

console.log("\n挂住与放行：");

{
  const { pause, gate, autoContinue } = makeHarness();
  pause.pause("s-1");

  check("暂停态记下了", pause.isPaused("s-1") === true);
  check("暂停顺手压住了自动续行", autoContinue.isStopped("s-1") === true);
  check("压住自动续行只调了一次", autoContinue.calls.join(",") === "stop:s-1");

  const step = makeStep("s-1");
  let settled = false;
  const running = gate(step.payload, step.next).then((value) => {
    settled = true;
    return value;
  });

  await tick();
  check("暂停后挂住了，没有结算", settled === false);
  check("挂住期间没有碰 next", step.nextCalls.length === 0);

  pause.resume("s-1");
  const decision = await running;
  check("点继续后放行", settled === true);
  check("放行后 next 被调用", step.nextCalls.length === 1);
  check("next 的结果原样透传", decision?.kind === "enter");
  check("继续后不再是暂停态", pause.isPaused("s-1") === false);
  check(
    "继续时放开了自动续行",
    autoContinue.calls.join(",") === "stop:s-1,resume:s-1" && autoContinue.isStopped("s-1") === false,
  );
}

// ---------------------------------------------------------------- 闸门只拦自动推进

console.log("\n闸门只拦自动推进：");

{
  const { pause, gate } = makeHarness();
  pause.pause("s-2");
  const step = makeStep("s-2", { human: true });
  const decision = await gate(step.payload, step.next);
  check("真人发言直接放行", decision?.kind === "enter");
  check("next 被调用了一次", step.nextCalls.length === 1);
  check("人自己发了消息，暂停态跟着解除", pause.isPaused("s-2") === false);
}

// ---------------------------------------------------------------- 取消时不能吊住轮次

console.log("\n本轮被取消：");

{
  const { pause, gate } = makeHarness();
  pause.pause("s-3");
  const step = makeStep("s-3");
  let settled = false;
  const running = gate(step.payload, step.next).then(() => {
    settled = true;
  });

  await tick();
  check("先挂住", settled === false);

  step.controller.abort();
  await running;
  check("本轮一取消就立刻放行", settled === true);
  check("放行后 next 被调用", step.nextCalls.length === 1);
  check("取消不会顺手解除暂停态（人还能再点继续）", pause.isPaused("s-3") === true);
}

{
  // signal 早就 abort 了才轮到 pre-step：不能再挂上去。
  const { pause, gate } = makeHarness();
  pause.pause("s-4");
  const step = makeStep("s-4");
  step.controller.abort();
  const decision = await gate(step.payload, step.next);
  check("已经取消的信号不会被挂住", decision?.kind === "enter");
}

// ---------------------------------------------------------------- 互不干扰

console.log("\n会话之间互不干扰：");

{
  const { pause, gate } = makeHarness();
  pause.pause("s-5");
  const step = makeStep("s-6");
  const decision = await gate(step.payload, step.next);
  check("只暂停了一个会话，别的会话照跑", decision?.kind === "enter");
  check("另一个会话没有被记上暂停", pause.isPaused("s-6") === false);
}

{
  // 同一会话连点两次暂停、再点一次继续：挂住的那些必须都能醒来。
  const { pause, gate } = makeHarness();
  pause.pause("s-7");
  pause.pause("s-7");
  const first = makeStep("s-7");
  const second = makeStep("s-7");
  let firstDone = false;
  let secondDone = false;
  const runningFirst = gate(first.payload, first.next).then(() => {
    firstDone = true;
  });
  const runningSecond = gate(second.payload, second.next).then(() => {
    secondDone = true;
  });
  await tick();
  check("两次挂起都在等", firstDone === false && secondDone === false);
  pause.resume("s-7");
  await Promise.all([runningFirst, runningSecond]);
  check("一次继续把两个挂起都放行", firstDone === true && secondDone === true);
}

// ---------------------------------------------------------------- 落盘与重启

console.log("\n「被按住」落盘：");

{
  const root = makeRoot();
  try {
    const store = createStore(root);
    const { pause } = makeHarness({ store });
    pause.pause("s-20");
    check("暂停写进了 held 文件", store.readHeld("s-20").paused === true);
    check("内存里也记着", pause.isPaused("s-20") === true);
    // 这个会话既没有 agent 也没有计划：唤醒不成功，状态必须留着——
    // 旧实现是"先清状态再尝试唤醒"，用户于是既没入口也没提示。
    const outcome = pause.resume("s-20");
    check("没唤醒成功时状态保留着", store.readHeld("s-20").paused === true, JSON.stringify(outcome));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n模拟重启：内存全空，只有磁盘还在：");

{
  const root = makeRoot();
  try {
    const before = makeHarness({ store: createStore(root) });
    before.pause.pause("s-21");

    // 新进程：新 store、新 registry，内存里什么都没有。
    const store = createStore(root);
    const after = makeHarness({ store });
    check("重启后仍是暂停态（界面才画得出「继续」）", after.pause.isPaused("s-21") === true);

    const step = makeStep("s-21");
    let settled = false;
    const running = after.gate(step.payload, step.next).then(() => {
      settled = true;
    });
    await tick();
    check("重启后闸门照样拦得住新的推进", settled === false);
    after.pause.resume("s-21");
    await running;
    check("放行之后 next 才被调用", settled === true && step.nextCalls.length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\n跨重启的那次继续：把 idle 会话推起来：");

{
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-22", makePlan());
    createStore(root).patchHeld("s-22", { paused: true }); // 上一个进程留下的

    const agents = makeAgents({ "s-22": { status: "idle" } });
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-22");

    check("推了一次", outcome.woke === true && agents.followed.length === 1);
    check(
      "推的是插件自己的「恢复续行」消息",
      agents.followed[0]?.message?.source?.kind === "plugin:dsh-tree-task-flow" &&
        agents.followed[0]?.message?.source?.summary === "恢复续行",
      JSON.stringify(agents.followed[0]?.message?.source),
    );
    check(
      "正文非空（告诉模型接着干什么）",
      typeof agents.followed[0]?.message?.content?.[0]?.text === "string" &&
        agents.followed[0].message.content[0].text.length > 0,
    );
    check(
      "状态清干净了",
      store.readHeld("s-22").paused === false && pause.isPaused("s-22") === false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 常规暂停：本进程里真挂着 waiter，只放行，绝不能推消息。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-23", makePlan());
    const agents = makeAgents({ "s-23": { status: "idle" } });
    const { pause, gate } = makeHarness({ store, agents });
    pause.pause("s-23");
    const step = makeStep("s-23");
    let settled = false;
    const running = gate(step.payload, step.next).then(() => {
      settled = true;
    });
    await tick();
    const outcome = pause.resume("s-23");
    await running;
    check("常规继续走的是放行", outcome.released === true && outcome.woke === false);
    check("常规继续一条消息都没推", agents.followed.length === 0);
    check("那一步确实被放行了", settled === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 会话正在跑：不推。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-24", makePlan());
    createStore(root).patchHeld("s-24", { paused: true });
    const agents = makeAgents({ "s-24": { status: "running" } });
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-24");
    check("正在跑的会话不推消息", outcome.woke === false && agents.followed.length === 0);
    check("给出的是 busy 的说法", outcome.reason === "busy", JSON.stringify(outcome));
    check("正在跑时也留着状态（下一个岔口还会被按住）", store.readHeld("s-24").paused === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 会话还没被加载：只提示，不抛错。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-25", makePlan());
    createStore(root).patchHeld("s-25", { paused: true });
    const agents = makeAgents({});
    const { pause } = makeHarness({ store, agents });
    let outcome = null;
    let threw = false;
    try {
      outcome = pause.resume("s-25");
    } catch {
      threw = true;
    }
    check("拿不到 agent 也不抛错", threw === false);
    check(
      "降级成提示",
      outcome?.woke === false && outcome?.reason === "unloaded",
      JSON.stringify(outcome),
    );
    check("提示里讲了怎么办", String(outcome?.text ?? "").includes("发一条消息"), outcome?.text);
    check("没加载时不丢状态，用户还能再点一次", store.readHeld("s-25").paused === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 计划已经收尾：不推。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-26", makeFinishedPlan());
    createStore(root).patchHeld("s-26", { paused: true });
    const agents = makeAgents({ "s-26": { status: "idle" } });
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-26");
    check("计划收尾的会话不唤醒", outcome.woke === false && agents.followed.length === 0);
    check("给出的是 finished 的说法", outcome.reason === "finished", JSON.stringify(outcome));
    check("整棵树都结束了才清状态", store.readHeld("s-26").paused === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 目标还在、任务也还开着，只是**还没拆子任务**：这是"待拆分"，不是收尾。
  // 实机上就是这么卡住的：任务挂着没拆，点继续什么都不会发生。
  const root = makeRoot();
  try {
    const store = createStore(root);
    const plan = makePlan();
    plan.goals[0].tasks[0].steps = [];
    store.writePlan("s-28", plan);
    createStore(root).patchHeld("s-28", { paused: true });
    const agents = makeAgents({ "s-28": { status: "idle" } });
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-28");
    check(
      "任务还没拆子任务也要唤醒",
      outcome.woke === true && agents.followed.length === 1,
      JSON.stringify(outcome),
    );
    check(
      "推的是「接下来需要进行任务」",
      String(agents.followed[0]?.message?.content?.[0]?.text ?? "").includes("接下来需要进行任务"),
      JSON.stringify(agents.followed[0]?.message),
    );
    check("真唤醒了才清状态", store.readHeld("s-28").paused === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 检查点：任务下的子任务都结束了、任务自己还开着——要模型拍板，同样得唤醒。
  const root = makeRoot();
  try {
    const store = createStore(root);
    const plan = makePlan();
    plan.goals[0].tasks[0].steps[0].status = "done";
    store.writePlan("s-29", plan);
    createStore(root).patchHeld("s-29", { paused: true });
    const agents = makeAgents({ "s-29": { status: "idle" } });
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-29");
    check(
      "检查点也要唤醒（老判据把它当成了收尾）",
      outcome.woke === true && agents.followed.length === 1,
      JSON.stringify(outcome),
    );
    check(
      "推的是检查点的说法",
      String(agents.followed[0]?.message?.content?.[0]?.text ?? "").includes("检查点"),
      JSON.stringify(agents.followed[0]?.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // followup 自己抛错：状态保留，提示里带上原因。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-30", makePlan());
    createStore(root).patchHeld("s-30", { paused: true });
    const agents = {
      get: () => ({
        id: "s-30",
        status: "idle",
        followup() {
          throw new Error("boom");
        },
      }),
    };
    const { pause } = makeHarness({ store, agents });
    const outcome = pause.resume("s-30");
    check("唤醒抛错也不炸", outcome.woke === false && outcome.reason === "error", JSON.stringify(outcome));
    check("提示里带上原因", String(outcome.text).includes("boom"), outcome.text);
    check("出错时状态保留着", store.readHeld("s-30").paused === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 真人的消息：自动解除暂停，并把磁盘上的那一半也清掉。
  const root = makeRoot();
  try {
    const store = createStore(root);
    createStore(root).patchHeld("s-27", { paused: true });
    const { pause, gate } = makeHarness({ store });
    const step = makeStep("s-27", { human: true });
    const decision = await gate(step.payload, step.next);
    check("真人发言直接放行", decision?.kind === "enter");
    check("磁盘上的暂停跟着解除", store.readHeld("s-27").paused === false);
    check("内存里也不再说暂停", pause.isPaused("s-27") === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // 会话之间互不干扰：A 的 held 不影响 B。
  const root = makeRoot();
  try {
    const store = createStore(root);
    store.writePlan("s-28", makePlan());
    store.writePlan("s-29", makePlan());
    createStore(root).patchHeld("s-28", { paused: true });
    const agents = makeAgents({ "s-29": { status: "idle" } });
    const { pause } = makeHarness({ store, agents });
    check("A 暂停着", pause.isPaused("s-28") === true);
    check("B 没被牵连", pause.isPaused("s-29") === false);
    const outcome = pause.resume("s-29");
    check("推的是 B 那个会话", outcome.woke === true && agents.followed[0]?.sessionId === "s-29");
    check("A 的暂停态没被这次继续动过", store.readHeld("s-28").paused === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 汇总

console.log("\n" + "─".repeat(60));
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
  process.exit(0);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
