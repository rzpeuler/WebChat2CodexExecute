# web_chat2codex_exe 实现计划

日期：2026-09-09
基于设计：docs/superpowers/specs/2026-09-09-web-chat2codex-automation-design.md
状态：待实现

## 0. 本轮升级追加范围（2026-09-10）

- 初始化向导改为“选择本地目录 + 远端 URL + 克隆/接管”模式；软件自动创建标准 `docs/governance`，备份既有治理目录，并自动完成初始化 commit/push。
- `docs/governance` 固定为唯一治理入口；项目扫描不再根据文件名或目录名推断外部治理候选。
- 增加绑定 Edge 会话后的“治理一致性检查”按钮；Sol 自行判断外部文档冲突并输出 `GOVERNANCE_RECONCILIATION` Writing Block，软件自动完成备份、全文替换、commit/push。
- 一致性检查不进入普通任务 loop，不产生 Luna 任务；PASS、CHANGES_REQUIRED、BLOCKED 均有独立状态和通知。

## 1. 实现目标

构建一个 Windows 本地 Electron + TypeScript 桌面程序，实现已确认的 Sol → Luna → Git → Sol 自动循环。

第一版只允许一个项目处于运行状态，支持保存多个项目配置；不支持多个 Luna 任务并发或任务队列。

## 2. 技术边界

- 桌面壳：Electron。
- 主进程：TypeScript，负责生命周期、状态、进程、文件、Git、通知和安全边界。
- 渲染器：TypeScript + HTML/CSS，优先保持轻量，不引入大型状态管理框架。
- Edge：由主进程启动专用 profile；通过 Chromium 调试协议连接页面，Edge 适配器与协议解析器隔离。
- Codex：调用本机已安装的 Codex CLI；启动时检查版本、登录状态和可用模型。
- 状态：本地 JSON 状态快照 + JSONL 事件日志，使用临时文件和原子替换。
- Git：使用无 shell 的子进程调用，禁止拼接命令字符串和 force push。
- Windows 通知：使用 Electron 原生通知；通知只显示摘要。
- 打包：实现完成后再选择 Electron Builder 或等价 Windows 打包工具；不在第一阶段提前发布安装包。

## 3. 目录结构目标

~~~text
src/
├── main/
│   ├── app.ts
│   ├── lifecycle/
│   ├── state/
│   ├── edge/
│   ├── sol/
│   ├── governance/
│   ├── codex/
│   ├── git/
│   ├── notify/
│   └── security/
├── renderer/
│   ├── index.html
│   ├── app.ts
│   ├── styles.css
│   └── views/
├── shared/
│   ├── contracts/
│   ├── protocol/
│   └── errors/
└── test/
    ├── unit/
    ├── integration/
    └── fixtures/
~~~

项目治理文档和任务报告仍放在目标业务仓库，不放入本工具仓库。

## 4. 阶段一：项目骨架与运行安全

### 任务 1.1：初始化 TypeScript/Electron 工程

- 创建 package、TypeScript 配置和 Electron 主进程/渲染器入口；
- 配置严格类型检查、格式化、单元测试和构建命令；
- 设置 Electron preload 与上下文隔离；
- 渲染器不得直接访问文件系统、子进程或 Cookie。

验证：

- npm run typecheck
- npm test
- npm run build

### 任务 1.2：单实例和运行状态框架

- 实现应用单实例锁；
- 定义顶层状态：IDLE、ARMED、RUNNING、PAUSED、NEEDS_USER_ACTION、FAILED；
- 建立状态转换校验；
- 建立原子状态快照和 JSONL 事件日志；
- 软件重启时恢复状态但不自动执行未确认的新任务。

验证：

- 崩溃前后快照可恢复；
- 同一实例不会启动第二个循环；
- 非法状态转换被拒绝并通知。

## 5. 阶段二：初始化向导和项目配置

### 任务 2.1：项目扫描与配置

- 选择本地目录；
- 检查是否为 Git 仓库；
- 读取远端、分支、当前 commit；
- 让用户确认目标分支和报告目录；
- 只登记 `docs/governance` 内的治理文档，不根据外部文件名推断治理候选；
- 保存项目配置，但不保存 Cookie、密码或 Token。

### 任务 2.2：治理文档注册表

- 实现 governance-manifest.yaml 的读取和校验；
- 支持文档 ID、路径、受众、版本、状态；
- 支持未知文档类型的保存、索引和传递；
- 检查路径必须位于项目允许范围内；
- 区分活动文档、候选文档和历史版本。

### 任务 2.3：Sol 初始化提示词编译器

- 将稳定模板和项目动态信息合并；
- 注入角色边界、单回合单任务规则和 Writing Block 协议；
- 注入当前治理、架构、commit 和远端信息；
- 输出可复制的初始化提示词；
- 输出独立的治理一致性检查提示词，要求 Sol 自行检查外部文档并输出完整替换全文；
- 生成自包含的每轮动态上下文。

验证：

- 配置可保存和重新加载；
- 路径越界被拒绝；
- 生成提示词不包含凭证；
- 同一输入配置产生稳定输出。

### 任务 2.4：项目克隆、接管和治理初始化

- 支持选择本地目录、输入远端仓库 URL 和目标分支；
- 提供 Git 远程授权检查，并明确本机 Git Credential Manager/SSH 与 Codex 登录是两套独立授权；
- 使用无 shell 的 Git clone；
- 已有项目备份 `docs/governance` 后安装标准模板；
- 已初始化且无漂移时幂等，发生漂移时拒绝静默覆盖；
- 初始化 commit/push 由软件完成，支持空远端的首次提交；
- 远端地址禁止携带密码、Token、查询参数或片段。

验证：

- 新项目 clone 后治理模板存在且远端有初始化提交；
- 已有治理目录可恢复；
- 重复初始化不会重复备份或覆盖漂移规则。

## 6. 阶段三：专用 Edge profile 与会话绑定

### 任务 3.1：专用 Edge 生命周期

- 定位 Windows Edge 可执行文件；
- 创建或复用应用管理的专用用户目录；
- 首次启动时允许用户手动登录；
- 后续启动复用该 profile 的登录状态；
- 不读取日常 Edge profile 的 Cookie；
- 处理 Edge 进程退出、调试端口不可用和登录墙。

### 任务 3.2：Project 和活动会话绑定

- 列出专用 profile 中的真实网页标签页；
- 让用户选择一个 ChatGPT Project 内的 Sol 对话；
- 保存 Project 指纹、当前对话 URL、标题和最后消息哈希；
- 建立当前消息基线，不执行历史消息；
- 维护活动会话和历史会话链。

### 任务 3.3：Edge 状态适配器

- 读取最新消息、状态控件、错误区域和 Project 身份；
- 以 DOM/可访问文本为主，截图只用于诊断；
- 使用消息哈希稳定性确认完成；
- 支持 THINKING、COMPLETED_CANDIDATE、NETWORK_ERROR、CONTEXT_LIMIT、AUTH_REQUIRED、SESSION_LOST、AMBIGUOUS；
- 对页面结构和错误文案使用可版本化适配规则。

验证：

- 绑定历史消息不会触发 Luna；
- 流式消息不会被提前解析；
- 网络错误和上下文错误不会被误判为完成；
- 标签页变化会暂停；
- 账号和 Project 不匹配时不会发送消息。

## 7. 阶段四：Writing Block 协议和架构/治理处理

### 任务 4.1：定义协议 schema

- 定义 LUNA_TASK、GOVERNANCE_CHANGE、ARCHITECTURE_FREEZE、BLOCKED；
- 定义版本字段、必填字段和错误码；
- 定义一回合最多一个 Luna 任务、多个治理和架构变更；
- 为每个 Block 建立 JSON Schema 和 markdown fixture；
- 解析失败必须 fail closed。

### 任务 4.2：治理变更应用器

- 支持新增文档、更新文档、增加章节、废弃文档和决策记录；
- 普通变更自动写入并更新注册表；
- 高风险变更保存为候选版本并通知；
- 保留旧版本和变更来源；
- 禁止治理变更写出项目范围或覆盖受保护文件。

### 任务 4.3：架构冻结下载器

- 下载所有架构冻结链接到临时目录；
- 验证响应、文件类型和可读取性；
- 计算 SHA-256；
- 全部成功后一次性写入新架构版本；
- 任意失败时丢弃本轮临时变更；
- 记录 freeze ID、版本、URL、哈希和来源。

验证：

- 多个架构文档原子成功或全部失败；
- 高风险治理变更不进入活动快照；
- 重放同一变更不会产生重复版本；
- 非法路径和恶意链接被拒绝。

### 任务 4.4：治理一致性检查应用器

- 定义 `GOVERNANCE_RECONCILIATION` 的 PASS、CHANGES_REQUIRED、BLOCKED 状态；
- 由 Sol 自行选择需要检查和更新的外部文档；
- 软件只校验路径、普通文本、原文件 SHA 和完整全文；
- 替换前自动备份，所有文件通过校验后批量原子替换；
- 独立入口自动提交并推送，不启动 Luna，不进入普通任务队列。

验证：

- PASS 不修改仓库；
- SHA 冲突或不安全路径不产生部分替换；
- 多文件替换失败时保留恢复备份；
- 一致性检查成功后只有治理同步 commit。

## 8. 阶段五：Git 控制器

### 任务 5.1：基线和工作区保护

- 检查仓库、分支、远端和当前 commit；
- 检测未授权工作区修改；
- 记录任务基准 commit；
- 禁止自动 reset、checkout、clean 和 force push；
- 对远端 URL 脱敏后写入日志。

### 任务 5.2：治理同步事务

- 写入治理/架构变更；
- 创建 chore(governance): sync <change_id> commit；
- push 成功前不启动 Luna；
- push 失败时保留本地 commit，进入 PUSH_FAILED。

### 任务 5.3：代码同步事务

- Luna 结束后检查报告、测试和变更；
- 创建代码 commit；
- push 前确认分支和基准未被外部改变；
- push 响应丢失时先查询远端再重试；
- 记录本地和远端 commit。

验证：

- 使用临时 Git 仓库和假远端测试；
- push 失败恢复不会重复创建 commit；
- 强制 push 参数不存在；
- 工作区有外部修改时不会自动提交。

## 9. 阶段六：Codex CLI Luna Runner

### 任务 6.1：CLI 能力和配置检查

- 定位 Codex CLI；
- 检查版本；
- 检查登录和模型可用性；
- 检查目标路径为有效仓库；
- 记录实际运行配置的脱敏摘要。

### 任务 6.2：任务启动和输出采集

- 以最新治理/架构快照和一个 LUNA_TASK 启动新会话；
- 使用机器可解析输出和最终报告文件；
- 流式保存 JSONL 事件；
- 保存 stdout/stderr 摘要；
- 进程退出码、结果块、报告、测试和 Git 状态共同决定完成。

### 任务 6.3：Codex 会话轮换

- 主动轮换时创建新的 CLI 会话；
- 新会话使用当前本地仓库和新的自包含 Handoff；
- 保存 Codex 会话链；
- 不复制无关旧聊天记录；
- 不在 Luna 执行期间中断轮换。

验证：

- 使用假的 Codex Runner 测试运行中、完成、失败、超时和报告缺失；
- CLI 不可用时正确暂停；
- 非法结果不会触发代码 push；
- 新会话读取到最新 commit 和治理文档。

## 10. 阶段七：上下文轮换和恢复

### 任务 7.1：主动轮换

- 支持 Sol 阶段完成触发；
- 支持已完成任务数阈值触发；
- 默认阈值作为配置，不写死；
- 生成 Session Handoff；
- 在同一 Project 创建新 Sol chat；
- 同步创建新的 Codex CLI session；
- 更新活动会话指针。

### 任务 7.2：CONTEXT_LIMIT 恢复

- 通过页面错误信号、消息状态和连续采样哈希确认；
- 保存旧会话和最后一次原始输入；
- 在同一 Project 新建会话；
- 验证账号、Project 和会话身份；
- 原样重放上一次输入；
- 同一事件只恢复一次；
- 再次过长或恢复失败时暂停并通知。

验证：

- 半截 Writing Block 不会执行；
- 新会话属于同一 Project；
- 原始输入哈希一致；
- 重复轮询不会创建多个新会话；
- 恢复失败可从旧状态继续诊断。

## 11. 阶段八：Windows 通知和状态面板

### 任务 8.1：通知服务

- 为异常生成稳定错误码；
- 对相同异常去重；
- 只显示摘要、任务 ID、阶段和建议动作；
- 支持可恢复、需要用户和致命错误级别；
- 不显示 Cookie、Token、完整任务或完整日志。

### 任务 8.2：托盘与状态面板

- 显示项目、活动 Sol 会话、当前阶段、任务 ID、治理/架构版本、Luna 状态、commit 和最近异常；
- 提供启动、暂停、重试当前阶段、重新绑定、打开 Edge、打开项目和查看报告；
- 渲染器只通过 preload IPC 调用受控命令；
- 所有危险操作要求明确用户动作。

## 12. 阶段九：集成验证与打包

### 任务 9.1：模拟端到端测试

使用假的 EdgeAdapter、CodexRunner 和 Git remote 验证：

- 初始化；
- 基线绑定；
- 单任务解析；
- 多任务拒绝；
- 多架构冻结；
- 治理同步；
- Luna 结果；
- 测试失败；
- push 失败；
- 上下文恢复；
- 软件重启恢复。

### 任务 9.2：真实本机验收

在用户手动登录专用 Edge profile 后验证：

- 实际 Project 绑定；
- 实际 Sol 状态读取；
- 实际 Writing Block 提取；
- 实际架构文件下载；
- 实际 Codex CLI Luna 任务；
- 实际 Git push；
- 实际 Windows 通知。

真实验收中不自动处理用户账号、验证码和第三方平台配置。

### 任务 9.3：Windows 打包

- 生成开发版和可安装版；
- 验证安装、启动、升级前后的配置保留；
- 验证专用 Edge profile 路径；
- 验证日志和状态目录权限；
- 记录未签名安装包的 Windows 安全提示。

## 13. 推荐实施顺序

~~~text
工程骨架与安全
  ↓
配置与治理文档
  ↓
协议解析器和 Git 控制器
  ↓
Codex Runner
  ↓
Edge profile 与会话绑定
  ↓
Sol 状态和 Writing Block 提取
  ↓
上下文轮换恢复
  ↓
通知和状态面板
  ↓
模拟集成测试
  ↓
真实本机验收和打包
~~~

Edge 自动化和 Codex CLI 应尽早各做一个垂直切片，以便尽早暴露登录、Project 识别、模型权限和页面结构风险。

## 14. 每阶段完成标准

每个阶段必须同时满足：

- 代码和接口有单元测试；
- 失败路径有测试；
- 日志不泄露秘密；
- 状态可以恢复；
- npm run typecheck 通过；
- npm test 通过；
- npm run build 通过；
- git diff --check 通过。

## 15. 初始实现风险

- Edge Web Chat 的 DOM 和 Project 新聊天操作可能变化；
- ChatGPT 账户登录状态和 Project 权限必须在真实机器上验证；
- Codex CLI 登录和模型可用性不能仅由可执行文件存在推断；
- Codex 的沙箱、网络和审批配置应在首次运行时展示并记录脱敏摘要；
- 远端仓库目前为空，首次 push 的分支命名和保护策略需要在初始化向导中明确；
- Electron 打包后的 Edge profile、权限和通知行为需要单独验证。

## 16. 实现前的默认假设

- 使用当前已安装的 codex-cli 0.152.1 做第一轮能力验证；
- 默认保留当前本地分支名，除非初始化向导明确选择目标分支；
- 自动化软件不复制日常 Edge profile；
- 所有真实外部验收均需要用户已完成登录并提供必要的第三方配置；
- 本计划不包含自动安装 Codex CLI，只有检测和提示安装缺失。
