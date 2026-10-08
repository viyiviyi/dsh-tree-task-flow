/**
 * 消息 source 形状的自测。
 *
 * 钉住的是**写入侧的 source 契约**——2026-10-08 那次「会话卡死」的根因：
 *
 *   DSH 的会话格式 v4 要求消息来源带**生产者自有的** kind。老写法
 *   `{ kind: "plugin", plugin: "包名" }` 只在 v3 → v4 迁移那一刻被改写，
 *   **已经是 v4 的会话不走迁移**，写入时直接按 v4 校验，于是被拒：
 *
 *       format v4 message requires a producer-owned source kind
 *
 *   这条错误出在 DSH 自己的落盘路径（`releasedV4SessionFormatCodec.encodeEvent`
 *   → `assertV4RowAdmission` → `assertV4SourceRowAdmission`），插件里的 try/catch
 *   拦不住；一旦会话迁到 v4，折叠通告、压缩提示、续行消息**全部注入失败**，
 *   计划树在会话里彻底哑掉。
 *
 * 所以这里钉四件事：
 *
 *   1. 写出去的 kind **就是** `plugin:dsh-tree-task-flow`，且不再带 `plugin` 字段；
 *   2. 读回来时**两种形状都认**（新会话是新写法，没迁移的老会话仍是老写法）；
 *   3. `lib/` 里不允许再出现写入侧的老写法（源码级回归闸）；
 *   4. 能在这台机器上找到 DSH 的话，**拿真的 v4 编码器当场验一遍**：
 *      新写法通过、老写法被拒。
 *
 * 跑：node verify-source.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN,
  PLUGIN_SOURCE_KIND,
  isPluginSource,
  pluginSource,
  summaryMessage,
} from "./lib/region.js";

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

// ---------------------------------------------------------------- 写出去的东西

console.log("\n写出去的 source：");

check("插件名没变", PLUGIN === "dsh-tree-task-flow", PLUGIN);
check(
  "source kind 是生产者自有的 plugin:<包名>",
  PLUGIN_SOURCE_KIND === "plugin:dsh-tree-task-flow",
  PLUGIN_SOURCE_KIND,
);

const source = pluginSource("一行摘要");
check("pluginSource 的 kind 是 PLUGIN_SOURCE_KIND", source.kind === PLUGIN_SOURCE_KIND, String(source.kind));
check("pluginSource 不再带老写法的 plugin 字段", source.plugin === undefined, String(source.plugin));
check("pluginSource 保留 form: notice", source.form === "notice", String(source.form));
check("pluginSource 保留 summary", source.summary === "一行摘要", String(source.summary));

const notice = summaryMessage("tt-x-1", "tree_task消息：正文", "一行摘要");
check("summaryMessage 的 source 与 pluginSource 同形", notice.source.kind === PLUGIN_SOURCE_KIND, String(notice.source.kind));
check("summaryMessage 的 source 里没有 plugin 字段", !("plugin" in notice.source), JSON.stringify(notice.source));
check("summaryMessage 的 role 仍是 user", notice.role === "user", String(notice.role));
check("summaryMessage 的 id 原样带上", notice.id === "tt-x-1", String(notice.id));
check(
  "summaryMessage 的正文原样带上",
  notice.content?.[0]?.type === "text" && notice.content[0].text === "tree_task消息：正文",
);

// ---------------------------------------------------------------- 读回来的东西

console.log("\n读回来认哪些 source：");

check("认新写法", isPluginSource({ kind: PLUGIN_SOURCE_KIND, form: "notice", summary: "x" }) === true);
check("认老写法（迁移前留在 v3 会话里的）", isPluginSource({ kind: "plugin", plugin: PLUGIN }) === true);
check("不认真人消息", isPluginSource({ kind: "user" }) === false);
check("不认只有 kind: plugin、没有包名的", isPluginSource({ kind: "plugin" }) === false);
check("不认别的插件的老写法", isPluginSource({ kind: "plugin", plugin: "别的插件" }) === false);
check("不认别的插件的新写法", isPluginSource({ kind: "plugin:别的插件" }) === false);
check("不认 undefined", isPluginSource(undefined) === false);
check("不认 null", isPluginSource(null) === false);
check("不认压缩检查点", isPluginSource({ kind: "compact-checkpoint" }) === false);

// ---------------------------------------------------------------- 源码级回归闸

console.log("\nlib/ 里不许再写老写法：");

const libDir = join(import.meta.dirname, "lib");
const libFiles = readdirSync(libDir).filter((name) => name.endsWith(".js"));
// 只抓**对象字面量**形式的写入侧老写法：source: { kind: "plugin" …
// 读侧的兼容判断写的是 `source.kind === "plugin"`，不会命中。
const writerPattern = /source:\s*\{\s*kind:\s*["']plugin["']/u;
const offenders = libFiles.filter((name) => writerPattern.test(readFileSync(join(libDir, name), "utf8")));
check("没有模块往 source 里写字面量 kind: \"plugin\"", offenders.length === 0, offenders.join(", "));

// ---------------------------------------------------------------- 拿真的编码器验

console.log("\n拿真的 DSH 编码器验（找不到就跳过）：");

/** 在 node 安装目录里找 DSH 自带的会话格式编解码器。 */
function findV4Codec() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-session-format-v3-to-v4", "lib", "index.js"),
    join(dirname(process.execPath), "node_modules", "@deepseek-ai", "dsh-session-format-v3-to-v4", "lib", "index.js"),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

const codecFile = findV4Codec();
if (codecFile === null) {
  console.log("  SKIP  这台机器上没找到 DSH 的会话格式模块");
} else {
  const { releasedV4SessionFormatCodec } = await import(pathToFileURL(codecFile).href);
  const event = (src) => ({
    type: "user/message",
    seq: 1,
    time: Date.now(),
    surfaceOp: "append",
    data: { id: "tt-x-1", role: "user", content: [{ type: "text", text: "探针" }], source: src },
  });

  let v4Error = null;
  try {
    releasedV4SessionFormatCodec.encodeEvent(event({ kind: PLUGIN_SOURCE_KIND, form: "notice", summary: "x" }));
  } catch (error) {
    v4Error = error;
  }
  check("新写法能过 v4 编码器", v4Error === null, String(v4Error?.message ?? ""));

  let legacyError = null;
  try {
    releasedV4SessionFormatCodec.encodeEvent(event({ kind: "plugin", plugin: PLUGIN }));
  } catch (error) {
    legacyError = error;
  }
  check("老写法确实被 v4 编码器拒掉（这就是那个 bug）", legacyError !== null);
  check(
    "拒的理由与线上报错一字不差",
    String(legacyError?.message ?? "").includes("format v4 message requires a producer-owned source kind"),
    String(legacyError?.message ?? ""),
  );
}

// ---------------------------------------------------------------- 收尾

console.log("\n────────────────────────────────────────────────────────────");
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
