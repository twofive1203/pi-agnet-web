# Extension Web UI P2/P3

## Scope

1. **Intercom 侧栏** — 列出本机 intercom broker 上的其它 session，支持发送消息
2. **interactive_shell → Web Terminal** — 检测到 interactive_shell 工具调用时打开/复用 Web Terminal 并注入 command（避免依赖 TUI overlay）
3. **CLI-only 命令标记** — 斜杠补全标记/弱化纯 TUI 命令（slopchop/btw/paste 等）

## Non-goals

- 完整替换 pi-interactive-shell 内部 PTY 实现
- Intercom 实时 presence 推送（轮询即可）
- 从 UI 安装/卸载 packages
