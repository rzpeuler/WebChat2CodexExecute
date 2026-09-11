# 可见 ChatGPT 编辑器提交修复设计

## 问题

当前 ChatGPT 页面同时存在隐藏的 fallback `textarea` 和可见的 ProseMirror `div#prompt-textarea[contenteditable="true"]`。现有选择器先命中隐藏 textarea，随后表单兜底提交空内容，造成软件短暂误判为已发送，最终因没有思考状态或新消息而超时。

## 方案

发送脚本只允许操作可见且可编辑的输入控件，选择优先级为：

1. `#prompt-textarea[contenteditable="true"]`
2. 其他可见的 `[contenteditable="true"]`
3. 可见的 `textarea`

隐藏元素、`display:none` 元素和不可编辑元素不得作为输入目标。

写入可见编辑器后，脚本等待 React/ProseMirror 更新，并轮询同一表单中的真实发送按钮。发送按钮必须可见、未禁用，并匹配 ChatGPT 当前的发送按钮属性；在按钮没有出现时，不再调用 `form.requestSubmit()` 作为成功路径，而是返回未提交错误。

发送按钮点击后继续使用现有确认机制：确认可见编辑器清空，或 Edge 进入思考状态，或出现新的助手消息。只有确认成功后运行时才写入 `lastRawInput`。

## 错误与兼容

- 找不到可见编辑器：立即返回中文输入控件错误。
- 编辑器已填充但发送按钮未出现：返回中文提交控件错误。
- 点击后未观察到清空、思考或新消息：返回现有 `SOL_INPUT_SUBMIT_UNCONFIRMED`。
- 保留当前会话身份校验和后续 Sol 输出等待流程。

## 测试

- 隐藏 textarea 与可见 contenteditable 同时存在时，必须选择 contenteditable。
- 可见编辑器存在但没有发送按钮时，必须失败且不得调用表单兜底提交。
- 发送按钮出现并可用时，继续通过提交确认。
- 提交失败时 `lastRawInput` 不得被写入。
