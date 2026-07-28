# 蜗牛派（Snail Pi Web）

蜗牛派（Snail Pi Web）是面向 `pi` 编程智能体的本地 Web 工作台。它把会话管理、实时对话、模型与扩展配置、项目文件、Git/WorkTree、浏览器调试和可选 Web 终端集中到一个界面中，适合在桌面或服务器环境中长期运行。

- npm 包：[`@twofive/snail-pi-web`](https://www.npmjs.com/package/@twofive/snail-pi-web)
- GitHub：[`twofive1203/pi-agnet-web`](https://github.com/twofive1203/pi-agnet-web)
- 命令行入口：`spi`

更完整的中文说明见 [`README.zh-CN.md`](README.zh-CN.md)。

## 运行环境

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 建议 Node.js 22+ | Next.js 16 / React 19 运行环境；低版本 Node 可能无法启动。 |
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

默认监听 `http://localhost:62666`。服务就绪后，CLI 会尝试自动打开浏览器。

## 常用启动参数

```bash
spi --port 8080              # 自定义端口
spi --hostname 127.0.0.1     # 仅本机访问
spi -p 8080 -H 127.0.0.1     # 短参数组合
PORT=8080 spi                # 也支持 PORT 环境变量
spi --proxy http://127.0.0.1:7897                 # HTTP/HTTPS 代理
spi --socks-proxy socks5://127.0.0.1:7897         # ALL_PROXY/SOCKS 代理
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
- **用量与工作流**：查看会话成本及可选的 ChatGPT/Codex、Grok 用量；通过 SnFlow 面板管理显式启用的结构化任务。
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
