# 隐藏窗口下 Sol 会话采集修复实现计划

设计依据：[2026-09-14-hidden-sol-capture-design.md](../specs/2026-09-14-hidden-sol-capture-design.md)

## 实施目标

让专用 Edge 在隐藏、最小化、被其他窗口覆盖或被全屏窗口遮挡时，仍能通过 CDP 采集完整 Sol assistant 输出。保持现有稳定采样、Writing Block 协议门禁、不可消费输出处理和编排器状态语义不变。

## 任务 1：重构 DOM 快照的采集可用性判断

涉及文件：

- `src/main/edge/state-adapter.ts`
- `test/unit/phase-three-edge.test.ts`

工作内容：

1. 将快照脚本中的 `isVisible` 改为面向 DOM 采集的 `isCaptureUsable`。
2. 保留 `isConnected`、`display`、`visibility` 和 `aria-hidden` 检查，移除 `getBoundingClientRect()` 和窗口几何尺寸依赖。
3. 让 assistant 根节点、最终回答候选及其后代统一使用新的判断。
4. 节点文本采用 `innerText || textContent` 回退，并保持 trim、marker 规范化和候选排序逻辑不变。
5. 保持 `captureDiagnostics` 字段结构和隐私边界不变。

验收：生成的快照脚本不再依赖 `getBoundingClientRect()`；真正 `display:none`、`visibility:hidden`、`aria-hidden=true` 的节点仍被排除。

## 任务 2：增加隐藏窗口回归覆盖

涉及文件：

- `test/unit/phase-three-edge.test.ts`

工作内容：

1. 增加快照脚本契约断言，确认存在 DOM 连接性、样式和 `aria-hidden` 过滤。
2. 增加无有效几何尺寸但有完整 `textContent` 的 assistant 节点场景，确认能形成协议候选。
3. 增加真正隐藏节点的排除场景，避免采集历史模板或不可用节点。
4. 保留并验证完整 Writing Block 连续稳定采样后仍为 `COMPLETED_CANDIDATE`。
5. 回归不完整块、稳定普通文本和 `UNCONSUMABLE_CANDIDATE` 的既有行为。

验收：相关 Edge 测试覆盖采集边界和状态分类，不需要启动真实 Edge 或抢占用户前台窗口。

## 任务 3：全量验证与收口

验证命令：

```text
npm test
npm run typecheck
npm run build
git diff --check
```

手工验收：

1. W2C 最小化到托盘后让 Sol 输出完整任务书，确认 loop 能从 `WAITING_FOR_SOL` 继续。
2. 专用 Edge 最小化后重复上述流程。
3. W2C 或专用 Edge 被其他置顶/全屏窗口覆盖时重复上述流程。
4. 确认完整任务书仍经过原有解析、校验和后续流程，不直接绕过协议门禁。

实施顺序：任务 1 → 任务 2 → 任务 3。任务 1 完成后先运行相关 Edge 测试；任务 2 完成后运行 Edge 与编排器相关测试；最后执行全量验证。

## 风险和边界

- 不修改 Edge 隐藏/恢复策略，不通过显示窗口或抢焦点规避问题。
- 不修改 CDP transport、会话绑定、通知服务、轮询间隔或编排器状态机。
- 不引入网络层消息捕获或辅助功能树。
- 若页面保留不可见历史/模板节点，仍由 DOM 过滤、协议完整性、候选排序和最终解析共同约束；不通过拼接普通文本生成任务书。
