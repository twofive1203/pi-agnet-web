---
title: "refactor: Iteration 7 — 迁移 Models 与资源配置面板"
type: refactor
status: completed
date: 2026-08-01
origin: docs/plans/2026-08-01-001-refactor-frontend-visual-system-plan.md
iteration: 7
depends_on: docs/plans/2026-08-01-006-refactor-settings-primitives-plan.md
---

# refactor: Iteration 7 — 迁移 Models 与资源配置面板

## Overview

本迭代处理配置界面中体量最大、信息密度最高的一组：Models、Extensions 和 Skills。采用分区迁移，优先统一外壳和通用状态，不改变 provider、OAuth、账号、价格同步、资源诊断或技能安装行为。

**前置依赖：** Iteration 1、Iteration 5；建议在 Iteration 6 后实施以复用经过复杂状态验证的原语。

---

## Scope

### In scope

- `ModelsConfig` Modal、provider/model/account/pricing/usage 等视觉分区。
- `ExtensionsConfig` Resources/Settings、诊断、资源列表与状态。
- `SkillsConfig` 浏览、搜索、详情、安装与错误状态。
- ChatGPT/Grok usage 与 warmup 相关 Modal/Popover 的表面一致性。
- 必要的共享 Settings 原语扩展。

### Out of scope

- 不修改模型发现、OAuth/API key、账号转换、价格同步、Warmup 调度或 Skill 安装协议。
- 不重构超大组件的业务状态架构；视觉迁移之外的拆文件另行规划。
- 不在本迭代建立自动截图平台或完成全站无障碍审计。

---

## Requirements

- R1. 高密度配置界面有明确 section、层级、主次操作和状态反馈。
- R2. Provider/account/model/skill 长名称与多列表格在窄屏可降级。
- R3. OAuth、API key、删除账号、安装 Skill 等敏感或危险操作视觉明确。
- R4. 业务数据色与配额图表可保留，通用表面/按钮/Notice 使用共享 Token。
- R5. 所有现有功能、保存边界和请求契约不变。

---

## Implementation Units

- [x] U1. **迁移 ModelsConfig 外壳与 Provider/Model 编辑区**

**Goal:** 先统一 Models Modal 骨架和最核心的 provider/model 配置路径。

**Files:**
- Modify: `components/ModelsConfig.tsx`
- Modify: `components/ModelPricingCatalog.tsx`
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`

**Approach:**
- 迁移 Modal、section nav、provider list、model list、field、headers editor、action row 和 Notice。
- 明确 selected、dirty、disabled、loading、success、error、danger 状态。
- 保持模型发现、header default seeding、pricing candidate 和保存行为。
- 对宽表格优先采用受控滚动或信息折叠，不改数据结构。

**Test scenarios:**
- Happy path：新增/编辑 provider 和 model，发现模型，修改 headers 并保存。
- Edge case：长 provider/model id、空列表、大量模型、ambiguous pricing candidate。
- Error path：发现失败、保存失败、pricing sync 失败。
- Mobile：列表与编辑区可顺序访问，主保存/关闭操作持续可达。

**Verification:**
- Models 核心编辑路径使用共享原语。
- provider/model 数据与保存 payload 不变。

- [x] U2. **迁移账号、Usage、Pricing 与 Warmup 子界面**

**Dependencies:** U1

**Files:**
- Modify: `components/ModelsConfig.tsx`
- Modify: `components/ChatGptUsagePanel.tsx`
- Modify: `components/GrokUsagePanel.tsx`
- Modify: `components/ChatGptWarmupDialog.tsx`
- Modify: `components/UsageStatsModal.tsx`
- Modify: `app/globals.css`

**Approach:**
- 统一账号卡、配额图、Popover、Warmup Dialog、状态提示和危险删除操作。
- 配额分段、mini pie 和 provider 标识保留数据可视化颜色。
- 保持 OAuth、import、activate、temporary selection、refresh、reset-credit 和 warmup 行为。

**Test scenarios:**
- Accounts：添加/导入/激活/备注/删除账号，空账号和错误状态。
- Usage：cache-first、刷新、not configured、quota reset、reset-credit confirm。
- Warmup：手动多选、计划设置、历史列表、加载和失败状态。
- Portal：Popover 在顶部上下文栏外不被裁切，移动端视口内可滚动。

**Verification:**
- 账号与配额功能不变，危险动作具有明确确认层级。

- [x] U3. **迁移 Extensions 与 Skills 面板**

**Goal:** 完成剩余资源管理界面的视觉统一。

**Dependencies:** Iteration 5 原语；可与 U2 分开实施

**Files:**
- Modify: `components/ExtensionsConfig.tsx`
- Modify: `components/SkillsConfig.tsx`
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`

**Approach:**
- Extensions 统一 Resources/Settings tabs、资源列表、source badge、诊断、empty/error/loading 和保存状态。
- Skills 统一搜索、分类、列表、详情、安装进度、成功/失败和已安装状态。
- 保留资源 discovery、extension settings 保存和 Skill 安装请求。

**Test scenarios:**
- Extensions：资源正常/为空/诊断失败，切换 tabs，修改并保存 extension settings。
- Skills：搜索、选择、安装、已安装、安装失败和无结果。
- Edge case：长 package/path/skill description，窄屏列表与详情降级。
- Accessibility：Tabs、列表选择、安装/保存操作可键盘访问。

**Verification:**
- Extensions/Skills 与 Settings/Models 使用同一视觉原语。
- 资源和安装业务行为不变。

- [x] U4. **清理迁移范围内的重复基础样式**

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `components/ui/SettingsPrimitives.tsx`
- Modify: `app/globals.css`
- Modify: `docs/modules/frontend.md`

**Approach:**
- 删除仅服务于已迁移旧结构的重复基础选择器和通用硬编码颜色。
- 保留数据可视化、provider 品牌和领域状态所需的专用色。
- 更新复杂配置面板的原语使用规则。

**Test scenarios:**
- Test expectation: none — 纯清理；通过 U1–U3 全场景回归验证。

**Verification:**
- 不存在新旧两套基础表单样式并行覆盖同一组件。

---

## Iteration Acceptance Gate

- Models、账号/Usage/Warmup、Extensions、Skills 分别完成正常、空、加载、错误和窄屏场景验证。
- OAuth/API key、账号、Pricing、Warmup、资源设置和 Skill 安装行为保持不变。
- lint、TypeScript、主题契约 smoke 和相关现有 API protection/runtime smoke 按触及范围通过。
- 不进行与视觉无关的超大组件业务重构。

---

## Risks

| Risk | Mitigation |
| --- | --- |
| `ModelsConfig.tsx` 体量大 | 按核心编辑、账号配额、资源面板分单元迁移和验收 |
| 品牌/图表色被错误统一 | 保留领域色，只统一通用 UI 状态和表面 |
| 视觉迁移顺带重构业务 | 将拆组件或状态重构记录为后续工作，不在本迭代执行 |

---

## Handoff to Next Iteration

Iteration 8 不再大规模迁移这些面板，只修复跨主题、跨视口、键盘和 Portal 组合中发现的阻塞问题，并建立最终回归文档。
