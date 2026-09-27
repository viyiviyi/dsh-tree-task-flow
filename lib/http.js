/**
 * 任务树条目用的 HTTP 接口。
 *
 * 条目跑在浏览器里，拿不到宿主内存中的 store，所以数据要经由这里出去。
 * 全部挂在 `/dsh-tree-task-flow/` 前缀下；只读写插件**自己的**状态目录，
 * 不碰会话日志（那是后端内部格式）。
 *
 * 条目要显示两样东西，都在这里算好给它：
 *
 *   - **每层的结果**：节点完成时提交的文本。条目不自己去挖计划树的深层结构，
 *     接口直接把三层各自的结果摆出来。
 *   - **检查点状态**：一个节点自己的子节点全部结束、而它自己还开着的那一刻。
 *     此刻只有两条路——继续拆子节点，或者提交结果并完成它。
 *
 * 条目上的按钮都写计划树，所以写完要把**新的**活动路径、结果与检查点一并回传，
 * 免得条目还要再发一次请求才知道自己按出了什么效果。
 *
 * @module dsh-tree-task-flow/http
 */

import { activePath, checkpointOf, complete, dropNode, levelLabel } from "./plan.js";

/** 统一的 JSON 响应。 */
function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/** 读请求体并解析 JSON；读不动就当空对象，别让面板拿到 500。 */
async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** 活动路径压成面板要的形状：三层各自的 id，没到那层就是 null。 */
function activeInfo(plan) {
  const active = activePath(plan);
  if (active === null) return null;
  return {
    goalId: active.goal.id,
    taskId: active.task?.id ?? null,
    stepId: active.step?.id ?? null,
  };
}

/** 检查点压成面板要的形状；没有检查点就是 null。 */
function checkpointInfo(plan) {
  const found = checkpointOf(plan);
  if (found === null) return null;
  return {
    id: found.node.id,
    level: found.level,
    label: levelLabel(found.level),
    title: found.node.title,
  };
}

/** 一个节点提交过的结果；还没提交就是 null。 */
function resultOf(node) {
  if (!node?.result) return null;
  return {
    id: node.id,
    title: node.title,
    text: node.result.text,
    at: node.result.at,
  };
}

/** 活动路径上每一层各自提交的结果。 */
function levelResults(plan) {
  const active = activePath(plan);
  return {
    goal: resultOf(active?.goal),
    task: resultOf(active?.task),
    step: resultOf(active?.step),
  };
}

/** 一次写操作之后，面板需要的全部新状态。 */
function afterWrite(plan) {
  return {
    active: activeInfo(plan),
    checkpoint: checkpointInfo(plan),
    results: levelResults(plan),
  };
}

/**
 * 注册全部面板接口。
 *
 * @param ctx - 挂载本行的 Cordis 上下文。
 * @param options - `{ store, autoContinue }`。
 */
export function registerHttp(ctx, { store, autoContinue }) {
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // 一棵树的全部信息：结构 + 每层结果 + 检查点 + 当前路径 + 三层折叠游标。
      host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-tree-task-flow/tree",
          handler: async (request, response) => {
            if (request.method !== "GET") return sendJson(response, 405, { ok: false, error: "只支持 GET" });
            const url = new URL(request.url ?? "/", "http://localhost");
            const sessionId = url.searchParams.get("sessionId") ?? "";
            const plan = store.readPlan(sessionId);
            if (plan === null) return sendJson(response, 404, { ok: false, error: "这个会话没有计划" });

            const cursors = store.readSurfaces(sessionId);
            sendJson(response, 200, {
              ok: true,
              plan,
              ...afterWrite(plan),
              cursors: {
                goal: cursors.goal ?? null,
                task: cursors.task ?? null,
                step: cursors.step ?? null,
              },
              stopped: autoContinue?.isStopped?.(sessionId) === true,
            });
          },
        },
        "dsh-tree-task-flow: tree",
      );

      // 面板上的按钮都走这一个端点。
      host.webServer.register(
        {
          kind: "exact",
          path: "/dsh-tree-task-flow/action",
          handler: async (request, response) => {
            if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "只支持 POST" });
            const body = await readJsonBody(request);
            const sessionId = String(body.sessionId ?? "");
            const action = String(body.action ?? "");

            if (action === "stop" || action === "resume") {
              autoContinue?.[action]?.(sessionId);
              return sendJson(response, 200, {
                ok: true,
                stopped: autoContinue?.isStopped?.(sessionId) === true,
              });
            }

            if (action === "reset") {
              store.writePlan(sessionId, null);
              // 计划没了，游标也必须跟着清：游标里记的是"这一层总结到哪儿了"，
              // 留着旧节点 id，下一次建树的第一层就会被误判成"没换节点"。
              store.writeSurfaces(sessionId, {
                sessionId,
                goal: null,
                task: null,
                step: null,
                updatedAt: Date.now(),
              });
              return sendJson(response, 200, { ok: true, active: null, checkpoint: null, results: null });
            }

            if (action === "done" || action === "drop") {
              const plan = store.readPlan(sessionId);
              if (plan === null) return sendJson(response, 404, { ok: false, error: "这个会话没有计划" });
              const id = String(body.id ?? "");
              // 完成必须带结果：插件要用它替换掉这个节点的执行过程。
              const outcome = action === "done" ? complete(plan, id, body.result) : dropNode(plan, id);
              if (!outcome.ok) return sendJson(response, 200, { ok: false, error: outcome.reason });
              store.writePlan(sessionId, plan);
              return sendJson(response, 200, {
                ok: true,
                events: outcome.events ?? outcome.dropped ?? [],
                ...afterWrite(plan),
              });
            }

            return sendJson(response, 400, { ok: false, error: `不认识的动作：${action}` });
          },
        },
        "dsh-tree-task-flow: action",
      );

      ctx.logger?.info?.("dsh-tree-task-flow: 设置面板接口已挂载");
    }, "dsh-tree-task-flow: http");
  });
}
