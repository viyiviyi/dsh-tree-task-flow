/**
 * 入口装配自测（index.js + prompt.js）。
 *
 * 用假 ctx 直接跑 `apply`，覆盖三件事：
 *
 *   1. 启用后注册的是**六个**工具，记忆三工具与全部 `needs` 字段都清干净了。
 *   2. 资料层已经不存在：`lib/resource.js` 没了，也没有任何模块还引用它、
 *      或残留 `registerResourceCapture` / `injectResources` / `pickResources` 之类的符号；
 *      配置项里也没有资料相关的开关。
 *   3. 提示词**只有一段、静态**——注册的正文是常量字符串本身，文本里不含
 *      `needs` 与记忆相关的说法；两次装配得到逐字节相同的一段。
 *
 * 另外核对未启用态：一个工具、一段提示词都不注册，只留命令与面板接口。
 *
 * 假 ctx 只实现 `apply` 装配路径真正用到的那几样：`effect` / `systemPrompt.section`
 * / `tools.register` / `on` / `get` / `inject` / `logger`。
 *
 * 跑：node verify-entry.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG, apply, inject, name as PLUGIN_NAME } from "./lib/index.js";
import { DEFAULT_ORDER, SECTION_NAME, SECTION_TEXT, registerPromptSection } from "./lib/prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "lib");

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

/** 新模型下的六个工具。 */
const SIX_TOOLS = [
  "tree_task_status",
  "tree_task_create",
  "tree_task_plan",
  "tree_task_done",
  "tree_task_update",
  "tree_task_drop",
];

/** 已移除的记忆三工具——再出现在任何地方都说明删漏了。 */
const REMOVED_TOOLS = ["tree_task_save", "tree_task_recall", "tree_task_forget"];

/** 假 ctx：只给装配路径真正用到的东西，多给会掩盖真实耦合。 */
function makeHarness() {
  const tools = [];
  const sections = [];
  const handlers = new Map();
  const effects = [];
  const injected = [];
  const logs = [];

  const ctx = {
    effect(register, label) {
      effects.push(label);
      return register();
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
      },
    },
    tools: {
      register(def) {
        tools.push(def);
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    get() {
      return undefined;
    },
    inject(services) {
      injected.push(services);
    },
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      debug: (message) => logs.push(message),
    },
  };

  return { ctx, tools, sections, handlers, effects, injected, logs };
}

const stateRoot = () => join(HERE, ".verify-entry-state");

// ---------------------------------------------------------------- 启用态

console.log("启用态：");
const on = makeHarness();
apply(on.ctx, { enabled: true, rootDir: stateRoot() });

const names = on.tools.map((tool) => tool.name).sort();
const toolNames = names.join(", ");

check("插件名是 dsh-tree-task-flow", PLUGIN_NAME === "dsh-tree-task-flow", PLUGIN_NAME);
check(
  "inject 只声明 systemPrompt 与 tools",
  inject.length === 2 && inject.includes("systemPrompt") && inject.includes("tools"),
  JSON.stringify(inject),
);
check("注册了六个工具", names.length === 6, toolNames);
check(
  "六个工具正好是这一组",
  SIX_TOOLS.every((want) => names.includes(want)),
  toolNames,
);
check(
  "记忆三工具一个都没有",
  REMOVED_TOOLS.every((gone) => !names.includes(gone)),
  toolNames,
);
check(
  "没有任何工具 schema 提到 needs",
  on.tools.every((tool) => !JSON.stringify(tool.parameters ?? {}).includes("needs")),
);
check(
  "没有任何工具描述提到 needs 或记忆",
  on.tools.every((tool) => !/needs|记忆/u.test(tool.description ?? "")),
);

const doneTool = on.tools.find((tool) => tool.name === "tree_task_done");
check(
  "tree_task_done 的 result 必填",
  (doneTool?.parameters?.required ?? []).includes("result"),
  JSON.stringify(doneTool?.parameters?.required),
);
check(
  "tree_task_done 的 result 有说明",
  typeof doneTool?.parameters?.properties?.result?.description === "string",
);

// ---------------------------------------------------------------- 提示词

console.log("\n提示词段落：");
check("只注册了一段", on.sections.length === 1, String(on.sections.length));
check("段落名固定", on.sections[0]?.name === SECTION_NAME, String(on.sections[0]?.name));
check("段落排序固定", on.sections[0]?.order === DEFAULT_ORDER, String(on.sections[0]?.order));
check(
  "正文是常量字符串本身（静态）",
  typeof on.sections[0]?.text === "string" && on.sections[0].text === SECTION_TEXT,
);
check("文本不含 needs", !SECTION_TEXT.includes("needs"));
check("文本不含“记忆”", !SECTION_TEXT.includes("记忆"));
check(
  "文本不含记忆三工具",
  REMOVED_TOOLS.every((gone) => !SECTION_TEXT.includes(gone)),
  REMOVED_TOOLS.filter((gone) => SECTION_TEXT.includes(gone)).join(", "),
);
check(
  "文本提到全部六个工具",
  SIX_TOOLS.every((want) => SECTION_TEXT.includes(want)),
  SIX_TOOLS.filter((want) => !SECTION_TEXT.includes(want)).join(", "),
);
check("文本不再讲资料注入", !SECTION_TEXT.includes("资料"));
check(
  "registerPromptSection 返回 disposer（供 effect 持有）",
  typeof registerPromptSection(on.ctx, DEFAULT_ORDER) === "function",
);

// 再装配一次，确认这一段的字节不随装配次数变化。
const again = makeHarness();
apply(again.ctx, { enabled: true, rootDir: stateRoot() });
check(
  "两次装配得到逐字节相同的一段",
  again.sections[0]?.text === on.sections[0]?.text && again.sections.length === 1,
);

// ---------------------------------------------------------------- 监听面

console.log("\n监听面：");
check("挂了检查点闸门", on.handlers.has("tools/pre-execute"));
check(
  "pre-step 上正好两个监听（折叠 + 续行）",
  (on.handlers.get("agent/pre-step") ?? []).length === 2,
  String((on.handlers.get("agent/pre-step") ?? []).length),
);
check("挂了停止信号监听", on.handlers.has("agent/turn-stopping"));
check("挂了状态监听", on.handlers.has("agent/status"));
check(
  "没有挂 tools/result（资料捕获已随资料层一起删除）",
  !on.handlers.has("tools/result"),
);

// ---------------------------------------------------------------- 资料层

console.log("\n资料层：");
check("lib/resource.js 已删除", !existsSync(join(LIB, "resource.js")));

const libFiles = readdirSync(LIB).filter((file) => file.endsWith(".js"));
const sources = Object.fromEntries(
  libFiles.map((file) => [file, readFileSync(join(LIB, file), "utf8")]),
);

check(
  "没有模块引用 resource.js",
  libFiles.every((file) => !/["'][^"']*resource\.js["']/u.test(sources[file])),
  libFiles.filter((file) => /["'][^"']*resource\.js["']/u.test(sources[file])).join(", "),
);
check(
  "资料层符号已清干净",
  libFiles.every(
    (file) =>
      !/registerResourceCapture|injectResources|pickResources|normalizePathKey|resourceTotalBytes/u.test(
        sources[file],
      ),
  ),
  libFiles
    .filter((file) =>
      /registerResourceCapture|injectResources|pickResources|normalizePathKey|resourceTotalBytes/u.test(
        sources[file],
      ),
    )
    .join(", "),
);
check(
  "lib 里没有文件名带 resource",
  libFiles.every((file) => !/resource/iu.test(file)),
  libFiles.filter((file) => /resource/iu.test(file)).join(", "),
);
check(
  "配置项里没有资料相关开关",
  !Object.keys(DEFAULT_CONFIG).some((key) =>
    /resource|injectResources|reloadOnCompaction|cutOnStepDone/iu.test(key),
  ),
  Object.keys(DEFAULT_CONFIG).join(", "),
);
check(
  "enable 示例文件里也没有资料开关",
  !/resource|injectResources|reloadOnCompaction|cutOnStepDone/iu.test(
    readFileSync(join(HERE, "enable.example.yml"), "utf8"),
  ),
);

// ---------------------------------------------------------------- 未启用态

console.log("\n未启用态：");
const off = makeHarness();
apply(off.ctx, { enabled: false, rootDir: stateRoot() });

check("一个工具都不注册", off.tools.length === 0, String(off.tools.length));
check("一段提示词都不注册", off.sections.length === 0, String(off.sections.length));
check("不挂 pre-step", !off.handlers.has("agent/pre-step"));
check("不挂检查点闸门", !off.handlers.has("tools/pre-execute"));
check("面板接口照挂", off.injected.length > 0, JSON.stringify(off.injected));

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
