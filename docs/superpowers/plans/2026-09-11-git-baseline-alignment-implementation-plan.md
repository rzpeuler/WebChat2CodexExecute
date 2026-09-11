# Git 提交同步与基线对齐实现计划

设计依据：`docs/superpowers/specs/2026-09-11-git-baseline-alignment-design.md`

## 实施原则

- 两个动作是自动循环外的人工维护命令，不增加或重排 Loop Graph 节点。
- 不自动修改任务书中的 `base_commit`，不自动发送 Sol，不自动启动循环。
- 所有 Git 命令使用参数数组和项目仓库根目录执行，不经过 shell 拼接。
- 发生远端冲突时停止，不自动 pull、merge、rebase 或 force push。
- 利用现有 single-flight/orchestration lock，保证 Git 维护操作与循环、Codex、治理同步互斥。

## 任务 1：扩展共享命令与状态契约

涉及文件：

- `src/shared/contracts/dashboard.ts`
- `src/main/orchestration/types.ts`
- `src/main/git/types.ts`

工作内容：

1. 增加 `align-latest-baseline` 和 `commit-and-push` 两个 Dashboard 命令。
2. 将两者加入需要一次确认的命令集合；`commit-and-push` 的确认文案必须包含“提交工作区全部变更”。
3. 增加 Git 维护操作状态类型：检查工作区、提交、推送、对齐、成功、失败。
4. 为手动 Git 提交结果定义独立结果类型，至少包含本地提交 SHA、远端提交 SHA、是否实际创建 commit、是否推送成功和阶段信息。
5. 为持久化编排状态增加可选的手动 Git 操作记录，默认值保持兼容旧状态文件。
6. 为仪表盘快照增加当前基线摘要和旧任务失效提示所需的安全字段，限制长度并复用现有清理逻辑。

验证：命令验证、快照清理和旧状态恢复单元测试。

## 任务 2：实现 Git 全量提交、推送与状态读取

涉及文件：

- `src/main/git/git-controller.ts`
- `src/main/git/types.ts`
- `test/unit/phase-five-git-controller.test.ts`
- 新增或扩展 Git 维护测试

工作内容：

1. 暴露只读仓库状态读取能力，返回仓库根目录、分支、远端 URL、HEAD、远端跟踪提交、工作区路径和干净状态。
2. 实现全量提交方法：
   - 读取并返回变更摘要；
   - 对仓库根目录执行 `git add -A`；
   - 再次读取状态，避免空提交；
   - 使用固定提交信息创建 commit；
   - 返回新 commit SHA。
3. 实现 push 方法：
   - 只推送当前配置的远端和当前分支；
   - 不使用 force；
   - push 失败时持久化“本地 commit 待推送”记录；
   - 重试时优先复用该记录，只执行 push，不重复 commit；
   - 远端已前进或非快进时返回明确错误。
4. commit/push 成功后重新读取仓库状态，确认工作区干净且本地/远端提交关系明确。
5. 保持现有治理同步、代码同步和初始化同步行为不变。

验证场景：新增、修改、删除、重命名、备份文件、无变更、commit 失败、push 失败、远端冲突、重复恢复和重启恢复。

## 任务 3：在 Orchestrator 中增加人工维护操作

涉及文件：

- `src/main/orchestration/orchestrator.ts`
- `src/main/orchestration/types.ts`
- `test/unit/orchestration.test.ts`
- `test/unit/phase-eight-dashboard.test.ts`

工作内容：

1. 增加 `commitAndPushProject()`：
   - 仅在自动循环未运行且没有其他后台操作时执行；
   - 发布阶段状态和持久化记录；
   - 调用 Git 全量提交/推送；
   - 成功后重新捕获并替换内存 baseline；
   - 若 HEAD 变化，清除旧任务的继续执行记录并设置“需要重新生成任务书”提示；
   - 不改变 Loop Graph 当前节点，不调用 `processRound()`。
2. 增加 `alignLatestBaseline()`：
   - 要求工作区干净；
   - 捕获当前本地 HEAD 和远端状态；
   - 替换内存 baseline；
   - 若新旧 HEAD 不同，清除旧任务恢复上下文并标记旧任务失效；
   - 不触发循环、不发送 Sol。
3. 在 `dashboardActions()` 中只允许这两个命令在人工恢复窗口执行；操作中显示 busy 并禁用冲突按钮。
4. 将 `BASELINE_CHANGED` 的恢复提示与“重新对齐/重新生成任务书”关联，但不把该错误变成自动重试。
5. 对 push 失败支持下一次操作只恢复 push；对齐失败不修改内存 baseline。
6. 确保软件重启后能从持久化记录恢复“本地已提交、远端未同步”的状态。

## 任务 4：接入 IPC 与前端操作区

涉及文件：

- `src/main/app.ts`
- `src/main/preload.cts`
- `src/renderer/app.ts`
- `src/renderer/index.html`
- `src/renderer/styles.css` 或对应样式文件

工作内容：

1. 通过现有 Dashboard 命令通道接入新命令，不另建绕过状态管理的 IPC。
2. 在自动循环控制区附近增加“对齐最新基线”和“提交并同步 Git”按钮，明确标注“人工阻塞处理”。
3. 显示当前仓库状态、旧基线/新基线、当前分支、远端同步状态和下一步建议。
4. 提交前展示变更数量和路径摘要，并要求一次确认。
5. 所有按钮执行期间防重复点击，并在失败时保留错误阶段和可执行的下一步。
6. 不向 Loop Graph 增加 Git 节点，不改变“启动、暂停、重试、继续执行”的原有布局和逻辑。

## 任务 5：回归验证与收口

涉及文件：

- `test/unit/application-wiring.test.ts`
- `test/unit/orchestration.test.ts`
- `test/unit/phase-eight-dashboard.test.ts`
- `test/unit/phase-five-git-controller.test.ts`

验证命令：

```text
npm test
npm run typecheck
npm run build
git diff --check
```

必须覆盖：

1. 干净工作区不创建空提交；
2. 全部新增、修改、删除和备份文件均进入 commit；
3. push 失败可恢复且不重复 commit；
4. 远端非快进不会自动合并；
5. 脏工作区不能执行“对齐最新基线”；
6. HEAD 变化后旧任务被标记失效；
7. 人工维护操作不启动自动循环、不改变 Loop Graph；
8. 重复点击、运行中点击和应用重启行为正确；
9. 现有 Sol/Luna 自动循环测试全部通过。

## 实施顺序

按任务 1 → 任务 2 → 任务 3 → 任务 4 → 任务 5 顺序执行。每个任务完成后先运行对应单元测试，再进入下一任务；全部完成后执行完整验证并报告 commit、远端状态和剩余风险。
