# Writing Block JSON 模板驱动设计

状态：已确认，待实现

日期：2026-09-11

## 1. 背景与目标

前几轮测试表明，仅依靠 Sol 系统提示词要求其手写 Writing Block，仍可能出现块内 JSON/YAML 解析冲突。典型风险包括数组类型错误、多行内容缩进错误、引号和反斜杠未转义、`null` 与对象或字符串混用，以及必填字段缺失。

本设计将 Writing Block 的输出格式改为“模板驱动”：项目治理目录保存每种 Writing Block 的 JSON 模板，Sol 读取模板并按原结构填写；软件仍是最终协议校验者，不自动猜测或修复有歧义的任务语义。

目标：

- 让 Sol 有稳定、可读取、可版本化的输出结构来源；
- 统一所有 Writing Block 的块内格式为 JSON；
- 保留现有解析器对 YAML 的兼容能力，避免旧输出立即失效；
- 让新项目初始化和已有项目接管都得到相同的模板结构；
- 使协议结构扩展可以通过模板版本和软件解析器协同升级。

非目标：

- 不让模板替代软件的严格解析和安全校验；
- 不由软件自动修复 Sol 输出中的任务语义或路径语义；
- 不改变 `docs/governance` 是唯一治理入口的既有规则；
- 不改变一回合最多一个 `LUNA_TASK` 的规则；
- 不改变治理/架构变更的 Git 提交和推送策略。

## 2. 模板目录与治理登记

固定目录：

```text
docs/governance/templates/writing-blocks/
├── luna-task.template.json
├── governance-change.template.json
├── architecture-freeze.template.json
├── blocked.template.json
└── governance-reconciliation.template.json
```

每个文件都是合法 JSON 对象。模板使用明确的占位字符串表达待填写值，例如 `<填写唯一任务 ID>`；数组、对象、布尔值和 `null` 使用正确的 JSON 类型表示。模板本身不作为 Sol 输出直接执行，只有 Sol 返回的 Writing Block 才进入解析器。

`governance-manifest.yaml` 为每个模板登记独立文档记录：

- `audience: [Sol, Codex]`；
- `status: active`；
- `type: writing-block-template`；
- 独立的文档 ID 和版本号；
- 路径必须位于 `docs/governance` 内。

模板由项目初始化器创建，属于治理初始化内容。已有 `docs/governance` 的项目继续按照既定策略先备份原目录，再安装标准治理目录和模板。

## 3. 模板内容约束

模板覆盖五类块：

### 3.1 `luna-task.template.json`

包含 `LUNA_TASK` 的全部必填字段：

`schema_version`、`task_id`、`title`、`objective`、`base_commit`、`scope`、`out_of_scope`、`deliverables`、`validation_commands`、`governance_revision`、`architecture_revision_set`、`report_path`、`remote_sync_policy` 和 `execution_semantics`。

其中：

- `scope`、`out_of_scope`、`deliverables`、`validation_commands` 必须是字符串数组；
- `architecture_revision_set` 必须是数组；
- `remote_sync_policy` 使用对象示例，不使用 `null`；
- `execution_semantics` 保留默认放行普通实现细节、仅对外部配置/冲突/高风险事项阻塞的语义。

### 3.2 `governance-change.template.json`

包含治理变更的必填字段，并将 `affected_agents` 表示为字符串数组，将完整文档内容表示为 JSON 字符串。多行内容必须使用 JSON 转义后的 `\\n`，引号和反斜杠必须转义。

### 3.3 `architecture-freeze.template.json`

包含冻结 ID、版本、下载地址、可选哈希、原因、影响范围和 Luna 后续动作。`affected_scope` 使用字符串数组，`sha256_if_known` 允许明确的 `null`。

### 3.4 `blocked.template.json`

包含 `code` 和 `reason`，用于 Sol 无法安全生成任务或需要外部用户操作时的结构化阻塞说明。

### 3.5 `governance-reconciliation.template.json`

包含治理一致性检查的状态字段。`CHANGES_REQUIRED` 模板同时展示 `baseline_commit` 和完整 `files` 替换结构；`PASS` 和 `BLOCKED` 的模板展示各自允许的字段形态。该块只由治理一致性检查入口消费，不进入普通 Luna 任务循环。

## 4. Sol 提示词边界

系统提示词不再重复携带所有字段的完整结构，只保留稳定的行为约束和模板路径：

- 读取 `docs/governance/templates/writing-blocks/` 下与当前动作对应的 JSON 模板；
- 复制模板结构，只替换占位值；
- 每个块的块内内容必须是一个完整 JSON 对象；
- 不使用 YAML、Markdown 代码围栏、注释、尾逗号或未转义的多行字符串；
- 同一回合最多一个 `LUNA_TASK`，治理变更和架构冻结保持独立块；
- 架构冻结由 Sol 和软件处理，不交给 Luna；
- 普通实现细节默认由 Luna 自行决定，不向 Sol 或用户二次确认。

模板路径是提示词的稳定入口；字段具体结构、示例和版本以治理目录中的模板为准。

## 5. 软件校验与执行边界

软件继续对 Sol 输出执行 fail-closed 校验：

1. 校验块头尾标记和块外内容；
2. 读取块体，优先接受合法 JSON，同时保留现有 YAML 兼容路径；
3. 校验 `schema_version`、块类型、必填字段和字段类型；
4. 校验数量限制、路径安全、基线、治理版本和架构版本；
5. 仅在完整校验通过后应用治理/架构变更或启动 Luna；
6. 失败时保留明确错误码和字段上下文，不自动修改 Sol 的任务语义。

模板中的占位符只用于帮助 Sol 填写。软件不得因为模板文件中存在占位符而将模板自身当作可执行任务。

对于合法 JSON 但语义不完整的输出，仍然拒绝执行并进入现有需要重新规划或可恢复错误路径。模板不能绕过 Git、治理、范围、外部配置和用户操作边界。

## 6. 初始化、接管与远端同步流程

### 新项目

1. 用户选择本地父目录并填写远端仓库地址；
2. 软件 clone 项目；
3. 软件创建标准 `docs/governance` 和五个 JSON 模板；
4. 软件更新治理 manifest；
5. 软件创建初始化提交并 push；
6. 用户在 ChatGPT Project 中刷新远端仓库内容后，Sol 可读取模板；
7. 用户使用生成的 Sol 系统提示词开始规划。

### 已有项目

1. 软件验证本地仓库、分支、远端和干净工作区；
2. 备份原有 `docs/governance`；
3. 安装标准治理目录、manifest 和 JSON 模板；
4. 创建初始化提交并 push；
5. 用户执行一次治理一致性检查，让 Sol 检查 `docs/governance` 外部的潜在冲突文档；
6. 软件按 `GOVERNANCE_RECONCILIATION` 结果自动备份、替换、提交和同步。

初始化同步失败时保留本地变更和可恢复的 Git pending 状态，不宣称远端已同步。

## 7. 版本与扩展策略

- 模板 JSON 使用 `schema_version`；
- manifest 文档使用独立版本号；
- 新增可选字段时，解析器先保持向后兼容；
- 新增必填字段或改变字段类型时，提升 schema 版本，并在初始化器中生成新模板；
- 旧项目升级时不直接覆盖用户修改过的模板，先将旧模板备份到工具管理的备份目录，再安装标准版本；
- 软件不能仅凭模板文件名推断协议版本，必须读取并校验版本字段；
- 未知扩展字段继续按现有协议保留，但不得改变已知字段的语义。

## 8. 异常与用户反馈

需要明确区分：

- 模板文件缺失或治理 manifest 未登记：初始化/提示词预览失败，提示修复治理目录；
- JSON 语法错误：显示块编号和 JSON 解析失败，不启动 Luna；
- 字段缺失或类型错误：显示块类型、字段名和期望类型；
- 多个 `LUNA_TASK`：拒绝旧输出，要求 Sol 重新规划；
- 模板版本与软件不兼容：暂停并提示升级软件或治理模板；
- 模板读取内容与远端基线不一致：按现有基线变更规则暂停；
- 认证、API Key、OTP 或其他外部平台配置缺失：进入 `NEEDS_USER_ACTION`，通知用户；
- 模板或输出包含敏感信息：沿用现有脱敏、日志和通知边界，不将完整敏感内容展示给用户。

## 9. 测试验收标准

### 模板与初始化

- 新项目初始化会创建五个合法 JSON 模板；
- 已有项目会备份原治理目录并安装相同模板；
- manifest 正确登记模板路径、受众、类型和版本；
- 初始化提交包含治理文件和模板，远端同步状态准确；
- 模板文件缺失、损坏、越界路径和版本冲突会 fail closed。

### 协议解析

- 五种模板示例替换为实际值后都能被解析器接受；
- JSON 字符串中的换行、引号、反斜杠、冒号和 URL 能稳定解析；
- 错误数组、`null`、缺失字段、错误版本、尾逗号和注释均被拒绝；
- YAML 旧输出仍按兼容路径解析；
- 多任务、嵌套块、未闭合块和块外文字仍被拒绝。

### Sol 与循环集成

- Sol 初始化提示词包含固定模板目录路径和 JSON-only 规则；
- 任务解析失败不会启动 Luna；
- 合法任务仍只启动一个 Luna 任务；
- 架构冻结和治理变更仍按既有独立同步流程执行；
- 模板升级不破坏旧版本兼容策略；
- Dashboard 能显示模板读取/协议解析失败的具体阶段和建议。

## 10. 实施边界

实现计划应拆分为：

1. 标准 JSON 模板和 manifest 初始化；
2. 模板读取/校验和提示词编译；
3. 协议 JSON-only 输出约束及兼容测试；
4. 旧项目接管、升级和 Git 同步测试；
5. UI 错误提示和真实本机验收。

本设计获用户批准后，才能进入实现计划和代码修改阶段。
