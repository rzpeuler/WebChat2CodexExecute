# LUNA_RESULT 测试证据对象化与枚举约束设计

## 目标

修复 Luna 输出 `LUNA_RESULT` 时将 `tests` 生成为字符串数组而导致 `INVALID_RESULT` 的问题，使合法测试证据结构在模板、提示词、解析器和测试中保持一致。

## 协议设计

`tests` 必须是非空数组，数组成员必须是对象：

```json
{
  "command": "npm test",
  "status": "PASSED"
}
```

字段约束：

- `command`：可选；存在时必须是非空字符串。
- `status`：必填，只能是 `PASSED`、`FAILED` 或 `NOT_RUN`。
- 除上述字段外，不允许未知字段，避免 Luna 把自然语言说明直接放进测试结果。

运行时继续对 `tests_status` 使用相同的三值枚举，并校验它与测试明细的聚合结果一致。字符串数组、空数组、未知状态、错误字段类型和额外字段均返回 `INVALID_RESULT`，不进入代码同步。

## 修改边界

1. 更新 Writing Block/Luna 结果模板，直接展示对象数组和状态枚举。
2. 更新 Codex CLI 任务提示词，明确禁止字符串数组、Markdown 说明和额外字段。
3. 更新 `CodexRunner` 的协议解析和类型定义，严格执行对象字段白名单及枚举校验。
4. 保持当前安全策略：非法结果不自动消费、不生成 `pendingCodeSync`，避免未经验证的工作区进入 commit/push。
5. 增加合法对象、字符串数组、未知字段和非法状态的回归测试。

## 错误处理

合法的 `LUNA_RESULT` 才能继续现有的报告、工作区和基线校验。若 `tests` 结构非法，流程停在 `run-luna`，提示具体字段错误；本次任务不会自动重复执行 Luna，也不会猜测或修复报告格式。

## 验收标准

- 合法对象数组可以被解析并进入现有同步流程。
- 原本导致本次 `INVALID_RESULT` 的字符串数组被明确拒绝，并给出可定位诊断。
- `PASSED`、`FAILED`、`NOT_RUN` 三种状态均覆盖测试。
- `npm test`、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。
