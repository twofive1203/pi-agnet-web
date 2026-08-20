# Tauri Desktop Pet Preview — Validation

- **Date:** 2026-09-17
- **Plan:** `docs/plans/2026-09-17-001-refactor-tauri-desktop-pet-migration-plan.md`
- **Scope:** Gate A Windows shell viability（U1–U2）、Gate B secure observer / renderer reuse（U3–U4）、Gate C feature parity（U5–U7）、Gate D package / migration rehearsal / qualification（U8）
- **Product:** `SnailPiPet Tauri Preview` / `com.twofive.snail-pi-pet.tauri-preview`
- **ADR:** `docs/architecture/decisions/desktop-pet-tauri-migration.md`

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
| Recovery | Tray 始终包含“取消鼠标穿透”和 Preview-only Quit；左键主动 reveal，右键菜单 | Rust/静态自动覆盖 |
| Runtime parity | 焦点/后台状态驱动 `background-only`；声音冷却跨 Snapshot 保持 | 共享 sequence fixture + Rust 自动覆盖 |
| Host state sync | Tray DND/声音/穿透动作完成后 emit view 并刷新 checked state | Rust/静态自动覆盖 |
| Display recovery | 负坐标/屏幕移除选择最近 work area；拓扑 watcher 被动恢复且不激活 | Rust 纯几何 + 静态自动覆盖 |
| Custom pet fallback | 已选自定义宠物消失后回退并持久化内置默认 key | Rust 自动覆盖 |
| Clean frontend | UI build 清空 `dist` 并拒绝 allowlist 外文件/目录/source map | 构建 + package smoke 自动覆盖 |
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
| TA-A3 | Tray 显示/隐藏/退出 | 依次使用隐藏、左键 Tray 显示、右键菜单、退出 | 左键直接激活桌宠、右键保留菜单；退出只结束 Preview，不影响 Electron/`spi` | **未执行** | **未执行** |
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
| TA-D8 | 运行时拔除/停用当前显示器 | 窗口回到剩余可见 work area，隐藏状态与前台应用焦点不变 | **未执行** |
| TA-D9 | 从 large/展开/负坐标状态恢复默认位置和大小 | 恢复 medium、收起 tray，并停靠当前显示器右下 24px | **未执行** |

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

## Phase C — 功能等价

```powershell
npm run test:desktop-tauri-contract
cargo test --manifest-path desktop-tauri/src-tauri/Cargo.toml
```

| Contract | Expected | Status |
| --- | --- | --- |
| Isolated settings | Preview 设置文件名/目录与 Electron 不同；缺字段/非法枚举按 Electron 规则归一化 | 自动覆盖 |
| Secrets | Access Key 落盘无明文；加密不可用或损坏时不泄漏并要求重输 | 自动覆盖 |
| Custom pets | 合法 Snail/Codex 可列出；越界路径/坏 manifest 失败；catalog/asset 无绝对路径 | 自动覆盖 |
| Deep links | 相对 allowlist 通过；绝对 URL / cwd / token query 拒绝 | 自动覆盖 |
| Tray / DND | 菜单含穿透恢复、DND、声音、Retry、WebUI、Preview-only Quit；DND 消费不重放 | 自动覆盖 |
| Quick session | path-free catalog、同 requestId 幂等、旧服务隐藏 composer、payload 无 cwd/token | 自动覆盖 |
| Capability | 仍无 shell/process/fs/http/opener 通配；打开 URL/目录走 Rust ShellExecuteW | 自动覆盖 |

## Windows Gate C 矩阵

| ID | 场景 | Pass criteria | Status |
| --- | --- | --- | --- |
| TA-C1 | 设置重启恢复 | Preview 重启后恢复 petScale/DND/选中宠物；Electron 设置文件内容与时间戳不变 | **未执行** |
| TA-C2 | Access Key | server-mode 输入密钥后连接；落盘文件无明文；清除后重连 | **未执行** |
| TA-C3 | 自定义宠物 | 合法 Snail/Codex 包列出并显示；越界/坏包不崩溃 | **未执行** |
| TA-C4 | 聚焦/可见失焦/隐藏状态下触发 Ready，连续触发同类 cue，并切换 DND/声音 | `background-only` 只在后台通知且历史不重放；10 秒冷却跨 Snapshot；Tray 与 Renderer 状态立即一致 | **未执行** |
| TA-C5 | Deep Link | 点击活动打开已验证 origin；绝对 URL 被拒绝 | **未执行** |
| TA-C6 | 开机启动 | Preview 登录启动切换不修改 Electron 项，也不启动 `spi` | **未执行** |
| TA-C7 | 快速会话 | local 与 loopback server-mode 各成功创建一次；退出 Preview 不结束 session | **未执行** |

## Gate C conclusion

**Pending / 自动契约已完成，实机未执行。** 残余只允许明确记录的签名、clean-profile 或低优先级外观问题。

## Phase D — 打包、迁移预演与候选验收

```powershell
npm run test:desktop-tauri-package
npm run test:desktop-tauri-contract
npm run test:desktop-package
powershell -File scripts/benchmark-desktop-runtimes.ps1 -Scenario connected-idle
```

生成安装包后先检查外层 bundle，再把 NSIS 解包或静默安装到隔离临时目录并扫描真实展开内容：

```powershell
npm run desktop:tauri:build
$env:DESKTOP_TAURI_PACKAGE_OUT = "desktop-tauri/src-tauri/target/release/bundle"
npm run test:desktop-tauri-package # 仅输出 BUNDLE_OUTER_SCAN_OK

# <expanded-temp-dir> 必须是隔离的解包/临时安装目录，不得指向正式 user-data。
$env:DESKTOP_TAURI_EXPANDED_APP_DIR = "<expanded-temp-dir>"
npm run test:desktop-tauri-package # 检查真实内容后才输出 ARTIFACT_SCAN_OK
```

只读设置迁移预演默认使用 `scripts/fixtures/desktop-pet-host/electron-settings-import.json`。若要解析本机 Electron 设置，只设 `DESKTOP_TAURI_ELECTRON_SETTINGS`；脚本不得写 Electron 或 Preview 正式设置文件。

| Contract | Expected | Status |
| --- | --- | --- |
| Isolated installer identity | Preview product/identifier/exe/Start Menu 与 Electron 不同；NSIS current-user；无 updater artifact | 自动覆盖 |
| WebView2 mode | 默认 `embedBootstrapper`；`downloadBootstrapper` 可作为体积对照；`offlineInstaller` / `fixedRuntime` 不得当作达标结果 | 自动覆盖 |
| Pet-only artifact | 包内无 `.next` / Next / pi SDK / Node / Electron / Forge / node-pty / Automation / `bin/pi-web.js` / fixture / Electron 设置或密钥 | 配置/外层 bundle 自动覆盖；真实 expanded app **未执行** |
| Settings rehearsal | 只读映射 Electron 设置并输出匿名化 diff；不写双方正式文件 | 自动覆盖 |
| Signing placeholders | `certificateThumbprint` 为空，`digestAlgorithm=sha256`；证书不入库 | 自动覆盖 |
| Electron regression | `desktop:*` 与 `test:desktop-package` 不读取 Tauri 输出 | 自动覆盖 |

## AE / QS 功能等价（Tauri 独立证据）

不得把 Electron `desktop-pet-validation.md` 的 Pass 继承为 Tauri Pass。

| ID | Scenario | Automated | Manual Windows | Status |
| --- | --- | --- | --- | --- |
| AE1 | 多项目 Agent/Automation/Quick Command 在关闭浏览器后可见 | Partial（共享 fixture / view parity） | 真实 SSE 三源 | **未执行** |
| AE2 | Ready 只通知一次；SSE replay 不重复 | Partial（transition fixture） | 系统 toast 一次 | **未执行** |
| AE3 | Subagent 嵌套且不重复计数 | Partial（共享 observer fixture） | Activity 子行 | **未执行** |
| AE4 | Snapshot / bridge 无禁止字段 | Yes（view/privacy smokes） | DevTools 抽查 | **Automated OK** |
| AE5 | 关闭窗口进 Tray；点击穿透可恢复 | Partial（native contract） | 真实 Tray | **未执行** |
| AE6 | 通知/活动打开 allowlisted WebUI；任意 URL 拒绝 | Yes（deep-link smoke） | 默认浏览器 | **未执行** |
| AE7 | 端口拒绝 → 服务未启动 + 复制命令；无子进程；Retry | Yes（connection + attach-only） | E2E | **未执行** |
| AE8 | 未授权 observer 拒绝；payload 隐私 | Yes（observer/privacy） | — | **Automated OK** |
| AE9 | instanceId 变化建 baseline，不刷成功通知 | Yes（connection + transition） | 实机重启服务 | **未执行** |
| AE10 | 退出 Preview 不影响 `spi`/任务 | Yes（静态 attach-only） | 任务运行中退出 | **未执行** |
| AE11 | Needs input > Blocked > Ready > Running；已读仅本地 | Yes（view parity） | UI 标记已读 | **未执行** |
| AE12 | 减弱动画静态帧；宠物/位置持久化 | Partial（settings normalize） | OS reduced-motion | **未执行** |
| AE13 | 未知/不兼容/server-mode 诊断；loopback access key | Yes（connection/auth） | 错端口与密钥 | **未执行** |
| QS1 | 已连接且具备 capability 时启动一次会话 | Partial（Rust/TS quick-session） | local/server-mode | **未执行** |
| QS2 | 超时后同 requestId 不创建第二个会话 | Yes（idempotency） | 实机超时 | **未执行** |
| QS3 | catalog/success/error 无 cwd/Prompt/token | Yes（privacy） | DevTools | **Automated OK** |
| QS4 | catalog 之后项目被删则提交失败 | Yes（resolver） | 实机删除目录 | **未执行** |
| QS5 | 旧服务隐藏 composer，observer 仍可用 | Yes（capability fallback） | 新旧 `spi` 混用 | **未执行** |

## 隔离 / WebView2 / 卸载矩阵

| ID | 场景 | Pass criteria | Status |
| --- | --- | --- | --- |
| TA-D-P1 | Preview 安装 | 安装只创建 Preview 目录/开始菜单/单实例域；Electron 可执行文件与设置时间戳不变 | **未执行** |
| TA-D-P2 | 覆盖升级 Preview | 只替换 Preview；Electron 与 `~/.pi/agent` 不变 | **未执行** |
| TA-D-P3 | 卸载 Preview | 删除 Preview 应用与 Preview app-data；`spi`、Electron、`~/.pi/agent` 仍在 | **未执行** |
| TA-D-P4 | 双安装共存 | 同时安装并分别启动；开机启动项互不影响 | **未执行** |
| TA-D-P5 | 已有 WebView2 | 安装后直接启动，不强制再装 Runtime | **未执行** |
| TA-D-P6 | 缺失 WebView2 | embed/download Bootstrapper 给出可理解结果；离线失败不得伪装成功 | **未执行** |
| TA-D-P7 | 体积口径 | installer ≤20 MB、应用专属目录 ≤30 MB；WebView2 共享 Runtime 与用户 cache 单列 | **未执行** |
| TA-D-P8 | 内存口径 | connected-idle 完整进程树 private working set 中位数；相对 Electron 至少 -30% 或记录实测偏差 | **未执行** |
| TA-D-P9 | 启动口径 | 冷/暖启动多次采样；不得用 `target/debug` 或未压缩 `target` 代表发行结果 | **未执行** |
| TA-D-P10 | 签名 / SmartScreen | 未签名工程包可安装但可能警告；正式分发才使用证书占位字段 | **未执行** |
| TA-D-P11 | clean profile | 新 Windows 用户安装 Preview，不读取/写入 Electron userData | **未执行** |

同机基准脚本：`scripts/benchmark-desktop-runtimes.ps1`。报告必须包含日期、Windows/WebView2/CPU/RAM、场景、进程口径和 artifact 路径。缺测行保持 **未执行**，不得改口径后宣称达标。

## Gate D conclusion

**Extend。** U8 自动契约（隔离身份、NSIS/Evergreen 配置、只读设置预演、clean `dist`、外层 bundle 检查、expanded scan 入口、Electron 回归入口）已落地；真实 expanded NSIS 应用扫描、同机体积/内存/启动、clean-profile、签名和 AE1–AE13 / QS1–QS5 实机行仍为 **未执行**。Electron 保持默认发行物，无需回滚。

若后续实测体积达标而完整进程树内存未降 30%，可继续 Extend，但必须公布 WebView2 子进程数据，不得只展示 Rust host。Proceed 需要独立切换计划，不能在本文件把 Preview 改成正式 `SnailPiPet`。
