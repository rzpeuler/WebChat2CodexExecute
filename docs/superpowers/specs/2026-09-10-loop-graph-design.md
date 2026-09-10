# 自动循环 Loop Graph 设计

## 目标

将 Dashboard 的“自动循环”区域改为可视化 Loop Graph，使用户能一眼确认当前正在执行什么、流程停在哪个关键阶段、各阶段的状态以及下一步处理建议。图形必须以后台状态为唯一事实来源，不允许 Renderer 根据单一 `stage` 字段自行猜测复杂状态。

## 已确认的界面方案

- 使用横向流水线布局，适配当前 Dashboard 的自动循环区域。
- 使用 8 个关键节点，不展开为无限细的后端状态列表：
  `读取 Sol → 解析任务书 → 应用治理/架构更新 → 同步治理 → Luna 执行 → 同步代码 → 通知 Sol → 等待 Sol`。
- 所有节点显示状态摘要。
- 当前节点使用强高亮：蓝色边框、光晕、“当前”标签和呼吸点；这是界面的最高优先级视觉信号。
- 已完成节点为绿色，等待节点为灰色，可恢复阻塞为橙色，需要用户处理或新的 Sol 输出为红色，已暂停为紫色，不适用为灰色虚线。
- 点击任意节点后，在图下方展开该节点详情；流程图本身保持可见，详情为只读。
- 只展示当前轮快照，不保留无限增长的多轮历史。

## 后端状态契约

在共享 Dashboard 快照中增加 `loopGraph`，由后端编排器产生并随当前轮状态持久化。建议结构：

```ts
type LoopGraphNodeState =
  | 'PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'RECOVERABLE_BLOCKED'
  | 'NEEDS_USER_ACTION'
  | 'PAUSED'
  | 'NOT_APPLICABLE';

interface LoopGraphNodeSnapshot {
  id: string;
  label: string;
  state: LoopGraphNodeState;
  summary: string;
  details: string[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface LoopGraphSnapshot {
  roundId: string | null;
  currentNodeId: string | null;
  nodes: LoopGraphNodeSnapshot[];
}
```

`currentNodeId` 是当前正在做什么的权威字段。节点状态和摘要由编排器根据实际阶段转换、任务结果、Git 同步结果、Sol/Luna 会话及错误状态更新；Renderer 只渲染，不推导状态。快照需要经过与现有 Dashboard 相同的安全清洗，未知节点状态或超长文本必须安全降级。

## 节点信息

节点摘要和详情只展示当前轮相关信息，并对长度进行限制：

1. 读取 Sol：会话 ID、消息状态、输出编号或哈希。
2. 解析任务书：Writing Block 类型、数量、协议检查结果。
3. 应用治理/架构更新：治理变更数、架构冻结数、变更路径摘要。
4. 同步治理：本地 Commit、远端 Commit、同步结果。
5. Luna 执行：任务 ID、Luna 会话 ID、执行状态、耗时。
6. 同步代码：报告路径、测试结果、本地/远端 Commit、同步错误。
7. 通知 Sol：通知时间、提交信息、通知结果。
8. 等待 Sol：等待原因、最后更新时间、上下文恢复状态。

节点详情不直接复制完整日志或完整模型输出；如需要诊断，显示受限摘要和现有“查看报告/打开项目”等操作入口。

## 状态转换与异常

- 每一轮开始时节点为 `PENDING`；编排器进入某一阶段时该节点变为 `ACTIVE`，并设置 `currentNodeId`。
- 成功离开阶段后变为 `COMPLETED`；后续节点保持 `PENDING`。
- 无需执行的治理、架构或代码节点变为 `NOT_APPLICABLE`，避免用户误以为尚未运行。
- 可恢复技术故障进入 `RECOVERABLE_BLOCKED`，保留重试动作和错误摘要。
- 登录、授权、API Key、OTP、外部配置等进入 `NEEDS_USER_ACTION`，显示 Windows 通知和处理建议。
- Writing Block 协议错误、治理/范围冲突、基线变化、受保护文件越权和需要新 Sol 输出的结果进入阻塞状态，禁止旧输出重试，并显示“请让 Sol 重新输出/规划任务”。
- 用户暂停后，当前节点及整体状态保持 `PAUSED`，任何异步收尾不得把状态写回 `ACTIVE` 或 `RUNNING`。
- 应用重启后恢复最近一次当前轮快照；不恢复正在执行的进程，按现有启动恢复策略进入暂停或待机。

## Renderer 交互

- Loop Graph 作为自动循环区域的主体，保留启动、暂停、重试按钮。
- 节点使用可访问按钮，当前节点设置 `aria-current`，选中节点设置 `aria-expanded`。
- 点击节点只更新图下详情，不触发执行动作；所有执行动作继续经过后端 `enabled/busy/reason` 门禁。
- 横向空间不足时允许滚动，不引入缩放、拖拽或第三方图形库。
- 轮询维持 1.5 秒且单飞；节点详情随快照更新，防止旧详情覆盖新状态。

## 实现边界

- 只改共享 Dashboard 契约、编排器状态映射、Renderer HTML/CSS/TypeScript 和对应测试。
- 不修改 Sol/Luna Writing Block 协议、Git 提交策略、治理文档内容或远端仓库治理规则。
- 不建立多轮历史数据库；只保存当前轮节点状态和必要的时间字段。
- 如果 8 节点的持久化改动显著扩大状态机复杂度，可以退回 5 个核心节点，但必须保留当前节点强高亮、节点状态、摘要详情和后端权威快照四项能力。

## 验证

- 共享契约测试：节点顺序、状态枚举、未知值清洗、长度限制和旧快照兼容。
- 编排器测试：每个关键阶段映射、成功/阻塞/暂停/需要用户处理、当前节点唯一性和重启恢复。
- Renderer 测试：当前节点高亮、节点点击展开、快照更新、按钮门禁、1.5 秒单飞轮询和无障碍属性。
- 回归验证：类型检查、全量单元测试、构建、`git diff --check`。
