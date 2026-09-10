# Loop Graph Dashboard 实现计划

## 实现目标

在现有 Dashboard 的自动循环区域加入后端权威的当前轮 Loop Graph，使用横向 8 节点、当前节点强高亮、节点摘要和图下详情展开。保持现有初始化、Edge 绑定、自动循环、Git 同步、Windows 通知和 Dashboard 动作门禁不变。

## 任务 1：扩展共享快照契约

修改：

- `src/shared/contracts/dashboard.ts`
- `src/main/orchestration/types.ts`（如需要将当前轮快照纳入持久化状态）
- `test/unit/phase-eight-dashboard.test.ts`

内容：

1. 定义固定顺序的 8 个节点 ID 和节点标签。
2. 增加 `LoopGraphNodeState`：`PENDING`、`ACTIVE`、`COMPLETED`、`RECOVERABLE_BLOCKED`、`NEEDS_USER_ACTION`、`PAUSED`、`NOT_APPLICABLE`。
3. 增加节点快照字段：`id`、`label`、`state`、`summary`、`details`、`startedAt`、`completedAt`、`updatedAt`。
4. 增加 Loop Graph 快照：`roundId`、`currentNodeId`、`nodes`。
5. 将 `loopGraph` 加入 `DashboardSnapshot` 和 `DashboardSnapshotSource`。
6. 为节点数量、ID、文本长度、时间格式和未知状态增加安全清洗；旧快照缺少 `loopGraph` 时返回安全的空/待机图，不影响旧状态读取。

验收：契约测试能证明节点顺序固定、恶意/超长输入被清洗、旧快照仍可显示，且当前节点最多一个。

## 任务 2：实现编排器当前轮状态投影

修改：

- `src/main/orchestration/orchestrator.ts`
- `src/main/orchestration/types.ts` 或持久化状态验证文件
- `test/unit/orchestration.test.ts`

内容：

1. 建立 8 节点与现有 phase 的明确映射：
   - `READING_SOL` → 读取 Sol
   - `PARSING` → 解析任务书
   - `APPLYING_UPDATES` → 应用治理/架构更新
   - `SYNCING_GOVERNANCE` → 同步治理
   - `RUNNING_LUNA` → Luna 执行
   - `SYNCING_CODE` → 同步代码
   - `NOTIFYING_SOL` → 通知 Sol
   - `WAITING_FOR_SOL` → 等待 Sol
2. 每轮开始初始化节点；进入 phase 时更新 `currentNodeId`、当前节点状态和开始时间；成功离开阶段时标记完成。
3. 对无任务、无治理更新、无架构更新等路径标记 `NOT_APPLICABLE`，不伪装成等待。
4. 将任务 ID、会话 ID、Commit、报告、测试、错误码等已有状态投影为摘要和受限详情，不复制完整模型输出或完整日志。
5. 对可恢复错误、用户操作阻塞、需要新 Sol 输出、暂停和上下文恢复分别映射节点状态，并复用现有通知建议。
6. 保证异步暂停竞态不能将当前节点或整体状态写回 `ACTIVE/RUNNING`；应用重启只恢复持久化快照，不恢复正在执行的进程。
7. `getDashboardSnapshot()` 输出清洗后的 Loop Graph，动作 `enabled/busy/reason` 继续由后端权威计算。

验收：每个 phase 有对应节点；成功、网络/CLI 错误、协议错误、治理冲突、用户操作和暂停均有测试；currentNodeId 与节点状态一致。

## 任务 3：接入持久化与恢复边界

修改：

- `src/main/orchestration/types.ts`
- `src/main/state/*` 中对应状态验证/初始化文件
- `test/unit/startup-recovery.test.ts`
- `test/unit/persistence.test.ts`（仅在需要时）

内容：

1. 只保存当前轮 `roundId`、节点状态和必要时间字段，不保存无限增长的多轮历史。
2. 启动时校验节点 ID、顺序和状态；损坏或不兼容的图降级为安全待机/暂停状态，并保留现有错误恢复策略。
3. 在异常、暂停、成功完成和进程重启边界验证快照一致性。

验收：状态文件往返读取后节点信息不丢失；非法快照不会让应用启动失败或开放动作权限。

## 任务 4：实现 Renderer Loop Graph

修改：

- `src/renderer/index.html`
- `src/renderer/styles.css`
- `src/renderer/app.ts`

内容：

1. 将自动循环区域的静态 Dashboard 主体替换为横向可滚动的 8 节点图。
2. 节点使用按钮语义，显示编号、标签、状态摘要和状态标识；当前节点设置 `aria-current`。
3. 当前节点应用强高亮：蓝色边框、光晕、“当前”标签和呼吸点；其他状态使用设计文档约定的颜色和图例。
4. 所有节点显示摘要；点击节点后在图下方展开详情，使用 `aria-expanded`，不触发执行命令。
5. 每次快照刷新后同步节点状态和详情；若当前节点变化，自动收起旧节点详情并展开新当前节点，避免显示过时信息。
6. 保留现有启动、暂停、重试按钮、后端动作门禁、1.5 秒单飞轮询、错误建议和功能说明浮窗。
7. 窄窗口允许横向滚动，不引入第三方图形库、缩放或拖拽依赖。

验收：运行中能明确看到唯一当前节点；节点状态和摘要随快照变化；点击详情不产生后台命令；按钮 busy/disabled 行为不回归。

## 任务 5：测试与可访问性验证

修改：

- `test/unit/phase-eight-dashboard.test.ts`
- `test/unit/orchestration.test.ts`
- `test/unit/phase-eight-renderer-security.test.ts`
- 必要时新增专门的 Loop Graph 测试文件

内容：

1. 测试 8 节点固定顺序、清洗和向后兼容。
2. 测试所有现有 phase 映射、currentNodeId 唯一性、成功/阻塞/暂停/重启恢复。
3. 测试节点详情使用 `textContent` 或安全 DOM API，不执行模型输出中的 HTML/脚本。
4. 测试当前节点高亮、节点点击详情、未知状态降级、空图降级和轮询单飞。
5. 测试动作按钮仍受后端 `enabled/busy/reason` 门禁，旧 Sol 输出与危险并发不能绕过。
6. 验证 `aria-current`、`aria-expanded`、键盘聚焦和横向滚动布局。

## 任务 6：集成验证与交付

执行：

```powershell
npx prettier --check src test
npm run typecheck
npm test
npm run build
git diff --check
```

通过后：

1. 检查工作树只包含本次 Loop Graph 相关文件。
2. 提交清晰的功能 commit。
3. 推送 `origin/master`。
4. 重启桌面应用，进行一次人工冒烟测试：待机、读取 Sol、解析、Luna 执行、同步代码、失败/暂停、完成等待 Sol。
5. 记录测试结果、commit、远端状态和剩余风险。

## 风险与控制

- 8 节点需要跨共享契约、持久化、编排器和 Renderer 协调；先完成契约和后端投影，再接 Renderer，避免前端自行推导。
- 当前 phase 不一定能表达每个节点的真实完成时间；首版只记录当前轮阶段进入/完成时间，不建立历史事件流。
- 现有 Renderer 测试以 Node 环境为主；若没有 DOM 测试运行时，不伪造运行时覆盖，至少补充契约/源码安全测试，并通过人工冒烟验证交互。
- 如状态迁移显著扩大现有编排器复杂度，按已批准边界退回 5 个核心节点，但不得削弱当前节点强高亮、后端权威状态、节点摘要和图下详情四项能力。
