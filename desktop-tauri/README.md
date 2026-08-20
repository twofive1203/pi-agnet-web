# Snail Pi Pet — Tauri Preview

这是与现有 Electron `desktop/` 完全隔离的 Tauri 2 Windows 可行性 Preview。Phase A 只验证透明桌宠窗口、Tray、拖动、点击穿透恢复、置顶、动态尺寸、焦点和多显示器/DPI；**不连接、启动、停止或监督 `spi`**，也不替代 Electron 发行物。

## 独立身份

| 项目 | Tauri Preview | Electron 稳定实现 |
| --- | --- | --- |
| Identifier / 单实例域 | `com.twofive.snail-pi-pet.tauri-preview` | `com.twofive.snail-pi-pet` |
| Product | `SnailPiPet Tauri Preview` | `SnailPiPet` |
| Executable crate | `snail-pi-pet-tauri-preview` | `snail-pi-pet` |
| 设置文件（后续阶段） | `tauri-preview-settings.json` | `desktop-pet-settings.json` |
| 构建输出 | `desktop-tauri/dist`, `desktop-tauri/src-tauri/target` | `desktop/out` |

Tauri 的 app-data/config 目录由 Preview identifier 派生。Phase A 不写设置或密钥；后续也不得写 Electron 的 userData 文件。两个实现可以并行安装和运行。

## Windows 前置

- Rust stable（最低 1.77.2）与 Cargo；
- Visual Studio C++ Build Tools / Windows SDK；
- Evergreen WebView2 Runtime；
- Node.js `>=22.19.0`；
- 在 `desktop-tauri/` 内运行 `npm install --include=dev`，安装隔离的 Tauri JS/CLI 依赖。

## 命令

```powershell
cd desktop-tauri
npm install --include=dev
cd ..
npm run desktop:tauri:build-ui
npm run desktop:tauri:dev
npm run desktop:tauri:build
npm run test:desktop-tauri-contract
```

`desktop:tauri:dev` 和 `desktop:tauri:build` 的 before hook 会重建静态 UI。现有 `desktop:build/dev/package/make` 命令仍只操作 Electron。

## Phase A 操作

- 拖动蜗牛主体移动透明无边框窗口；
- “展开 / 收起”动态切换窗口尺寸，并尽量保持最近屏幕角锚点；
- “开启穿透”后，必须从系统 Tray 选择“取消鼠标穿透”恢复；
- Tray 可显示、隐藏、切换置顶和退出 Preview；
- 关闭窗口只隐藏到 Tray；第二实例只唤醒本 Preview；
- 启动使用 Windows `SW_SHOWNOACTIVATE` 窄适配，用户 Tray/第二实例动作才聚焦。

Tauri 的 `set_ignore_cursor_events` 没有 Electron `{ forward: true }` 等价参数。Phase A 不安装全局鼠标 hook，恢复路径始终保留在 Tray。是否满足实际体验必须按验证矩阵实机判断。

## 权限边界

- capability 只绑定 `pet` 窗口和 `core:default`；
- 无 shell/process/fs/http/opener 插件权限；
- `withGlobalTauri` 关闭；前端只暴露冻结的 `window.snailPet` allowlist；
- CSP `connect-src 'none'`；Phase A WebView 不联网；
- Rust/前端均无服务进程控制代码。

## 当前 Electron 基线与后续测量

计划记录的同机前置基线为 Electron Setup 约 **140.4 MB**、解包应用目录约 **365.1 MB**，而 `app.asar` + 内置宠物资源不足 1 MB。该数字只用于说明 PoC 动机，不是 Tauri 成功结论。

Phase D 才测量发行包。届时须在同一机器分别记录 installer、应用专属安装目录、用户数据/WebView2 cache、共享 Evergreen Runtime，并按完整进程树统计 private working set；不得用 `target/` 或仅 Rust host 进程代表发行结果。

## 验证状态

自动契约与 Rust 几何测试不能证明真实 Windows 透明白闪、焦点、虚拟桌面、混合 DPI 或点击穿透转发。Gate A 证据与未执行项维护在 [`../docs/operations/desktop-pet-tauri-validation.md`](../docs/operations/desktop-pet-tauri-validation.md)。
