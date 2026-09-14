# 隐藏窗口下 Sol 会话采集修复设计

## 目标

修复 Web Chat2Codex 在以下状态下无法识别 Sol 已完成任务书、loop 长时间停留在“等待 Sol”的问题：

- W2C 最小化到系统托盘；
- 专用 Edge 被隐藏或最小化；
- W2C 或专用 Edge 被其他置顶窗口、全屏窗口遮挡。

目标行为是：窗口是否位于前台、是否有屏幕尺寸、是否被其他窗口遮挡，不应影响 W2C 通过 CDP 读取专用 Edge 页面中的完整 Sol 会话内容。

## 当前证据与根因假设

当前 `src/main/edge/state-adapter.ts` 的 `domSnapshotScript` 使用 `isVisible` 筛选 assistant 节点。该判断同时要求：

- `display` 不是 `none`；
- `visibility` 不是 `hidden`/`collapse`；
- `opacity` 不是 `0`；
- `getBoundingClientRect()` 的宽度和高度大于零。

托盘隐藏路径通过 Windows `ShowWindowAsync(..., 0)` 隐藏专用 Edge。隐藏或最小化状态可能使 DOM 节点不满足几何尺寸条件，导致 assistant 节点集合为空，随后 `latestAssistantText` 和 hash 为空。编排器只能持续得到 `AMBIGUOUS`/`THINKING`，因而继续等待。

最近的 `2c7747e` 只将“输入发送”脚本改为不依赖几何尺寸的 DOM 可用性判断；Sol 输出采集脚本仍依赖 `getBoundingClientRect()`。本设计只修复采集边界，不改变通知服务、CDP 生命周期、loop 状态机或 Writing Block 协议。

## 设计

### 1. 分离 DOM 可采集性与屏幕可见性

在 `domSnapshotScript` 中使用独立的 `isCaptureUsable` 判断：

- 节点必须仍连接在当前 DOM；
- `display` 不能是 `none`；
- `visibility` 不能是 `hidden` 或 `collapse`；
- `aria-hidden` 不能是 `true`；
- 不检查 `getBoundingClientRect()`；
- 不依赖窗口前台、焦点、最小化状态或被其他窗口遮挡状态。

该判断用于 assistant 根节点、最终回答候选节点及其后代节点。它仍排除真正从 DOM 语义上不可用的模板，但不会把后台窗口中的正常会话内容排除。

### 2. 为隐藏/最小化 DOM 增加文本回退

采集节点文本时优先使用 `innerText`，为空时回退到 `textContent`，并继续执行现有的 marker 规范化与完整候选选择。

这样可以覆盖浏览器在非前台渲染状态下 `innerText` 不完整或为空、但 DOM 文本仍存在的情况。现有候选排序、Writing Block 尾部提取、协议就绪判定和稳定 hash 保持不变。

### 3. 保持编排器语义不变

本修复不新增状态，也不放宽完成门禁：

- 仍需连续稳定采样；
- 仍需完整 Writing Block 或 `USER_MESSAGE`；
- 不完整或不可消费的稳定文本仍按既有路径处理；
- `UNCONSUMABLE_CANDIDATE`、自动修复、暂停和通知逻辑不变。

### 4. 诊断字段

继续保留现有 `captureDiagnostics` 字段。采集方式本身不写入窗口路径、焦点状态或敏感原文，避免扩大持久化数据范围。

## 测试设计

在 `test/unit/phase-three-edge.test.ts` 增加或调整以下覆盖：

1. DOM 快照脚本不再包含 `getBoundingClientRect()`，并包含 DOM 连接性、样式和 `aria-hidden` 检查。
2. 模拟无有效几何尺寸但有完整 `textContent` 的 assistant 节点，确认可形成完整候选。
3. 模拟 `display:none`、`visibility:hidden` 和 `aria-hidden=true` 节点，确认它们不会成为候选。
4. 确认隐藏状态下完整 Writing Block 仍可经过两次稳定采样进入 `COMPLETED_CANDIDATE`。
5. 确认现有不完整 Writing Block、普通稳定文本和 `UNCONSUMABLE_CANDIDATE` 回归行为不变。

验证范围：Edge 单元测试、相关编排器测试、类型检查、构建和 `git diff --check`。手工验收需要分别覆盖托盘隐藏、Edge 最小化、W2C 被置顶/全屏窗口覆盖三种状态。

## 非目标与风险

非目标：

- 不改变 Edge 进程隐藏/恢复策略；
- 不通过恢复窗口或抢焦点来读取页面；
- 不改 CDP transport、会话绑定、通知去重或 Writing Block 协议；
- 不引入网络层消息捕获或辅助功能树作为新数据源。

主要风险是 ChatGPT 页面可能保留不可见的历史/模板节点。风险由现有的 assistant 节点去重、协议完整性判断、候选排序、稳定采样和最终协议解析共同约束；真正的 `display:none`、`visibility:hidden` 与 `aria-hidden=true` 节点仍会被排除。

## 完成标准

- 专用 Edge 隐藏、最小化或被其他窗口遮挡时，W2C 能读取新的完整 Sol 任务书；
- loop 不再因为窗口状态而无限停留在等待 Sol；
- 现有 Writing Block 协议门禁和不可消费输出处理不回退；
- 相关测试、类型检查、构建和 diff 检查通过。
