# 项目配置启动回填与 Sol 提交确认实现计划

## 目标

实现已确认设计中的三项行为：同目录配置覆盖、启动回填上一次项目、Sol 消息提交后确认。

## 任务 1：配置存储按本地目录唯一化

- 在 `src/main/project/config.ts` 增加 Windows 安全的本地路径唯一键。
- 让 `ProjectConfigStore.loadAll()` 对历史重复目录做归并并持久化清理。
- 让 `ProjectConfigStore.save()` 按目录覆盖、沿用已有 `projectId`、把保存项移动到首位。
- 增加相同目录不同路径格式、历史重复项、不同目录不互相覆盖的单元测试。

## 任务 2：启动回填前端配置

- 在 `src/renderer/app.ts` 增加启动加载配置流程。
- 回填本地目录、远程地址、目标分支、报告目录。
- 将绝对报告目录转换为项目相对显示路径。
- 回填后刷新 Git 扫描事实，扫描失败时保留字段并显示中文反馈。
- 增加前端可测试的纯函数/启动流程测试；不改变现有项目初始化按钮语义。

## 任务 3：Sol 发送确认

- 在 `src/main/edge/cdp-conversation.ts` 增加提交控件和提交后状态确认。
- 让 `src/main/automation-runtime.ts` 只在会话控制器确认成功后调用 `recordRawInput()`。
- 覆盖提交成功、找不到提交控件、输入未清空/状态未变化等测试场景。

## 任务 4：回归验证

- 运行配置、Edge、运行时相关单元测试。
- 运行 typecheck、build、prettier 检查和完整测试。
- 检查 `projects.json` 相关错误信息、启动顺序和既有状态机没有回归。
- 完成后提交实现并同步远端。
