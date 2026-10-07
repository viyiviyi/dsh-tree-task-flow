/**
 * compaction.js 的压缩后提示自测。
 *
 * 钉住的规则：
 *
 *   1. 只有「这个会话有计划树」且「表层里出现了压缩检查点」才提示；
 *   2. 同一个检查点只提示一次，再压缩一次才会再提示；
 *   3. 提示与折叠通告同形：`tree_task消息：` 开头、plugin/notice 形态、带 surfaceOp；
 *   4. 拒绝、中止、没有会话时一律不动；
 *   5. 注入失败不往外抛，也不推进去重位置（下一轮还能再试）。
 *
 * 认的是**表层里那条** `user/message`（source 为 `plugin: "compact"`），
 * 不是 `compaction/summary` 事件——后者不带 surfaceOp，根本不在表层里。
 * 假 session 因此会同时提供这两种形态，用来证明"只认对的那一种"。
 *
 * 跑：node verify-compaction.mjs
 */

import { latestCompactionSeq, registerCompactionNotice } from "./lib/compaction.js";

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
const ctx = {
  on(event, handler) {
    if (event === "agent/pre-step") handlers.push(handler);
  },
  logger: { warn: (...parts) => warnings.push(parts.join(" ")) },
};
const handlers = [];

/** 假 session：表层是位置顺序的数组，append 必须显式声明 surfaceOp。 */
let sessionCounter = 0;
function makeSession(id) {
  // 每个场景一个独立会话 id：去重状态按会话隔离，共用 id 会让场景之间串味。
  const sessionId = id ?? `session-${(sessionCounter += 1)}`;
  const events = [];
  const nodes = [];
  let next = 0;
  let failNext = false;

  function put(type, data, opts) {
    const seq = next;
    next += 1;
    events[seq] = {
      type,
      data,
      ...(opts?.surfaceOp === undefined ? {} : { surfaceOp: opts.surfaceOp }),
      ...(opts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    };
    return seq;
  }

  return {
    id: sessionId,
    get surface() {
      return { nodes: [...nodes] };
    },
    eventAt(seq) {
      return events[seq];
    },
    append(type, data, opts) {
      if (failNext) {
        failNext = false;
        throw new Error("注入失败（测试）");
      }
      if (opts?.surfaceOp === undefined) {
        throw new Error(`surface event "${type}" requires a surfaceOp marker`);
      }
      const seq = put(type, data, opts);
      nodes.push(seq);
      return events[seq];
    },
    /** 测试用：往表层放一条真人消息。 */
    addHuman(text) {
      const seq = put("user/message", {
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }, { surfaceOp: "append" });
      nodes.push(seq);
      return seq;
    },
    /** 测试用：放一个压缩检查点（表层里那条 user/message）。 */
    addCompactionCheckpoint(compactionId = "c-1") {
      const seq = put("user/message", {
        role: "user",
        content: [{ type: "text", text: "This is an automatically generated checkpoint …" }],
        source: { kind: "plugin", plugin: "compact", compactionId },
      }, { surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 } });
      nodes.push(seq);
      return seq;
    },
    /** 测试用：放一个 `compaction/summary` 事件——它不带 surfaceOp，不在表层里。 */
    addCompactionSummaryEvent() {
      return put("compaction/summary", { compactionId: "c-1", summary: [] });
    },
    failNextAppend() {
      failNext = true;
    },
    /** 测试用：把压缩检查点从表层移除，模拟被同一轮折叠收走。 */
    hideCompaction() {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const event = events[nodes[index]];
        if (event?.type === "user/message" && event.data?.source?.plugin === "compact") {
          nodes.splice(index, 1);
        }
      }
    },
    live: () => [...nodes],
    /** 本插件注入的提示条数。 */
    noticeCount() {
      return nodes.filter((seq) => {
        const event = events[seq];
        return event?.type === "user/message" && event.data?.source?.plugin === "dsh-tree-task-flow";
      }).length;
    },
    lastNotice() {
      const seqs = nodes.filter((seq) => {
        const event = events[seq];
        return event?.type === "user/message" && event.data?.source?.plugin === "dsh-tree-task-flow";
      });
      return seqs.length === 0 ? null : events[seqs[seqs.length - 1]];
    },
  };
}

/** 假 store：内存里的计划表与游标表。 */
function makeStore({ withPlan = true } = {}) {
  const surfaces = new Map();
  return {
    // 有没有计划只由 withPlan 决定，不看 sessionId——计划的归属由 verify-plan 管。
    readPlan: () => (withPlan ? { version: 2, goals: [] } : null),
    writePlan: () => {},
    readSurfaces: (id) =>
      surfaces.get(id) ?? {
        sessionId: id,
        goal: null,
        task: null,
        step: null,
        compactionNoticeAt: null,
        updatedAt: null,
      },
    writeSurfaces: (id, value) => surfaces.set(id, value),
  };
}

/** 跑一次 pre-step（handler 已注册）。 */
function step(session, { decision = { kind: "ok" }, aborted = false } = {}) {
  const handler = handlers[0];
  return handler({ agent: { session }, signal: { aborted } }, async () => decision);
}

function textOf(event) {
  return (event?.data?.content ?? []).map((block) => block.text ?? "").join("");
}

// ---------------------------------------------------------------- 注册

const store = makeStore();
registerCompactionNotice(ctx, { store });
check("注册了一个 agent/pre-step 监听器", handlers.length === 1, `handlers=${handlers.length}`);

// ---------------------------------------------------------------- 不该提示的情形

const noPlanHandlers = [];
registerCompactionNotice(
  {
    on: (event, handler) => {
      if (event === "agent/pre-step") noPlanHandlers.push(handler);
    },
    logger: ctx.logger,
  },
  { store: makeStore({ withPlan: false }) },
);
const noPlanSession = makeSession();
noPlanSession.addCompactionCheckpoint();
await noPlanHandlers[0](
  { agent: { session: noPlanSession }, signal: { aborted: false } },
  async () => ({ kind: "ok" }),
);
check("没有计划树就不提示", noPlanSession.noticeCount() === 0, `条数=${noPlanSession.noticeCount()}`);

const cleanSession = makeSession();
cleanSession.addHuman("开始干活");
await step(cleanSession);
check("有计划树但没压缩过时不提示", cleanSession.noticeCount() === 0, `条数=${cleanSession.noticeCount()}`);

const summaryOnly = makeSession();
summaryOnly.addCompactionSummaryEvent();
await step(summaryOnly);
check(
  "只有 compaction/summary 事件（不在表层）时不提示",
  summaryOnly.noticeCount() === 0,
  `条数=${summaryOnly.noticeCount()}`,
);

// ---------------------------------------------------------------- 该提示的情形

const session = makeSession();
session.addHuman("开始干活");
session.addCompactionCheckpoint("c-1");
const nodesBeforeNotice = session.live().length;
await step(session);

check("有压缩检查点时提示一次", session.noticeCount() === 1, `条数=${session.noticeCount()}`);
const notice = session.lastNotice();
check("提示以 tree_task消息： 开头", textOf(notice).startsWith("tree_task消息："), textOf(notice).slice(0, 30));
check("提示里点名 tree_task_status", textOf(notice).includes("tree_task_status"));
check("提示的 source.kind 是 plugin", notice?.data?.source?.kind === "plugin");
check("提示的 source.plugin 是本插件", notice?.data?.source?.plugin === "dsh-tree-task-flow");
check("提示的 source.form 是 notice", notice?.data?.source?.form === "notice");
check("提示带一行摘要", typeof notice?.data?.source?.summary === "string" && notice.data.source.summary.length > 0);
check("提示带 surfaceOp: append", notice?.surfaceOp === "append");
check(
  "提示是追加到表层末尾，不是替换",
  session.live().length === nodesBeforeNotice + 1,
  `节点数 ${session.live().length}，期望 ${nodesBeforeNotice + 1}`,
);

// ---------------------------------------------------------------- 去重

await step(session);
check("同一个检查点不重复提示", session.noticeCount() === 1, `条数=${session.noticeCount()}`);

session.addCompactionCheckpoint("c-2");
await step(session);
check("又压缩一次会再提示一条", session.noticeCount() === 2, `条数=${session.noticeCount()}`);

// ---------------------------------------------------------------- 拒绝与中止

const rejected = makeSession();
rejected.addCompactionCheckpoint();
await step(rejected, { decision: { kind: "reject" } });
check("decision 为 reject 时不提示", rejected.noticeCount() === 0, `条数=${rejected.noticeCount()}`);

const aborted = makeSession();
aborted.addCompactionCheckpoint();
await step(aborted, { aborted: true });
check("signal 已中止时不提示", aborted.noticeCount() === 0, `条数=${aborted.noticeCount()}`);

const noSession = handlers[0];
const before = warnings.length;
await noSession({ agent: {}, signal: { aborted: false } }, async () => ({ kind: "ok" }));
check("没有 session 时不抛错也不提示", warnings.length === before);

// ---------------------------------------------------------------- 检出在前、注入在后

const swallowed = makeSession();
swallowed.addHuman("开始干活");
swallowed.addCompactionCheckpoint("c-3");
await handlers[0]({ agent: { session: swallowed }, signal: { aborted: false } }, async () => {
  // 模拟同一轮折叠把压缩检查点收走：检出若放在后置，这次提示就会漏掉。
  swallowed.hideCompaction();
  return { kind: "ok" };
});
check(
  "检查点被同一轮折叠收走时仍然提示",
  swallowed.noticeCount() === 1,
  `条数=${swallowed.noticeCount()}`,
);

const late = makeSession();
late.addHuman("开始干活");
await handlers[0]({ agent: { session: late }, signal: { aborted: false } }, async () => {
  // 模拟压缩发生在内层：前置时还没有检查点，后置才出现。
  late.addCompactionCheckpoint("c-4");
  return { kind: "ok" };
});
check(
  "压缩发生在内层（前置看不到）时也提示",
  late.noticeCount() === 1,
  `条数=${late.noticeCount()}`,
);

// ---------------------------------------------------------------- 注入失败

const failing = makeSession();
failing.addCompactionCheckpoint("c-9");
failing.failNextAppend();
const warnsBefore = warnings.length;
await step(failing);
check("注入失败不往外抛", failing.noticeCount() === 0, `条数=${failing.noticeCount()}`);
check("注入失败留下一条 warn", warnings.length === warnsBefore + 1, `warn=${warnings.length - warnsBefore}`);

await step(failing);
check("注入失败后下一轮还能再试", failing.noticeCount() === 1, `条数=${failing.noticeCount()}`);

// ---------------------------------------------------------------- 纯函数

const probe = makeSession();
check("没有压缩检查点时 latestCompactionSeq 返回 null", latestCompactionSeq(probe) === null);
const probeSeq = probe.addCompactionCheckpoint();
check("有压缩检查点时返回它的 seq", latestCompactionSeq(probe) === probeSeq);
probe.addHuman("后来的真人消息");
check("后加的普通消息不影响判断", latestCompactionSeq(probe) === probeSeq);

// ---------------------------------------------------------------- 汇总

console.log(`\n${pass} 项通过${failures.length === 0 ? "，全部通过。" : `，${failures.length} 项失败：`}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
