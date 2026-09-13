# Web Chat 2 Codex

Windows 桌面自动化编排器，将 ChatGPT Web 中的 Sol、Codex CLI 中的 Luna 和项目 Git 仓库连接成一个可持续运行的开发闭环。

## 项目背景

在常规 vibe coding 流程中，用户需要不断地把 Sol 的任务书交给 Luna，再把 Luna 的执行报告转回 Sol。Web Chat 2 Codex 用本地 ORCHESTRATOR 自动完成这段信息传递和工程流程管理：

```text
Sol 规划任务
   ↓
ORCHESTRATOR 读取并校验 Writing Block
   ↓
Codex CLI / Luna 执行任务、测试并生成报告
   ↓
ORCHESTRATOR 校验结果、提交并推送 Git
   ↓
通知 Sol 验收并规划下一轮
```

三者职责边界如下：

- **Sol（Web Chat）**：负责产品方向、架构、治理、任务拆分和验收判断。
- **Luna（Codex CLI）**：负责按照任务书修改代码、执行测试和生成报告。
- **ORCHESTRATOR（本软件）**：负责协议解析、状态机、Git 基线、同步、通知和异常恢复。

## 主要功能

- 新项目 Clone、已有项目接管和 `docs/governance` 治理文档初始化。
- 自动生成 Sol 系统提示词，并读取项目内 Writing Block 模板。
- 使用专用 Edge profile 连接 ChatGPT Project 会话。
- Loop Graph 展示读取 Sol、解析任务、执行 Luna、同步代码、通知 Sol 和等待下一轮等节点。
- 支持 `LUNA_TASK`、`ARCHITECTURE_FREEZE`、`GOVERNANCE_CHANGE`、`GOVERNANCE_RECONCILIATION` 和 `BLOCKED` 协议块。
- 一回合最多执行一个 `LUNA_TASK`；架构冻结允许包含多个架构块。
- 自动检查项目基线、工作区、受保护路径、报告和测试结果。
- 由软件统一执行 commit/push，Luna 不自行提交或推送。
- Windows 通知提醒登录、网络、上下文过长、Git 冲突和外部配置等阻塞。
- 支持托盘运行、状态持久化、人工对齐最新 base commit 和一键 commit/push。

## 环境要求

- Windows 10/11
- Node.js 与 npm
- Git，并已通过 Git Credential Manager、SSH 或其他本机方式完成远程仓库授权
- Codex CLI，且已完成 Codex 登录和模型访问授权
- ChatGPT Web 账号，以及可访问目标 Project 的专用 Edge profile

Codex CLI 默认使用 `gpt-5.6-luna` 和 `medium` 推理强度。Windows 下软件会先使用 PATH 中的 `codex`，找不到时再检查 Codex 的本地安装目录。

## 开发版运行

在项目根目录执行：

```powershell
npm install
npm start
```

`npm start` 会先构建 TypeScript 和 Renderer 资源，再启动 Electron 应用。

常用验证命令：

```powershell
npm run typecheck
npm test
npm run build
```

## 首次使用流程

1. 启动软件，选择本地项目目录，或通过远端仓库地址 Clone 新项目。
2. 检查 Git 远程授权，确认本地工作区可读写且状态符合初始化要求。
3. 初始化或接管 `docs/governance`。已有治理目录会按软件规则备份后安装标准结构。
4. 预览并复制 Sol 提示词，将其放入对应 ChatGPT Project 的背景配置。
5. 打开专用 Edge，在其中登录 ChatGPT，并打开目标 Project 会话。
6. 绑定目标 Sol 会话；第一次绑定只建立基线，不消费历史消息。
7. 点击“启动”，在 Loop Graph 中观察当前节点、任务、基线和执行耗时。
8. Luna 完成后，软件会校验报告、同步代码并通知 Sol 开始验收。

## Writing Block 协议

Writing Block 模板位于：

```text
docs/governance/templates/writing-blocks/
```

Sol 的机器可消费输出使用以下形式：

```text
[WRITING_BLOCK type="LUNA_TASK"]
{完整 JSON 对象}
[/WRITING_BLOCK]
```

软件会从最新 Sol assistant 消息的尾部提取完整 Writing Block 序列，支持一条消息中的多个架构冻结块。块尚未闭合时不会回退消费更早的旧块；块体必须通过模板和字段校验后，流程才会继续。

## Git 与安全边界

- 自动循环开始前会重新确认任务的 `base_commit` 和工作区状态。
- Luna 不负责 `commit`、`push`、`amend`、`rebase` 或强制推送。
- 软件拒绝项目目录之外的修改，并保护治理、架构、提示词模板和其他受保护路径。
- `IMPLEMENTATION` 可以包含合理的项目内部修改；敏感路径、保护路径和越界文件仍会阻塞。
- 任务报告必须写入任务书指定的项目相对路径。
- 外部账号、API Key、验证码、第三方平台配置和无法安全判断的 Git 状态保留人工处理边界。

## Windows 安装包

构建 NSIS 安装包：

```powershell
npm run dist:win
```

生成文件位于：

```text
release/Web-Chat-2-Codex-Setup-0.1.0.exe
```

开发版和安装版使用同一套源码，但运行目录、Electron 打包资源和用户数据目录相互独立。升级安装时请先关闭正在运行的旧版本；项目配置和运行状态保存在用户数据目录，不写入项目源代码仓库。

## 项目结构

```text
src/main/      Electron 主进程、编排器、Git、Edge、Codex 和治理逻辑
src/renderer/  Dashboard、Loop Graph 和界面交互
src/shared/    Writing Block、项目配置和 Dashboard 共享协议
test/unit/     单元测试与流程回归测试
docs/          项目说明、设计文档和治理相关文档
scripts/       构建与资源复制脚本
release/       Windows 安装包输出
```

## 项目边界

Web Chat 2 Codex 自动化的是“规划—执行—同步—通知”的工程流程，不替代 Sol 的产品判断、架构判断或 CTO 最终验收。软件可以严格校验协议、路径、Git 状态和流程状态，但不会替用户决定需求是否正确、实现是否符合业务目标，或外部授权是否安全。

