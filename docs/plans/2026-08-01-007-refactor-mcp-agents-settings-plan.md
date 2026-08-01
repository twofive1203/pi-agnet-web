---
title: "refactor: Iteration 6 — 迁移 MCP 与 Agents 配置面板"
type: refactor
status: completed
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 6
depends_on: docs/plans/2026-08-01-006-refactor-settings-primitives-plan.md
---

# refactor: Iteration 6 — 迁移 MCP 与 Agents 配置面板

## Overview

本迭代用已稳定的 Settings 原语迁移 MCP 与 Agents 两个独立保存边界。重点验证 scoped config、dirty、conflict、secret 和模型策略等复杂状态，而不同时进入体量最大的 Models/Extensions/Skills 面板。

**前置依赖：** Iteration 1、Iteration 5。

---

## Scope

### In scope

- `McpConfig` 的 server list/editor、transport、secret、precedence、conflict 和保存状态。
- `AgentsConfig` 的 scope、agent list、model/thinking/fallback 选择和保存状态。
- 必要的 Settings 原语扩展，但必须保持通用。
- 相关硬编码文案与状态提示的 i18n 收口。

### Out of scope

- 不修改 `/api/mcp/config`、subagent settings API 或配置数据模型。
- 不迁移 `ModelsConfig`、`ExtensionsConfig`、`SkillsConfig`。
- 不改变 MCP `/reload` 激活机制、secret preserve/replace/clear 或 scope precedence。

---

## Requirements

- R1. MCP 与 Agents 看起来属于 Settings，但继续拥有独立 load/save/dirty/error 状态。
- R2. Secret、conflict、precedence、runtime unknown 等状态清晰且不只依赖颜色。
- R3. 模型、Thinking、Fallback 与 inherit/clear 语义保持不变。
- R4. 复杂表单在窄屏转为单列，长路径和命令不截断关键操作。
- R5. 迁移复用 Iteration 5 原语，不创建第二套表单组件。

---

## Implementation Units

- [x] U1. **迁移 MCP 配置面板**

**Goal:** 统一 MCP 的高密度表单和状态表达，同时保持 adapter-native 配置契约。

**Files:**
- Modify: `components/McpConfig.tsx`
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/settings.ts`
- Test: `scripts/smoke-mcp-config.ts`

**Approach:**
- 迁移 server list、editor、transport tabs、field、button、notice 和 conflict banner。
- 用语义 Notice 区分 info/warning/danger/success，并配合图标/标签文本。
- Secret 控件明确 preserve、replace、clear 三态和 masked 值，不改变请求 payload。
- 保持 user/project shared/Pi override 的 precedence 显示和独立 revision 保存。

**Test scenarios:**
- Happy path：创建、编辑、删除 stdio/HTTP/socket server 并保存。
- Secret：preserve、replace、clear 分别生成原有语义，UI 不泄露原值。
- Conflict：revision 冲突、重新加载和保存恢复路径清楚。
- Edge case：无 cwd、package configured/runtime unknown、长 command/URL/path。
- Mobile：server list/editor 单列，保存和删除持续可达。

**Verification:**
- `test:mcp` 覆盖的数据契约保持通过。
- MCP 独立 dirty/error/conflict 状态未并入 `pi-web.json` 保存。

- [x] U2. **迁移 Agents 配置面板**

**Goal:** 统一 native subagent 设置视觉，并保持 scope 与 inherit 语义。

**Dependencies:** U1 中必要原语稳定；业务上可独立实施

**Files:**
- Modify: `components/AgentsConfig.tsx`
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/settings.ts`

**Approach:**
- 迁移 scope switch、agent row、source badge、model/thinking/fallback controls 和保存状态。
- 明确 inherit、clear、specific、follow main、Pi default 的层级，不用颜色代替文本。
- 保持 user-global/project scope 读取与独立保存。
- 原语扩展仅限通用 Field/Badge/Notice/ActionRow 需求。

**Test scenarios:**
- Happy path：切换 user/project scope，修改 agent model/thinking/fallback 并保存。
- Edge case：无项目 cwd、agent 列表为空、模型列表加载失败、长 agent/source 名称。
- State：inherit、unset、specific 和 clear 状态可区分。
- Error path：加载/保存失败保留编辑值和恢复入口。

**Verification:**
- 配置 payload、scope 和 fallback 语义不变。
- Agents 与 MCP 共享相同表单和 Notice 视觉。

- [x] U3. **回补原语契约与文档**

**Goal:** 将复杂面板验证出的通用需求沉淀回共享层，而不是留在局部。

**Dependencies:** U1, U2

**Files:**
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `docs/modules/frontend.md`
- Modify: `docs/standards/code-style.md`

**Approach:**
- 删除 MCP/Agents 迁移中出现的重复基础样式。
- 记录何时使用 Field、Notice、Badge、ActionRow 和 Button variant。
- 不把 transport、secret、agent model 等业务专属结构提升为通用原语。

**Test scenarios:**
- Test expectation: none — 纯共享样式与文档收口；通过 MCP/Agents 场景回归验证。

**Verification:**
- 两个面板没有复制出新的基础视觉体系。

---

## Iteration Acceptance Gate

- MCP 与 Agents 的正常、空、加载、保存、错误和特殊状态完成代表主题抽查。
- MCP secret/conflict/precedence 与 Agents scope/inherit/fallback 行为保持不变。
- `test:mcp`、lint、TypeScript 和主题契约 smoke 通过。
- 未修改 Models、Extensions、Skills 业务组件。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| 视觉迁移误伤敏感 secret 状态 | 以现有 API smoke 和 payload 语义为硬边界 |
| Agents 与 MCP 需求推动原语膨胀 | 仅抽取跨两个面板重复的通用结构 |
| 独立保存状态被 Settings 外壳吞并 | 保持组件自有 load/save/dirty/error 状态 |

---

## Handoff to Next Iteration

Iteration 7 可复用已验证的 Field、Badge、Notice 和 ActionRow，但不得把 Models 的 provider/account 特例反向塞入 MCP/Agents 原语。
