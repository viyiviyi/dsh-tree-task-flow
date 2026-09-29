/**
 * region.js 的折叠行为自测。
 *
 * 钉住的规则只有一条，纯表层、与计划树无关：
 *
 *   从上一个**边界调用**之后，到下一个 `tree_task_done` 之前，中间那一段过程收走。
 *   边界调用 = `tree_task_create` / `tree_task_plan` / `tree_task_done`。
 *
 * 由此推出四件必须成立的事：
 *
 *   1. 边界调用的调用与返回都留在表层上（模型靠它们看计划与下一步）；
 *   2. 中间夹着真人消息就**整段不折**——往前折丢需求，往后折丢回应；
 *   3. 两次边界调用挨着（中间没有过程）就**什么都不注入**；
 *   4. 末尾最近的那次边界调用不是 done（比如刚调完 plan）就不折。
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

import { foldOnce, foldRange, touchedFiles } from "./lib/region.js";

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
    return `#${seq} ${event?.type} ${text.slice(0, 64).replace(/\n/gu, " ⏎ ")}`;
  });
}

/** 模拟一段执行过程：assistant 消息 + 工具结果。 */
function work(session, rounds) {
  for (let index = 0; index < rounds; index += 1) {
    session.append("assistant/message", { message: { content: [{ type: "text", text: `执行第 ${index} 轮` }] } }, { surfaceOp: "append" });
    session.append("tool/result", { message: { content: [{ type: "text", text: `工具结果 ${index}` }] } }, { surfaceOp: "append" });
  }
}

/** 模拟一次工具调用：assistant/message（tool-call）+ tool/result。 */
function toolCall(session, name, args, id) {
  const call = session.append(
    "assistant/message",
    { message: { content: [{ type: "tool-call", id, name, arguments: JSON.stringify(args ?? {}) }] } },
    { surfaceOp: "append" },
  ).seq;
  const result = session.append(
    "tool/result",
    { message: { content: [{ type: "tool-result", toolCallId: id, content: [{ type: "text", text: `${name} 的返回` }] }] } },
    { surfaceOp: "append" },
  ).seq;
  return { call, result };
}

/** 三个边界调用。 */
const create = (session, id) => toolCall(session, "tree_task_create", { title: "目标" }, id);
const plan = (session, id) => toolCall(session, "tree_task_plan", { parentId: "g-1" }, id);
const done = (session, id) => toolCall(session, "tree_task_done", { id: "s-1", result: "结果" }, id);

/** 模拟一次文件类工具调用。 */
function fileCall(session, tool, path, id) {
  toolCall(session, tool, { file_path: path }, id);
}

/** 真人发言（带 source；插件注入的消息 source 是 plugin）。 */
function humanSay(session, text) {
  return session.append(
    "user/message",
    { content: [{ type: "text", text }], source: { kind: "user" } },
    { surfaceOp: "append" },
  ).seq;
}

/** 系统提示词 + 一条真人消息：真实会话的开头。 */
function boot(session) {
  session.append("system/message", { message: { content: [{ type: "text", text: "系统提示词" }] } }, { surfaceOp: "append" });
  humanSay(session, "帮我做件事");
}

/** surface 上最后一条折叠通告。 */
function lastNotice(session) {
  const live = session.live();
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const text = textOf(session.eventAt(live[index]));
    if (text.startsWith("tree_task消息：隐藏了")) return { seq: live[index], text };
  }
  return null;
}

function countNotices(session) {
  return session.live().filter((seq) => textOf(session.eventAt(seq)).startsWith("tree_task消息：隐藏了")).length;
}

// ---------------------------------------------------------------- 场景 1

console.log("\n场景 1 · 区间就是两次边界调用之间那一段");
{
  const session = makeSession();
  boot(session);
  const c = create(session, "c1");
  work(session, 2);
  const p = plan(session, "p1");
  work(session, 3);
  const d = done(session, "d1");

  const live = session.live();
  const range = foldRange(session);
  check("区间起点在 plan 调用之后（连它的返回一起跳过）",
    range !== null && range.from === live.indexOf(p.result) + 1,
    `range=${JSON.stringify(range)} surface=${JSON.stringify(live)}`);
  check("区间终点在 done 调用之前",
    range !== null && range.to === live.indexOf(d.call) - 1,
    `range=${JSON.stringify(range)}`);

  const folded = foldOnce(ctx, session);
  const after = session.live();
  const notice = lastNotice(session);
  check("确实折了", folded === true && notice !== null, JSON.stringify(after));
  check("只报了 plan 与 done 之间那 6 条",
    notice.text === "tree_task消息：隐藏了6条过程上下文。", JSON.stringify(notice.text));
  check("create / plan / done 的调用与返回都还在",
    [c, p, d].every((each) => after.includes(each.call) && after.includes(each.result)),
    `surface = ${JSON.stringify(after)}`);
  check("通告落在 plan 返回之后、done 调用之前",
    after.indexOf(notice.seq) > after.indexOf(p.result) && after.indexOf(notice.seq) < after.indexOf(d.call),
    `surface = ${JSON.stringify(after)}`);

  console.log("  surface:");
  for (const line of surfaceLines(session)) console.log(`    ${line}`);
}

// ---------------------------------------------------------------- 场景 2

console.log("\n场景 2 · 末尾最近的那次边界调用不是 done 就不折");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  work(session, 2);
  plan(session, "p1");
  work(session, 1);

  check("刚调完 plan，还没完成任何节点：这一轮不折",
    foldRange(session) === null && foldOnce(ctx, session) === false,
    `surface = ${JSON.stringify(session.live())}`);
  check("什么都没注入", countNotices(session) === 0);
  check("没有抛异常、没有 warn", warnings.length === 0, JSON.stringify(warnings));
}

// ---------------------------------------------------------------- 场景 3

console.log("\n场景 3 · 两次边界调用挨着：什么都不注入");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  plan(session, "p1");
  done(session, "d1");

  const before = session.live();
  check("中间没有过程，区间为空", foldRange(session) === null, `surface = ${JSON.stringify(before)}`);
  check("不折也不注入", foldOnce(ctx, session) === false && countNotices(session) === 0);
  check("表层一个节点都没变",
    JSON.stringify(session.live()) === JSON.stringify(before), JSON.stringify(session.live()));
}

// ---------------------------------------------------------------- 场景 4

console.log("\n场景 4 · 中间夹着真人消息：整段不折");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  work(session, 1);
  const ask = humanSay(session, "等等，先别写文件");
  work(session, 2);
  done(session, "d1");

  const before = session.live();
  const range = foldRange(session);
  check("区间确实横跨了那条真人消息",
    range !== null && range.shadowed.includes(ask), JSON.stringify(range));
  check("整段不折", foldOnce(ctx, session) === false, `surface = ${JSON.stringify(before)}`);
  check("一个节点都没动、也没注入",
    JSON.stringify(session.live()) === JSON.stringify(before) && countNotices(session) === 0);
}

// ---------------------------------------------------------------- 场景 5

console.log("\n场景 5 · 真人消息在区间之外不影响折叠");
{
  const session = makeSession();
  boot(session);
  const ask = humanSay(session, "换个说法");
  const c = create(session, "c1");
  work(session, 1);
  done(session, "d1");

  const folded = foldOnce(ctx, session);
  const after = session.live();
  const notice = lastNotice(session);
  check("照折", folded === true && notice !== null, JSON.stringify(after));
  check("那条真人消息不在区间里、也还在表层上",
    after.includes(ask), `surface = ${JSON.stringify(after)}`);
  check("create 的调用与返回也还在",
    after.includes(c.call) && after.includes(c.result), `surface = ${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------- 场景 6

console.log("\n场景 6 · 正文附上读写了哪些文件");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  fileCall(session, "read", "C:/w/a.js", "r1");
  fileCall(session, "read", "C:/w/b.js", "r2");
  fileCall(session, "read", "C:/w/a.js", "r3");
  fileCall(session, "write", "C:/w/c.js", "w1");
  fileCall(session, "edit", "C:/w/c.js", "e1");
  toolCall(session, "pwsh", { command: "node x.js" }, "p1");
  done(session, "d1");

  foldOnce(ctx, session);
  const notice = lastNotice(session);
  check("读取列表去重、按出现顺序",
    notice.text.includes("读取：C:/w/a.js、C:/w/b.js"), JSON.stringify(notice.text));
  check("写入列表分开列，同一文件既读又写也各算一次",
    notice.text.includes("写入：C:/w/c.js"), JSON.stringify(notice.text));
  check("命令类调用不产生文件条目", !notice.text.includes("d.js"), JSON.stringify(notice.text));
  check("多行：条数一行、读一行、写一行", notice.text.split("\n").length === 3, JSON.stringify(notice.text));
}

// ---------------------------------------------------------------- 场景 7

console.log("\n场景 7 · done 之后又干活，区间仍止于新的那次 done 之前");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  work(session, 1);
  const d1 = done(session, "d1");
  work(session, 2);
  const d2 = done(session, "d2");

  foldOnce(ctx, session);
  const after = session.live();
  const notice = lastNotice(session);
  check("区间从 d1 调用之后收到 d2 调用之前（那 4 条过程）",
    notice !== null && notice.text === "tree_task消息：隐藏了4条过程上下文。", JSON.stringify(notice?.text));
  check("d1 与 d2 的调用和返回都还在",
    [d1, d2].every((each) => after.includes(each.call) && after.includes(each.result)),
    `surface = ${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------- 场景 8

console.log("\n场景 8 · 找不到更早的边界调用：退回表层第一个节点之后");
{
  const session = makeSession();
  boot(session);
  work(session, 2);
  done(session, "d1");

  const range = foldRange(session);
  check("起点退回节点 0 之后（系统提示词不能进替换区间）",
    range !== null && range.from === 1, JSON.stringify(range));
  check("区间里撞上真人消息，于是整段不折",
    foldOnce(ctx, session) === false && countNotices(session) === 0);
  check("真人消息完好", textOf(session.eventAt(session.live()[1])) === "帮我做件事");
}

// ---------------------------------------------------------------- 场景 9

console.log("\n场景 9 · 一轮只折一次，折完这一段就没了");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  work(session, 2);
  done(session, "d1");

  check("第一次折成功", foldOnce(ctx, session) === true);
  check("紧接着再折一次：区间已经没了，什么都不做",
    foldOnce(ctx, session) === false && countNotices(session) === 1,
    `surface = ${JSON.stringify(session.live())}`);
}

// ---------------------------------------------------------------- 场景 10

console.log("\n场景 10 · 工具函数：foldRange 与 touchedFiles");
{
  const session = makeSession();
  boot(session);
  create(session, "c1");
  fileCall(session, "read", "C:/w/a.js", "r1");
  fileCall(session, "write", "C:/w/b.js", "w1");
  done(session, "d1");

  const range = foldRange(session);
  const files = touchedFiles(session, range.shadowed);
  check("touchedFiles 如实报出读与写",
    files.read.length === 1 && files.read[0] === "C:/w/a.js" &&
      files.write.length === 1 && files.write[0] === "C:/w/b.js",
    JSON.stringify(files));

  check("折一次", foldOnce(ctx, session) === true);
  check("折完之后，同一次调用之间再无可收的内容",
    foldOnce(ctx, session) === false && countNotices(session) === 1,
    `surface = ${JSON.stringify(session.live())}`);
  check("落下的那条通告没有被后来这一次折掉",
    lastNotice(session) !== null, `surface = ${JSON.stringify(session.live())}`);

  const empty = makeSession();
  empty.append("system/message", { message: { content: [{ type: "text", text: "系统提示词" }] } }, { surfaceOp: "append" });
  check("表层只有系统提示词时返回 null", foldRange(empty) === null);
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
