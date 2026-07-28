# 蜗牛派（Snail Pi Web）

蜗牛派（Snail Pi Web）是面向 `pi` 编程智能体的本地 Web 工作台。它会读取本机 pi agent 数据目录，在浏览器中提供会话管理、实时对话、模型与扩展配置、项目文件、Git/WorkTree、浏览器调试和可选 Web 终端。

- npm 包：[`@twofive/snail-pi-web`](https://www.npmjs.com/package/@twofive/snail-pi-web)
- GitHub：[`twofive1203/pi-agnet-web`](https://github.com/twofive1203/pi-agnet-web)
- 命令行入口：`spi`

## 环境依赖

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 建议 Node.js 22+ | Next.js 16 / React 19 运行环境；低版本 Node 可能无法启动。 |
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

启动后打开 [http://localhost:62666](http://localhost:62666)。CLI 会在服务就绪后尝试自动打开浏览器。

## 启动参数

```bash
spi --port 8080              # 自定义端口
spi --hostname 127.0.0.1     # 仅本机访问
spi -p 8080 -H 127.0.0.1     # 组合使用
PORT=8080 spi                # 也支持环境变量
spi --proxy http://127.0.0.1:7897                 # HTTP/HTTPS 代理
spi --socks-proxy socks5://127.0.0.1:7897         # ALL_PROXY/SOCKS 代理
```

`npx` 运行时也可以传参：

```bash
npx @twofive/snail-pi-web@latest --port 8080
```

如果 shell 中已有 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，`spi` 会继承并自动为 Node 追加 `--use-env-proxy`。也可以用 `PROXY_URL` 和 `SOCKS_PROXY_URL`：

```bash
PROXY_URL=http://127.0.0.1:7897 SOCKS_PROXY_URL=socks5://127.0.0.1:7897 spi
```

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
