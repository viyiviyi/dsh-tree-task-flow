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
 *
 * waterfall 的契约是"必须 await next() 并把它返回"，所以每个场景除了看有没有
 * 结算，还要看 next 有没有被调用、返回值有没有原样传出去。
 *
 * 跑：node verify-pause.mjs
 */

import { registerPause } from "./lib/pause.js";

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

/** 假 ctx：只需要 `on`。多给的假件会掩盖真实耦合。 */
function makeHarness() {
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const autoContinue = makeAutoContinue();
  const pause = registerPause(ctx, { autoContinue });
  const gate = (handlers.get("agent/pre-step") ?? [])[0];
  return { handlers, autoContinue, pause, gate };
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
    messages: human ? [{ source: { kind: "user" } }] : [{ source: { kind: "plugin" } }],
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
