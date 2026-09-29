/**
 * 客户端条目自测（client.js）。
 *
 * client.js 是浏览器脚本：顶层是 `window.__ModuleLoader__.load(...)`，模块体用
 * `h()` 而不是 JSX。这里用一套**最小运行时**把它物化出来——假 window、假
 * document、假 react、假 primitives——然后真调一次 apply、真渲染一次条目。
 *
 * 验证的是**装配与接线**，不是视觉效果：
 *
 *   1. 模块身份与依赖：注册 id、`inject`、只 require 内置基座里那两样。
 *   2. 挂载点：注册在 `conversation.input.dock`，用自己的 id 与 order 50，
 *      不顶掉内置的 todo(0) / goal(10) / queue(20)。
 *   3. 样式注入：一个带 `data-plugin-css` 的 <style>（客户端 HMR 靠它卸载），
 *      正文含条目外壳、单行条、图标按钮、展开体这些关键类。
 *   4. 文案：zh / en 键集一致，渲染过程中没有取到不存在的键。
 *   5. 渲染：折叠态是单行条（状态标签 + 目标标题 + 进度 + 暂停/继续、
 *      清空、展开三个图标按钮，没有展开体）；展开态出展开体，且只摊开正在走的
 *      那条路径；暂停态状态标签变「已暂停」、按钮变「继续」、并给出暂停说明。
 *
 * 假 react 不实现真实的 hook 语义：`TaskTreeDock` 的三个 `useState` 初值由
 * 用例直接注入（`dockPreset`），`useEffect` 不执行——所以渲染不碰 fetch。
 *
 * 跑：node verify-client.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "client.js"), "utf8");

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

// ---------------------------------------------------------------- 最小运行时

let captured = null;
const styleTags = [];

globalThis.window = {
  location: { origin: "http://localhost" },
  confirm: () => true,
  __ModuleLoader__: {
    load(registration) {
      captured = registration;
    },
  },
};

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: {
    appendChild: (tag) => {
      styleTags.push(tag);
    },
  },
};

const noop = () => {};
let currentInstance = null;
/** TaskTreeDock 的三个 useState 初值；null 表示按真实初值走。 */
let dockPreset = null;

function makeElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
}

const miniReact = {
  createElement: makeElement,
  useState(initial) {
    const instance = currentInstance;
    const index = instance.hookIndex++;
    if (instance.preset !== null && index < instance.preset.length) {
      return [instance.preset[index], noop];
    }
    if (!(index in instance.values)) {
      instance.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [instance.values[index], noop];
  },
  useEffect() {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
};

/** 渲染成元素树：宿主元素是 `{ type, props, children }`，文本是 `{ type: "#text", text }`。 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") {
    return { type: "#text", props: {}, text: String(node), children: [] };
  }
  if (Array.isArray(node)) {
    return { type: "#fragment", props: {}, children: node.map(render).filter(Boolean) };
  }

  const { type, props } = node;
  if (typeof type === "function") {
    const previous = currentInstance;
    currentInstance = {
      hookIndex: 0,
      values: [],
      preset: type.name === "TaskTreeDock" ? dockPreset : null,
    };
    let output;
    try {
      output = type(props || {});
    } finally {
      currentInstance = previous;
    }
    return render(output);
  }

  const raw = props === undefined ? undefined : props.children;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return { type, props: props || {}, children: list.map(render).filter(Boolean) };
}

function walk(node, visit) {
  if (node === null) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(root, predicate) {
  const hits = [];
  walk(root, (node) => {
    if (predicate(node)) hits.push(node);
  });
  return hits;
}

function classOf(node) {
  const value = node.props === undefined ? undefined : node.props.className;
  return typeof value === "string" ? value.split(/\s+/u) : [];
}

const hasClass = (root, want) => findAll(root, (node) => classOf(node).includes(want)).length > 0;
const byAria = (root, label) =>
  findAll(root, (node) => node.props !== undefined && node.props["aria-label"] === label);
const hasText = (root, want) =>
  findAll(root, (node) => node.type === "#text" && node.text.includes(want)).length > 0;
const hasIcon = (root, want) =>
  findAll(root, (node) => node.props !== undefined && node.props["data-icon"] === want).length > 0;

// ---------------------------------------------------------------- 物化模块

console.log("模块装配：");

await import(pathToFileURL(join(HERE, "client.js")).href);

check("以 dsh-tree-task-flow 注册", captured !== null && captured.id === "dsh-tree-task-flow", String(captured && captured.id));

const ICONS = [
  "IconChecklistOutline14",
  "IconChevronDownOutline14",
  "IconChevronRightOutline14",
  "IconChevronUpOutline14",
  "IconCheckOutline14",
  "IconCheckOutline16",
  "IconCloseOutline16",
  "IconPauseOutline16",
  "IconPlayOutline16",
  "IconTrashOutline16",
];

const primitives = {};
for (const iconName of ICONS) {
  primitives[iconName] = () => makeElement("i", { "data-icon": iconName });
}
primitives.Tooltip = (props) => props.children;

const requested = [];
function fakeRequire(spec) {
  requested.push(spec);
  if (spec === "react") return miniReact;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error("client.js 请求了没准备的模块：" + spec);
}

const plugin = captured.factory(fakeRequire);

const REQUIRED = ["@deepseek-ai/dsh-client-ui-primitives", "react"];
check(
  "只 require 内置基座里的 react 与自己要用的 primitives",
  [...new Set(requested)].sort().join(", ") === REQUIRED.join(", "),
  [...new Set(requested)].sort().join(", "),
);
check("插件名是 dsh-tree-task-flow", plugin.name === "dsh-tree-task-flow", String(plugin.name));
check(
  "注入 slots 与 locale",
  Array.isArray(plugin.inject) &&
    plugin.inject.length === 2 &&
    plugin.inject.includes("slots") &&
    plugin.inject.includes("locale"),
  JSON.stringify(plugin.inject),
);

// ---------------------------------------------------------------- apply

const dictionaries = new Map();
const missingKeys = [];
let slotRegistration = null;
const injectedSlots = [];

const ctx = {
  effect(register) {
    register();
    return noop;
  },
  locale: {
    register(ns, dicts) {
      dictionaries.set(ns, dicts);
    },
    bind(ns) {
      return (key, params) => {
        const dict = dictionaries.get(ns);
        const table = dict === undefined ? undefined : dict.zh;
        let text = table === undefined ? undefined : table[key];
        if (typeof text !== "string") {
          missingKeys.push(key);
          return key;
        }
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split("{" + name + "}").join(String(value));
          }
        }
        return text;
      };
    },
  },
  slots: {
    inject(name, callback) {
      injectedSlots.push(name);
      callback();
    },
    register(options, component) {
      slotRegistration = { options, component };
      return noop;
    },
  },
};

plugin.apply(ctx);

console.log("\n挂载点与样式：");

check(
  "挂在 conversation.input.dock",
  injectedSlots.length === 1 && injectedSlots[0] === "conversation.input.dock",
  injectedSlots.join(", "),
);
check(
  "用自己的 id 注册（不顶掉内置条目）",
  slotRegistration !== null && slotRegistration.options.id === "dsh-tree-task-flow",
  String(slotRegistration && slotRegistration.options.id),
);
check(
  "排序 50，排在内置 todo(0) / goal(10) / queue(20) 之后",
  slotRegistration !== null && slotRegistration.options.order === 50,
  String(slotRegistration && slotRegistration.options.order),
);
check(
  "注册的是个组件",
  slotRegistration !== null && typeof slotRegistration.component === "function",
);

check("注入了一个样式标签", styleTags.length === 1, String(styleTags.length));
const styleTag = styleTags[0];
check(
  "样式标签带 data-plugin-css（HMR 靠它卸载）",
  styleTag !== undefined && typeof styleTag.dataset.pluginCss === "string" && styleTag.dataset.pluginCss.length > 0,
  JSON.stringify(styleTag && styleTag.dataset),
);
const CSS = styleTag === undefined ? "" : styleTag.textContent;
for (const cls of [
  ".dsh-ttf-dock",
  ".dsh-ttf-panel",
  ".dsh-ttf-bar",
  ".dsh-ttf-iconBtn",
  ".dsh-ttf-label",
  ".dsh-ttf-progress",
  ".dsh-ttf-body",
  ".dsh-ttf-row",
  ".dsh-ttf-tagWarn",
]) {
  check(`样式里有 ${cls}`, CSS.includes(cls));
}
check(
  "条目宽度沿用内置的算法（不会与消息正文错位）",
  CSS.includes("--dsh-composer-side-clearance") &&
    CSS.includes("--dsh-composer-dock-inset") &&
    CSS.includes("--dsh-composer-card-max-width"),
);
check(
  "样式用内置的颜色变量，不是写死色值",
  CSS.includes("var(--dsw-specific-tip)") && CSS.includes("var(--dsw-alias-border-l1)"),
);

console.log("\n文案：");

const zhDict = dictionaries.get("dsh-tree-task-flow") === undefined ? {} : dictionaries.get("dsh-tree-task-flow").zh;
const enDict = dictionaries.get("dsh-tree-task-flow") === undefined ? {} : dictionaries.get("dsh-tree-task-flow").en;
const zhKeys = Object.keys(zhDict).sort();
const enKeys = Object.keys(enDict).sort();

check("注册了 zh 与 en", Object.keys(zhDict).length > 0 && Object.keys(enDict).length > 0);
check("zh 与 en 键集一致", zhKeys.join(",") === enKeys.join(","), zhKeys.filter((key) => !enKeys.includes(key)).join(", "));
for (const key of [
  "state.running",
  "state.paused",
  "action.pause",
  "action.resume",
  "action.reset",
  "action.expand",
  "action.collapse",
  "note.paused",
]) {
  check(`有 ${key}`, typeof zhDict[key] === "string" && zhDict[key].length > 0);
}

// ---------------------------------------------------------------- 渲染

const DATA = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "示例目标",
        detail: "目标的补充说明",
      status: "pending",
      tasks: [
        {
          id: "t1",
          title: "任务一",
          status: "pending",
          steps: [
            {
              id: "x1",
              title: "子任务一",
              status: "done",
              result: {
                id: "x1",
                title: "子任务一",
                text: "子任务一产出的东西\n第二行：补充细节\n第三行：还有一点",
                at: 1700000000000,
              },
            },
          ],
        },
      ],
    }],
  },
  // 渲染单测：把当前项指到最深一层，好一次看见整条活动路径。
  active: { goalId: "g1", taskId: "t1", stepId: "x1" },
  checkpoint: null,
  stopped: false,
  paused: false,
};

function renderDock(data, open) {
  dockPreset = [{ loading: false, data }, open, false];
  try {
    return render(makeElement(slotRegistration.component, { sessionId: "s1" }));
  } finally {
    dockPreset = null;
  }
}

console.log("\n折叠态（单行条）：");
const collapsed = renderDock(DATA, false);

check("渲染出条目外壳", hasClass(collapsed, "dsh-ttf-dock"));
check("渲染出卡片", hasClass(collapsed, "dsh-ttf-panel"));
check("渲染出单行条", hasClass(collapsed, "dsh-ttf-bar"));
check("左侧是清单图标", hasIcon(collapsed, "IconChecklistOutline14"));
check("状态标签是「进行中」", hasText(collapsed, "进行中"));
check("显示目标标题", hasText(collapsed, "示例目标"));
check("显示进度与当前节点", hasText(collapsed, "1/3") && hasText(collapsed, "任务一"));
check("没有展开体", !hasClass(collapsed, "dsh-ttf-body"));
check("运行中有「暂停」按钮", byAria(collapsed, "暂停").length === 1, String(byAria(collapsed, "暂停").length));
check("运行中没有「继续」按钮", byAria(collapsed, "继续").length === 0);
check("有「清空计划」按钮", byAria(collapsed, "清空计划").length === 1);
check("有「展开」按钮", byAria(collapsed, "展开").length === 1);
check(
  "按钮是图标按钮（走内置样式）",
  findAll(collapsed, (node) => classOf(node).includes("dsh-ttf-iconBtn")).length === 3,
  String(findAll(collapsed, (node) => classOf(node).includes("dsh-ttf-iconBtn")).length),
);
check("暂停按钮用的是内置图标", hasIcon(collapsed, "IconPauseOutline16"));

console.log("\n展开态（卡片）：");
const expanded = renderDock(DATA, true);

check("出现展开体", hasClass(expanded, "dsh-ttf-body"));
check("有「收起」按钮", byAria(expanded, "收起").length >= 1, String(byAria(expanded, "收起").length));
check("展开后不再有「展开」按钮（该收的都摊开了）", byAria(expanded, "展开").length === 0, String(byAria(expanded, "展开").length));
check("画出目标", hasText(expanded, "示例目标"));
check("画出任务", hasText(expanded, "任务一"));
check("画出子任务", hasText(expanded, "子任务一"));
check("三层缩进都在", hasClass(expanded, "dsh-ttf-depth0") && hasClass(expanded, "dsh-ttf-depth1") && hasClass(expanded, "dsh-ttf-depth2"));
check("当前节点带「当前」标签", hasText(expanded, "当前"));
check("提交过的结果可见", hasText(expanded, "子任务一产出的东西"));
const resultBlocks = findAll(expanded, (node) => classOf(node).includes("dsh-ttf-result"));
check("结果有专门的呈现块", resultBlocks.length >= 1, String(resultBlocks.length));
check(
  "结果默认收起，只占一行",
  resultBlocks.every((node) => !classOf(node).includes("dsh-ttf-resultOpen")),
);
check(
  "放不下的结果标成可点开",
  resultBlocks.some((node) => classOf(node).includes("dsh-ttf-resultClick")),
);

console.log("\n正在运行的标记：");
const running = findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markSpin"));
check("活动路径上的节点画出转圈标记", running.length === 2, String(running.length));
check(
  "转的还是原来那个虚线圆（外观没变，只是加转动）",
  running.every(
    (node) =>
      findAll(node, (child) => child.type === "circle").length === 1 &&
      findAll(node, (child) => child.type === "circle")[0].props.strokeDasharray === "2.4 2.4",
  ),
);
check(
  "转圈标记外面还是原来的标记格（颜色和尺寸都没动）",
  findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markCell")).length === 2,
  String(findAll(expanded, (node) => classOf(node).includes("dsh-ttf-markCell")).length),
);

const idle = renderDock(Object.assign({}, DATA, { active: null }), true);
check(
  "没有活动节点时一个都不转",
  findAll(idle, (node) => classOf(node).includes("dsh-ttf-markSpin")).length === 0,
);
check(
  "没有活动节点时整棵树默认收起（只留目标那一行）",
  !hasText(idle, "任务一") && !hasText(idle, "子任务一"),
);
check(
  "收起的节点仍是待办圈",
  findAll(idle, (node) => classOf(node).includes("dsh-ttf-markCell")).length === 1,
  String(findAll(idle, (node) => classOf(node).includes("dsh-ttf-markCell")).length),
);

console.log("\n默认只摊开正在走的那条路径：");
const TWO = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      {
        id: "g1",
        title: "示例目标",
        status: "pending",
        tasks: [
          { id: "t1", title: "任务一", status: "done", steps: [{ id: "x1", title: "子任务一", status: "done" }] },
          { id: "t2", title: "任务二", status: "pending", steps: [{ id: "x2", title: "子任务二", status: "pending" }] },
        ],
      },
    ],
  },
  active: { goalId: "g1", taskId: "t2", stepId: "x2" },
  checkpoint: null,
  stopped: false,
  paused: false,
};
const two = renderDock(TWO, true);
check("目标展开，两条任务都看得见", hasText(two, "任务一") && hasText(two, "任务二"));
check("当前任务展开，看得见正在跑的子任务", hasText(two, "子任务二"));
check("已经收尾的任务默认收起，不画它的子节点", !hasText(two, "子任务一"));

console.log("\n多个目标：");
const MULTI = {
  ok: true,
  plan: {
    sessionId: "s1",
    goals: [
      TWO.plan.goals[0],
      {
        id: "g2",
        title: "第二个目标",
        status: "pending",
        tasks: [
          {
            id: "t3",
            title: "任务三",
            status: "pending",
            steps: [{ id: "x3", title: "子任务三", status: "pending" }],
          },
        ],
      },
    ],
  },
  active: { goalId: "g2", taskId: "t3", stepId: "x3" },
  checkpoint: null,
  stopped: false,
  paused: false,
};
const multi = renderDock(MULTI, true);
check("多个目标时，条上写的是目标个数", hasText(multi, "2 个目标"));
check("两个目标都渲染出来", hasText(multi, "示例目标") && hasText(multi, "第二个目标"));
check("正在走的那个目标默认摊开", hasText(multi, "子任务三"));
check("已经收尾的那个目标默认收起", !hasText(multi, "子任务一"));

const checkpointed = renderDock(
  Object.assign({}, TWO, {
    active: null,
    checkpoint: { id: "t1", level: "task", label: "任务", title: "任务一" },
  }),
  true,
);
check(
  "检查点所在的任务默认展开（不用人自己去翻）",
  hasText(checkpointed, "子任务一") && !hasText(checkpointed, "子任务二"),
);

console.log("\n外观约定（树形、分界、标题、结果）：");
check("同一层的节点之间有分界线", SOURCE.includes(".dsh-ttf-node+.dsh-ttf-node{"));
check("详情里的内容块之间有分界线", SOURCE.includes(".dsh-ttf-detail>*+*{"));
check(
  "三层节点各自带层级类（树形连线靠它画）",
  hasClass(expanded, "dsh-ttf-node") &&
    hasClass(expanded, "dsh-ttf-depth1") &&
    hasClass(expanded, "dsh-ttf-depth2"),
);
check(
  "节点标题不缩略，多了换行",
  SOURCE.includes('".dsh-ttf-rowTitle{min-width:0;flex:1;white-space:pre-wrap;word-break:break-word}"') &&
    !/\.dsh-ttf-rowTitle\{[^}]*text-overflow/u.test(SOURCE),
);
check("结果默认只占一行（行数钳到 1）", SOURCE.includes("-webkit-line-clamp:1"));
check(
  "转圈靠 CSS 关键帧（1s 匀速、无限，与内置待办面板同款）",
  SOURCE.includes("@keyframes dsh-ttf-spin{to{transform:rotate(360deg)}}") &&
    SOURCE.includes("animation:dsh-ttf-spin 1s linear infinite"),
);
check("点开后取消钳制，看全文", SOURCE.includes(".dsh-ttf-resultOpen{display:block"));
check(
  "旧写法已经清干净（pre 呈现、三层 padding 缩进）",
  !SOURCE.includes("dsh-ttf-pre") && !SOURCE.includes("dsh-ttf-depth0{padding-left"),
);
const dropButtons = byAria(expanded, "丢弃");
// 这份数据里「子任务一」已经完成（完成态不给丢弃按钮），还开着的只剩目标与任务一。
check(
  "还开着的节点都能丢——目标也算一个",
  dropButtons.length === 2,
  String(dropButtons.length),
);

console.log("\n暂停态：");
const paused = renderDock(Object.assign({}, DATA, { paused: true }), true);

check("状态标签变「已暂停」", hasText(paused, "已暂停"));
check("出现「继续」按钮", byAria(paused, "继续").length === 1, String(byAria(paused, "继续").length));
check("不再有「暂停」按钮", byAria(paused, "暂停").length === 0);
check("继续按钮用的是内置播放图标", hasIcon(paused, "IconPlayOutline16"));
check("给出暂停说明", hasText(paused, "点「继续」从原处接着跑"));

console.log("\n停止态与空态：");
const stopped = renderDock(Object.assign({}, DATA, { stopped: true }), false);
check("人按过停止时也显示「已暂停」并给「继续」", hasText(stopped, "已暂停") && byAria(stopped, "继续").length === 1);

dockPreset = [{ loading: false, empty: true }, false, false];
const empty = render(makeElement(slotRegistration.component, { sessionId: "s1" }));
dockPreset = null;
check("没有计划时什么都不渲染", empty === null);

check("渲染过程没有取到不存在的文案键", missingKeys.length === 0, missingKeys.join(", "));

console.log("\n客户端源码约定：");
check("仍以手写模块格式加载", SOURCE.includes("window.__ModuleLoader__.load("));
check("没有走 JSX（不出现 React.createElement 之外的编译产物）", !SOURCE.includes("react/jsx-runtime"));
check("不再用「停止自动续行」这套旧文案", !SOURCE.includes("btn.stop") && !SOURCE.includes("state.stopped"));

// ---------------------------------------------------------------- 汇总

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
