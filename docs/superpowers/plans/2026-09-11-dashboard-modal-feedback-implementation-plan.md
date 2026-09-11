# Dashboard 弹窗、布局与固定反馈实现计划

设计依据：`docs/superpowers/specs/2026-09-11-dashboard-modal-feedback-design.md`

## 任务 1：弹窗结构与只读展示

修改 `src/renderer/index.html`：

- 将项目详情预览改为“查看当前配置”按钮触发的通用弹窗。
- 将 Sol 提示词预览改为同一个通用弹窗展示。
- 弹窗包含标题、只读内容区、一键复制和关闭按钮。

## 任务 2：前端交互

修改 `src/renderer/app.ts`：

- 复用现有预览生成流程，把结果写入弹窗。
- 实现打开、关闭、遮罩关闭、ESC 关闭和焦点返回。
- 使用 Clipboard API 复制；失败时保留弹窗内容并显示中文状态。
- 不新增后端 IPC。

## 任务 3：布局样式

修改 `src/renderer/styles.css`：

- 工作台最大宽度调整为 `1360px`。
- 增加底部固定状态条样式和主体底部安全空间。
- 保留现有响应式断点与 Loop Graph 横向滚动。

## 任务 4：验证与交付

- 增加/调整前端单元测试，覆盖弹窗状态和复制成功/失败。
- 运行 `npm run typecheck`、`npm test -- --run`、`npm run build` 和相关格式检查。
- 提交并推送到 `origin/master`，重启桌面应用。
