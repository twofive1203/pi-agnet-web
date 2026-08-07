# 蜗牛派（Snail Pi Web）

蜗牛派（Snail Pi Web）是面向 `pi` 编程智能体的本地 Web 工作台。它把会话管理、实时对话、模型与扩展配置、项目文件、Git/WorkTree、浏览器调试和可选 Web 终端集中到一个界面中，适合在桌面或服务器环境中长期运行。

- npm 包：[`@twofive/snail-pi-web`](https://www.npmjs.com/package/@twofive/snail-pi-web)
- GitHub：[`twofive1203/pi-agnet-web`](https://github.com/twofive1203/pi-agnet-web)
- 命令行入口：`spi`

更完整的中文说明见 [`README.zh-CN.md`](README.zh-CN.md)。

## 运行环境

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | Node.js >=22.19.0 | Next.js 16 / React 19 运行环境；低版本 Node 可能无法启动。 |
| npm | 建议 npm 10+ | 用于 `npx`、全局安装和源码安装依赖。 |
| pi agent 数据目录 | 默认 `~/.pi/agent/` | Web UI 会读取本机 pi 会话、模型和设置文件。 |
| Git | 可选但建议安装 | Git 状态、分支、WorkTree 功能需要。 |
| 本地 shell | 可选 | 开启 Web Terminal 时需要系统 shell。 |

> `@lydell/node-pty` 是 Web Terminal 的原生 PTY 依赖。通常随 npm 安装自动处理；如果目标机器缺少原生依赖构建环境，可先关闭 Web Terminal 功能。

## 快速开始

无需安装，直接运行最新版本：

```bash
npx @twofive/snail-pi-web@latest
```

或全局安装后使用 `spi`：

```bash
npm install -g @twofive/snail-pi-web
spi
```

默认仅监听回环地址 `http://127.0.0.1:62666`，本机免认证。服务就绪后，CLI 会尝试自动打开浏览器。

> **安全说明：** 官方入口不再默认继承 `0.0.0.0`。远程/局域网访问必须使用 `spi --server`（或等价环境变量）；非回环监听会强制启用全局访问密钥认证。HTTP 只提供访问控制、不加密传输，公网请放在 HTTPS 反向代理后面。

## 常用启动参数

```bash
spi                              # 本机回环，免认证
spi --port 8080                  # 自定义端口
spi --server                     # 服务器模式：0.0.0.0 + 访问密钥认证
spi --server -H 127.0.0.1        # 回环后端 + 认证（给 Nginx/Caddy 反代）
spi --server --rotate-access-key # 轮换访问密钥并失效全部会话
spi -H 0.0.0.0                   # 非回环监听会自动启用认证
PORT=8080 spi                    # 也支持 PORT 环境变量
PI_WEB_HOSTNAME=10.0.0.5 spi     # 显式监听地址（勿用系统 HOSTNAME）
# Tailscale 等可信客户端可免密钥：优先写配置文件 ~/.pi/agent/server-access-policy.json
# { "version": 1, "authBypassCidrs": ["100.64.0.0/10"] }
# 也可用环境变量覆盖（勿写 0.0.0.0/0）
PI_WEB_AUTH_BYPASS_CIDRS=100.64.0.0/10 spi --server --no-open
spi --proxy http://127.0.0.1:7897
spi --socks-proxy socks5://127.0.0.1:7897
```

`npx` 同样支持这些参数：

```bash
npx @twofive/snail-pi-web@latest --port 8080
```

如果 shell 中已有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，`spi` 会继承并自动为 Node 追加 `--use-env-proxy`。也可以用 `PROXY_URL` 和 `SOCKS_PROXY_URL`：

```bash
PROXY_URL=http://127.0.0.1:7897 SOCKS_PROXY_URL=socks5://127.0.0.1:7897 spi
```

## 数据与配置

默认读取 `~/.pi/agent/`。如需使用其他数据目录：

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent-data spi
```

| 路径 | 用途 |
| --- | --- |
| `sessions/` | 会话 JSONL 文件，按工作目录归档。 |
| `models.json` | 模型提供商和模型列表配置。 |
| `settings.json` | pi agent 设置，包括默认模型。 |
| `pi-web.json` | Web UI 设置，例如 WorkTree、Usage、Web Terminal、ChatGPT/Grok 面板、编辑器和 SnFlow 偏好。 |
| `server-access.json` | 服务器模式访问密钥校验信息与会话哈希（无明文密钥）；容器/PM2 需持久化 Agent 目录。 |
| `server-access-policy.json` | 可选：免密钥客户端 IP/CIDR 白名单（如 Tailscale）；环境变量可覆盖。 |

会话文件路径格式：

```text
~/.pi/agent/sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl
```

## 核心能力

- **会话与分支**：按工作目录浏览、搜索和归档本地会话；支持 Fork、会话内分支导航、上下文压缩和流式对话。
- **模型与 Pi 资源**：切换模型和 thinking level，管理模型认证、工具预设、Skills、Extensions、Pi 原生子智能体及模型定价目录。
- **项目文件与编辑器**：浏览和编辑源码，预览 Markdown、图片、音频、PDF、DOCX，查看当前会话产生的文件改动与 Diff。
- **Git 与 WorkTree**：查看状态、提交图和提交 Diff，切换分支、管理 stash，并创建独立 WorkTree。
- **终端与浏览器调试**：可选多标签/分屏 Web Terminal；配合随附的 Chrome 扩展，把浏览器标签页临时绑定给智能体进行受限调试。
- **用量与工作流**：查看会话成本及可选的 ChatGPT/Codex、Grok 用量；通过 SnFlow 面板管理显式启用的结构化任务，并用 `/snflow-spec-review` 审核当前任务中可沉淀的项目规范候选。
- **界面体验**：支持中英文界面、多套主题、桌面/移动端布局和可调整大小的工作区面板。

## 从源码运行

```bash
git clone https://github.com/twofive1203/pi-agnet-web.git
cd pi-agnet-web
npm install
npm run dev
```

开发服务器默认端口：`http://localhost:62666`。

生产构建和启动：

```bash
npm run build
npm run start
```

> 请使用 `npm run build`，不要直接运行 `next build`。构建脚本 `scripts/build-next.js` 包含项目需要的环境处理。

## 开发检查

```bash
npm run lint
node_modules/.bin/tsc --noEmit
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

更多部署、发布和运行细节见 [`docs/deployment/README.md`](docs/deployment/README.md)。

## MCP configuration

Settings → **MCP** safely edits `pi-mcp-adapter` native user/project configuration files with redacted secrets, revision-conflict protection, and explicit `/reload` guidance. The adapter remains optional and is not bundled as a WebUI transport; see [`docs/integrations/README.md`](docs/integrations/README.md#mcp-adapter-configuration-pi-mcp-adapter) and run `npm run test:mcp` for focused validation.

## Automation

Scheduled Agent Automation is available from the top-right **A** drawer. Tasks use five-field cron + IANA timezone, run only while Snail Pi Web is online, and keep transcripts outside ordinary project sessions. Chinese setup and trial instructions are in [`docs/automation-user-guide.zh-CN.md`](docs/automation-user-guide.zh-CN.md). See [`docs/architecture/decisions/automation-scheduler.md`](docs/architecture/decisions/automation-scheduler.md) for architecture and run `npm run test:automation` for the smoke suite.
