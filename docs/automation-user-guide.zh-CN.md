# 定时 Agent Automation 使用手册

本文面向第一次试用 Snail Pi Web 定时自动化的用户。Automation 可以在指定时间启动一个独立 Agent，执行固定提示词，并把结果、工具调用、用量和文件变更保存在独立的运行记录中。

## 1. 使用前须知

- Automation 仅支持本机访问的 Snail Pi Web。请直接使用 `http://127.0.0.1:62666` 或 `http://localhost:62666`，不要通过局域网地址或反向代理访问。
- 定时任务只在 Snail Pi Web 服务进程运行时调度。浏览器可以关闭，但服务不能停止。
- 使用 Node.js `>=22.19.0`。
- 先在 Snail Pi Web 中配置可用的模型和认证。模型或凭据在激活预检时不可用，任务会进入“已阻断”，不会开始调度；若凭据在激活后失效，后续运行会以认证错误或 blocked 状态结束。
- Automation 的运行会话与普通项目会话隔离，不会自动出现在左侧普通会话列表。
- 首版不允许 Automation 使用 unrestricted `bash` 或任意 subprocess。界面中被标记为“已阻断”或“不兼容无头”的工具不能授权。

启动开发服务：

```bash
npm install
npm run dev
```

生产方式：

```bash
npm run build
npm run start
```

打开页面后，确认右上角 **A** 入口中的状态显示为“调度器在线”。

## 2. 建议先做一次最小试跑

第一次建议创建一个不修改文件、只读取项目的任务，并先使用“立即运行”验证模型、工作目录和权限。

示例任务：

- 名称：`每日项目摘要`
- Cron：`0 9 * * *`
- 时区：`Asia/Shanghai`
- 工作目录：选择一个真实项目目录
- 工具：`read`、`grep`、`find`、`ls`
- 提示词：

```text
检查当前项目的 README、package.json 和最近可见的源码结构。
输出：
1. 项目用途的一段摘要；
2. 三个值得关注的维护事项；
3. 不要修改任何文件。
```

## 3. 创建任务

1. 打开 Snail Pi Web。
2. 点击右上角 **A**，打开“自动化”抽屉。
3. 确认顶部显示“调度器在线”。若显示不可用，先看本文“故障排查”。
4. 点击“新建任务”。
5. 填写任务配置。

### 名称与描述

- **名称**用于任务列表和运行记录，建议能直接说明频率与目标，例如“每天 8 点新闻摘要”。
- **描述**用于补充用途，不代替任务提示词。

### Cron 与时区

Cron 必须是标准五段表达式：

```text
分钟 小时 日 月 星期
```

常用示例：

| 需求 | Cron | 建议时区 |
| --- | --- | --- |
| 每天 08:00 | `0 8 * * *` | `Asia/Shanghai` |
| 工作日 09:30 | `30 9 * * 1-5` | `Asia/Shanghai` |
| 每周一 10:00 | `0 10 * * 1` | `Asia/Shanghai` |
| 每 30 分钟 | `*/30 * * * *` | 按所在地选择 |
| 每天 23:00 | `0 23 * * *` | `Asia/Shanghai` |

注意：

- 不支持带秒的六段 Cron。
- 最小间隔是 5 分钟。
- 时区填写 IANA 名称，例如 `Asia/Shanghai`、`America/New_York`、`Europe/London`，不要写 `UTC+8`。
- 编辑器会显示“接下来几次运行”，激活前应核对本地时间和 UTC 时间。
- 服务短暂离线后，5 分钟窗口内的最近一次计划可能补跑一次；更早的遗漏会记录为 missed/omission，不会批量补跑。

### 工作目录

有两种方式：

- **默认 `~/pi-automation-cwd`**：适合新闻摘要、通用研究等不依赖现有项目的任务。该目录首次使用后会固定保存。
- **项目**：输入项目的绝对路径，适合代码检查、文档整理、项目报告等任务。

建议：

- 需要读取或修改某个仓库时，必须选择该项目的真实绝对路径。
- 不要选择临时 worktree 或随时会删除的目录做长期任务目标。
- Automation 不会在目录失效时静默退回 Snail Pi Web 的启动目录；它会阻断并留下原因。

### 模型与 Thinking

- 从模型列表中选择已经配置并可认证的 provider/model。
- Thinking 可留空使用模型默认值，或填写该模型支持的级别。
- 定时运行不会继承创建任务时的聊天上下文，所以提示词必须自包含。

### 任务提示词

把无人值守执行所需的信息全部写入提示词，至少说明：

- 要做什么；
- 输入从哪里获取；
- 输出格式；
- 是否允许修改文件；
- 失败时如何报告；
- 不应做什么。

推荐模板：

```text
目标：<任务目标>

工作范围：
- 工作目录：当前 Automation 工作目录
- 只允许使用已授权工具

执行步骤：
1. <步骤一>
2. <步骤二>
3. <步骤三>

输出要求：
- <结构和语言>
- 标明数据时间或来源
- 若无法完成，说明具体阻断原因

限制：
- 不等待用户交互
- 不执行未授权操作
- <是否允许修改文件>
```

不要让定时 Agent “有问题时询问用户”。Automation 是无头运行；需要 confirm/select/input/editor 的工具会立即失败或被阻断。

### 工具授权

工具选择器会展示来源和风险维度：

- **本地变更/文件系统**：可能读取或修改工作目录。
- **网络出站**：会访问外部网络。
- **凭据使用**：需要实时读取已配置的凭据。
- **需要交互**：不适合无头执行。
- **已阻断**：首版策略不允许选择。

第一次试跑建议只选：

```text
read, grep, find, ls
```

如果要做网络研究，只选择界面中明确可选、已 reviewed 的 `web_search` / `web_fetch`。工具或 extension 的源码、digest、schema 或安全配置后来发生变化时，历史任务会 fail closed，进入“需要重新授权”，不会自动接受新能力。

### 运行时长与预算上限

- **最大运行时间**：首版 UI 当前固定使用 30 分钟默认值，尚未提供编辑控件。
- **每日最大运行次数**：防止 Cron 配置错误或异常重试造成运行风暴。
- **每次最大 token**：单次硬上限。
- **每月最大费用**：Automation 自己的费用上限（USD）。
- **连续失败暂停阈值**：达到阈值后停止继续运行，避免持续消耗。
- **授权到期时间**：可留空使用默认授权期限；到期后需重新审核。

第一次使用可保留默认值，但应确认每月费用上限符合预期。

## 4. 保存草稿与激活

编辑完成后有两个主要动作：

- **保存草稿**：只保存配置，不会开始定时调度。
- **审核并激活**：保存配置，展示服务端生成的授权摘要，并要求明确确认。

激活前重点核对授权摘要中的：

- Cron 和时区；
- canonical 工作目录；
- provider/model 和 thinking；
- 提示词；
- 工具与 extension；
- 网络、凭据、文件系统权限；
- 预算、最长运行时间和授权到期时间；
- “仅在 Snail Pi Web 服务在线时执行”的说明。

确认后任务状态应变为“已激活”，并显示下次运行时间。

敏感配置发生变化时，系统会创建待审核的新配置；旧的已批准配置不会因为编辑了一半就静默扩权。完成新一轮确认后，新配置才会生效。

## 5. 用“立即运行”测试

建议不要等 Cron，先试跑：

1. 打开任务详情。
2. 点击“立即运行”。
3. 核对确认对话框中的授权摘要。
4. 确认运行。
5. 在“运行历史”中等待状态从 queued/claimed/running 进入终态。

常见终态：

| 状态 | 含义 |
| --- | --- |
| `succeeded` / 成功 | Agent 正常完成 |
| `failed` / 失败 | 模型、工具或执行发生明确错误 |
| `blocked` / 已阻断 | cwd、模型、凭据、授权或策略不满足，未继续执行 |
| `timed_out` / 超时 | 达到最大运行时间 |
| `cancelled` / 已取消 | 取消得到确认 |
| `ambiguous` / 状态不确定 | 崩溃或强制终止后无法证明副作用是否发生；系统不会自动重跑 |
| `skipped` / 已跳过 | overlap、misfire 或策略决定不执行 |

如果首次激活时出现 model/credential blocked，请先修复模型或工具凭据，再点击“恢复”并重新确认授权，随后才能使用“立即运行”。如果任务已经成功激活、但某次运行以 `auth` 错误失败，则修复凭据后可直接再次“立即运行”。

## 6. 查看结果与文件变更

点击“运行历史”中的某次运行，可查看：

- 计划时间、实际开始时间和完成时间；
- 请求模型与实际模型；
- 实际生效的工具；
- token/费用；
- 只读 Agent transcript；
- edit/write 产生的文件变更；
- blocked reason、error category 和会话诊断。

有些 preflight-blocked 或 skipped 运行没有 Agent Session，界面显示“此次运行没有会话记录”是正常现象。

Automation transcript 默认不会进入普通会话列表。这样可以避免周期任务污染项目聊天历史。

## 7. 继续讨论：提升为普通会话

当一次运行已经结束且 transcript 已 sealed 时，可以点击：

**继续讨论（提升为普通会话）**

系统会：

1. 保留原 Automation 运行记录为只读；
2. 在该 run 的项目工作目录下创建普通会话；
3. 打开新会话，供你继续追问或处理结果。

以下情况不能提升：

- 运行仍在进行；
- 没有 session；
- session 尚未 sealed；
- 运行产物已删除或不可用。

## 8. 暂停、恢复、归档与全局禁用

### 暂停

“暂停”阻止后续计划被 claim，但不会暗中终止当前正在运行的任务。需要停止当前运行时，应进入运行详情点击“取消运行”。

### 恢复

恢复长期执行权限需要再次确认授权摘要。若工具、cwd、模型或授权已经漂移，应先修复配置，再恢复。

### 归档

归档停止后续调度并隐藏任务的日常管理入口，但不会立即级联删除历史运行、会话和审计记录。

### 全局禁用

任务列表中的“全局禁用”是紧急停止新 Automation claim 的开关。它不会删除任务；处理完问题后可“取消全局禁用”。

## 9. 收件箱

Automation 抽屉中的收件箱会聚合：

- 成功完成；
- 被阻断；
- 状态不确定；
- missed/omission。

点击条目会打开对应运行或任务。已读状态保存在当前浏览器中。大量记录可使用上一页/下一页翻页。

## 10. 在普通对话中管理 Automation

普通交互会话可以使用内置 `automation_tasks` tool。你可以直接对 Agent 说：

```text
创建一个 Automation 草稿：每天上海时间 8:00，在默认 Automation 目录运行，
使用我当前可用的模型，生成一份当天技术新闻摘要。先不要激活。
```

或：

```text
列出我的 Automation，并告诉我哪些处于 blocked 状态以及原因。
```

```text
暂停名为“每日项目摘要”的 Automation。
```

```text
立即运行“每日项目摘要”。
```

规则：

- 创建草稿、查询通常不需要确认。
- 激活、恢复、立即运行、归档、提升、导出、删除产物、修复锁、扩大权限等敏感操作会通过可信 UI 弹窗确认。
- Agent 参数中的 `confirmed: true` 不能绕过确认。
- 无可用 UI 确认通道时，敏感操作会 fail closed。
- Automation 自己启动的 scheduled Agent 不会获得 `automation_tasks`，不能递归创建或触发其他 Automation。

## 11. 网络任务示例

如果工具目录中存在可选的 reviewed `web_search` / `web_fetch`，可以创建新闻摘要任务：

```text
目标：生成过去 24 小时 AI Agent 工程新闻摘要。

步骤：
1. 使用已授权的 web_search 查找可靠来源；
2. 使用 web_fetch 阅读最相关的原文；
3. 去重并按重要性排序。

输出：
- 使用中文；
- 最多 8 条；
- 每条包含标题、两句摘要、来源链接和发布时间；
- 最后列出“值得继续跟踪”的 3 个主题；
- 若无法联网或凭据缺失，明确说明原因，不编造内容。

限制：
- 不修改本地文件；
- 不访问内网、loopback、私有地址或云元数据地址；
- 不等待用户交互。
```

Automation 的网络实现会限制协议、私有/本地地址、redirect、DNS rebinding、响应大小和超时。被拒绝的地址不会因为提示词要求而放行。

## 12. 故障排查

### 调度器不可用

1. 保持 Snail Pi Web 服务运行。
2. 打开 Automation → “调度器诊断”。
3. 查看 owner、heartbeat、next wake、last error、free space 和是否需要修复。
4. 若明确显示 corrupt/stale lock 且“修复锁”按钮可用，再经过确认执行修复。
5. 不要在不了解原因时手工删除 `scheduler.lock`。

数据位置：

```text
~/.pi/agent/automations/
```

若设置了 `PI_CODING_AGENT_DIR`，Automation 数据位于该 agent dir 下。

### 非 loopback 或代理访问被拒绝

首版 Automation 是 local-only。请改用本机 `127.0.0.1` / `localhost` 直接访问。通过反向代理、LAN IP 或远程浏览器控制不受支持。

### 任务显示 reauthorization_required

工具、extension digest、schema、安全配置或来源发生变化。打开任务编辑器，检查工具目录和授权摘要，重新审核并激活。不要期待系统自动降级到同名工具。

### cwd_unavailable

项目目录被移动、删除、权限变化或不再属于允许 root。恢复原目录或编辑任务为新的 canonical 绝对路径，然后重新授权。

### model_unavailable / credential_unavailable / auth

- 检查模型是否仍在 Snail Pi Web 模型配置中；
- 检查 provider API key/OAuth；
- 检查网络代理环境；
- 修复后，若任务处于“已阻断”，先点击“恢复”并重新确认授权；任务恢复为 active 后再“立即运行”。

### interaction_required

任务调用了需要 confirm/select/input/editor/browser binding 的工具。修改提示词和工具授权，改为完全无头、自包含的执行方式。

### capacity / budget / approval_expired

- `capacity`：检查磁盘空间和 retention；
- budget：调高合理上限或等待周期重置；
- `approval_expired`：重新审核长期权限。

### ambiguous

状态不确定表示系统无法证明任务在崩溃前是否已经产生副作用。先检查 transcript、文件变更和外部系统，再决定是否手工重跑。系统不会自动重试 ambiguous run。

### 运行记录不在普通侧栏

这是预期行为。请从 Automation 抽屉查看；需要继续聊天时使用“提升为普通会话”。

## 13. 数据保留与删除

默认策略：

- transcript 和 changed-file artifacts：约 90 天；
- terminal metadata 和 audit：约 365 天。

“导出”可保存一次运行的记录。“删除保留产物”会删除 transcript/changes 等保留产物，但保留最小 tombstone/audit；进行中、未 sealed 或 promotion-in-flight 的运行不能删除。

## 14. 安全建议

- 第一次先运行只读任务，再逐步增加工具权限。
- Prompt 中明确写出“不要修改文件”不能替代工具授权；真正的权限边界以授权工具为准。
- 给网络任务设置合理的 token、运行时间和月度费用上限。
- 对会修改项目文件的任务使用专门分支或稳定 worktree，并定期检查变更。
- 不要把 Automation 当作任意命令调度器；首版有意禁止 unrestricted subprocess。
- 遇到 ambiguous、tool drift、cwd drift 时先人工核查，不要盲目重跑。
- Automation 是本机控制面，不是多用户远程调度平台。

## 15. 推荐验收清单

第一次试用可按以下顺序检查：

1. 顶部显示“调度器在线”。
2. 创建只读草稿，核对 next-run preview。
3. 审核授权摘要并激活。
4. 点击“立即运行”。
5. 看到 queued/running 到终态的变化。
6. 打开 transcript、usage 和 changes。
7. 确认普通会话侧栏没有自动出现该 run。
8. 对 sealed run 使用“提升为普通会话”。
9. 暂停任务，确认下次计划不再执行。
10. 恢复任务并再次确认授权。

如需验证代码层 smoke：

```bash
npm run test:automation
npm run test:browser
npm run test:runtime
npm run lint
node_modules/.bin/tsc --noEmit
```

发布验证使用：

```bash
npm run build
```

不要直接运行 `next build`。
