# ORCHESTRATOR 可恢复错误自动修复实现计划

设计依据：[2026-09-12-orchestrator-auto-repair-design.md](../specs/2026-09-12-orchestrator-auto-repair-design.md)

## 实施目标

为 Sol 输出解析阶段增加受白名单控制的自动修复分支。自动修复必须重新向当前 Sol 会话发送提示词并等待新输出；不得修改仓库、绕过基线校验、调用 Luna 或把人工阻塞转成自动重试。

## 任务 1：扩展状态和 Dashboard 协议

涉及文件：

- `src/main/orchestration/types.ts`
- `src/shared/contracts/dashboard.ts`
- `src/main/orchestration/orchestrator.ts`

工作内容：

1. 在编排器阶段和恢复状态中增加自动修复所需的持久化数据，至少记录错误码、原输出 key、任务类型、任务 ID、回合 ID、当前尝试次数、最大次数、状态和最近发送时间。
2. 增加固定 Graph 节点 `auto-repair`，位置为 `parse-task` 与 `wait-sol` 之间；保留现有 8 个节点顺序语义，不把自动修复变成任务队列。
3. 扩展节点映射、状态清理、旧状态归一化和重启恢复逻辑，确保旧版状态文件没有该节点时仍能正常加载。
4. 给 Dashboard snapshot 增加自动修复摘要，避免把完整修复提示词暴露到普通状态展示中。
5. 修复期间仅允许当前等待流程继续，启动、暂停、重试和继续按钮遵循 busy 状态，防止重复发送。

验收：旧状态可加载；新的 Graph 能唯一标识当前节点；状态持久化后重启不会丢失或重复发送修复任务。

## 任务 2：实现错误白名单和修复提示词

涉及文件：

- `src/main/orchestration/orchestrator.ts`
- `src/main/sol/prompt-compiler.ts`
- `src/main/orchestration/types.ts`
- `test/unit/orchestration.test.ts`

工作内容：

1. 建立显式的可自动修复错误白名单，并同时校验错误发生阶段：
   - `BASELINE_CHANGED` 只允许 `parse-task` 的任务基线不匹配进入；
   - Writing Block 语法和字段校验错误按设计文档进入；
   - 外部配置、工作区安全、Luna 结果不确定和治理应用器错误全部拒绝自动修复。
2. 新增纯函数提示词构造器，输入错误诊断、目标 Writing Block 类型、任务上下文和当前本地基线，输出受长度限制的修复提示词。
3. `BASELINE_CHANGED` 使用本地 Git 控制器已捕获的真实 HEAD；不得使用 Sol 提供的哈希覆盖软件基线。
4. 提示词要求保持任务 ID、目标、范围和验收标准不变，只输出一个合法目标 Writing Block，并禁止执行代码、修改仓库、commit、push 和块外解释。
5. 对错误诊断、任务字段和文件路径进行长度限制与安全清洗；超过现有提示词预算时直接转人工处理。

验收：提示词稳定、可测试、不会泄漏凭据；当前基线值准确；禁止错误不会生成修复提示词。

## 任务 3：接入 `parse-task` 自动修复分支

涉及文件：

- `src/main/orchestration/orchestrator.ts`
- `src/main/edge/types.ts`（仅在现有发送接口需要补充幂等上下文时）
- `src/main/edge/cdp-conversation.ts`（仅在需要保留现有发送确认语义时）

工作内容：

1. 在 `parseWritingBlocks` 或任务基线校验抛出白名单错误后，先创建自动修复记录并标记 `auto-repair` 节点为 `ACTIVE`。
2. 通过现有 `SolMessageSource.sendMessage` 发送修复提示词，不新增绕过会话绑定的发送通道。
3. 发送成功后将修复记录标记为 `WAITING_FOR_SOL`，Graph 当前节点切换到 `wait-sol`，并保留下一次读取所需的输出去重边界。
4. 新输出到达后必须经过完整 `read-sol`、Writing Block 解析、字段校验和基线校验；合法后清除修复记录并继续原有流程。
5. 发送失败、发送未确认、同错误重复出现或达到两次总上限时，转为 `NEEDS_USER_ACTION`，并给出具体原因。
6. 不能对同一个 `outputKey + errorCode + repairAttempt` 重复发送；重启后已确认进入等待状态的记录不得再次发送。

验收：当前 `BASELINE_CHANGED` 能自动回到等待 Sol；新任务书不会直接进入 Luna；重复错误会稳定停在人工处理状态。

## 任务 4：Graph 和前端状态展示

涉及文件：

- `src/renderer/app.ts`
- `src/renderer/index.html`
- `src/renderer/styles.css`
- `test/unit/phase-eight-dashboard.test.ts`

工作内容：

1. 在自动循环 Graph 中渲染 `auto-repair` 节点，并在节点周围显示错误码、尝试次数、发送/等待状态和最后更新时间。
2. 自动修复等待 Sol 时，明确显示“正在等待 Sol 输出修复后的 Writing Block”，区别于普通任务等待。
3. 自动修复进入人工处理时，显示失败原因和“不会自动执行 Luna”的说明。
4. 保持现有按钮状态管理，不新增会绕过状态机的前端按钮。
5. 对旧版没有自动修复字段的快照提供安全默认值。

验收：当前正在做什么可以被直接识别；按钮不会因节点新增而失去响应；旧快照仍可展示。

## 任务 5：测试和收口

涉及文件：

- `test/unit/orchestration.test.ts`
- `test/unit/phase-eight-dashboard.test.ts`
- `test/unit/writing-block-protocol.test.ts`（如现有文件名不同则沿用实际测试文件）
- `test/unit/application-wiring.test.ts`（如发送接口 wiring 受影响）

必须覆盖：

1. `BASELINE_CHANGED` 生成包含当前 HEAD 的修复提示词。
2. 修复消息发送成功后状态为 `WAITING_FOR_SOL`，不调用 Codex/Luna。
3. 新合法任务书到达后从 `parse-task` 正常继续。
4. Writing Block 块外文本、JSON、YAML、头部和字段错误可分别触发修复。
5. `BLOCKED_EXTERNAL_SETUP`、`UNAUTHORIZED_CHANGE`、`INVALID_RESULT`、治理 SHA 冲突等不会触发修复。
6. 同一错误最多一次、单回合总计最多两次，不出现死循环或重复消息。
7. 发送失败、未确认发送和应用重启恢复行为正确。
8. Graph 当前节点、节点详情、错误状态和按钮禁用状态一致。

验证命令：

```text
npm test
npm run typecheck
npm run build
git diff --check
```

实施顺序：任务 1 → 任务 2 → 任务 3 → 任务 4 → 任务 5。每项先运行相关单元测试，再进入下一项；全部通过后检查工作区、提交信息和远端状态。

## 风险和明确边界

- 若 Sol 在等待期间继续输出普通说明文字，仍按现有协议拒绝，不由软件猜测或拼接任务书。
- 若本地 HEAD 在自动修复等待期间变化，新输出必须重新校验，旧修复结果不能复用。
- 若任务已经进入 `run-luna` 或 `sync-code`，本功能不自动重跑，避免重复执行。
- 本计划不修改 ResearchHub_Lite 的治理模板；本次变更只影响本地 ORCHESTRATOR 的错误恢复。
