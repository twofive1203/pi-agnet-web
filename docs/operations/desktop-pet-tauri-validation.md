# Tauri Desktop Pet Preview — Phase A Validation

- **Date:** 2026-09-17
- **Plan:** `docs/plans/2026-09-17-001-refactor-tauri-desktop-pet-migration-plan.md`
- **Scope:** Gate A Windows shell viability（U1–U2）and Gate B secure observer / renderer reuse（U3–U4）
- **Product:** `SnailPiPet Tauri Preview` / `com.twofive.snail-pi-pet.tauri-preview`

本矩阵独立于 Electron 的 `desktop-pet-validation.md`。自动测试只证明配置隔离、权限静态契约和纯几何；真实 WebView2 窗口、Tray、焦点、点击穿透、多显示器/DPI 和虚拟桌面必须保留实机证据。未实际执行的行必须保持 **未执行**，不能继承 Electron 结果。

## 自动检查

```powershell
cd desktop-tauri
npm install --include=dev
cd ..
npm run desktop:tauri:build-ui
npm run test:desktop-tauri-contract
cargo test --manifest-path desktop-tauri/src-tauri/Cargo.toml
cargo check --manifest-path desktop-tauri/src-tauri/Cargo.toml
```

| Contract | Expected | Status |
| --- | --- | --- |
| Identity isolation | App identifier/product/executable/settings filename/输出目录与 Electron 不同 | 自动覆盖 |
| Command regression | Electron `desktop:*` 命令保持原语义，Forge 不读取 Tauri 输出 | 自动覆盖 |
| Capability minimum | 无 shell/process/fs/http/opener 或 wildcard；WebView `connect-src 'none'` | 自动覆盖 |
| Geometry | 负坐标 clamp、屏幕角锚点、虚拟桌面 union | Rust 自动覆盖 |
| Recovery | Tray 始终包含“取消鼠标穿透”和 Preview-only Quit | Rust/静态自动覆盖 |
| Attach-only | Phase A 无 child process/PID/signal/service control | 静态自动覆盖 |

**本次工程验证：** `desktop:tauri:build-ui`、Tauri contract smoke、7 个 Rust integration tests、`cargo check`、`cargo clippy -D warnings`、项目 TypeScript/ESLint、Electron `desktop:build` 与 `test:desktop-package` 均通过。`tauri build --debug --no-bundle` 已生成独立 `target/debug/snail-pi-pet-tauri-preview.exe`；该编译结果不等同于下方实机视觉矩阵 Pass。

## 实机记录模板

每次运行记录：

- Windows 版本/build：**未执行**
- 机器/GPU/驱动：**未执行**
- WebView2 Runtime 版本：**未执行**
- Tauri/Rust 版本：**未执行**
- 显示器分辨率、坐标布局、DPI：**未执行**
- 构建类型与 artifact hash：**未执行**
- 截图/录屏路径：**未执行**

## Windows 10 / Windows 11 Gate A 矩阵

| ID | 场景 | 步骤 | Pass criteria | Windows 10 | Windows 11 |
| --- | --- | --- | --- | --- | --- |
| TA-A1 | 首次显示/透明 | 冷启动 Preview，观察首帧和背景 | 无持续白底/黑底；透明无边框窗口可见 | **未执行** | **未执行** |
| TA-A2 | 被动不抢焦点 | 让另一应用保持输入焦点后启动 Preview | Preview 可见但不获得焦点、不切换应用 | **未执行** | **未执行** |
| TA-A3 | Tray 显示/隐藏/退出 | 依次使用隐藏、显示、退出 | 用户显示会激活；退出只结束 Preview，不影响 Electron/`spi` | **未执行** | **未执行** |
| TA-A4 | 拖动 | 从宠物主体连续拖动、快速拖动 | 位置连续，无明显抖动/丢失，点击仍可用 | **未执行** | **未执行** |
| TA-A5 | 动态尺寸锚点 | 在四个屏幕角展开/收起 | 宠物视觉锚点稳定，窗口不跳离可见区 | **未执行** | **未执行** |
| TA-A6 | 点击穿透恢复 | 开启点击穿透，再用 Tray 取消 | 桌面点击可穿透；Tray 始终可恢复交互 | **未执行** | **未执行** |
| TA-A7 | 穿透转发差异 | 开启/关闭穿透并观察 hover/move 恢复 | 记录与 Electron `{ forward:true }` 差异；不得声称自动等价 | **未执行** | **未执行** |
| TA-A8 | 置顶 | 切换 Tray/UI 置顶后覆盖普通窗口 | checked/实际行为一致，不成为全屏独占干扰 | **未执行** | **未执行** |
| TA-A9 | 单实例隔离 | 同时运行 Electron，再启动两个 Tauri Preview | 第二个 Preview 不建新窗口，只激活 Preview；Electron 不受影响 | **未执行** | **未执行** |
| TA-A10 | 隐藏后的被动行为 | 隐藏 Preview，等待/模拟普通窗口事件 | 保持隐藏；只有 Tray/第二实例用户动作显示 | **未执行** | **未执行** |
| TA-A11 | 虚拟桌面焦点 | Preview 和前台应用置于不同虚拟桌面，再执行被动/用户显示 | 被动不切桌面；用户显示行为可解释且不持续抢焦点 | **未执行** | **未执行** |

## DPI / 多显示器矩阵

每一行均需双向拖动、四角展开/收起、隐藏/Tray 恢复，并记录物理与逻辑尺寸：

| ID | 布局 | Expected | Status |
| --- | --- | --- | --- |
| TA-D1 | 单屏 100% | 尺寸/拖动/锚点正常 | **未执行** |
| TA-D2 | 单屏 150% | 无缩放跳变或模糊导致的不可用 | **未执行** |
| TA-D3 | 单屏 200% | 控件可用，窗口不超出 work area | **未执行** |
| TA-D4 | 主屏 100% → 副屏 150% | 跨屏双向移动，scale 更新，位置不跳离可见区 | **未执行** |
| TA-D5 | 主屏 150% → 副屏 200% | 跨屏双向移动，展开/收起锚点稳定 | **未执行** |
| TA-D6 | 副屏位于主屏左侧（负 X） | 可进入负坐标屏并从 Tray 恢复 | **未执行** |
| TA-D7 | 副屏位于主屏上方（负 Y） | 可进入负坐标屏并从 Tray 恢复 | **未执行** |
| TA-D8 | 运行时拔除/停用当前显示器 | 窗口回到剩余可见 work area | **未执行** |

## Stop conditions

出现任一条件，Gate A 必须记为 **Stop**，不得进入 Observer/UI 迁移：

- 透明窗口持续白闪/黑底且无稳定公开 API 修复；
- 混合 DPI 或负坐标下窗口可永久丢失/卡死；
- 点击穿透无法通过 Tray 可靠恢复；
- 被动显示持续抢焦点或切换虚拟桌面；
- 单实例与 Electron identity/安装域冲突；
- 需要全局输入 hook、大范围私有 API 或扩大 shell/process 权限才能维持基本交互。

## Gate A conclusion

**Pending / 未执行实机 Gate。** U1–U2 自动契约已完成；Windows 10/11、DPI 和虚拟桌面证据仍需实机填写。Phase B 代码已按旁路策略继续，不把未执行的 Gate A 行记为 Pass。

## Phase B — 安全观察与 renderer 复用

```powershell
npm run test:desktop-connection
npm run test:desktop-tauri-view-parity
npm run test:desktop-tauri-contract
npm run desktop:tauri:build-ui
```

| Contract | Expected | Status |
| --- | --- | --- |
| Shared connection fixtures | Electron TS 与 Rust reducer/protocol/SSE/url allowlist 同一组输入输出 | 自动覆盖 |
| Shared view/transition fixtures | 同一 Snapshot 的 presentation/priority/unread/DND/dedupe 结果一致 | 自动覆盖 |
| WebView privacy | 发给 renderer 的 view 不含 token/accessKey/cwd/prompt/非 loopback URL | 自动覆盖 |
| Attach-only | Rust observer 无 process/PID/service control；capability 无 http/fs/shell | 自动覆盖 |
| Renderer reuse | Tauri 构建复用 `desktop/renderer`，只增加 `tauri-bridge.ts` | 自动覆盖 |

## Windows Gate B 矩阵

| ID | 场景 | Pass criteria | Status |
| --- | --- | --- | --- |
| TA-B1 | 连接真实 local `spi` | 展示与 Electron 可比的 Idle/Running/Needs input/Ready/Blocked | **未执行** |
| TA-B2 | DevTools 检查 | Application/Network/事件载荷中不可见 Token、Access Key、cwd、Prompt | **未执行** |
| TA-B3 | 启停 `spi` | service-not-running / reconnecting 诊断与 Electron 一致；退出 Preview 不影响服务任务 | **未执行** |
| TA-B4 | instance 变更 | 新 baseline，不把旧 terminal transition 重放成声音 | **未执行** |
| TA-B5 | server-mode 无密钥 | 显示 Access key 面板；输入错误密钥得到 auth_invalid | **未执行** |

## Gate B conclusion

**Pending / 自动契约已完成，实机未执行。** 不得把 Electron 证据继承为 Tauri Pass。
