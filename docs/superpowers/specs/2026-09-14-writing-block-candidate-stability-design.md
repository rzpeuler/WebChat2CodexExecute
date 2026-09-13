# Writing Block 候选采集与稳定消费设计

## 目标

解决 Edge 采集器将“稳定但不可执行的 assistant 文本”误判为已完成输出，导致编排器随后收到空 Writing Block 集合并报 `SOL_OUTPUT_UNCONSUMABLE` 的问题。

## 设计

Edge DOM 快照对匹配到的 assistant 节点去重，不再只依赖最后一个 selector 结果。采集器在所有当前可见 assistant 节点及其可见后代中寻找完整 Writing Block/User Message 候选；如果候选位于较早节点但属于当前 DOM 中最新的协议候选，则优先返回该候选。若没有完整候选，则返回最新 assistant 文本，同时返回不包含原文的采集诊断：节点数量、候选数量、选中节点索引和协议标记计数。

稳定判定同时检查文本哈希和协议可消费性。协议可消费性定义为：`extractUserMessage()` 成功，或 `parseWritingBlocks()` 至少得到一个合法块。合法协议候选连续稳定后才返回 `COMPLETED_CANDIDATE`。文本稳定但不可消费时，Edge 在有限次数内返回等待状态；超过阈值后返回 `UNCONSUMABLE_CANDIDATE`，由编排器使用既有 `SOL_OUTPUT_UNCONSUMABLE` 安全暂停，不启动 Luna。

本轮不引入消息时间戳依赖。若平台未来暴露稳定 message id 或真实创建时间，可作为候选排序和新旧回复区分的辅助字段；协议解析仍是最终消费门禁。

## 错误处理

- Sol 仍在生成、页面身份未知或协议文本未稳定：继续等待。
- 文本稳定但无合法 Writing Block/User Message：有限重采集后暂停，并保留安全诊断。
- 文本包含损坏协议标记：沿用现有协议错误路径，不把它静默当作普通文本。
- 找到合法协议候选：交给既有 `parseWritingBlocks()` 和编排流程，不改变任务范围、基线和 Git 语义。

## 验证

增加 Edge 单元测试覆盖：重复 selector 去重、跨 assistant 节点候选选择、合法协议稳定消费、稳定普通文本的有限等待与最终不可消费状态、协议诊断字段；增加编排器测试确认 `UNCONSUMABLE_CANDIDATE` 只暂停而不启动 Luna，并运行现有 Edge/协议回归测试、类型检查和 diff 检查。
