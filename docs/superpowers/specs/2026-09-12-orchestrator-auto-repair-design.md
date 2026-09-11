# ORCHESTRATOR 可恢复错误自动修复设计

## 1. 目标

当 Sol 已经给出任务或治理输出，但输出因为任务基线过期或 Writing Block 协议错误而无法被本地 ORCHESTRATOR 消费时，软件自动向 Sol 发送一次结构化修复请求，并回到 `WAITING_FOR_SOL` 等待新的输出。

自动修复只处理“重新输出即可解决”的错误，不绕过 Git 基线校验，不重复执行 Luna，不自动处理外部环境和真实执行结果的不确定性。

## 2. 适用范围

### 2.1 允许自动修复的错误

仅当错误发生在 Sol 输出读取或任务书解析阶段时，允许进入自动修复：

- `BASELINE_CHANGED`（仅限 `parse-task` 阶段的任务书 `base_commit` 不匹配）
- `WRITING_BLOCK_OUT_OF_BLOCK_CONTENT`
- `WRITING_BLOCK_HEADER_INVALID`
- `WRITING_BLOCK_UNCLOSED`
- `WRITING_BLOCK_BODY_INVALID_JSON`
- `WRITING_BLOCK_BODY_INVALID_YAML`
- `WRITING_BLOCK_UNKNOWN_TYPE`
- `WRITING_BLOCK_MISSING_FIELD`
- `WRITING_BLOCK_INVALID_FIELD`
- `WRITING_BLOCK_DUPLICATE_LUNA_TASK`

### 2.2 必须人工处理的错误

以下错误不进入 Sol 自动修复：

- `BLOCKED_EXTERNAL_SETUP`
- `UNAUTHORIZED_CHANGE`
- `INVALID_RESULT`
- `GOVERNANCE_RECONCILIATION_UNAVAILABLE`
- `GOVERNANCE_RECONCILIATION_SHA_CONFLICT`
- 账户、API Key、登录、权限或外部平台配置问题
- Luna 可能已经完成但结果无法确认的错误

原因是这些错误代表外部环境未准备好、工作区存在安全风险，或任务可能已经产生真实副作用。重新发送提示词不能安全地证明任务可以重做。

## 3. 状态流转

自动修复是当前节点的恢复分支，不创建任务队列，也不跳过原节点校验。

```text
parse-task
    |
    | 可自动修复错误
    v
auto-repair
    |
    | 发送修复请求成功
    v
WAITING_FOR_SOL
    |
    | 获取新输出
    v
read-sol -> parse-task
```

成功得到合法 Writing Block 后，清除本轮自动修复状态，继续原有流程。修复失败或超过次数限制后，进入 `NEEDS_USER_ACTION`，保留原错误、修复记录和下一步建议。

Graph 必须突出显示：

- 当前错误码
- 自动修复节点是否正在发送或等待 Sol
- 当前修复次数和上限
- 最近一次修复提示词发送时间
- 等待的是新输出，而不是旧的 baseline 消息

## 4. 修复次数和幂等

- 同一个错误码在同一个任务回合内最多自动修复 1 次。
- 单个任务回合最多自动修复 2 次。
- 相同 `outputKey + errorCode + repairAttempt` 不得重复发送。
- 自动修复过程中，启动、暂停、重试和继续按钮遵循当前运行状态，不允许重复触发相同操作。
- 收到新输出后必须重新执行完整的 Writing Block 解析和基线校验；自动修复不是放宽校验。

## 5. 修复提示词

修复提示词由软件根据错误类型生成，不由 Sol 自行决定修复边界。提示词必须包含：

- `ORCHESTRATOR_AUTO_REPAIR` 标识
- 原错误码和本地诊断
- 原任务类型、任务 ID 和本轮目标
- 当前项目真实 `base_commit`（适用于 `BASELINE_CHANGED`）
- 保持任务目标、范围和验收标准不变的要求
- 只输出一个完整合法的目标 Writing Block
- 禁止解释、Markdown 代码围栏和块外文本
- 禁止执行代码、修改仓库、commit 或 push

`BASELINE_CHANGED` 的核心内容如下：

```text
[ORCHESTRATOR_AUTO_REPAIR]

当前任务书无法被本地编排器接受。

错误码：BASELINE_CHANGED
原因：任务书中的 base_commit 与当前项目基线不一致。
当前真实 base_commit：<CURRENT_BASE_COMMIT>

请保持原任务 ID、目标、范围和验收标准不变，只更新 base_commit 为上述值。

请重新输出一个完整、合法的 LUNA_TASK Writing Block。
只能输出 Writing Block，不得输出解释、Markdown 代码围栏或块外文本。
不要执行代码，不要修改仓库，不要 commit，不要 push。
```

对于 Writing Block 协议错误，提示词只提供必要的错误诊断和目标类型，要求 Sol 重新序列化完整正文，不要求软件自行修补正文。

提示词必须经过现有长度限制检查；如果修复诊断导致提示词无法安全发送，则直接转人工处理。

## 6. 基线安全约束

`BASELINE_CHANGED` 的自动修复只更新 Sol 任务书中的声明值，不更新软件捕获的基线，也不接受 Sol 提供的任意哈希。当前基线必须由本地 Git 控制器读取，并在新任务书解析时再次校验。

如果在等待 Sol 期间本地仓库发生新的提交、推送或工作区变化，新任务书仍必须以最新捕获的基线重新校验；不允许沿用旧的自动修复结果。

## 7. 持久化和恢复

自动修复记录应随执行恢复状态持久化，至少包含：

- 原错误码和诊断
- 原输出标识
- 任务类型和任务 ID
- 当前修复次数
- 修复状态：`PENDING`、`SENT`、`WAITING_FOR_SOL`、`SUCCEEDED` 或 `EXHAUSTED`
- 最近一次提示词发送时间
- 关联的回合 ID

软件重启后，如果记录处于 `WAITING_FOR_SOL`，应恢复为等待 Sol，不重复发送提示词；如果记录处于 `SENT` 但尚未确认发送结果，应先执行现有发送确认逻辑，再决定是否转人工处理。

## 8. 测试要求

至少覆盖：

1. `BASELINE_CHANGED` 自动生成提示词，包含当前真实 HEAD。
2. 修复请求发送成功后状态进入 `WAITING_FOR_SOL`，而不是继续执行 Luna。
3. 新 Writing Block 到达后重新解析并继续正常流程。
4. 同一错误第二次出现后进入人工处理，不发生无限循环。
5. 单回合累计两次自动修复后进入人工处理。
6. Writing Block 协议错误能够自动重发，但不修改原始正文。
7. `BLOCKED_EXTERNAL_SETUP`、`UNAUTHORIZED_CHANGE`、`INVALID_RESULT` 等错误不会自动修复。
8. 重启后不会重复发送已确认的修复提示词。
9. 修复期间按钮状态和 Graph 当前节点正确更新。

## 9. 非目标

本设计不改变：

- Sol 任务书和治理一致性检查的字段协议
- Luna 的模型、推理强度和执行权限
- Git commit/push 的职责边界
- 外部账户、API Key 和登录流程
- 已完成但结果不确定的 Luna 任务的恢复策略
