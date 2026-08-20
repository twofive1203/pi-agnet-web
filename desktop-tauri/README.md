# Snail Pi Pet — Tauri Preview

这是与现有 Electron `desktop/` 完全隔离的 Tauri 2 Windows Preview。Phase A 验证透明窗口/Tray/拖动/穿透恢复；Phase B 在 Rust 后端接入真实 `spi` Observer，并通过兼容桥复用现有 `desktop/renderer/`；Phase C 补齐独立设置/密钥/自定义宠物、原生集成和快速会话；Phase D 提供独立 NSIS 安装包契约、只读设置迁移预演和同机基准脚本。**不启动、停止或监督 `spi`**，也不替代 Electron 发行物。

## 独立身份

| 项目 | Tauri Preview | Electron 稳定实现 |
| --- | --- | --- |
| Identifier / 单实例域 | `com.twofive.snail-pi-pet.tauri-preview` | `com.twofive.snail-pi-pet` |
| Product | `SnailPiPet Tauri Preview` | `SnailPiPet` |
| Executable crate | `snail-pi-pet-tauri-preview` | `snail-pi-pet` |
| 设置文件 | `tauri-preview-settings.json` | `desktop-pet-settings.json` |
| Access Key 文件 | `tauri-preview-access-key.json`（DPAPI 密文） | `desktop-pet-access-key.json` |
| 开机启动项 | `SnailPiPetTauriPreview` | Electron 独立登录项 |
| 构建输出 | `desktop-tauri/dist`, `desktop-tauri/src-tauri/target` | `desktop/out` |
| 安装器 | Preview NSIS current-user + Evergreen WebView2 | Squirrel `SnailPiPetSetup` |

Tauri 的 app-data/config 目录由 Preview identifier 派生。设置、Access Key 密文和窗口位置只写 Preview 目录；不得写 Electron 的 userData 文件。自定义宠物只只读扫描既有用户目录。两个实现可以并行安装和运行，并可同时 attach 同一个 `spi`。

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
npm run test:desktop-tauri-package
```

`desktop:tauri:dev` / `desktop:tauri:build` 的 before hook 会先删除并重建 `desktop-tauri/dist`，再把现有 `desktop/renderer` 与 `tauri-bridge.ts` 打入固定 allowlist；额外文件、目录或 source map 会使构建失败。现有 `desktop:build/dev/package/make` 命令仍只操作 Electron。

## Phase C 行为

- Rust 只连接 `http://127.0.0.1:<port>`；Observer Token / Control Token / Access Key 只留在后端；
- Access Key 用 Windows DPAPI 落盘；加密不可用时只留内存，不写明文；
- 设置重启后从 Preview 目录恢复；Electron 设置文件不被读取或写入；
- 自定义 Snail/Codex 宠物只读扫描，catalog/asset 不回传绝对路径；
- Tray 提供显示、关闭穿透、DND、声音、Retry、打开 WebUI、复制 `spi --no-open`、退出 Preview；
- Deep Link 仅打开二次校验后的 loopback 相对 allowlist；
- 快速会话使用独立 Control Token；renderer 只发送 projectRef / message / requestId / 可选模型。

启动 Preview 前请先自行运行 `spi`。关闭 Preview 只断开自己的 HTTP/SSE，不影响 Electron 或服务任务。

## 权限边界

- capability 只绑定 `pet` 窗口和 `core:default`；
- 无 shell/process/fs/http/opener 插件权限（HTTP 走普通 Rust crate，不进 WebView）；
- `withGlobalTauri` 关闭；前端只暴露冻结的 `window.snailPet` allowlist；
- Rust/前端均无服务进程控制代码。

## 打包与 WebView2

`desktop:tauri:build` 生成独立 Preview NSIS，默认 `embedBootstrapper`（Evergreen + 约 1.8 MB 引导包）。`downloadBootstrapper` 可作为更小安装包对照，但缺失 Runtime 时需要联网。`offlineInstaller` / Fixed Runtime 不得用来证明体积达标。

签名只通过 `tauri.conf.json` 的 `certificateThumbprint` / `digestAlgorithm` / `timestampUrl` 占位配置；不要把证书或密码提交进仓库。未签名包仅供工程验收，SmartScreen 可能警告。

卸载 Preview 只应删除 Preview 安装目录和 Preview app-data，不得删除 Electron 设置或 `~/.pi/agent`。

`DESKTOP_TAURI_PACKAGE_OUT` 只扫描 NSIS 外层并输出 `BUNDLE_OUTER_SCAN_OK`，不能证明压缩包内部 pet-only。资格验证必须先把 NSIS 解包或静默安装到隔离临时目录，再设置 `DESKTOP_TAURI_EXPANDED_APP_DIR`；脚本扫描真实应用树后才会输出 `ARTIFACT_SCAN_OK`，同时检查应用目录不超过 30 MB。未提供展开目录时明确输出 `ARTIFACT_SCAN_SKIPPED`。

同机基准（完整进程树，而不是只看 Rust host）：

```powershell
powershell -File scripts/benchmark-desktop-runtimes.ps1 -Scenario connected-idle
```

## 验证

自动契约、共享 fixture、打包扫描和 Rust 测试：

```powershell
npm run test:desktop-connection
npm run test:desktop-tauri-contract
npm run test:desktop-tauri-package
```

Gate A–D 实机证据与未执行项维护在 [`../docs/operations/desktop-pet-tauri-validation.md`](../docs/operations/desktop-pet-tauri-validation.md)。迁移边界见 [`../docs/architecture/decisions/desktop-pet-tauri-migration.md`](../docs/architecture/decisions/desktop-pet-tauri-migration.md)。
