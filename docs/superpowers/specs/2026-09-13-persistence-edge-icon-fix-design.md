# 配置恢复、Edge 窗口联动与 Windows 图标设计

## 目标

修复安装版与开发版之间的配置连续性，确保最近项目配置、编排器状态和专用 Edge profile 使用稳定的应用数据目录；修复 W2C 隐藏到托盘或恢复时专用 Edge 窗口不联动的问题；使用项目 Logo 作为安装包、快捷方式和应用图标。

## 方案

1. 在 Electron 启动最早阶段固定 userData 到 `%APPDATA%\\web-chat2codex-exe`。若检测到旧产品名生成的 userData 目录，只在稳定目录缺少对应文件时迁移 `projects.json`、`state`、`streams` 和 `edge-profile`，不覆盖已有数据，也不删除旧目录。
2. 为项目配置保存一个稳定的最近项目选择记录；启动时优先加载该项目，失效时回退到配置列表第一项。渲染器和后台运行时使用同一选择结果。
3. Edge profile 在新启动和复用已有调试实例两种情况下都记录可控的根 PID。窗口控制器按根 PID 枚举 Edge 子进程并批量隐藏/恢复；没有 W2C 所有权的外部 Edge 不进行控制。窗口已处于目标状态时视为成功，不因 Win32 返回值为 false 而报错。
4. 将用户指定的 600x600 PNG 转换为 ICO，配置 Electron Builder 的 `build/icon.ico`，不把 Downloads 路径作为运行时依赖。

## 边界与异常

- Cookie 不写入 `projects.json`，由专用 Edge profile 持有；迁移 profile 时保留其全部浏览器数据。
- 如果旧目录和稳定目录都存在，稳定目录优先，避免覆盖当前数据。
- 如果复用的 Edge 无法解析出 PID，应用仍可连接 CDP，但托盘窗口联动记录警告并保持运行。
- 退出流程沿用现有 Loop/Luna 确认逻辑。

## 验证

- 单元测试覆盖稳定路径选择、旧目录迁移条件、Edge 新启动/复用 PID 和窗口控制器的无窗口成功语义。
- 运行完整测试、typecheck、build，并生成 NSIS 安装包。
