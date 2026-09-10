# Writing Block JSON 模板驱动实现计划

状态：待用户确认后实施

关联设计：[2026-09-11-writing-block-json-templates-design.md](../specs/2026-09-11-writing-block-json-templates-design.md)

## 实施目标

在不改变现有 Writing Block 解析器 fail-closed 边界、治理目录锁定规则、Git 同步策略和“一回合最多一个 LUNA_TASK”规则的前提下：

- 初始化项目时生成五个合法 JSON 模板；
- 将模板登记到 \`docs/governance/governance-manifest.yaml\`；
- 让 Sol 提示词引用固定模板目录，并明确块内 JSON 约束；
- 让模板和协议版本可以升级、校验和回滚；
- 用 JSON fixture 覆盖之前暴露的块内解析冲突，同时保留旧 YAML 输出兼容；
- 对新项目和已有项目接管提供一致的初始化结果。

## 不变的边界

- \`docs/governance\` 仍是唯一治理入口；
- 软件仍是最终解析、字段、路径、版本和 Git 安全校验者；
- 模板文件不会被当作 Sol 输出或任务直接执行；
- 软件不自动猜测或修复含义不明确的任务字段；
- 不引入 YAML 模板作为新格式；
- 不修改与本需求无关的项目文件。

## 任务 1：建立可复用的标准 JSON 模板定义

### 修改范围

- \`src/shared/protocol/writing-block.ts\`
- 新增 \`src/shared/protocol/writing-block-templates.ts\`（如实际结构更适合，可放入现有协议模块）
- \`test/unit/phase-four-writing-block.test.ts\`
- 新增模板专用单元测试

### 工作内容

1. 为五类块定义标准模板对象：
   - \`LUNA_TASK\`；
   - \`GOVERNANCE_CHANGE\`；
   - \`ARCHITECTURE_FREEZE\`；
   - \`BLOCKED\`；
   - \`GOVERNANCE_RECONCILIATION\`。
2. 模板输出必须由 \`JSON.stringify\` 生成或经过 \`JSON.parse\` 自校验，禁止手写可能非法的 JSON 文本。
3. 所有字段保持正确 JSON 类型：字符串、字符串数组、对象、布尔值和 \`null\` 不混用。
4. 为多行 \`content\` 使用 JSON 字符串转义，覆盖换行、引号、反斜杠、冒号、URL 等内容。
5. 模板占位符只用于帮助填写，不作为真实任务输入；模板不能包含会触发 Writing Block 结束的 \`[/WRITING_BLOCK]\` 字符串。
6. 导出模板文件名、相对路径、文档类型、受众和版本常量，供初始化器和提示词编译器共同使用，避免重复硬编码。

### 验收

- 五个模板均能被 \`JSON.parse\` 读取为对象；
- 替换所有占位符后的 fixture 均能通过 \`parseWritingBlocks\`；
- 每类模板的字段类型与现有协议 schema 一致；
- 不改变旧 YAML fixture 的解析结果。

## 任务 2：初始化器生成并登记模板

### 修改范围

- \`src/main/project/initializer.ts\`
- \`src/main/governance/manifest.ts\`（仅在需要支持模板登记/读取校验时修改）
- \`test/unit/project-initializer.test.ts\`
- \`test/unit/phase-two-project-config.test.ts\`（如扫描结果需要覆盖模板登记）

### 工作内容

1. 将五个 JSON 模板写入：

   \`docs/governance/templates/writing-blocks/\`

2. 为每个模板增加 manifest 记录：

   - \`audience: [Sol, Codex]\`；
   - \`status: active\`；
   - \`type: writing-block-template\`；
   - 独立 ID、路径和版本。

3. 初始化采用现有 staging → 原子替换流程，确保模板不出现半套安装。
4. \`changedPaths\` 必须包含模板文件和 manifest，初始化提交必须包含全部模板。
5. 更新 managed-directory 的完整性检查，使其能递归检查模板子目录，而不是只检查治理目录顶层。
6. 将治理模板版本从当前版本提升到新版本，并定义旧 managed tree 的升级判断：
   - 未修改的旧标准目录可安全升级；
   - 已修改的治理或模板文件不能静默覆盖；
   - 需要覆盖时先写入 \`.web-chat2codex/backups/governance/<run-id>\`；
   - 升级失败保留原目录，不留下半套新目录。
7. 保持已有项目接管的干净工作区、仓库根目录和远端校验。

### 验收

- 新项目初始化后五个模板存在且内容合法；
- manifest 中模板数量、路径、类型、受众和版本正确；
- 已有项目原治理目录和旧模板均可恢复；
- 重复初始化在同版本且无漂移时幂等；
- 模板或治理目录发生漂移时 fail closed，不覆盖用户修改；
- 初始化提交/推送的 changed paths 完整且不包含工作区外文件。

## 任务 3：模板读取校验与 Sol 提示词引用

### 修改范围

- \`src/main/sol/prompt-compiler.ts\`
- \`src/main/project/config.ts\`
- \`src/shared/contracts/project-config.ts\`（如需增加模板版本/状态字段）
- 相关 Sol prompt 单元测试

### 工作内容

1. 增加模板目录和五个固定文件的安全路径校验。
2. 在提示词预览/配置校验阶段验证模板存在、可读取、是合法 JSON 对象，并且 \`schema_version\` 与软件支持范围兼容。
3. 在初始化 Sol system prompt 中只保留稳定规则和固定目录引用，不重复维护五份完整字段表。
4. 明确写入块内约束：
   - 每个块的 body 是一个完整 JSON 对象；
   - 不使用 YAML、注释、尾逗号或 Markdown 代码围栏；
   - 字符串、数组、多行内容按模板原 JSON 类型填写；
   - 复制模板结构，不新增或删除已知字段；
   - 一回合最多一个 \`LUNA_TASK\`，治理变更和架构冻结独立成块。
5. 提示词明确 \`ARCHITECTURE_FREEZE\` 不交给 Luna，并保留普通实现细节默认放行语义。
6. 治理一致性检查提示词同样引用固定模板目录，但继续禁止输出普通任务和治理变更块。
7. 不把模板内容直接拼进每一轮动态上下文；动态上下文只携带路径、版本和必要状态，避免提示词膨胀。

### 验收

- 预览 Sol 提示词包含固定模板目录和 JSON-only 规则；
- 模板缺失、非法 JSON、越界路径和不支持版本会给出中文可定位错误；
- 提示词不泄露凭证或私密认证信息；
- 现有项目配置、远端校验和提示词动态上下文测试不回归。

## 任务 4：加强 JSON 协议 fixture 与解析错误诊断

### 修改范围

- \`src/shared/protocol/writing-block.ts\`
- \`src/main/orchestration/orchestrator.ts\`（如需将字段错误映射到 Dashboard）
- \`src/renderer/app.ts\`（仅在现有错误显示无法呈现块/字段上下文时修改）
- \`test/unit/phase-four-writing-block.test.ts\`
- \`test/unit/orchestration.test.ts\`

### 工作内容

1. 为五类 JSON 模板建立合法 fixture 和边界 fixture。
2. 覆盖以下历史高风险内容：
   - 多行治理文档全文；
   - 引号和反斜杠；
   - Windows 路径和 URL；
   - 冒号、井号和 Unicode 文本；
   - 空数组与显式 \`null\`；
   - 不允许的尾逗号、注释和截断 JSON。
3. 保留 JSON 优先、YAML 兼容的解析策略；模板驱动的新输出只要求 JSON。
4. 错误诊断至少包含块序号、块类型（已识别时）和字段名（字段校验失败时），并保持现有稳定错误码兼容。
5. 对多任务、嵌套块、未闭合块、块外文本和结束标记冲突继续 fail closed。
6. 确保解析失败发生在任何治理写入、架构下载、Git commit/push 或 Luna 启动之前。

### 验收

- 所有合法 JSON fixture 解析成功；
- 所有非法 JSON/字段 fixture 按预期错误码拒绝；
- 旧 YAML fixture 继续通过；
- 解析失败不会产生治理文件、代码修改或 Luna 会话；
- Dashboard 能显示可操作的中文阶段和建议。

## 任务 5：初始化同步、已有项目迁移和远端验证

### 修改范围

- \`src/main/app.ts\`
- \`src/main/project/initializer.ts\`
- \`src/main/git/*\`（只在初始化 changed-path 或 pending push 需要调整时）
- \`test/unit/initialization-git-sync.test.ts\`
- \`test/unit/project-initializer.test.ts\`

### 工作内容

1. 验证新项目 clone 后的初始化提交包含治理文档、manifest 和五个模板。
2. 验证已有项目接管时先备份原 \`docs/governance\`，再提交新模板。
3. 验证远端 push 成功才报告“已同步”；push 不确定时保持 pending 状态。
4. 验证 ChatGPT Project 侧可通过远端仓库获取模板；软件不把 Cookie、Token 或完整认证数据写入模板、日志或通知。
5. 验证初始化失败、模板版本不兼容和远端冲突均停止在安全状态。

### 验收

- 新项目和已有项目两条路径均能完成本地初始化和远端同步；
- 远端 commit 可由 \`git ls-remote\` 验证；
- 旧治理文档备份可恢复；
- 失败路径不破坏原治理目录，不虚报远端同步成功。

## 任务 6：端到端回归与本机验收

### 验证命令

\`\`\`text
npm run typecheck
npm test -- --run
npm run build
npx prettier --check <本次修改文件>
git diff --check
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/master
\`\`\`

### 本机验收场景

1. 新建/选择测试仓库，运行项目初始化，确认五个模板和 manifest 登记。
2. 在 Sol 项目背景中确认可以读取模板路径。
3. 使用合法 JSON \`LUNA_TASK\`，确认软件进入解析和 Luna 阶段。
4. 使用包含多行全文、引号、反斜杠和 URL 的治理变更，确认合法解析。
5. 使用缺字段、错误数组、尾逗号和截断 JSON，确认软件显示中文错误且不启动 Luna。
6. 使用多个 \`LUNA_TASK\`，确认只阻止当前输出并提示重新规划。
7. 重启应用，确认保存配置和模板版本状态可恢复。

## 提交顺序

1. 先提交设计和模板协议测试；
2. 再提交初始化器、manifest 和迁移逻辑；
3. 再提交提示词引用和错误诊断；
4. 完成全量验证后合并为一个功能提交并推送远端；
5. 重启 Electron 应用并执行本机验收。

实现过程中如发现现有治理初始化语义与本计划冲突，不直接覆盖用户文件；保留原状态并报告具体冲突。
