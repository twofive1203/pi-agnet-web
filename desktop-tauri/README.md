# Snail Pi Pet — Tauri Preview

这是与现有 Electron `desktop/` 完全隔离的 Tauri 2 Windows Preview。Phase A 验证透明窗口/Tray/拖动/穿透恢复；Phase B 在 Rust 后端接入真实 `spi` Observer，并通过兼容桥复用现有 `desktop/renderer/`。**不启动、停止或监督 `spi`**，也不替代 Electron 发行物。

## 独立身份

| 项目 | Tauri Preview | Electron 稳定实现 |
| --- | --- | --- |
| Identifier / 单实例域 | `com.twofive.snail-pi-pet.tauri-preview` | `com.twofive.snail-pi-pet` |
| Product | `SnailPiPet Tauri Preview` | `SnailPiPet` |
| Executable crate | `snail-pi-pet-tauri-preview` | `snail-pi-pet` |
| 设置文件（后续阶段） | `tauri-preview-settings.json` | `desktop-pet-settings.json` |
| 构建输出 | `desktop-tauri/dist`, `desktop-tauri/src-tauri/target` | `desktop/out` |

Tauri 的 app-data/config 目录由 Preview identifier 派生。Phase B 设置只在内存中；不得写 Electron 的 userData 文件。两个实现可以并行安装和运行，并可同时 attach 同一个 `spi`。

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
npm run test:desktop-tauri-view-parity
```

`desktop:tauri:dev` / `desktop:tauri:build` 的 before hook 会把现有 `desktop/renderer` 与 `tauri-bridge.ts` 打进 `desktop-tauri/dist`。现有 `desktop:build/dev/package/make` 命令仍只操作 Electron。

## Phase B 行为

- Rust 只连接 `http://127.0.0.1:<port>`；Observer Token / Access Key 只留在后端内存；
- WebView CSP 仍是 `connect-src 'none'`，前端只消费 `window.snailPet` 安全视图；
- 现有 renderer 展示 Idle / Running / Needs input / Ready / Blocked 与 Activity tray；
- 设置、自定义宠物、Deep Link、剪贴板、快速会话写入仍是 Phase C 范围（当前为安全 stub）。

启动 Preview 前请先自行运行 `spi`。关闭 Preview 只断开自己的 HTTP/SSE，不影响 Electron 或服务任务。

## 权限边界

- capability 只绑定 `pet` 窗口和 `core:default`；
- 无 shell/process/fs/http/opener 插件权限（HTTP 走普通 Rust crate，不进 WebView）；
- `withGlobalTauri` 关闭；前端只暴露冻结的 `window.snailPet` allowlist；
- Rust/前端均无服务进程控制代码。

## 验证

自动契约、共享 fixture 和 Rust 测试：

```powershell
npm run test:desktop-connection
npm run test:desktop-tauri-contract
```

Gate B 实机证据与未执行项维护在 [`../docs/operations/desktop-pet-tauri-validation.md`](../docs/operations/desktop-pet-tauri-validation.md)。
