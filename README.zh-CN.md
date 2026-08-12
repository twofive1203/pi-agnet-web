# 蜗牛派（Snail Pi Web）

蜗牛派（Snail Pi Web）是面向 `pi` 编程智能体的本地 Web 工作台。它会读取本机 pi agent 数据目录，在浏览器中提供会话管理、实时对话、模型与扩展配置、项目文件、Git/WorkTree、浏览器调试和可选 Web 终端。

- npm 包：[`@twofive/snail-pi-web`](https://www.npmjs.com/package/@twofive/snail-pi-web)
- GitHub：[`twofive1203/pi-agnet-web`](https://github.com/twofive1203/pi-agnet-web)
- 命令行入口：`spi`

## 环境依赖

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | Node.js >=22.19.0 | Next.js 16 / React 19 运行环境；低版本 Node 可能无法启动。 |
| npm | 建议 npm 10+ | 用于 `npx`、全局安装和源码安装依赖。 |
| pi agent 数据目录 | 默认 `~/.pi/agent/` | Web UI 会读取本机会话、模型和设置文件。 |
| Git | 可选但建议安装 | Git 状态、分支、WorkTree 功能需要。 |
| 本地 shell | 可选 | 开启 Web Terminal 时需要系统 shell。 |

> Web Terminal 依赖 `@lydell/node-pty`。如果目标机器缺少原生依赖构建环境，可先关闭 Web Terminal 功能，不影响会话浏览和对话主流程。

## 快速开始

**无需安装，直接运行：**

```bash
npx @twofive/snail-pi-web@latest
```

**或全局安装后使用：**

```bash
npm install -g @twofive/snail-pi-web
spi
```

默认仅监听回环地址 [http://127.0.0.1:62666](http://127.0.0.1:62666)，本机免认证。CLI 会在服务就绪后尝试自动打开浏览器。

> **安全说明：** 官方入口不再默认继承 `0.0.0.0`。远程/局域网访问必须使用 `spi --server`（或等价环境变量）；非回环监听会强制启用全局访问密钥认证。服务器模式默认要求 HTTPS 才能输入访问密钥；仅当传输已由 Tailscale 等可信网络加密时，才应显式启用 HTTP 兼容模式。

## 启动参数

```bash
spi                              # 本机回环，免认证
spi --port 8080                  # 自定义端口
spi --server                     # 服务器模式：0.0.0.0 + 认证（默认要求 HTTPS）
spi --server -H 127.0.0.1        # 回环后端 + 认证（给 Nginx/Caddy HTTPS 反代）
spi --server --rotate-access-key # 轮换访问密钥并失效全部会话
spi --server --allow-insecure-http # 显式允许 HTTP 登录（仅限已有加密传输）
spi -H 0.0.0.0                   # 非回环监听会自动启用认证
PORT=8080 spi
PI_WEB_HOSTNAME=10.0.0.5 spi     # 显式监听地址（勿用系统 HOSTNAME）
# Tailscale 等可信客户端可免密钥：优先写配置文件 ~/.pi/agent/server-access-policy.json
# { "version": 1, "authBypassCidrs": ["100.64.0.0/10"] }
# 也可用环境变量覆盖；全网与回环地址规则均会被拒绝
PI_WEB_AUTH_BYPASS_CIDRS=100.64.0.0/10 spi --server --no-open
PI_WEB_ALLOW_INSECURE_HTTP=1 spi --server --no-open # 仅限已有加密传输
spi --proxy http://127.0.0.1:7897
spi --socks-proxy socks5://127.0.0.1:7897
```

`npx` 运行时也可以传参：

```bash
npx @twofive/snail-pi-web@latest --port 8080
```

如果 shell 中已有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，`spi` 会继承并自动为 Node 追加 `--use-env-proxy`。也可以用 `PROXY_URL` 和 `SOCKS_PROXY_URL`：

```bash
PROXY_URL=http://127.0.0.1:7897 SOCKS_PROXY_URL=socks5://127.0.0.1:7897 spi
```

## Windows 桌宠（可选，独立安装）

桌宠是 attach-only 的 Windows 任务观察器，与 npm 包 `spi` **分开安装/发布**。它只连接已经运行的本地蜗牛派服务，**不会**启动、停止或托管 `spi`，卸载桌宠也不会删除 `~/.pi/agent`。

### 源码里怎么跑

```bash
# 终端 A
npm run dev                 # 或 spi --no-open

# 终端 B
npm run desktop:dev         # 编译（如需要）并启动 Electron 桌宠
npm run desktop:build       # 仅打包 main/preload JS
```

### 使用要点

- 默认连接 `http://127.0.0.1:62666`（仅 `127.0.0.1` 本地模式）。
- **拖动**宠物上方灰色条移动窗口；点宠物本体展开/收起 Activity tray。
- 点 **×** = 隐藏到托盘（不是退出）；托盘「退出桌宠」才结束桌宠进程，且不影响 `spi`。
- 端口无服务时提示「蜗牛派服务未启动」，可复制 `spi --no-open`，桌宠不会自动执行该命令。
- 点任务/通知才用默认浏览器打开 WebUI。
- 开发说明：[`desktop/README.md`](desktop/README.md)；验收：[`docs/operations/desktop-pet-validation.md`](docs/operations/desktop-pet-validation.md)。
- 合约测试：`npm run test:desktop-observer` / `npm run test:desktop-package`。

## 数据目录与配置

默认读取：

```text
~/.pi/agent/
```

如需指定其他 pi agent 数据目录：

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent-data spi
```

| 文件/目录 | 用途 |
| --- | --- |
| `sessions/` | 会话 JSONL 文件，按工作目录归档。 |
| `models.json` | 模型提供商和模型列表配置。 |
| `settings.json` | pi agent 设置，包括默认模型。 |
| `server-access.json` | 服务器模式访问密钥校验信息与会话哈希（无明文密钥）。 |
| `server-access-policy.json` | 可选：免密钥客户端 IP/CIDR 白名单（如 Tailscale）；环境变量可覆盖。 |
| `pi-web.json` | Web UI 设置，例如 WorkTree、Usage、Web Terminal、ChatGPT/Grok 面板、编辑器和 SnFlow 偏好。 |

会话文件路径形如：

```text
~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl
```

## 功能介绍

- **会话管理**：按工作目录浏览、搜索和归档本地会话，通过 SSE 实时接收回复，并查看上下文占用、花费和压缩结果。
- **Fork 与分支导航**：从历史消息创建独立会话，或在同一会话文件内切换分支，方便并行探索不同方案。
- **模型与 Pi 资源**：切换模型和 thinking level，管理登录/API key、自定义提供商、模型定价、工具预设、Skills、Extensions 和 Pi 原生子智能体配置。
- **文件浏览与编辑**：查看和编辑源码，预览 Markdown、图片、音频、PDF、DOCX，并通过会话改动面板查看智能体产生的文件 Diff。
- **Git 与 WorkTree**：查看 Git 状态、提交图和提交 Diff，切换分支、管理 stash，并为独立任务创建 WorkTree。
- **Web Terminal**：在当前工作区打开可选的多标签、可分屏终端；可以在设置中选择 shell 和环境变量。
- **浏览器标签页调试**：通过 `extensions/chrome-tab-debug/` 中随附的 Chrome MV3 扩展，将标签页临时绑定到当前会话，供智能体执行受限 DOM、控制台和网络调试。
- **用量与结构化任务**：统计会话 token/成本，显示可选的 ChatGPT/Codex 与 Grok 配额，并通过 SnFlow 面板管理显式启用的任务。
- **界面体验**：支持中英文、多套明暗主题、桌面/移动端布局，以及可调整大小的文件、任务和终端面板。

## 使用注意

- **文件访问范围**：文件浏览和预览面向当前选择的项目目录，以及会话中已出现过的工作目录。
- **模型配置**：Models 面板读写 pi agent 数据目录下的 `models.json`，模型列表和默认模型由 pi 配置解析得到。
- **Fork 与会话内分支不同**：Fork 会创建新的 `.jsonl` 文件；“Edit from here” 是同一会话文件里的分支。
- **Web Terminal**：需要本机 shell 和 PTY 支持；可在 `pi-web.json` 或界面设置中关闭。
- **浏览器调试**：浏览器桥接仅监听本机回环地址；标签页绑定是临时的，服务重启后不会恢复。
- **SnFlow**：项目初始化只会安装所需资源；普通开发仍保持直接模式，只有显式请求 SnFlow 时才进入结构化任务流程。

## 从源码运行

```bash
git clone https://github.com/twofive1203/pi-agnet-web.git
cd pi-agnet-web
npm install
npm run dev
```

本地开发端口为 [http://localhost:62666](http://localhost:62666)。

生产构建和启动：

```bash
npm run build
npm run start
```

> 开发时不要直接运行 `next build`。发布或生产验证时使用 `npm run build`。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

## 项目结构

```text
app/          # Next.js 页面和 API 路由
components/   # 浏览器端 UI 组件
hooks/        # 会话状态、主题、拖拽、音频等 React hooks
lib/          # 会话解析、RPC 生命周期、路径/配置/提供商等共享逻辑
scripts/      # 构建和运维脚本
bin/          # spi CLI 入口
public/       # 静态资源
extensions/   # 随项目提供的扩展（如 Chrome 标签页调试）
docs/         # 架构、模块、部署和运维文档
```

更多架构、开发、部署和运行说明见 [`docs/`](docs/)；部署与发布细节见 [`docs/deployment/README.md`](docs/deployment/README.md)。

## MCP 配置

Settings → **MCP** 可安全编辑 `pi-mcp-adapter` 原生的用户级/项目级配置文件，敏感字段只返回脱敏状态，并提供 revision 冲突保护和明确的 `/reload` 生效提示。adapter 是可选 Pi package，不是 WebUI 内置 transport；详见 [`docs/integrations/README.md`](docs/integrations/README.md#mcp-adapter-configuration-pi-mcp-adapter)，聚焦验证命令为 `npm run test:mcp`。

## 自动化（Automation）

右上角 **A** 抽屉可管理定时 Agent 任务。使用五段 cron 与 IANA 时区；仅在 Snail Pi Web 服务在线时调度；运行记录不进入普通项目会话列表。

第一次试用请阅读 [`docs/automation-user-guide.zh-CN.md`](docs/automation-user-guide.zh-CN.md)，其中包含创建、授权、立即运行、结果查看、提升普通会话及故障排查步骤。架构决策见 [`docs/architecture/decisions/automation-scheduler.md`](docs/architecture/decisions/automation-scheduler.md)。验证命令：`npm run test:automation`。
