/**
 * dsh-tree-task-flow 的客户端：输入框上方的树形任务流条目 + 设置页里的插件开关说明。
 *
 * 这是**手写**的模块包装格式（和 dsh-purge 的 client.js 一样），不经过打包，
 * 所以用 `h()` 而不是 JSX。
 *
 * 挂载点是 `conversation.input.dock`——输入框上方的全宽条目区，内置的任务清单
 * （`todo`）与目标（`goal`）就在那里。这是一个 `list` 槽：**用自己的 id 注册就
 * 会并列加在它们旁边**，不会替换任何一个；用内置的 id 才会顶掉它。
 *
 * 没有计划的会话**一个像素都不占**：读不到计划就返回 null，免得平白挤掉内置条目。
 *
 * 数据全部来自 host 端的 `/dsh-tree-task-flow/*` 接口；条目本身不持有任何状态，
 * 动作（完成 / 丢弃 / 停止 / 恢复 / 重置）都是 POST 回 host，由 host 改真正的文件。
 *
 * 面板只展示两样东西：**每个节点提交的结果**，以及**现在是不是停在检查点**。
 *
 * 「完成」必须带结果，所以它不是一步按钮：先在节点下展开一个输入框，
 * 写清产出了什么，再提交。结果一旦提交，这个节点整段执行过程就会被它顶替，
 * 所以输入框的提示语要把这一点讲明白。
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

		/** 取首行并截断。树上只报"产出了什么"，全文展开看。 */
		function firstLine(text, limit) {
			const line = String(text ?? "").split("\n")[0].trim();
			return line.length > limit ? line.slice(0, limit) + "…" : line;
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

		function mark(node) {
			if (node.status === "done") return "[x]";
			if (node.status === "dropped") return "[-]";
			return "[ ]";
		}

		/** 三层节点总数与已完成数，给折叠时的摘要用。 */
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

		/** 当前活动节点的标题：子任务优先，其次任务，最后目标。 */
		function currentLabel(data) {
			const active = data.active;
			if (!active) return "";
			const goal = data.plan.goal;
			const task = (goal.tasks || []).find((each) => each.id === active.taskId);
			if (!task) return goal.title;
			const step = (task.steps || []).find((each) => each.id === active.stepId);
			return step ? step.title : task.title;
		}

		// ---------------------------------------------------------------- 文案

		const zh = {
			nav: "树形任务流",
			"empty.title": "这个会话还没有计划",
			"empty.hint": "让模型调用 tree_task_create 建立目标与任务，这里就会显示整棵树。",
			"state.running": "进行中",
			"state.stopped": "自动续行已停止",
			"state.done": "已全部完成",
			"state.checkpoint": "检查点",
			"checkpoint.note": "「{title}」的子节点已全部结束。要么继续给它拆子节点，要么提交结果并完成它。",
			"btn.stop": "停止自动续行",
			"btn.resume": "恢复自动续行",
			"btn.reset": "清空计划",
			"btn.refresh": "刷新",
			"btn.done": "完成…",
			"btn.drop": "丢弃",
			"btn.submit": "提交结果",
			"btn.cancel": "取消",
			"label.result": "结果",
			"label.noResult": "（还没提交结果）",
			"label.current": "当前",
			"label.checkpointHere": "检查点",
			"placeholder.result":
				"写清这个节点产出了什么。它整段执行过程会被这条结果顶替，所以要能独立看懂。",
			"confirm.reset": "确定要清空这个会话的计划树吗？",
			"confirm.drop": "确定要丢弃「{title}」吗？",
			"settings.title": "树形任务流",
			"settings.enabled": "已启用",
			"settings.disabled": "未启用",
			"settings.impact": "启用后它会做什么",
			"settings.impact.1": "在每个会话的系统提示词里加一段固定的工具组说明（会话内逐字节不变）。",
			"settings.impact.2": "注册 6 个 tree_task_* 工具。",
			"settings.impact.3":
				"一个节点完成时，把它那一段执行过程从模型可见的上下文里折叠掉，换成一条携带提交结果的汇总消息。",
			"settings.impact.4":
				"一个节点的子节点全部结束时转入检查点：那一刻只放行 tree_task_plan 与 tree_task_done。",
			"settings.impact.5":
				"可选：模型停下来时自动续行（默认关闭；你按下停止后不会再被拉起来）。",
			"settings.howto": "怎么开 / 怎么关",
			"settings.howto.body":
				"改 profile 的 cordis.patch.yml 里 task-tree 那一行的 config.enabled，然后重启 dsh web。装上不等于启用——默认是关的。",
			"settings.stateDir": "状态目录",
			"settings.sessions": "有计划的会话",
			"settings.noSessions": "（还没有）",
			"settings.checkpoint": "检查点",
		};

		const en = {
			nav: "Tree Task Flow",
			"empty.title": "No plan in this session yet",
			"empty.hint": "Ask the model to call tree_task_create to build a goal and tasks.",
			"state.running": "In progress",
			"state.stopped": "Auto-continue stopped",
			"state.done": "All done",
			"state.checkpoint": "Checkpoint",
			"checkpoint.note":
				"Every child of “{title}” has finished. Either break out more children, or submit its result and complete it.",
			"btn.stop": "Stop auto-continue",
			"btn.resume": "Resume auto-continue",
			"btn.reset": "Clear plan",
			"btn.refresh": "Refresh",
			"btn.done": "Complete…",
			"btn.drop": "Drop",
			"btn.submit": "Submit result",
			"btn.cancel": "Cancel",
			"label.result": "Result",
			"label.noResult": "(no result submitted yet)",
			"label.current": "current",
			"label.checkpointHere": "checkpoint",
			"placeholder.result":
				"State what this node produced. Its whole execution range is replaced by this result, so it must stand on its own.",
			"confirm.reset": "Clear this session's plan tree?",
			"confirm.drop": "Drop “{title}”?",
			"settings.title": "Tree Task Flow",
			"settings.enabled": "Enabled",
			"settings.disabled": "Not enabled",
			"settings.impact": "What it does once enabled",
			"settings.impact.1": "Adds one static tool-group section to every session's system prompt.",
			"settings.impact.2": "Registers six tree_task_* tools.",
			"settings.impact.3":
				"When a node completes, folds its execution range out of the model-visible context and replaces it with one summary message carrying the submitted result.",
			"settings.impact.4":
				"When every child of a node finishes, the tree enters a checkpoint: only tree_task_plan and tree_task_done are allowed there.",
			"settings.impact.5":
				"Optional auto-continue when the model goes idle (off by default; never resumes after you stop it).",
			"settings.howto": "How to enable / disable",
			"settings.howto.body":
				"Set config.enabled on the task-tree row in the profile's cordis.patch.yml, then restart dsh web. Installing is not enabling — it is off by default.",
			"settings.stateDir": "State directory",
			"settings.sessions": "Sessions with a plan",
			"settings.noSessions": "(none yet)",
			"settings.checkpoint": "checkpoint",
		};

		// ---------------------------------------------------------------- 样式

		const S = {
			wrap: { padding: "10px 12px", font: "13px/1.6 system-ui, sans-serif", overflow: "auto", height: "100%" },
			// 输入框上方的条目：和内置 todo / goal 条目共用同一片区域。
			// 宽度必须照它们的算法来——直接写 100% 会顶满整栏，和消息正文对不齐。
			dock: {
				boxSizing: "border-box",
				width:
					"calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)" +
					" - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)" +
					" - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))",
				maxWidth:
					"calc(var(--dsh-composer-card-max-width)" +
					" - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)" +
					" - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))",
				border: "0.5px solid var(--dsw-alias-border-l1, #00000018)",
				background: "var(--dsw-specific-tip, #00000008)",
				borderRadius: "12px",
				flex: "none",
				margin: "0 auto",
				overflow: "hidden",
				"--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
				"--dsh-scrollbar-thumb-hover": "var(--dsw-alias-scrollbar-hover-l2)",
			},
			dockHead: { display: "flex", alignItems: "center", gap: "8px", padding: "0 12px" },
			dockToggle: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flex: "auto",
				minWidth: 0,
				background: "none",
				border: "none",
				color: "inherit",
				cursor: "pointer",
				padding: "6px 0",
				font: "inherit",
				textAlign: "left",
			},
			dockTitle: { fontWeight: 500, flex: "none", fontSize: "13px" },
			dockProgress: {
				color: "var(--dsw-alias-label-tertiary, #00000088)",
				fontSize: "13px",
				flex: "auto",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			dockChevron: { color: "var(--dsw-alias-label-tertiary, #00000088)", flex: "none" },
			dockBody: { padding: "0 12px 8px", maxHeight: "260px", overflow: "auto" },
			bar: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" },
			btn: {
				border: "1px solid var(--dsh-border, #d0d0d0)",
				background: "transparent",
				color: "inherit",
				borderRadius: "6px",
				padding: "3px 8px",
				cursor: "pointer",
				font: "inherit",
			},
			badge: { borderRadius: "6px", padding: "2px 6px", background: "var(--dsh-muted, #00000010)" },
			badgeWarn: {
				borderRadius: "6px",
				padding: "2px 6px",
				background: "var(--dsh-warn, #ffcc0033)",
				border: "1px solid var(--dsh-warn-border, #cc990055)",
			},
			warn: {
				marginTop: "6px",
				padding: "6px 8px",
				borderRadius: "6px",
				fontSize: "13px",
				background: "var(--dsh-warn, #ffcc0033)",
			},
			node: { marginLeft: "0", padding: "3px 0" },
			child: { marginLeft: "14px", borderLeft: "1px solid var(--dsh-border, #00000018)", paddingLeft: "8px" },
			stepTitle: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
			done: { opacity: 0.55 },
			cur: { fontWeight: 600 },
			meta: { opacity: 0.7, font: "12px/1.5 ui-monospace, monospace", wordBreak: "break-all" },
			resultLine: { opacity: 0.75, marginTop: "1px" },
			hint: { opacity: 0.65, marginTop: "6px" },
			err: { color: "var(--dsh-danger, #c00)", whiteSpace: "pre-wrap" },
			pre: {
				margin: "2px 0 0",
				padding: "6px 8px",
				background: "var(--dsh-muted, #00000010)",
				borderRadius: "6px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				font: "12px/1.5 ui-monospace, monospace",
				maxHeight: "220px",
				overflow: "auto",
			},
			form: { marginTop: "6px", border: "1px solid var(--dsh-border, #d0d0d0)", borderRadius: "6px", padding: "6px" },
			textarea: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: "64px",
				font: "12px/1.5 ui-monospace, monospace",
				background: "transparent",
				color: "inherit",
				border: "1px solid var(--dsh-border, #d0d0d0)",
				borderRadius: "4px",
				padding: "4px",
				resize: "vertical",
			},
		};

		// ---------------------------------------------------------------- 零件

		/** 一行节点的抬头：标记 + 标题 + 徽章 + id + 操作按钮。 */
		function NodeHeader({ node, t, isCurrent, isCheckpoint, onToggle, onDone, onDrop, canDrop, busy }) {
			const canAct = node.status === "pending";
			return h(
				"div",
				{ style: S.stepTitle },
				h("span", null, mark(node)),
				h(
					"a",
					{
						href: "#",
						style: { color: "inherit" },
						onClick: (event) => {
							event.preventDefault();
							onToggle();
						},
					},
					node.title,
				),
				isCurrent ? h("span", { style: S.badge }, t("label.current")) : null,
				isCheckpoint ? h("span", { style: S.badgeWarn }, t("label.checkpointHere")) : null,
				h("span", { style: S.meta }, node.id),
				canAct ? h("button", { style: S.btn, disabled: busy, onClick: onDone }, t("btn.done")) : null,
				canAct && canDrop
					? h("button", { style: S.btn, disabled: busy, onClick: onDrop }, t("btn.drop"))
					: null,
			);
		}

		/** 提交结果的输入框。空文本提交不出去——host 也会拒绝，这里先挡住。 */
		function CompleteForm({ onSubmit, onCancel, busy, error, t }) {
			const [text, setText] = useState("");
			return h(
				"div",
				{ style: S.form },
				h("textarea", {
					style: S.textarea,
					value: text,
					rows: 4,
					placeholder: t("placeholder.result"),
					onChange: (event) => setText(event.target.value),
				}),
				error ? h("div", { style: S.err }, error) : null,
				h(
					"div",
					{ style: Object.assign({}, S.bar, { marginTop: "6px" }) },
					h(
						"button",
						{
							style: S.btn,
							disabled: busy || text.trim() === "",
							onClick: () => onSubmit(text),
						},
						t("btn.submit"),
					),
					h("button", { style: S.btn, disabled: busy, onClick: onCancel }, t("btn.cancel")),
				),
			);
		}

		/** 一个节点提交过的结果。折叠时只报首行，展开时给全文。 */
		function ResultBlock({ node, t, expanded }) {
			if (!node.result) {
				return expanded ? h("div", { style: S.meta }, t("label.result") + "：" + t("label.noResult")) : null;
			}
			if (!expanded) {
				return h("div", { style: S.resultLine }, t("label.result") + "：" + firstLine(node.result.text, 100));
			}
			return h(
				"div",
				null,
				h("div", { style: S.meta }, t("label.result") + "（" + formatTime(node.result.at) + "）"),
				h("pre", { style: S.pre }, node.result.text),
			);
		}

		function StatusBar({ data, sessionId, reload, t }) {
			const [busy, setBusy] = useState(false);

			const act = useCallback(
				async (body) => {
					setBusy(true);
					try {
						await post(Object.assign({ sessionId }, body));
						await reload();
					} finally {
						setBusy(false);
					}
				},
				[sessionId, reload],
			);

			const checkpoint = data.checkpoint;
			const badge = checkpoint
				? t("state.checkpoint")
				: data.stopped
					? t("state.stopped")
					: data.active === null
						? t("state.done")
						: t("state.running");

			return h(
				"div",
				null,
				h(
					"div",
					{ style: S.bar },
					h("span", { style: checkpoint ? S.badgeWarn : S.badge }, badge),
					h(
						"button",
						{ style: S.btn, disabled: busy, onClick: () => act({ action: data.stopped ? "resume" : "stop" }) },
						data.stopped ? t("btn.resume") : t("btn.stop"),
					),
					h(
						"button",
						{
							style: S.btn,
							disabled: busy,
							onClick: () => {
								if (window.confirm(t("confirm.reset"))) act({ action: "reset" });
							},
						},
						t("btn.reset"),
					),
					h("button", { style: S.btn, disabled: busy, onClick: reload }, t("btn.refresh")),
				),
				checkpoint
					? h(
							"div",
							{ style: S.warn },
							t("state.checkpoint") + "：" + checkpoint.label + "「" + checkpoint.title + "」",
							h("div", null, t("checkpoint.note", { title: checkpoint.title })),
						)
					: null,
			);
		}

		function StepNode({ step, isCurrent, isCheckpoint, sessionId, reload, t, defaultOpen = true }) {
			const [open, setOpen] = useState(defaultOpen);
			const [composing, setComposing] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);

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

			const style = Object.assign({}, S.node, step.status === "done" ? S.done : null);

			return h(
				"div",
				{ style },
				h(NodeHeader, {
					node: step,
					t,
					isCurrent,
					isCheckpoint,
					onToggle: () => setOpen(!open),
					onDone: () => {
						setComposing(true);
						setOpen(true);
					},
					onDrop: () => {
						if (window.confirm(t("confirm.drop", { title: step.title }))) act({ action: "drop", id: step.id });
					},
					canDrop: true,
					busy,
				}),
				h(ResultBlock, { node: step, t, expanded: false }),
				open
					? h(
							"div",
							{ style: S.child },
							step.detail ? h("div", { style: S.meta }, step.detail) : null,
							h(ResultBlock, { node: step, t, expanded: true }),
							composing
								? h(CompleteForm, {
										t,
										busy,
										error,
										onSubmit: (text) => act({ action: "done", id: step.id, result: text }),
										onCancel: () => {
											setComposing(false);
											setError(null);
										},
									})
								: null,
						)
					: null,
			);
		}

		function TaskNode({ task, active, checkpoint, sessionId, reload, t, defaultOpen = true }) {
			const [open, setOpen] = useState(defaultOpen);
			const [composing, setComposing] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);

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

			const style = Object.assign({}, S.node, task.status === "done" ? S.done : null);
			const steps = task.steps || [];

			return h(
				"div",
				{ style },
				h(NodeHeader, {
					node: task,
					t,
					isCurrent: active?.taskId === task.id,
					isCheckpoint: checkpoint?.id === task.id,
					onToggle: () => setOpen(!open),
					onDone: () => {
						setComposing(true);
						setOpen(true);
					},
					onDrop: () => {
						if (window.confirm(t("confirm.drop", { title: task.title }))) act({ action: "drop", id: task.id });
					},
					canDrop: true,
					busy,
				}),
				h(ResultBlock, { node: task, t, expanded: false }),
				open
					? h(
							"div",
							{ style: S.child },
							task.detail ? h("div", { style: S.meta }, task.detail) : null,
							h(ResultBlock, { node: task, t, expanded: true }),
							composing
								? h(CompleteForm, {
										t,
										busy,
										error,
										onSubmit: (text) => act({ action: "done", id: task.id, result: text }),
										onCancel: () => {
											setComposing(false);
											setError(null);
										},
									})
								: null,
							steps.length === 0
								? h("div", { style: S.hint }, "（还没有子任务 → 让模型调用 tree_task_plan）")
								: steps.map((step) =>
										h(StepNode, {
											key: step.id,
											step,
											isCurrent: active?.stepId === step.id,
											isCheckpoint: checkpoint?.id === step.id,
											sessionId,
											reload,
											t,
											defaultOpen,
										}),
									),
						)
					: null,
			);
		}

		function GoalNode({ goal, active, checkpoint, sessionId, reload, t, defaultOpen = true }) {
			const [open, setOpen] = useState(defaultOpen);
			const [composing, setComposing] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);

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

			const tasks = goal.tasks || [];

			return h(
				"div",
				null,
				h(NodeHeader, {
					node: goal,
					t,
					isCurrent: active?.goalId === goal.id,
					isCheckpoint: checkpoint?.id === goal.id,
					onToggle: () => setOpen(!open),
					onDone: () => {
						setComposing(true);
						setOpen(true);
					},
					// 整个目标不能丢弃：plan.js 会拒绝，这里也不给按钮。
					canDrop: false,
					busy,
				}),
				h(ResultBlock, { node: goal, t, expanded: false }),
				open
					? h(
							"div",
							{ style: S.child },
							goal.detail ? h("div", { style: S.meta }, goal.detail) : null,
							h(ResultBlock, { node: goal, t, expanded: true }),
							composing
								? h(CompleteForm, {
										t,
										busy,
										error,
										onSubmit: (text) => act({ action: "done", id: goal.id, result: text }),
										onCancel: () => {
											setComposing(false);
											setError(null);
										},
									})
								: null,
							tasks.map((task) =>
								h(TaskNode, {
									key: task.id,
									task,
									active,
									checkpoint,
									sessionId,
									reload,
									t,
									defaultOpen,
								}),
							),
						)
					: null,
			);
		}

		// ---------------------------------------------------------------- 条目

		/**
		 * 输入框上方的全宽条目。
		 *
		 * 折叠时只有一行：标题 + 进度 + 当前节点。展开才画整棵树，并限高滚动——
		 * 这是输入框旁边的位置，不能让它把会话挤没了。
		 *
		 * 会话没有计划时返回 null：内置的 todo / goal 条目不该因为我而挪位。
		 */
		function TaskTreeDock(props) {
			const t = useT();
			const sessionId = props.sessionId;
			const [state, setState] = useState({ loading: true });
			const [open, setOpen] = useState(false);

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

			if (state.loading || state.empty || !state.data) return null;

			const data = state.data;
			const stats = countNodes(data.plan.goal);
			const current = currentLabel(data);

			return h(
				"div",
				{ style: S.dock },
				h(
					"div",
					{ style: S.dockHead },
					h(
						"button",
						{ style: S.dockToggle, onClick: () => setOpen(!open) },
						h("span", { style: S.dockTitle }, t("nav")),
						h(
							"span",
							{ style: S.dockProgress },
							stats.done + "/" + stats.total + (current ? " · " + current : ""),
						),
						h("span", { style: S.dockChevron }, open ? "▾" : "▸"),
					),
					data.checkpoint ? h("span", { style: S.badgeWarn }, t("state.checkpoint")) : null,
				),
				open
					? h(
							"div",
							{ style: S.dockBody },
							h(StatusBar, { data, sessionId, reload, t }),
							h(
								"div",
								{ style: { marginTop: "6px" } },
								h(GoalNode, {
									goal: data.plan.goal,
									active: data.active,
									checkpoint: data.checkpoint,
									sessionId,
									reload,
									t,
									// 展开整棵树的动作已经由上面那一行承担，这里默认为折叠。
									defaultOpen: false,
								}),
							),
						)
					: null,
			);
		}

		// ---------------------------------------------------------------- 设置页

		function SettingsSection() {
			const t = useT();
			const [state, setState] = useState({ loading: true });

			useEffect(() => {
				api("/dsh-tree-task-flow/sessions")
					.then((data) => setState({ loading: false, data }))
					.catch((error) => setState({ loading: false, error: String((error && error.message) || error) }));
			}, []);

			if (state.loading) return h("div", { style: S.wrap }, "…");
			if (state.error) return h("div", { style: S.wrap }, h("div", { style: S.err }, state.error));

			const enabled = state.data && state.data.enabled === true;
			const sessions = (state.data && state.data.sessions) || [];

			const row = (label, value) =>
				h(
					"div",
					{ style: { display: "flex", gap: "8px", margin: "2px 0" } },
					h("span", { style: { minWidth: "9em", opacity: 0.7 } }, label),
					h("span", null, value),
				);

			return h(
				"div",
				{ style: S.wrap },
				h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, t("settings.title")),
				row(
					"",
					h("span", { style: S.badge }, enabled ? t("settings.enabled") : t("settings.disabled")),
				),
				h("div", { style: { marginTop: "10px", fontWeight: 600 } }, t("settings.impact")),
				h(
					"ul",
					{ style: { margin: "4px 0 10px 1.2em", padding: 0 } },
					[
						"settings.impact.1",
						"settings.impact.2",
						"settings.impact.3",
						"settings.impact.4",
						"settings.impact.5",
					].map((key) => h("li", { key }, t(key))),
				),
				h("div", { style: { fontWeight: 600 } }, t("settings.howto")),
				h("div", { style: S.hint }, t("settings.howto.body")),
				h("div", { style: { marginTop: "10px", fontWeight: 600 } }, t("settings.stateDir")),
				h("div", { style: S.meta }, "$DSH_HOME/dsh-task-tree/"),
				h(
					"div",
					{ style: { marginTop: "10px", fontWeight: 600 } },
					t("settings.sessions") + "：" + sessions.length,
				),
				sessions.length === 0
					? h("div", { style: S.hint }, t("settings.noSessions"))
					: h(
							"div",
							{ style: S.child },
							sessions.map((item) =>
								h(
									"div",
									{ key: item.sessionId, style: S.meta },
									item.goal +
										" · " +
										item.done +
										"/" +
										item.steps +
										(item.checkpoint ? " · " + t("settings.checkpoint") : "") +
										" · " +
										item.sessionId,
								),
							),
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

			// 设置页：只显示状态与影响说明（启用与否由 profile 配置决定，运行时不改）。
			ctx.effect(
				() =>
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{
								name: "settings.section",
								id: ENTRY_ID,
								order: 45,
								label: () => translate("nav"),
								locale: NS,
								inject: () => ({}),
							},
							SettingsSection,
						),
					),
				"dsh-tree-task-flow: settings section",
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
