# Snail Pi Chrome Tab Debug 验收 Checklist

用于验证 `extensions/chrome-tab-debug/` Chrome MV3 插件与 Snail Pi 本机会话绑定、页面调试和安全边界。

## 0. 基础准备

- [ ] 安装依赖：

```bash
npm install
```

- [ ] 启动 Snail Pi Web：

```bash
npm run dev
```

- [ ] 浏览器能打开：

```text
http://127.0.0.1:62666
```

- [ ] 自动化测试通过：

```bash
npm run test:browser
```

- [ ] lint 通过：

```bash
npm run lint
```

- [ ] TypeScript 通过：

```bash
node_modules/.bin/tsc --noEmit
```

## 1. Chrome 扩展安装

- [ ] 打开 Chrome：

```text
chrome://extensions
```

- [ ] 打开右上角 **Developer mode**
- [ ] 点击 **Load unpacked**
- [ ] 选择目录：

```text
extensions/chrome-tab-debug
```

- [ ] 扩展成功加载，无红色错误
- [ ] 扩展图标可点击
- [ ] popup 可以正常打开

## 2. 配对 Snail Pi

- [ ] 打开 Snail Pi Web
- [ ] 进入一个真实会话
- [ ] 找到 Browser panel
- [ ] 点击 **Enable + pair extension**
- [ ] 复制 pairing code
- [ ] 打开 Chrome 扩展 popup
- [ ] 输入 pairing code
- [ ] 确认端口是默认：

```text
62666
```

- [ ] 点击 **Pair**
- [ ] popup 显示已配对
- [ ] Snail Pi Browser panel 显示扩展/bridge 状态正常

预期：

- [ ] 没有报错
- [ ] 没有要求远程服务器
- [ ] 没有请求 `<all_urls>` 权限

## 3. 绑定普通网页 Tab

准备一个普通网页，例如：

```text
http://127.0.0.1:62666
```

或你自己的测试页面。

- [ ] 在 Snail Pi 当前会话里点击 **Connect browser tab**
- [ ] 切换到目标网页 tab
- [ ] 打开扩展 popup
- [ ] 点击 **Bind this tab**
- [ ] Snail Pi 面板显示该 tab 已绑定
- [ ] 该 tab 成为 primary tab

预期：

- [ ] 绑定只发生在用户点击扩展 popup 后
- [ ] 没有自动绑定其他 tab
- [ ] Chrome `tabId` 没有显示给模型或用户
- [ ] 一个会话可以看到当前绑定 tab

## 4. DOM 查看能力

在 Snail Pi 会话中让 agent 查看页面。

检查：

- [ ] 能获取页面标题
- [ ] 能获取当前 URL / origin
- [ ] 能获取 DOM / accessibility snapshot
- [ ] 能看到页面可见文本
- [ ] 输出有限长，没有无限 dump 整页

预期：

- [ ] 工具结果结构化
- [ ] 没有 Cookie / Authorization / token 泄漏
- [ ] 没有返回 Chrome 内部 tab id

## 5. 元素查找能力

在测试页面准备一些元素：

```html
<button>Save draft</button>
<input placeholder="Name" />
<a href="/next">Next</a>
```

测试：

- [ ] 按文本查找 `Save draft`
- [ ] 按 role/name 查找按钮
- [ ] 按文本查找链接
- [ ] 按 CSS 查找普通输入框

预期：

- [ ] 返回 `elementRef`
- [ ] 返回元素可见性
- [ ] 返回元素文本 / role / bounding box
- [ ] 页面刷新后旧 `elementRef` 会失效

## 6. 安全操作能力

测试正常操作：

- [ ] 高亮按钮
- [ ] 滚动到元素
- [ ] 点击普通按钮
- [ ] 在普通文本框输入内容
- [ ] 下拉框选择值
- [ ] 等待元素出现

预期：

- [ ] 普通安全操作成功
- [ ] 操作结果返回清晰
- [ ] 超时会返回 typed error
- [ ] 取消操作不会继续后台执行

## 7. 危险操作阻断

准备或打开包含以下元素的页面。

### 7.1 密码字段

```html
<input type="password" />
```

- [ ] 尝试输入密码字段

预期：

- [ ] 被拒绝
- [ ] 返回 `ACTION_BLOCKED`

### 7.2 文件上传

```html
<input type="file" />
```

- [ ] 尝试点击文件上传控件

预期：

- [ ] 被拒绝
- [ ] 不打开文件选择器
- [ ] 返回 `ACTION_BLOCKED`

### 7.3 下载链接

```html
<a href="/file.zip" download>Download</a>
```

- [ ] 尝试点击下载链接

预期：

- [ ] 被拒绝
- [ ] 不触发下载
- [ ] 返回 `ACTION_BLOCKED`

### 7.4 危险按钮

```html
<button>Delete account</button>
<button>Remove all data</button>
```

- [ ] 尝试点击危险按钮

预期：

- [ ] 被拒绝
- [ ] 返回 `ACTION_BLOCKED`

### 7.5 权限类按钮

```html
<button>Allow camera access</button>
<button>Enable notifications</button>
```

- [ ] 尝试点击权限按钮

预期：

- [ ] 被拒绝
- [ ] 不触发浏览器权限弹窗
- [ ] 返回 `ACTION_BLOCKED`

### 7.6 支付字段

```html
<input name="card_number" />
<input autocomplete="cc-number" />
```

- [ ] 尝试输入支付字段

预期：

- [ ] 被拒绝
- [ ] 返回 `ACTION_BLOCKED`

## 8. 截图能力

- [ ] 请求当前 viewport 截图
- [ ] 检查截图能返回
- [ ] 检查截图结果包含尺寸信息
- [ ] 检查 URL metadata 已脱敏

预期：

- [ ] 截图大小受限
- [ ] 超限时返回 typed error
- [ ] 不返回完整页面长截图
- [ ] 不暴露 token query 参数

## 9. Debug 模式

默认状态下测试：

- [ ] 未开启 debug 时请求 console

预期：

- [ ] 被拒绝
- [ ] 提示需要 debug capability

然后开启：

- [ ] 在扩展 popup 中显式启用 debug
- [ ] 接受 Chrome debugger 权限提示
- [ ] 再请求 console
- [ ] 再请求 network summary

预期：

- [ ] 开启前不会 attach debugger
- [ ] 开启后才允许 console/network
- [ ] Chrome 可能显示 debugger 提示，这是预期行为
- [ ] 没有暴露 Cookie / Authorization / body

## 10. Console / Exception 脱敏

在页面控制台执行类似内容：

```js
console.log("Authorization: Bearer super-secret-token")
console.log("api_key=abc123")
console.error("token=secret-value")
```

然后让 Snail Pi 读取 console。

预期：

- [ ] `super-secret-token` 不出现
- [ ] `abc123` 不出现
- [ ] `secret-value` 不出现
- [ ] 出现 `[redacted]` 或等价脱敏标记

## 11. Network 摘要

准备一个请求，比如 POST：

```js
fetch("/api/test?token=secret", { method: "POST" })
```

然后读取 network summary。

预期：

- [ ] method 是 `POST`，不是错误地显示为 `GET`
- [ ] URL 中 `token=secret` 被脱敏
- [ ] 不返回 request body
- [ ] 不返回 response body
- [ ] 不返回 Cookie / Authorization header

## 12. 跨域导航

在已绑定页面跳转到另一个 origin，例如：

```text
https://example.com
```

测试：

- [ ] 绑定状态变为 suspended
- [ ] Snail Pi 不能继续操作页面
- [ ] 扩展 popup 提供继续确认 / 重新确认入口
- [ ] 用户确认后才恢复

预期：

- [ ] 不会自动恢复绑定
- [ ] 不会被被动 `binding.updated` 恢复
- [ ] 必须显式确认

## 13. Revoke / Revoke all

### 单个撤销

- [ ] 在 Snail Pi Browser panel 点击 revoke 某个 tab
- [ ] 出现 danger confirmation dialog
- [ ] 点击 Cancel

预期：

- [ ] 绑定仍存在
- [ ] 不发送 revoke 请求

然后：

- [ ] 再点 revoke
- [ ] 点击 Confirm

预期：

- [ ] 绑定被移除
- [ ] 扩展状态同步更新

### 全部撤销

- [ ] 绑定多个 tab
- [ ] 点击 Revoke all
- [ ] 出现 danger confirmation dialog
- [ ] Cancel 不生效
- [ ] Confirm 后全部移除

## 14. 多 Tab 行为

- [ ] 同一会话绑定第一个 tab
- [ ] 再绑定第二个 tab
- [ ] Snail Pi 面板显示多个 tab
- [ ] 设置其中一个为 primary
- [ ] 不指定 bindingId 时默认操作 primary tab
- [ ] 指定 bindingId 时操作对应 tab

预期：

- [ ] 一个 session 可以多个 tab
- [ ] 只有一个 primary
- [ ] primary 删除后自动选择合理 fallback 或清空

## 15. 单 Tab 独占

测试：

- [ ] 会话 A 绑定某个 tab
- [ ] 会话 B 尝试绑定同一个 tab

预期：

- [ ] 不会静默抢占
- [ ] 返回冲突
- [ ] 原绑定仍属于会话 A

## 16. Fork / 新会话行为

- [ ] 在绑定 tab 的会话里 fork
- [ ] 切换到新会话
- [ ] 检查绑定状态

预期：

- [ ] 绑定不自动迁移
- [ ] 新会话需要重新绑定
- [ ] 父会话旧 runtime 销毁后不会继续拥有活动控制权

## 17. 重启行为

### Snail Pi 重启

- [ ] 绑定一个 tab
- [ ] 停止 `npm run dev`
- [ ] 重新启动 `npm run dev`
- [ ] 查看扩展和 Snail Pi 状态

预期：

- [ ] 安装配对可以保留
- [ ] 临时 tab binding 不自动恢复
- [ ] 需要重新绑定 tab

### Chrome 重启 / 扩展 reload

- [ ] 绑定一个 tab
- [ ] 在 `chrome://extensions` 点 Reload
- [ ] 检查 binding 状态

预期：

- [ ] 临时 binding 清理或需要重新确认
- [ ] 不静默继续控制旧 tab

## 18. DevTools 冲突

- [ ] 绑定 tab
- [ ] 开启 debug
- [ ] 打开 Chrome DevTools
- [ ] 或让其他 debugger 抢占

预期：

- [ ] 插件 debug 能力降级
- [ ] DOM 基础能力尽量不受影响
- [ ] console/network 工具返回 `CAPABILITY_UNAVAILABLE` 或类似明确错误

## 19. 自动化最终回归

手工测完后再跑一遍：

```bash
npm run test:browser
npm run lint
node_modules/.bin/tsc --noEmit
```

预期：

- [ ] 全部通过

## 最小验收通过标准

如果时间有限，至少要完成这些：

- [ ] 扩展能 Load unpacked
- [ ] 能 pairing
- [ ] 能 bind 当前 tab
- [ ] 能 snapshot / find / click / type 普通元素
- [ ] 危险动作会 `ACTION_BLOCKED`
- [ ] debug 需要显式授权
- [ ] console/network 输出脱敏
- [ ] 跨域导航 suspended
- [ ] revoke 有 danger confirmation
- [ ] `npm run test:browser` 通过
- [ ] `npm run lint` 通过
- [ ] `tsc --noEmit` 通过

## 测试结果记录模板

```md
## Snail Pi Chrome Tab Debug 验收记录

日期：
测试人：
Chrome 版本：
Snail Pi commit：

### 自动化
- npm run test:browser: pass / fail
- npm run lint: pass / fail
- tsc --noEmit: pass / fail

### 安装
- Load unpacked: pass / fail
- Pairing: pass / fail
- Bind tab: pass / fail

### 功能
- Snapshot: pass / fail
- Find element: pass / fail
- Click benign control: pass / fail
- Type benign input: pass / fail
- Screenshot: pass / fail
- Console debug: pass / fail
- Network debug: pass / fail

### 安全
- Password blocked: pass / fail
- File input blocked: pass / fail
- Download blocked: pass / fail
- Destructive button blocked: pass / fail
- Permission button blocked: pass / fail
- Token redaction: pass / fail
- Cross-origin suspend: pass / fail
- Revoke confirmation: pass / fail

### 备注
-
```
