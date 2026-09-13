# W2C 托盘生命周期与 Windows 安装包设计

## 目标

让开发版和安装版都具备一致的生命周期行为：双击启动不显示 PowerShell；关闭主窗口时隐藏到系统托盘；托盘退出时安全停止自动化运行时并保存状态；专用 Edge 与 W2C 一起隐藏和恢复；loop 运行期间退出必须明确确认，Luna 执行期间显示更强提示。

## 边界

- Edge 仍是外部浏览器，不内嵌到 Electron。
- 继续使用现有专用 Edge profile，因此不重新登录 ChatGPT。
- 只控制 W2C 自己启动并登记所有权的专用 Edge；普通 Edge 窗口不隐藏、不关闭。
- `npm start` 保留为开发入口；安装版由 Electron Builder 生成 Windows 安装程序。
- `projects.json`、编排器状态、会话绑定和 Edge profile 均保存在 Electron userData 中，不随程序更新删除。

## 生命周期

### 启动

安装版双击启动 Electron 主进程，不启动 PowerShell。W2C 继续加载上次项目配置，创建或复用专用 Edge profile，并用 `--app=<ChatGPT URL>` 启动可控的独立窗口。`--app` 只改变窗口外观，不改变 Cookie。

### 隐藏到托盘

主窗口的 close 事件默认转为隐藏，不退出进程。托盘菜单包括“打开 W2C”“显示专用 Edge”和“退出”。W2C 只在能够确认窗口属于自己启动的 Edge 时通过 Windows 窗口 API 隐藏该窗口；复用的外部 Edge 不做强制隐藏。

### 完全退出

托盘选择退出时，先检查编排器状态。loop 运行中弹出确认；`RUNNING_LUNA`、`SYNCING_CODE`、治理同步等有外部副作用的阶段显示阶段名称和风险提示。取消则保持托盘运行，确认后依次停止轮询、暂停/结束当前运行时、等待 Codex 子进程、关闭专用 Edge，并完成状态持久化后退出 Electron。退出清理失败时保留错误并阻止静默退出。

### Edge 意外关闭

保留现有进程退出回调和 CDP 检测。意外关闭时暂停 loop、保存恢复状态并通知用户；后续恢复动作可以重新打开同一个 profile。自动重开有次数上限，不能在用户明确退出 W2C 后触发。

## Windows 打包

增加 Electron Builder 的 Windows NSIS 配置，设置稳定的 `appId`、产品名称、安装目录和快捷方式。安装更新只替换程序文件，不覆盖 userData。打包验证包括安装、启动、托盘隐藏/恢复、完全退出、升级后配置保留和卸载行为。

## 验证

- 单元测试：生命周期状态机、退出确认、Luna 阶段提示、Edge 所有权窗口隐藏/恢复、意外 Edge 退出。
- 集成验证：`npm test`、`npm run build`、安装包构建。
- 手工验收：双击安装版无 PowerShell；关闭窗口进入托盘；托盘恢复 W2C 与 Edge；Luna 执行时退出会确认；退出后无 W2C/Codex/专用 Edge 残留进程；重新启动后项目配置和 Cookie 保留。
