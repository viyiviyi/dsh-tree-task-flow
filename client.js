/**
 * dsh-tree-task-flow 的客户端：输入框上方的树形任务流条目。
 *
 * 这是**手写**的模块包装格式（和 dsh-purge 的 client.js 一样），不经过打包，
 * 所以用 `h()` 而不是 JSX。
 *
 * 挂载点是 `conversation.input.dock`——输入框上方的全宽条目区，内置的任务清单
 * （`todo`）与目标（`goal`）就在那里。这是一个 `list` 槽：**用自己的 id 注册就
 * 会并列加在它们旁边**，不会替换任何一个；用内置的 id 才会顶掉它。
 *
 * 外观照内置条目来：收起时是目标条（GoalBar）那样的 36px 单行条，展开后是待办
 * 面板（TodoPanel）那样的卡片。图标与 Tooltip 直接用外壳播种的 UI 基座
 * `@deepseek-ai/dsh-client-ui-primitives`，尺寸与颜色变量也都取它那一套，
 * 这样并排放在输入框上方时看起来是一家。
 *
 * 没有计划的会话**一个像素都不占**：读不到计划就返回 null，免得平白挤掉内置条目。
 *
 * 数据全部来自 host 端的 `/dsh-tree-task-flow/*` 接口；动作（暂停 / 继续 / 完成 /
 * 丢弃 / 清空）都是 POST 回 host，由 host 改真正的文件和 agent 状态。
 *
 * 「暂停」不是只停掉自动续行，而是**真的把会话按住**：host 侧在模型发起下一次
 * 请求之前等一个闸门，所以当前正在执行的工具会正常跑完，之后什么都不干；点
 * 「继续」就放行，模型从原处接着跑，整个过程不往会话里插任何消息。
 *
 * 「完成」必须带结果，所以它不是一步按钮：先在节点下展开一个输入框，写清产出了
 * 什么，再提交。结果一旦提交，这个节点整段执行过程就会被它顶替，所以输入框的
 * 提示语要把这一点讲明白。
 */
window.__ModuleLoader__.load({
	id: "dsh-tree-task-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const name = "dsh-tree-task-flow";
		const inject = ["slots", "locale"];
		const NS = "dsh-tree-task-flow";
		/** 条目 id。用自己的 id，所以只会加在内置条目旁边。 */
		const ENTRY_ID = "dsh-tree-task-flow";

		let translate = (key) => key;
		const useT = () => translate;

		// ------------------------------------------------------------ 内置基座

		/**
		 * 内置 UI 基座。外壳启动时把这张表播种进模块表（react、cordis、store、
		 * slots、primitives、dockkit），所以这里的 require 正常一定成功；
		 * 仍然兜一层 try——万一这版外壳没有 primitives，条目该降级成文字，
		 * 而不是整块白掉。
		 */
		let primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		} catch {
			primitives = {};
		}

		/**
		 * 内置图标名有两套写法，这里两套都认。
		 *
		 * 旧外壳把尺寸写进名字：`IconCheckOutline16`、`IconChevronDownOutline14`；
		 * 升级后的外壳把名字里的尺寸换成笔画粗细：`IconCheckOutlineRegular`、
		 * `IconCheckOutlineMedium`，尺寸改由 `size` 属性给。按「尺寸后缀 → 粗细后缀
		 * → 裸名」的顺序找，两套外壳都取得回图标，不会平白降级成文字。
		 */
		function findIcon(base, size) {
			const candidates = [base + size, base + "14", base + "16", base + "Regular", base + "Medium", base];
			for (const candidate of candidates) {
				const component = primitives[candidate];
				if (typeof component === "function") return component;
			}
			return null;
		}

		/** 取一个内置图标；这版外壳没有就返回 null，由调用方决定怎么退。 */
		function icon(base, size) {
			const component = findIcon(base, size);
			if (component === null) return null;
			return h(component, { size });
		}

		/** 用内置 Tooltip 包一层；没有 Tooltip 就原样返回。 */
		function withTooltip(label, node) {
			const Tooltip = primitives.Tooltip;
			if (typeof Tooltip !== "function") return node;
			return h(Tooltip, { label, side: "bottom", delayMs: 500 }, node);
		}

		/**
		 * 图标按钮：有图标用图标，没图标退回短文字，保证永远点得到。
		 *
		 * 退回文字时换成 `dsh-ttf-iconBtnText`：按钮按文字宽度自己撑开、文字长了
		 * 用省略号收住，所以并排的几个按钮不会挤成一团互相压。
		 */
		function IconButton({ iconBase, label, size, disabled, onClick }) {
			const glyph = icon(iconBase, typeof size === "number" ? size : 16);
			return withTooltip(
				label,
				h(
					"button",
					{
						type: "button",
						className: glyph === null ? "dsh-ttf-iconBtn dsh-ttf-iconBtnText" : "dsh-ttf-iconBtn",
						disabled: disabled === true,
						"aria-label": label,
						onClick,
					},
					glyph === null ? h("span", { className: "dsh-ttf-iconText" }, label) : glyph,
				),
			);
		}

		// ---------------------------------------------------------------- 基础

		function urlOf(path) {
			try {
				return new URL(path, window.location.origin).toString();
			} catch {
				return path;
			}
		}

		async function api(path, init) {
			const response = await fetch(
				urlOf(path),
				Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}),
			);
			const text = await response.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				throw new Error(
					response.status + " 返回了非 JSON：" + String(text).slice(0, 120),
				);
			}
			if (!response.ok) {
				const error = new Error((data && data.error) || response.status + " " + response.statusText);
				// 调用方要能区分「这个会话没有计划」（正常）与真出错。
				error.status = response.status;
				throw error;
			}
			return data;
		}

		/**
		 * 写操作。host 用 HTTP 200 携带 `{ ok: false, error }` 表示业务拒绝
		 * （比如完成时没给结果），所以这里要把 `ok` 也当错误判一次。
		 */
		async function post(body) {
			const data = await api("/dsh-tree-task-flow/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (data && data.ok === false) throw new Error(data.error || "host 拒绝了这次操作");
			return data;
		}

		function formatTime(at) {
			const n = Number(at);
			if (!n) return "";
			try {
				return new Date(n).toLocaleString();
			} catch {
				return "";
			}
		}

		/** 三层节点总数与已完成数，给单行条上的进度用。 */
		function countNodes(goal) {
			let total = 1;
			let done = goal.status === "done" ? 1 : 0;
			for (const task of goal.tasks || []) {
				total += 1;
				if (task.status === "done") done += 1;
				for (const step of task.steps || []) {
					total += 1;
					if (step.status === "done") done += 1;
				}
			}
			return { total, done };
		}

		/** 计划里的全部目标。一个会话可以有多个目标，它们是最外层的兄弟。 */
		function goalsOf(data) {
			return data?.plan?.goals || [];
		}

		/** 当前该盯着哪个目标：活动路径上的那个；没有就取第一个还没结束的，再退到最后一个。 */
		function focusGoal(data) {
			const goals = goalsOf(data);
			if (goals.length === 0) return null;
			const here = goals.find((each) => each.id === data?.active?.goalId);
			if (here) return here;
			return (
				goals.find((each) => each.status !== "done" && each.status !== "dropped") ||
				goals[goals.length - 1]
			);
		}

		/** 当前活动节点的标题：子任务优先，其次任务，最后目标。 */
		function currentLabel(data) {
			const active = data.active;
			if (!active) return "";
			const goal = focusGoal(data);
			if (!goal) return "";
			const task = (goal.tasks || []).find((each) => each.id === active.taskId);
			if (!task) return goal.title;
			const step = (task.steps || []).find((each) => each.id === active.stepId);
			return step ? step.title : task.title;
		}

		/** 活动路径上三层各自的 id。节点 id 全局唯一，所以一个集合就够判"是不是当前节点"。 */
		function currentIds(data) {
			const active = data.active;
			return new Set(
				[active?.goalId, active?.taskId, active?.stepId].filter(
					(each) => typeof each === "string" && each !== "",
				),
			);
		}

		/**
		 * 面板一打开该摊开哪些节点：活动路径上的三层，加上检查点节点以及它的祖先。
		 *
		 * 其余节点一律收起——正在走的那条路径本来就窄，摊平整棵树只会让人翻半天。
		 * 检查点落在某个任务上时，目标也得一起摊开，否则连那一行都看不见。
		 */
		function defaultOpenIds(data) {
			const ids = currentIds(data);
			const checkpoint = data.checkpoint;
			if (checkpoint !== null && checkpoint !== undefined && typeof checkpoint.id === "string") {
				ids.add(checkpoint.id);
				const goalId = focusGoal(data)?.id;
				if (checkpoint.level !== "goal" && typeof goalId === "string") ids.add(goalId);
			}
			return ids;
		}

		// ---------------------------------------------------------------- 文案

		const zh = {
			nav: "树形任务流",
			"state.running": "进行中",
			"state.paused": "已暂停",
			"state.done": "已全部完成",
			"state.checkpoint": "检查点",
			"checkpoint.note": "「{title}」的子节点已全部结束。要么继续给它拆子节点，要么提交结果并完成它。",
			"note.paused": "已暂停：正在跑的工具会跑完，之后不再往下走。点「继续」从原处接着跑，不会往会话里插消息。",
			"action.pause": "暂停",
			"action.resume": "继续",
			"action.reset": "清空计划",
			"action.expand": "展开",
			"action.collapse": "收起",
			"action.done": "完成…",
			"action.drop": "丢弃",
			"action.submit": "提交结果",
			"action.expandResult": "展开看全文",
			"action.collapseResult": "收起",
			"action.cancel": "取消",
			"label.result": "结果",
			"label.noResult": "（还没提交结果）",
			"label.current": "当前",
			"label.checkpointHere": "检查点",
			"label.goals": "{count} 个目标",
			"placeholder.result":
				"写清这个节点产出了什么。它整段执行过程会被这条结果顶替，所以要能独立看懂。",
			"hint.noChildren": "（还没有子节点 → 让模型调用 tree_task_plan）",
			"confirm.reset": "确定要清空这个会话的计划树吗？",
			"confirm.drop": "确定要丢弃「{title}」吗？",
		};

		const en = {
			nav: "Tree Task Flow",
			"state.running": "In progress",
			"state.paused": "Paused",
			"state.done": "All done",
			"state.checkpoint": "Checkpoint",
			"checkpoint.note":
				"Every child of “{title}” has finished. Either break out more children, or submit its result and complete it.",
			"note.paused":
				"Paused: the running tool finishes, then nothing else happens. Resume picks up exactly where it stopped, without inserting any message.",
			"action.pause": "Pause",
			"action.resume": "Resume",
			"action.reset": "Clear plan",
			"action.expand": "Expand",
			"action.collapse": "Collapse",
			"action.done": "Complete…",
			"action.drop": "Drop",
			"action.submit": "Submit result",
			"action.expandResult": "Show the full result",
			"action.collapseResult": "Collapse",
			"action.cancel": "Cancel",
			"label.result": "Result",
			"label.noResult": "(no result submitted yet)",
			"label.current": "current",
			"label.checkpointHere": "checkpoint",
			"label.goals": "{count} goals",
			"placeholder.result":
				"State what this node produced. Its whole execution range is replaced by this result, so it must stand on its own.",
			"hint.noChildren": "(no children yet → ask the model to call tree_task_plan)",
			"confirm.reset": "Clear this session's plan tree?",
			"confirm.drop": "Drop “{title}”?",
		};

		// ---------------------------------------------------------------- 样式

		/**
		 * 样式照内置的 dock 条目写：宽高、间距、圆角、颜色变量都取
		 * `dsh-client-ui-goal` 的 GoalBar 与内置待办面板 TodoPanel 的同一套值。
		 *
		 * 注入方式也照它们：一个带 `data-plugin-css` 的 <style> 标签——
		 * 客户端 HMR 就是靠这个属性在插件卸载时收走样式的。
		 */
		const CSS_TAG = "dsh-tree-task-flow/Dock.module.css";

		const CSS = [
			// 条目外壳：宽度算法与内置 goal / todo 条目完全一致，否则会和消息正文对不齐。
			".dsh-ttf-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));margin:0 auto;flex:none;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
			// 卡片：背景与圆角同内置条目，描边用 ::after 画（.5px 在缩放屏上才不糊）。
			".dsh-ttf-panel{background:var(--dsw-specific-tip);border-radius:12px;position:relative;overflow:hidden}",
			'.dsh-ttf-panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;position:absolute;inset:0}',
			".dsh-ttf-bar{box-sizing:border-box;width:100%;height:36px;display:flex;align-items:center;gap:10px;padding:4px 5px 4px 12px}",
			".dsh-ttf-glyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;align-items:center}",
			".dsh-ttf-glyphFallback{font-size:13px;line-height:16px}",
			".dsh-ttf-label{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px;white-space:nowrap}",
			".dsh-ttf-labelHeld{color:var(--dsw-alias-state-warning-primary,#a06800)}",
			".dsh-ttf-title{min-width:0;flex:1;color:var(--dsw-alias-label-primary-dimmed);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-ttf-progress{flex:none;max-width:45%;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-ttf-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dsh-ttf-iconBtn{corner-shape:round;width:28px;height:28px;border:none;background:0 0;border-radius:999px;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;font:inherit;flex:none}",
			".dsh-ttf-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dsh-ttf-iconBtn:disabled{opacity:.4;cursor:default}",
			".dsh-ttf-iconBtn:disabled:hover{background:0 0;color:var(--dsw-alias-label-tertiary)}",
			// 取不到内置图标时退回文字：固定 28px 宽装不下几个字，文字会溢出到相邻
			// 按钮上，看着就是几个按钮叠在一起。这里按文字宽度撑开、留出边距，
			// 并给一个上限，长了用省略号收住——几个按钮始终各占各的位置。
			".dsh-ttf-iconBtnText{width:auto;min-width:28px;max-width:112px;height:24px;padding:0 8px}",
			".dsh-ttf-iconText{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:16px;white-space:nowrap}",
			// 展开体：限高滚动——这是输入框旁边的位置，不能让它把会话挤没了。
			".dsh-ttf-body{max-height:264px;overflow-y:auto;padding:2px 8px 8px}",
			".dsh-ttf-note{margin:4px 4px 6px;padding:6px 8px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}",
			// 节点行：行高与 hover 背景照内置待办面板。
			// 一个节点。行本身跟着标题长，标记与按钮对齐第一行。
			".dsh-ttf-node{position:relative}",
			// 同一层的相邻节点之间画一条分界线——任务与任务的分界就靠它。
			".dsh-ttf-node+.dsh-ttf-node{border-top:1px solid var(--dsw-alias-border-l1);margin-top:2px;padding-top:2px}",
			".dsh-ttf-row{position:relative;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dsh-ttf-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ttf-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			// 标题不缩略：有多长写多长，多了换行。
			".dsh-ttf-rowTitle{min-width:0;flex:1;white-space:pre-wrap;word-break:break-word}",
			".dsh-ttf-rowActions{flex:none;display:flex;align-items:center;gap:2px;margin-top:-4px}",
			".dsh-ttf-markCell{flex:none;display:inline-flex;align-items:center;margin-top:3px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-ttf-markDone{flex:none;display:inline-flex;align-items:center;margin-top:3px;color:var(--dsw-alias-state-success-primary,#1a7f37)}",
			".dsh-ttf-markMuted{flex:none;display:inline-flex;align-items:center;margin-top:3px;color:var(--dsw-alias-label-caption,#00000066)}",
			// 正在运行的标记：就是原来那个虚线圆，让它匀速转起来。1s 一圈、线性、
			// 无限，与内置待办面板 in_progress 的节奏一致。
			"@keyframes dsh-ttf-spin{to{transform:rotate(360deg)}}",
			".dsh-ttf-markSpin{animation:dsh-ttf-spin 1s linear infinite;transform-origin:50% 50%}",
			".dsh-ttf-done{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}",
			// 三层缩进。
			// 子节点：一条竖线 + 每个子节点一个拐角，把三层画成看得见的树。
			".dsh-ttf-depth1,.dsh-ttf-depth2{margin-left:11px;padding-left:9px;border-left:1px solid var(--dsw-alias-border-l2)}",
			'.dsh-ttf-depth1>.dsh-ttf-row:before,.dsh-ttf-depth2>.dsh-ttf-row:before{content:"";position:absolute;left:-9px;top:16px;width:8px;height:1px;background:var(--dsw-alias-border-l2)}',
			// 详情里的每一块（说明 / 结果 / 表单）自成一块，块间留白 + 描边，分得开。
			".dsh-ttf-detail>*+*{border-top:.5px solid var(--dsw-alias-border-l1);padding-top:6px}",
			".dsh-ttf-tag{flex:none;margin-top:1px;border-radius:999px;padding:0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}",
			".dsh-ttf-tagWarn{color:var(--dsw-alias-state-warning-primary,#a06800);background:var(--dsw-alias-state-warning-bg,#ffcc002e)}",
			// 展开详情：说明、结果、完成表单。
			".dsh-ttf-detail{display:flex;flex-direction:column;gap:6px;padding:2px 4px 4px}",
			".dsh-ttf-detailLabel{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsh-ttf-detailText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}",
			// 提交的结果：默认只占一行，点一下看全文。
			".dsh-ttf-result{margin-top:2px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}",
			".dsh-ttf-resultClick{cursor:pointer}",
			".dsh-ttf-resultOpen{display:block;max-height:220px;overflow-y:auto}",
			".dsh-ttf-form{margin:6px 0 2px}",
			".dsh-ttf-input{box-sizing:border-box;width:100%;min-height:64px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,monospace;font-size:12px;line-height:18px;resize:vertical;outline:none}",
			".dsh-ttf-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
			".dsh-ttf-input::placeholder{color:var(--dsw-alias-label-caption,#00000066)}",
			".dsh-ttf-formBar{margin-top:6px;display:flex;align-items:center;gap:6px}",
			".dsh-ttf-btn{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;font-family:inherit;font-size:12px;line-height:20px;cursor:pointer}",
			".dsh-ttf-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-ttf-btn:disabled{opacity:.4;cursor:default}",
			".dsh-ttf-btn:disabled:hover{background:var(--dsw-alias-bg-base)}",
			".dsh-ttf-error{color:var(--dsw-alias-state-error-primary,#c00);font-size:12px;line-height:18px;white-space:pre-wrap}",
			".dsh-ttf-hint{padding:4px 4px 6px 24px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
		].join("");

		if (
			typeof document !== "undefined" &&
			document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tree-task-flow";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---------------------------------------------------------------- 零件

		/**
		 * 节点状态标记：完成打勾、丢弃划掉、未完成画圈（当前节点用虚线圈，和内置待办一致）。
		 *
		 * 正在运行的那个圈还会匀速转起来——虚线一转就能看出这条路径还在推进。
		 */
		function StatusMark({ node, isCurrent }) {
			if (node.status === "done") {
				const check = icon("IconCheckOutline", 14);
				return h("span", { className: "dsh-ttf-markDone" }, check === null ? "✓" : check);
			}
			if (node.status === "dropped") {
				const close = icon("IconCloseOutline", 14);
				return h("span", { className: "dsh-ttf-markMuted" }, close === null ? "×" : close);
			}
			const circle = { cx: 7, cy: 7, r: 5.2, stroke: "currentColor", strokeWidth: 1.2 };
			if (isCurrent) circle.strokeDasharray = "2.4 2.4";
			return h(
				"span",
				{ className: "dsh-ttf-markCell" },
				h(
					"svg",
					{
						width: 14,
						height: 14,
						viewBox: "0 0 14 14",
						fill: "none",
						"aria-hidden": true,
						className: isCurrent ? "dsh-ttf-markSpin" : undefined,
					},
					h("circle", circle),
				),
			);
		}

		/**
		 * 提交的结果。默认只占一行，点一下摊开看全文。
		 *
		 * 短到一行放得下的结果不给展开——点了也没变化，只是徒增噪音。
		 */
		function ResultText({ text, t }) {
			const [open, setOpen] = useState(false);
			const body = String(text ?? "");
			const expandable = body.includes("\n") || body.length > 60;
			return h(
				"div",
				{
					className:
						"dsh-ttf-result" +
						(expandable ? " dsh-ttf-resultClick" : "") +
						(open ? " dsh-ttf-resultOpen" : ""),
					role: expandable ? "button" : undefined,
					tabIndex: expandable ? 0 : undefined,
					title: expandable ? t(open ? "action.collapseResult" : "action.expandResult") : undefined,
					onClick: expandable
						? () => setOpen(!open)
						: undefined,
				},
				body,
			);
		}

		/** 提交结果的输入框。空文本提交不出去——host 也会拒绝，这里先挡住。 */
		function CompleteForm({ onSubmit, onCancel, busy, error, t }) {
			const [text, setText] = useState("");
			return h(
				"div",
				{ className: "dsh-ttf-form" },
				h("textarea", {
					className: "dsh-ttf-input",
					value: text,
					rows: 4,
					placeholder: t("placeholder.result"),
					onChange: (event) => setText(event.target.value),
				}),
				error ? h("div", { className: "dsh-ttf-error" }, error) : null,
				h(
					"div",
					{ className: "dsh-ttf-formBar" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-ttf-btn",
							disabled: busy || text.trim() === "",
							onClick: () => onSubmit(text),
						},
						t("action.submit"),
					),
					h("button", { type: "button", className: "dsh-ttf-btn", disabled: busy, onClick: onCancel }, t("action.cancel")),
				),
			);
		}

		/**
		 * 一个节点：一行标题 + 可展开的详情。
		 *
		 * 三层共用同一个组件——它们的字段与动作本来就一样，差别只有缩进，
		 * 以及"这一层要不要给丢弃按钮"（目标、任务、子任务都能丢）。
		 */
		function NodeRow({ node, depth, activeIds, openIds, checkpointId, canDrop, sessionId, reload, t }) {
			const children = node.tasks || node.steps || [];
			const canAct = node.status === "pending";
			const isCurrent = activeIds.has(node.id);
			const isCheckpoint = checkpointId === node.id;
			const shouldOpen = openIds.has(node.id);
			const expandable = children.length > 0 || node.detail !== undefined || node.result !== undefined;

			// 默认只摊开"正在走的那条路径"（见 defaultOpenIds）：目标一路展开到当前子任务，
			// 其余节点收起。否则一打开面板就是一整棵摊平的树，想找正在跑的那个得翻半天。
			const [open, setOpen] = useState(shouldOpen);
			const [composing, setComposing] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);

			// 活动节点在会话里往前走了，就把它摊开：当前任务不该埋在收起里。
			useEffect(() => {
				if (shouldOpen) setOpen(true);
			}, [shouldOpen]);

			const act = useCallback(
				async (body) => {
					setBusy(true);
					setError(null);
					try {
						await post(Object.assign({ sessionId }, body));
						setComposing(false);
						await reload();
					} catch (failure) {
						setError(String((failure && failure.message) || failure));
					} finally {
						setBusy(false);
					}
				},
				[sessionId, reload],
			);

			return h(
				"div",
				{ className: "dsh-ttf-node dsh-ttf-depth" + depth },
				h(
					"div",
					{ className: "dsh-ttf-row" },
					h(StatusMark, { node, isCurrent }),
					h(
						"span",
						{ className: "dsh-ttf-rowTitle" + (node.status === "done" ? " dsh-ttf-done" : "") },
						node.title,
					),
					isCurrent ? h("span", { className: "dsh-ttf-tag" }, t("label.current")) : null,
					isCheckpoint ? h("span", { className: "dsh-ttf-tag dsh-ttf-tagWarn" }, t("label.checkpointHere")) : null,
					h(
						"span",
						{ className: "dsh-ttf-rowActions" },
						canAct
							? h(IconButton, {
									iconBase: "IconCheckOutline",
									label: t("action.done"),
									disabled: busy,
									onClick: () => {
										setComposing(true);
										setOpen(true);
									},
								})
							: null,
						canAct && canDrop
							? h(IconButton, {
									iconBase: "IconTrashOutline",
									label: t("action.drop"),
									disabled: busy,
									onClick: () => {
										if (window.confirm(t("confirm.drop", { title: node.title }))) {
											act({ action: "drop", id: node.id });
										}
									},
								})
							: null,
						expandable
							? h(IconButton, {
									iconBase: open ? "IconChevronDownOutline" : "IconChevronRightOutline",
									label: open ? t("action.collapse") : t("action.expand"),
									onClick: () => setOpen(!open),
								})
							: null,
					),
				),
				open
					? h(
							"div",
							{ className: "dsh-ttf-detail" },
							node.detail ? h("div", { className: "dsh-ttf-detailText" }, node.detail) : null,
							node.result
								? h(
										"div",
										null,
										h(
											"div",
											{ className: "dsh-ttf-detailLabel" },
											t("label.result") + "（" + formatTime(node.result.at) + "）",
										),
										h(ResultText, { text: node.result.text, t }),
									)
								: h(
										"div",
										{ className: "dsh-ttf-detailLabel" },
										t("label.result") + "：" + t("label.noResult"),
									),
							composing
								? h(CompleteForm, {
										t,
										busy,
										error,
										onSubmit: (text) => act({ action: "done", id: node.id, result: text }),
										onCancel: () => {
											setComposing(false);
											setError(null);
										},
									})
								: null,
							children.map((child) =>
								h(NodeRow, {
									key: child.id,
									node: child,
									depth: depth + 1,
									activeIds,
									openIds,
									checkpointId,
									canDrop: true,
									sessionId,
									reload,
									t,
								}),
							),
							children.length === 0 && depth < 2
								? h("div", { className: "dsh-ttf-hint" }, t("hint.noChildren"))
								: null,
						)
					: null,
			);
		}

		// ---------------------------------------------------------------- 条目

		/**
		 * 输入框上方的全宽条目。
		 *
		 * 收起时只有一行：图标 + 阶段标签 + 目标标题 + 进度，动作全在右侧的图标
		 * 按钮里（暂停 / 继续、清空、展开）。展开才画整棵树，并限高滚动。
		 *
		 * 会话没有计划时返回 null：内置的 todo / goal 条目不该因为我而挪位。
		 */
		function TaskTreeDock(props) {
			const t = useT();
			const sessionId = props.sessionId;
			const [state, setState] = useState({ loading: true });
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(false);

			const reload = useCallback(async () => {
				if (!sessionId) {
					setState({ loading: false, empty: true });
					return;
				}
				try {
					const data = await api("/dsh-tree-task-flow/tree?sessionId=" + encodeURIComponent(sessionId));
					setState({ loading: false, data });
				} catch {
					// 没有计划（404）是正常状态；真出错也不该占位。两种都当作"没有"。
					setState({ loading: false, empty: true });
				}
			}, [sessionId]);

			useEffect(() => {
				reload();
			}, [reload]);

			// 模型随时会改计划，而条目没有推送通道，所以自己轮询。
			// 4 秒一次，读的是插件自己的一个小 JSON。
			useEffect(() => {
				if (!sessionId) return undefined;
				const timer = setInterval(() => {
					reload();
				}, 4000);
				return () => clearInterval(timer);
			}, [sessionId, reload]);

			// 这次操作的结果说明（已放行 / 已唤醒 / 为什么没动）：恢复失败时用户最需要
			// 的就是这句话，不能只留在接口的返回里。
			const [note, setNote] = useState(null);
			useEffect(() => {
				if (!note) return undefined;
				const timer = setTimeout(() => setNote(null), 8000);
				return () => clearTimeout(timer);
			}, [note]);

			const act = useCallback(
				async (body) => {
					setBusy(true);
					setNote(null);
					try {
						const result = await post(Object.assign({ sessionId }, body));
						if (result && typeof result.message === "string" && result.message !== "") {
							setNote(result.message);
						}
						await reload();
					} finally {
						setBusy(false);
					}
				},
				[sessionId, reload],
			);

			if (state.loading || state.empty || !state.data) return null;

			const data = state.data;
			const goals = goalsOf(data);
			if (goals.length === 0) return null;
			// 一个会话可能有多个目标：条上给总数与合计进度，正文里把它们都列出来，
			// 展开状态仍旧只摊开正在走的那条路径。
			const stats = goals.reduce(
				(acc, each) => {
					const one = countNodes(each);
					return { total: acc.total + one.total, done: acc.done + one.done };
				},
				{ total: 0, done: 0 },
			);
			const heading = goals.length === 1 ? goals[0].title : t("label.goals", { count: goals.length });
			const current = currentLabel(data);
			// 「被按住」有两条来源：插件闸门（paused）与人按过界面停止（stopped）。
			// 对用户来说都是"停着呢，点继续就能接着跑"，所以合成一个状态展示。
			const held = data.paused === true || data.stopped === true;
			const stateLabel = held
				? t("state.paused")
				: data.checkpoint
					? t("state.checkpoint")
					: data.active === null
						? t("state.done")
						: t("state.running");
			// 条首的清单图标；外壳连这个图标都没有时退回一个同类字符，别留空白。
			const listIcon = icon("IconChecklistOutline", 14);
			const listGlyph =
				listIcon === null ? h("span", { className: "dsh-ttf-glyphFallback" }, "☰") : listIcon;

			return h(
				"div",
				{ className: "dsh-ttf-dock", "aria-label": t("nav") },
				h(
					"div",
					{ className: "dsh-ttf-panel" },
					h(
						"div",
						{ className: "dsh-ttf-bar" },
						h("span", { className: "dsh-ttf-glyph", "aria-hidden": true }, listGlyph),
						h("span", { className: "dsh-ttf-label" + (held ? " dsh-ttf-labelHeld" : "") }, stateLabel),
						h("span", { className: "dsh-ttf-title", title: heading }, heading),
						h(
							"span",
							{ className: "dsh-ttf-progress" },
							stats.done + "/" + stats.total + (current ? " · " + current : ""),
						),
						h(
							"div",
							{ className: "dsh-ttf-actions" },
							h(IconButton, {
								iconBase: held ? "IconPlayOutline" : "IconPauseOutline",
								label: held ? t("action.resume") : t("action.pause"),
								disabled: busy,
								onClick: () => act({ action: held ? "resume" : "pause" }),
							}),
							h(IconButton, {
								iconBase: "IconTrashOutline",
								label: t("action.reset"),
								disabled: busy,
								onClick: () => {
									if (window.confirm(t("confirm.reset"))) act({ action: "reset" });
								},
							}),
							h(IconButton, {
								iconBase: open ? "IconChevronDownOutline" : "IconChevronUpOutline",
								label: open ? t("action.collapse") : t("action.expand"),
								onClick: () => setOpen(!open),
							}),
						),
					),
					// 这次操作的结果与原因（已放行 / 已唤醒 / 为什么没动）。
					note ? h("div", { className: "dsh-ttf-note" }, note) : null,
					open
						? h(
								"div",
								{ className: "dsh-ttf-body" },
								data.checkpoint
									? h(
											"div",
											{ className: "dsh-ttf-note" },
											t("state.checkpoint") +
												"：" +
												data.checkpoint.label +
												"「" +
												data.checkpoint.title +
												"」",
											h("div", null, t("checkpoint.note", { title: data.checkpoint.title })),
										)
									: null,
								held ? h("div", { className: "dsh-ttf-note" }, t("note.paused")) : null,
								goals.map((each) =>
									h(NodeRow, {
										key: each.id,
										node: each,
										depth: 0,
										activeIds: currentIds(data),
										openIds: defaultOpenIds(data),
										checkpointId: data.checkpoint ? data.checkpoint.id : null,
										// 目标也能丢：丢弃会连同它下面的任务与子任务一起走。
										canDrop: true,
										sessionId,
										reload,
										t,
									}),
								),
							)
						: null,
				),
			);
		}

		// ---------------------------------------------------------------- 挂载

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-tree-task-flow: dictionaries");
			translate = ctx.locale.bind(NS);

			// 输入框上方的条目。list 槽 + 自己的 id ⇒ 只会并列加在内置
			// 的 queue / todo / goal 旁边，不会替换任何一个。
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.dock", () =>
						ctx.slots.register(
							{
								name: "conversation.input.dock",
								id: ENTRY_ID,
								order: 50,
								locale: NS,
							},
							TaskTreeDock,
						),
					),
				"dsh-tree-task-flow: conversation dock",
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
