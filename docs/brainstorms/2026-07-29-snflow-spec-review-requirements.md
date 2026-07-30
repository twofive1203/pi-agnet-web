---
date: 2026-07-29
topic: snflow-spec-review
---

# SnFlow 项目规范沉淀命令

## Problem Frame

SnFlow 初始化时会创建 `.pi/snflows/spec/` 骨架，并要求主会话在任务结束前沉淀可复用规范。但当前只有文字约定，没有明确命令、候选审核或写回闭环。Agent 在任务中犯过的错误、修正后的根因，以及新增的稳定设计模式容易停留在聊天或任务记录中，无法持续约束后续任务。

---

## Actors

- A1. 用户：显式发起规范复盘，并决定候选是否写入项目规范。
- A2. SnFlow 主 Agent：分析当前任务、提出规范候选，并在用户确认后维护 Spec。
- A3. 后续 Implement/Check Agent：读取沉淀后的规范，避免重复错误并遵循新约定。

---

## Key Flows

- F1. 生成规范候选
  - **Trigger:** 用户在存在当前 SnFlow 任务的聊天中执行 `/snflow-spec-review`。
  - **Actors:** A1, A2
  - **Steps:** 主 Agent读取当前任务文档、Implement/Check 结果、当前 diff 和已有 Spec；判断哪些经验具有跨任务复用价值；输出结构化候选或明确说明无需更新。
  - **Outcome:** 用户获得可审核的规范候选，Spec 尚未被修改。
  - **Covered by:** R1, R2, R3, R4, R5

- F2. 确认并写入规范
  - **Trigger:** 用户接受或修改一项或多项候选。
  - **Actors:** A1, A2, A3
  - **Steps:** 主 Agent只写入已确认候选；修订目标规范；同步相关索引；报告实际变更和未采纳候选。
  - **Outcome:** 后续 Agent 能从项目 Spec 读取经确认的可复用规则。
  - **Covered by:** R6, R7, R8

---

## Requirements

**触发与任务绑定**

- R1. 第一版提供显式聊天 Slash 命令 `/snflow-spec-review`，不得在普通任务完成或 Check 结束后自动触发。
- R2. 第一版只审核当前、非归档的 SnFlow 任务；没有有效当前任务时必须停止并给出明确诊断，不得猜测任务。
- R3. 命令在当前主会话中执行，不启动 Implement/Check Agent，也不通过隐藏 CLI/RPC 运行语义分析。

**候选生成**

- R4. 分析必须综合当前任务的 requirements/design/plan、可用的 Implement/Check 结果、当前相关 diff 和已有 `.pi/snflows/spec/`，并区分任务特例与可复用项目规则。
- R5. 每项候选必须包含候选类型、背景或根因、建议规范文本、适用范围、目标 Spec 文件、真实代码证据路径，以及与现有规范的关系。候选类型至少覆盖新增规则、修订规则、删除过时规则和不建议沉淀。
- R6. 若没有具备复用价值的结论，命令必须明确返回“本任务无需更新规范”，不得为了完成流程而制造规则。

**审核与写回**

- R7. 生成候选时不得修改 `.pi/snflows/spec/`；只有用户明确接受或修改候选后，主 Agent 才能写入确认内容。
- R8. 写回时必须避免重复规则，保留未涉及的现有规范内容，并同步目标层级及根 Spec 索引中受影响的状态或条目。
- R9. 完成写回后，主 Agent必须报告修改的规范文件、写入或修订的规则、忽略的候选及仍存在的不确定性。

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** 给定当前没有 SnFlow 任务，用户执行 `/snflow-spec-review` 时，命令说明缺少当前任务且不读取任意历史任务、不修改 Spec。
- AE2. **Covers R4, R5, R7.** 给定 Check 发现一个因违反既有 API 错误处理模式导致的回归，命令输出带根因、适用范围、证据路径和目标文件的修订候选，但在用户确认前不写文件。
- AE3. **Covers R4, R6.** 给定任务只修改一次性文案且没有产生可复用模式，命令返回无需更新规范。
- AE4. **Covers R7, R8, R9.** 给定用户只接受三项候选中的两项，主 Agent仅写入这两项，同步相关索引，并明确报告第三项未采纳。

---

## Success Criteria

- 用户可以主动把一次任务中的错误教训或稳定设计沉淀成经过审核的项目规范。
- 同类任务的后续 Implement/Check Agent 能读取规则和证据，减少重复错误。
- 一次性实现细节不会未经确认污染长期 Spec。
- 后续规划无需再决定第一版的触发方式、任务范围、审核门槛或写入责任。

---

## Scope Boundaries

- 第一版不自动在 Check 后提示或强制执行规范复盘。
- 第一版不支持通过 taskId 审核已完成或已归档历史任务。
- 第一版不自动写入候选，不允许无用户确认的 Spec 变更。
- 第一版不新增独立 Spec Review subagent。
- 第一版不把 Spec 维护变成进入 `ready_to_commit` 的强制状态机阶段。
- 面板快捷按钮和 CLI 入口可后续复用该能力，但不属于第一版。

---

## Key Decisions

- 显式触发：避免给每个任务增加流程负担。
- 先候选、后确认：防止偶发问题被升级为永久项目规则。
- Slash 命令优先：语义分析留在当前聊天编排层，不污染确定性的任务管理 CLI。
- 只支持当前任务：第一版优先保证上下文和代码证据可靠。
- 同时覆盖错误纠正与新增设计：将能力定位为项目知识沉淀，而不只是故障复盘。

---

## Dependencies / Assumptions

- 当前任务文档和运行记录可供主 Agent读取；缺少某类证据时应明确降低结论置信度。
- `.pi/snflows/spec/` 仍由项目拥有，SnFlow 更新不得覆盖用户沉淀内容。
- 项目资源加载机制能够暴露新的 Slash 命令或等价提示模板。

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R3][Technical] Slash 命令应由 SnFlow 扩展命令、prompt template 还是 skill 入口承载，以最好地复用现有 Web 会话命令支持。
- [Affects R5, R7][Technical] 候选在用户确认前只保留于当前对话，还是需要临时结构化载体以支持中断恢复。
- [Affects R8][Technical] 如何安全识别目标 Spec 文件、去重规则并验证索引同步。

---

## Next Steps

-> `/ce-plan` for structured implementation planning
