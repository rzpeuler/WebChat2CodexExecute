# web_chat2codex_exe 正式设计

日期：2026-09-09
状态：已确认，进入实现规划
范围：Windows 本地桌面编排器；Edge Web Chat 中的 Sol；Codex CLI 中的 Luna

## 1. 目标

在用户完成产品方向、顶层架构和初始治理确认后，自动完成以下循环：

1. 监控专用 Edge profile 中绑定的 ChatGPT Project 与当前 Sol 会话；
2. 识别 Sol 的思考、完成、异常和上下文过长状态；
3. 提取合法 Writing Block 中的任务、治理变更和架构冻结文档；
4. 将普通治理变更和架构冻结落盘、版本化并同步到 Git 远端；
5. 在最新治理和架构快照下启动一个 Codex CLI Luna 会话；
6. 收集 Luna 的代码、测试和任务报告，创建 commit 并 push；
7. 向 Sol 当前会话发送“最新提交完成，可以开始验收”；
8. 在可恢复异常时保存状态，并用 Windows 通知提醒用户。

本产品不替代 Sol 的产品和架构判断，也不让 Luna 自行改变项目治理规则。

## 2. 已确认的产品决策

- 使用专用 Edge profile；首次由用户手动登录，后续复用该 profile 的 Cookie。
- 首次绑定时选择一个具体的 Sol 对话；绑定时最后一条消息只建立基线，不立即执行。
- 绑定对象本质上是 Project + 当前活动会话，而不是永久固定某一个会话。
- 同一个 Sol 回合最多产生一个 LUNA_TASK。
- 同一个 Sol 回合可以包含多个 GOVERNANCE_CHANGE 和多个 ARCHITECTURE_FREEZE。
- 没有任务队列；检测到多个 Luna 任务时拒绝执行并通知。
- 普通治理变更自动生效；高风险治理变更只生成候选变更并通知用户。
- 架构冻结由 Sol 产出，软件负责下载、校验、保存、版本化和提交，不能交给 Luna。
- Luna 对任务范围内的实现细节自行决策，不需要向用户或 Sol 请求确认。
- 外部账号、API Key、验证码、第三方平台配置、需求冲突和范围扩展可以阻塞 Luna。
- Luna 任务完成后由软件统一校验、commit 和 push；禁止强制 push。
- 任务阶段完成或达到轮换阈值时，Sol 和 Codex 都可以主动新建会话。
- 检测到 CONTEXT_LIMIT 时，在同一 Project 中自动新建 Sol 会话并原样重放上一次输入。
- 新会话再次发生上下文过长时暂停并通知。

## 3. 非目标

第一版不包括：

- OpenAI API 直连替代 Web Chat；
- 多个项目同时运行；
- 多个 Luna 任务并发；
- 任务队列；
- 自动处理第三方账号登录、验证码和 API Key；
- 自动覆盖高风险治理规则；
- 直接读取或导出日常 Edge profile 的 Cookie；
- 依赖 Codex Desktop UI 作为 Luna 的主执行通道；
- 依赖截图/OCR 作为正常状态识别的主要方式。

## 4. 总体架构

```text
专用 Edge profile
        │
        ▼
EdgeSessionAdapter ── Sol 状态、Writing Block、下载、消息发送
        │
        ▼
SolProtocolParser ── 任务/治理/架构/阻塞协议校验
        │
        ├── GovernanceStore ── 文档注册表、版本、哈希、候选变更
        ├── SessionHandoffStore ── 会话链和上下文轮换包
        └── LoopStateStore ── 幂等、恢复、当前阶段
        │
        ▼
GitController ── 基线检查、同步 commit、代码 commit、push
        │
        ▼
CodexRunner ── codex exec、Luna 报告、退出状态
        │
        ▼
Notifier ── Windows 通知、状态面板、人工接管
```

各组件通过稳定的内部接口通信。Edge 页面结构、Codex CLI 参数和 Git 执行细节不应泄漏到其他组件。

## 5. 初始化向导

### 5.1 项目配置与初始化

初始化向导支持两种模式：

- 新项目：用户选择本地父目录，输入远端仓库地址和目标目录名，软件执行 `git clone`；
- 已有项目：用户选择 Git 仓库根目录，软件执行治理接管。

两种模式随后执行同一套治理初始化：先备份原有 `docs/governance`，再写入标准模板，最后由软件自动 commit 和 push。远端、当前分支和当前 commit 在已有项目中优先读取；凭证仍由本机 Git Credential Manager 或 SSH 管理，不能写入配置。

初始化向导提供“检查 Git 远程授权”按钮，以非交互方式执行远端可访问性检查，并将认证失败、网络失败和地址错误分开提示。Codex/OpenAI 登录状态不等于 GitHub 远端授权；软件不会把任一方的凭证复制或保存到项目配置。

### 5.2 唯一治理入口

软件不根据目录名或文件名推断外部治理候选。项目仓库内严格锁定：

```text
docs/governance/
├── README.md
├── PROJECT_RULES.md
├── DEVELOPMENT_WORKFLOW.md
├── AGENT_ROLES.md
├── GIT_POLICY.md
└── governance-manifest.yaml
```

`docs/governance` 是唯一有效治理入口，manifest 中登记的 active 文档是当前规则。已有目录在接管前备份到 `.web-chat2codex/backups/governance/<run-id>/`；已由本工具初始化且无漂移时重复操作幂等，发生漂移则拒绝静默覆盖。

外部 `AGENTS.md`、`CLAUDE.md`、README 和其他文档继续保留，不由初始化流程停用，也不自动成为治理规则。绑定 Edge 会话后，用户可以点击“治理一致性检查”，由 Sol 自行判断这些文件是否与 `docs/governance` 冲突。

## 6. 治理文档与 LLM 边界

### 6.1 软件负责

- 保存治理和架构文件；
- 计算哈希；
- 维护版本和注册表；
- 生成治理快照；
- 创建治理同步 commit；
- 执行路径、分支、基线和风险校验；
- 控制是否允许提交和 push。
- 仅对 Sol 明确输出的治理一致性替换执行备份、全文替换、commit 和 push；不负责语义筛选。

### 6.2 Sol 负责

- 产品方向；
- 顶层架构；
- 治理规则内容；
- 任务拆分；
- 验收标准；
- 架构冻结文档；
- 是否接受 Luna 发现的治理缺口。

### 6.3 Luna 负责

- 代码实现；
- 测试和验证；
- 任务报告；
- 报告治理缺口；
- 在既定治理和架构范围内自行决策实现细节。

Luna 可以报告 GOVERNANCE_GAP，但不能直接修改活动治理规则。

## 7. Sol 初始化提示词

软件生成一份 Sol 初始化主提示词，包含：

- Sol、Luna 和编排软件的角色；
- 项目路径、远端仓库、分支和当前 commit；
- 治理文档索引及当前版本；
- 架构文档及当前有效版本集合；
- Git、commit、push 和报告规则；
- Writing Block 协议；
- 单回合单任务规则；
- 多架构冻结规则；
- 治理变更的风险分类；
- Luna 实现细节自行决策规则；
- 外部配置和高风险操作的阻塞规则。

普通 Web Chat 中，这份内容作为初始化主提示词发送；如果用户将稳定规则放入 ChatGPT Project 指令，则后续 Project 内新会话可以继续使用该规则。项目指令和项目来源的可用性不能替代本地仓库治理快照。

每次运行发送给 Sol 的动态上下文包含：

```text
当前 commit
治理版本
架构版本集合
最近 Luna 报告摘要
最近治理缺口
当前阶段
当前运行状态
```

动态输入必须自包含，不能依赖旧聊天中的“继续上面的任务”等简称。

## 8. Writing Block 协议

Sol 输出允许包含以下类型：

```text
LUNA_TASK
GOVERNANCE_CHANGE
GOVERNANCE_RECONCILIATION
ARCHITECTURE_FREEZE
BLOCKED
```

一条 Sol 回合允许的数量：

```text
0 或 1 个 LUNA_TASK
0 或多个 GOVERNANCE_CHANGE
0 或 1 个 GOVERNANCE_RECONCILIATION（仅由治理一致性检查入口使用）
0 或多个 ARCHITECTURE_FREEZE
```

### 8.1 LUNA_TASK 必填字段

```text
task_id
title
objective
base_commit
scope
out_of_scope
deliverables
validation_commands
governance_revision
architecture_revision_set
report_path
remote_sync_policy
```

### 8.2 GOVERNANCE_CHANGE

```text
change_id
operation
document_id
path
reason
risk_level
affected_agents
content
```

支持新增文档、更新文档、增加章节、废弃文档和建立决策记录。

### 8.3 GOVERNANCE_RECONCILIATION

该 block 只由“治理一致性检查”按钮触发的独立流程消费，不进入普通 Sol 回合，不启动 Luna：

```text
status: PASS | CHANGES_REQUIRED | BLOCKED
baseline_commit: required when CHANGES_REQUIRED
files[].path
files[].action: replace
files[].reason
files[].sha256_before
files[].content: complete file text
```

Sol 负责自行检查 `docs/governance` 之外可能影响治理的文件并决定是否冲突；软件只做路径、文件类型、SHA 和全文完整性校验，随后自动备份、替换、commit 和 push。

### 8.4 ARCHITECTURE_FREEZE

```text
freeze_id
version
download_url
sha256_if_known
reason
affected_scope
luna_follow_up
```

多个架构冻结必须全部下载和校验成功后，作为一个原子架构同步变更提交。

### 8.5 协议错误

以下情况拒绝启动 Luna：

- 多个 LUNA_TASK；
- 缺少任务 ID、基准 commit 或验证命令；
- 治理版本不一致；
- 架构下载不完整；
- Writing Block 未闭合或无法解析；
- 任务范围超出项目绑定范围。

## 9. 治理与架构同步

Sol 输出治理或架构变更后：

1. 软件验证路径、文档 ID、风险级别和内容；
2. 保存旧版本；
3. 写入新文档或候选文档；
4. 更新治理注册表；
5. 计算治理/架构快照哈希；
6. 创建独立同步 commit；
7. push 到目标远端；
8. push 成功后才允许启动 Luna。

推荐提交形式：

```text
chore(governance): sync <change_id>
```

高风险变更包括删除治理文档、改变权限、改变分支规则、改变 push 规则和削弱安全边界。此类变更只产生候选文件并通知用户，不自动生效；依赖该变更的 Luna 任务必须暂停，不能使用候选文件作为活动治理快照。

## 10. Luna 执行

软件将以下内容组合为 Luna 输入：

- 项目路径和当前 commit；
- 最新治理快照；
- 最新架构版本集合；
- 一个 LUNA_TASK；
- 执行授权；
- 报告格式；
- Git 范围规则。

任务授权要求 Luna：

- 对任务范围内的实现细节自行决策；
- 不向用户或 Sol 请求普通方案确认；
- 记录假设、取舍和最终决定；
- 遇到外部账号、API Key、验证码、需求冲突、范围扩展或高风险操作时报告并暂停。

Codex CLI 会话由软件创建。第一版不依赖 Codex Desktop 的窗口状态。Luna 可以修改代码和写报告，但最终代码 commit 和 push 由 GitController 统一执行。

## 11. Luna 结果协议

Luna 最终输出必须包含：

```text
LUNA_RESULT
status: COMPLETED | BLOCKED_EXTERNAL_SETUP | FAILED
summary: ...
assumptions:
  - ...
changes:
  - ...
tests:
  - command: ...
    status: PASSED | FAILED | NOT_RUN
governance_gaps:
  - ...
report_path: docs/task-reports/<task_id>.md
```

软件使用进程状态、机器可解析输出、退出码、报告存在性、测试结果和 Git 状态综合判断，不以自然语言中的“完成”单独判断成功。

## 12. Git 流程

```text
检查工作区和分支
        ↓
同步治理/架构 commit
        ↓
确认同步 commit 已 push
        ↓
启动 Luna
        ↓
收集代码和报告
        ↓
执行验证
        ↓
创建代码 commit
        ↓
push
        ↓
向 Sol 发送验收消息
```

安全规则：

- 工作区存在未授权修改时暂停；
- 当前分支不匹配时暂停；
- 禁止 force push；
- push 失败时保留本地 commit，不重复创建新 commit；
- 恢复前先查询远端是否已有该 commit；
- Git 凭证由 SSH 或 Git Credential Manager 管理；
- 日志和通知不得暴露凭证。

## 13. 会话轮换与上下文恢复

### 13.1 主动轮换

触发条件：

- Sol 明确输出阶段完成；
- 达到配置的已完成任务数阈值；
- Codex 阶段完成且需要进入新阶段。

轮换时生成 Session Handoff，包含当前产品目标、阶段、已完成任务摘要、commit、治理版本、架构版本、未解决问题和下一步背景。它不写入治理文档，除非其中内容被 Sol 明确提升为长期规则。

主动轮换时同步创建新的 Sol Project chat 和新的 Codex CLI session。旧会话保留为历史链，不删除。

### 13.2 CONTEXT_LIMIT 恢复

检测到上下文过长后：

1. 保存旧会话、Project、错误摘要和最后一次发送给 Sol 的原始输入；
2. 在同一 Project 下创建新聊天；
3. 验证新聊天属于相同 Project 和账号；
4. 原样重放上一次输入；
5. 将新聊天设为当前活动会话；
6. 继续监控新会话。

同一个上下文过长事件只恢复一次。新会话再次过长、创建失败、Project 不匹配或输入无法重放时暂停并通知。

### 13.3 新会话输入

上下文恢复要求重放原始输入；主动轮换使用新的自包含 Handoff。两者不能混淆。

## 14. Sol 状态机

```text
UNBOUND
  ↓
BOUND_IDLE
  ↓
THINKING
  ↓
COMPLETED_CANDIDATE
  ↓
PARSING
  ↓
APPLYING_UPDATES
  ↓
RUNNING_LUNA
```

异常状态：

```text
NETWORK_ERROR
CONTEXT_LIMIT
AUTH_REQUIRED
SESSION_LOST
SESSION_CHANGED
AMBIGUOUS
PROTOCOL_ERROR
```

正常完成需要消息停止变化、连续采样哈希一致、页面恢复可发送、Writing Block 合法且不是绑定基线消息。

## 15. 异常与通知

可有限重试的异常：

- 页面临时加载失败；
- 网络短暂中断；
- 文档下载超时；
- 页面尚未稳定。

默认最多重试三次，之后暂停。

必须通知并暂停的异常：

- 登录失效；
- 上下文过长恢复失败；
- API Key 或第三方配置缺失；
- Codex CLI 不可用；
- 报告缺失；
- 测试失败；
- 工作区、分支或远端异常；
- 高风险治理变更；
- 多任务或协议错误。

通知只显示摘要、任务 ID、阶段和建议动作。完整诊断保存在本地日志。

## 16. 状态持久化

软件必须保存：

```text
project_id
local_repo_path
remote_url_redacted
target_branch
sol_project_fingerprint
active_conversation_url
conversation_chain
codex_session_chain
task_id
task_input_hash
governance_revision
architecture_revision_set
base_commit
code_commit
push_status
current_phase
retry_count
last_error
```

状态写入需要原子替换，避免软件崩溃造成半写入状态。

## 17. 第一版验收标准

1. 可初始化项目并生成 Sol 主提示词；
2. 可启动专用 Edge profile 并复用登录状态；
3. 可选择并绑定一个 Project 内的 Sol 对话；
4. 绑定时不会执行已有历史消息；
5. 可解析一个 Luna 任务；
6. 多个 Luna 任务会被拒绝，不进入队列；
7. 多个架构冻结可原子保存；
8. 治理同步 commit push 成功后才启动 Luna；
9. Luna 可在最新治理和架构快照下运行；
10. Luna 的实现细节不要求用户确认；
11. 外部配置缺失会暂停并通知；
12. 代码、报告、测试、commit 和 push 全部成功后才通知 Sol 验收；
13. 可在同一 Project 中自动恢复 CONTEXT_LIMIT；
14. 主动轮换时 Sol 和 Codex 都能创建新会话；
15. 软件重启后不会重复执行已完成任务；
16. 网络、登录、上下文过长、远端失败和协议错误均有明确状态和通知。

## 18. 主要风险

- Web Chat DOM 和错误文案变化，需将 Edge 适配器与协议解析器隔离；
- Project 新聊天的 UI 流程变化，需验证 Project 身份后才发送输入；
- Sol 输出不遵守协议，必须 fail closed；
- 远端 push 和本地状态可能出现响应丢失，恢复时必须先查询远端；
- 治理规则不断增加，文档注册表和 GOVERNANCE_CHANGE 必须保持开放扩展；
- 本地 CLI 登录、账号权限和模型可用性需要在安装验收中单独验证；
- 自动化软件只能控制其可访问的本地仓库和浏览器 profile，不能假设拥有其他账户或平台权限。

## 19. 设计结论

第一版采用“专用 Edge profile + Project/会话链 + Codex CLI + 仓库治理快照 + 原子 Git 同步”的架构。稳定规则进入 Project 指令和仓库治理文档；阶段状态进入软件状态和 Session Handoff；LLM 负责决策和实现，软件负责确定性执行、状态、版本和安全边界。
