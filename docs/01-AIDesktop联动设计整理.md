# AIDesktop「联动计划 + 记忆」设计整理

> 来源项目：`C:\apps\AIDesktop`
> 整理范围：目标（计划）执行模式与记忆系统如何**联动**——数据层、注入层、执行层、前端层。
> 本文件只描述既有实现与设计，不提出新设想；来源文件均在每节末尾标注。

---

## 1. 一句话概括

AIDesktop 把用户的一个大目标拆成 **L1 目标 → L2 任务 → L3 步骤** 三级结构，
用一条 **`path` 字符串**作为贯穿全系统的联动主键，
让「目标树」「消息记录」「上下文装配」「记忆」「沙箱文件层」五样东西**指同一件事**：

```
path = /g:{goalId}/t:{taskId}/s:{stepId}
```

- 目标树节点点击 → 用 path 拉取该节点的消息（前端联动）
- Agent 写消息 → 按「状态变更写父级」规则落到某个 path（归属联动）
- 组装上下文 → 按 path 取「父链 + 当前分支」（加载联动）
- 记忆按 taskId 分层 → 与 L2 任务节点同一把钥匙（记忆联动）
- 沙箱文件层按 task 分支存放 → 与 path 的 `t:` 段对齐（回退联动）

**联动的本质：path 既是"消息属于哪个目标节点"的答案，也是"该加载哪些上下文"的答案，还是"该回忆哪些记忆"的答案。**

---

## 2. 三级目标模型（联动的骨架）

| 层级 | 名称 | 谁创建 | 是否需要状态 | 能否并行 |
|------|------|--------|--------------|----------|
| L1 | 一级目标 | AI 与用户沟通后 `goal_create` | 存在即活跃（无中间状态） | 多个 L1 可并行 |
| L2 | 二级目标 / 任务 | AI 规划时 `goal_plan` | 需要：planned / in-progress / completed / cancelled | 同一 L1 内多个 L2 可并行 |
| L3 | 三级步骤 | AI 动态维护 `goal_plan` / `goal_update` | waiting / in-progress / completed / cancelled | 不支持并行，任务内串行 |

状态推进：L3 完成时若同 L2 下还有 waiting 的 L3 则推进；否则标记 L2 完成并进入下一个 L2；所有 L2 收尾则 L1 完成。
`goal_update` 支持增、删（标记 cancelled，不物理删除）、改、重排 L3。

来源：`server/src/services/goalService.ts`、`docs/设计/目标模式设计文档.md`、`docs/adr/0002-goal-execution-mode.md`

---

## 3. 存储层：联动靠三个字段

### 3.1 目标表

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, conv_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active / completed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE goal_items (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  parent_id TEXT REFERENCES goal_items(id),   -- L3 指向 L2；L2 为 NULL
  level INTEGER NOT NULL CHECK(level IN (2,3)),
  title TEXT NOT NULL, description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
```

### 3.2 消息表：`path`（归属）+ `load_flag`（回退）+ `turn_id`（循环层）

```sql
ALTER TABLE messages ADD COLUMN path TEXT DEFAULT '/';       -- 迁移 v4
ALTER TABLE messages ADD COLUMN load_flag INTEGER DEFAULT 1; -- 迁移 v4：0 = 已回退，不加载
ALTER TABLE messages ADD COLUMN turn_id TEXT;                -- 迁移 v5：一次 agent 循环
CREATE INDEX idx_messages_path ON messages(conv_id, path);
CREATE INDEX idx_messages_turn ON messages(conv_id, path, turn_id);
```

来源：`server/src/services/database.ts`（迁移 v3/v4/v5）

---

## 4. 联动规则一：消息归属（写哪个 path）

这是整套联动里最关键、也最容易看漏的一张表——**状态变更要写到父级**：

| 消息类型 | 写入 path | 理由 |
|----------|-----------|------|
| 任务建立前的对话确认 | 根 `/` | 目标模式**不加载**，保持上下文干净 |
| L1 目标建立 | `/g:{goalId}` | — |
| L2 任务开始（入口消息） | `/g:{goalId}/t:{taskId}` | 任务流 |
| 步骤执行期间 AI 对话 / 工具调用 / 结果 | `/g:{goalId}/t:{taskId}/s:{stepId}` | 步骤分支 |
| **L3 步骤 开始 / 完成 / 取消** | `/g:.../t:{taskId}`（**父级**） | 状态变更属于任务流，必须出现在下一步上下文里 |
| **L2 任务 完成** | `/g:{goalId}`（**父级**） | 任务完成对全目标可见 |
| **L1 目标 完成** | 根 `/`（**父级**） | 目标收尾回到会话级 |
| 用户在任务模式下的输入 | 当前活动步骤分支 | 属于当前执行 |

设计文档给出的理由原话是：**「状态变更归属：步骤状态→L2 任务流；任务状态→L1 任务流（写父级）」**，
配合第 5 节的加载规则「父链可见」，正好保证：**下一步的 AI 一定看得见上一步完成了什么，但看不见上一步的过程**。

来源：`docs/设计/目标模式设计文档.md` §4.2；实现见 `server/src/agent/runner.ts` 中
`handleGoalStepComplete`、`runTaskConfirm` 的 `addMessage(..., { path })` 调用。

---

## 5. 联动规则二：上下文加载（读哪些 path）

```sql
-- 某节点及其子树（前端点节点时用）
WHERE conv_id = @convId AND (path = @path OR path LIKE @path || '/%') AND load_flag = 1

-- 节点执行上下文（喂给 AI 时用）
-- path=/g:x/t:A/s:2 →
--   任务流精确消息  path = '/g:x/t:A'
-- + 当前步骤分支    path = '/g:x/t:A/s:2' 或其前缀
```

两个查询的差别就是**联动的第二条规则**：

- **前端点击节点**：取「该节点 + 子树」= 这一块做了什么的完整视图。
- **组装模型上下文**：取「任务流精确消息 + 当前步骤分支」= 任务级状态 + 当前步骤过程。

再叠加三条语义：

1. **跳过根对话**：任务模式建立后，`path='/'` 的任务前确认上下文不加载，只加载任务相关干净上下文 + 固定注入。
2. **跳过 `load_flag=0`**：被回退过的轮次留在库里、界面可展开查看，但绝不进上下文。**回退因此不需要改写历史，只要改标记。**
3. **并行互不污染**：各 L2 任务各自一条流 + 各自步骤分支树，切换任务 = 切换 path = 切换上下文。

来源：`server/src/services/conversation.ts` 的 `getMessagesByPath` / `getNodeContext` / `getNodeStats` / `markTurnUnloaded` / `addRollbackMarker`

---

## 6. 联动规则三：记忆三级共享

### 6.1 作用域

| 层级 | 键 | 存储位置 | 说明 |
|------|-----|----------|------|
| 应用级 `app` | appId | `apps_data/{appId}/memories.json` | 跨会话 |
| 会话级 `conversation` | appId + convId | `.../conversations/{convId}/memories.json` | 会话内跨任务 |
| **任务级 `task`** | appId + convId + **taskId** | `.../conversations/{convId}/tasks/{taskId}/memories.json` | **★联动点：taskId 就是 L2 节点 id** |

任务级记忆的目录名 `tasks/{taskId}` 与 path 里的 `/t:{taskId}` 用的是同一个 id——
**这是记忆与目标树真正的"联动"物理证据**：L2 任务下所有 L3 步骤继承该任务的记忆。

### 6.2 记忆条目结构

```ts
{
  id, type: 'fact' | 'goal' | ...,
  key: string,        // 标题，注入上下文用
  value: string,      // 摘要（保存时取正文前 80 字）
  content: string,    // 详情，AI 按需读取，上限 100KB
  tags: string[],     // 含 source/{agent|user}、importance/{high|normal|low}、goal/active
  scope, conversationId, ttl?, version, createdAt, updatedAt
}
```

### 6.3 注入策略（关键：只注入 key，不注入 content）

记忆块进 system prompt 时**只给标题**，详情由 AI 用 `memory_read` 按需拉：

```
## 长期记忆
### User
- user.name: 张三
- user.pref 偏好中文回答
```

设计意图（`tools/memory.ts` 注释原话）：**「标题列表（keys）通过 buildSystemPrompt 全量注入到 AI 上下文，详细内容由 AI 通过 memory_read 按需读取。」**

这就是「万级消息不爆上下文」的一半答案：
原始消息走 path 树形裁剪，长期信息走「索引全量 + 正文按需」。

### 6.4 工具集

| 工具 | 作用 |
|------|------|
| `memory_save(key, content)` | 保存，正文截断上限 100KB |
| `memory_list()` | 列出所有标题 |
| `memory_read(key)` | 按标题读正文 |
| `memory_search(pattern)` | 按标题关键词搜索 |

### 6.5 记忆与目标树在前端的绑定

`MemoryPanel` 渲染目标树时，**每个 L3 步骤节点后挂一个 📝 按钮**，
点击展开该步骤关联的记忆条目（`stepMemories[item.id]`）。
即：**记忆不是独立列表，而是挂在计划节点上的附件**。

来源：`server/src/services/memory.ts`、`server/src/tools/memory.ts`、`server/src/agent/system-prompt.ts` §目标模式注入、`client/src/components/MemoryPanel.tsx`

---

## 7. 执行层：一轮里的联动时序

### 7.1 AI 侧工具（5 个 + 帮助）

| 工具 | 作用 | 关键返回 |
|------|------|----------|
| `goal_help` | 计划模式说明 | 帮助文本 |
| `goal_create(title, description?)` | 建 L1 | goal.id |
| `goal_plan(goalId, subgoals[])` | 建 L2/L3；第一个 L3 自动 in-progress | 带各节点 id 的树 + 进度 |
| `goal_step_complete(stepId)` | 完成一个 L3，自动推进 | `details.stepComplete = true` ★ |
| `goal_update(goalId, {add,remove,reorder,modify})` | 动态改计划 | 更新后的 items |
| `goal_get()` | 看当前目标树 | 完整树 |

### 7.2 循环结束确认机制（L2 级）

```
AI 工作告一段落（输出不带工具调用的内容）
  → 系统临时把工具集换成只剩 task_confirm 一个
  → 问 AI：当前任务「xxx」的工作已告一段落，请确认
      completed（附 summary）/ continue / failed
  → 恢复原工具集，把确认结果写进当前任务流 path
```

`task_confirm` 是**循环结束后才临时注入的唯一工具**，目的是让 AI 无法"顺手继续干活"，
必须面对"这个任务到底完成没有"这个问题。

### 7.3 步骤完成后的自动续行（联动的发动机）

```
goal_step_complete 执行
  → 返回 details.stepComplete = true
  → runner 检测到该标志，abort 当前 agent 循环
  → handleGoalStepComplete:
       ① 给刚完成的步骤写「步骤完成: xxx」到 L2 任务流 path
       ② setImmediate 启动 runAgentAsync（无用户输入）
  → 下一轮装配时走目标模式分支：
       hasActiveGoal → getActiveNode 拿活动 path
       → getNodeContext(path) 按上文规则取上下文
       → session.agent.state.messages = orderToolMessages(piMsgs)
       → prompt('请继续执行当前步骤。')
  → AI 在新上下文里干下一步
```

**这就是"计划驱动执行"的闭环：工具调用 → 状态落库 → 上下文重装 → 自动进入下一步。**

### 7.4 沙箱层与回退（path 的第五个用途）

```
.aide-vfs/{convId}/
└── task-package-xxx/        ← 任务包
    ├── {taskId}/            ← L2 任务（类比 git 分支）
    │   ├── turn-001/        ← 一次 agent 循环（类比 git 提交）
    │   └── turn-002/
    └── {taskId2}/           ← 并行分支同步被写
```

- 回退由**用户**触发，只支持从后往前（栈式）。
- **无痕回退**：消息 `load_flag=0`（库里保留、界面可展开）+ VFS 层直接删除 → AI 不知情地重做。
- **有原因回退**：在回退处插入一条含原因的用户消息。
- 「上下文组装时跳过 `load_flag=0`」= 自动得到回退后的正确上下文。

来源：`server/src/agent/runner.ts`、`server/src/sandbox/layered-overlay.ts`、`docs/设计/目标模式设计文档.md` §6

---

## 8. 前端层：两棵树，一条 path

### 8.1 目标树（InjectionBar）

展开后渲染 L1 → L2（带状态图标）→ L3（当前步骤高亮），每个节点可点击：

```ts
function buildNodePath(goal, subgoalId?, stepId?) {
  let p = `/g:${goal.id}`;
  if (subgoalId) p += `/t:${subgoalId}`;
  if (stepId)    p += `/s:${stepId}`;
  return p;
}
// 点击 → onSelectNode?.(buildNodePath(...))
```

底部还有一行 `↺ 显示完整会话` → `onSelectNode?.('/')`。

### 8.2 树形消息列表（TreeMessageList）

按 `L2 任务 → L3 步骤 → agent 循环` 三级折叠，每级显示统计：

```
📁 任务A            消息 42 | 工具 12        [查看]
  📄 步骤A1         消息 18 | 工具 5         [查看]
    循环 1          消息 6  | 工具 2         [撤回]
    循环 2          消息 8  | 工具 3         [撤回]
  📄 步骤A2         ...
```

- 节点高亮靠 `activePath`。
- 回退按钮回调 `onRollback(taskId, turnId, taskPath)`。
- 「查看」回调 `onSelectStep(path)` → 重新拉取该 path 消息。

### 8.3 联动闭环

```
InjectionBar 点 L3 节点
   → onSelectNode(path)
   → MessageList 用该 path 重新拉取渲染，并高亮
   → 后端用同一个 path 查询（getMessagesByPath / getNodeContext）
```

**前端点击路径与后端上下文加载路径共用同一把钥匙**——这是"联动"在代码层面的收敛点，
也是从 AIDesktop 搬到任何宿主时最值得保留的性质。

来源：`client/src/components/InjectionBar.tsx`、`client/src/components/TreeMessageList.tsx`、`client/src/components/MemoryPanel.tsx`

---

## 9. 可搬运的性质清单（给 DSH 插件用）

把上面实现细节剥掉，这套联动剩下 7 条与宿主无关的性质：

| # | 性质 | 价值 |
|---|------|------|
| 1 | **三级目标树**（L1 目标 / L2 任务 / L3 步骤），L2 可并行、L3 串行 | 大目标可拆解、可追踪、可并行 |
| 2 | **节点 path 作为唯一坐标**，目标树/消息/上下文/记忆/文件层共用 | 一处点击，处处对齐 |
| 3 | **状态变更写父级**，过程写自身 | 下一步看得见结果，看不见过程 |
| 4 | **记忆三级作用域**（app / conversation / task），taskId = L2 节点 id | 记忆随任务走，任务结束即隔离 |
| 5 | **记忆索引全量注入 + 正文按需读取** | 长期信息不占上下文 |
| 6 | **工具返回完成标志 → 装配下一轮上下文 → 自动续行** | 计划能真正驱动执行，而不是"建议" |
| 7 | **回退靠标记不靠删除**（load_flag=0）+ 文件层删层 | 可回溯、可重做、AI 无感知 |

---

## 10. 关键来源文件索引

| 文件 | 内容 |
|------|------|
| `docs/设计/目标模式设计文档.md` | v2 完整设计（树形上下文、并行、回退、前端） |
| `docs/adr/0002-goal-execution-mode.md` | 10 条架构决策 |
| `docs/功能需求/目标模式PRD.md` | 需求侧 |
| `server/src/services/goalService.ts` | 目标树数据层、path 构造、活动节点、进度 |
| `server/src/services/memory.ts` | 三级记忆、注入块、归档 |
| `server/src/services/conversation.ts` | path 查询、回退标记 |
| `server/src/services/database.ts` | 表结构与迁移 |
| `server/src/tools/goal.ts` | 5 个目标工具 |
| `server/src/tools/memory.ts` | 4 个记忆工具 |
| `server/src/agent/runner.ts` | 步骤完成/任务确认/自动续行/上下文重装 |
| `server/src/agent/system-prompt.ts` | 目标树 + 三级记忆注入 |
| `server/src/routes/injections.ts` | 前端目标树的 `_tree` 数据源 |
| `client/src/components/InjectionBar.tsx` | 目标树 + onSelectNode |
| `client/src/components/TreeMessageList.tsx` | 树形消息列表 + 回退 |
| `client/src/components/MemoryPanel.tsx` | 目标树挂记忆 |
