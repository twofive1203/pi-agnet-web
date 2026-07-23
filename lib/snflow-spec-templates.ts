/** Project-owned SnFlow specification skeleton and bootstrap task content. */

export const SNFLOW_SPEC_DIR = ".pi/snflows/spec";

export interface SnflowSpecFile {
  /** Project-relative path using forward slashes. */
  path: string;
  content: string;
}

const SKELETON_NOTICE =
  "> Skeleton installed by SnFlow setup. Fill via the 00-bootstrap-spec task. Never overwritten by SnFlow update.";

/** Exact bounded section that the bootstrap task writes to project-root AGENTS.md. */
export const AGENTS_MD_MARKER_BEGIN = "<!-- BEGIN SNFLOW SPEC -->";
export const AGENTS_MD_MARKER_END = "<!-- END SNFLOW SPEC -->";

export const AGENTS_MD_MANAGED_SECTION = `${AGENTS_MD_MARKER_BEGIN}
## SnFlow Project Specifications

Before implementation or review:

1. Read \`.pi/snflows/spec/index.md\`.
2. Read the relevant layer indexes under \`.pi/snflows/spec/\`.
3. Follow the applicable project specifications.
4. If an active task conflicts with a specification, follow the task and report the conflict.
5. When reusable conventions or lessons are learned, update the relevant specification and its index status.

Specification maintenance under \`.pi/snflows/spec/\` is allowed in the main session.
${AGENTS_MD_MARKER_END}`;

export const SNFLOW_SPEC_FILES: readonly SnflowSpecFile[] = [
  {
    path: `${SNFLOW_SPEC_DIR}/index.md`,
    content: `# Project Specifications

${SKELETON_NOTICE}

## Purpose

Read this index before development work. These files record project-specific conventions that implementation and review must follow.

## How To Use

1. Before development, read this index and the indexes for relevant layers.
2. Follow applicable guidelines while implementing and checking changes.
3. Before finishing, capture reusable conventions or lessons in the relevant guideline and update the status tables.

## Status

| Layer | Index | Status |
| --- | --- | --- |
| Frontend | [frontend/index.md](frontend/index.md) | (To be filled) |
| Backend | [backend/index.md](backend/index.md) | (To be filled) |
| Guides | [guides/index.md](guides/index.md) | (To be filled) |

## Maintenance

Layers may be removed or renamed when they do not match the project. Add an index for every new layer and keep this table synchronized.
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/frontend/index.md`,
    content: `# Frontend Specifications

${SKELETON_NOTICE}

## Technology And Structure

(To be filled)

## Guidelines

| Guideline | Status |
| --- | --- |
| [component-guidelines.md](component-guidelines.md) | (To be filled) |
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/frontend/component-guidelines.md`,
    content: `# Component Guidelines

${SKELETON_NOTICE}

## Required

(To be filled)

## Forbidden

(To be filled)

## Good Example

(To be filled)

## Bad Example

(To be filled)
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/backend/index.md`,
    content: `# Backend Specifications

${SKELETON_NOTICE}

## Technology And Structure

(To be filled)

## Guidelines

| Guideline | Status |
| --- | --- |
| [error-handling.md](error-handling.md) | (To be filled) |
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/backend/error-handling.md`,
    content: `# Error Handling

${SKELETON_NOTICE}

## Required

(To be filled)

## Forbidden

(To be filled)

## Good Example

(To be filled)

## Bad Example

(To be filled)
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/guides/index.md`,
    content: `# Development Guides

${SKELETON_NOTICE}

## Purpose

(To be filled)

## Guides

| Guide | Status |
| --- | --- |
| [development-principles.md](development-principles.md) | (To be filled) |
`,
  },
  {
    path: `${SNFLOW_SPEC_DIR}/guides/development-principles.md`,
    content: `# Development Principles

${SKELETON_NOTICE}

## Before Starting

(To be filled)

## When Stuck

(To be filled)

## Before Finishing

(To be filled)
`,
  },
] as const;

export const BOOTSTRAP_SPEC_TASK_ID = "00-bootstrap-spec";

export const BOOTSTRAP_TASK_DOCS = {
  title: "初始化项目规范",
  description: "Scan the real project and replace the SnFlow specification skeleton with evidence-based project conventions.",
  requirements: `# Requirements

## Goal

Replace the placeholder skeleton under .pi/snflows/spec/ with specifications grounded in this project's real code, and create or idempotently update the project-root AGENTS.md with a bounded SnFlow managed section.

## Requirements

1. Scan the codebase to identify the technology stack, directory structure, and established conventions.
2. Replace every "(To be filled)" placeholder with project-specific content.
3. Remove or rename layers that do not apply. Every added layer must have an index.md.
4. Keep the root and layer status tables synchronized with the resulting specification files.
5. Create or idempotently update AGENTS.md at the project root with a SnFlow managed section (bounded by <!-- BEGIN SNFLOW SPEC --> / <!-- END SNFLOW SPEC --> markers). If AGENTS.md exists, preserve all non-managed content; replace the marked section or append one if absent. If AGENTS.md is missing, create it.

## Acceptance Criteria

- No "(To be filled)" placeholder remains under .pi/snflows/spec/.
- Material conclusions cite real project file paths as evidence.
- The root and layer indexes accurately describe the final specification structure.
- AGENTS.md contains the SnFlow managed section; all existing non-managed content is preserved.

## Out Of Scope

- Changing product source code.
`,
  design: `# Design

## Approach

Read the project source and configuration without modifying product files, then write the findings under .pi/snflows/spec/** and update AGENTS.md.

## Decisions

- Complete this task directly in the main session; specification files and AGENTS.md are the explicit main-session write exceptions.
- Do not dispatch implement/check agents or other subagents for this bootstrap task.
- Preserve the guideline structure of required rules, forbidden patterns, and grounded examples where applicable.
- The AGENTS.md managed section is bounded by <!-- BEGIN SNFLOW SPEC --> / <!-- END SNFLOW SPEC --> markers for idempotent replacement.
`,
  plan: `# Plan

1. Inventory the technology stack, package layout, and main entry points.
2. Fill the frontend specification layer from real frontend code, or remove/rename it if inapplicable.
3. Fill the backend specification layer from real server code, or remove/rename it if inapplicable.
4. Fill the development guides with project-specific working principles.
5. Update every layer index and the root status table to match the final files.
6. Only after steps 1-5 are complete, create or idempotently update the project-root AGENTS.md using the exact block below:
   - If AGENTS.md is missing, create it with this block. A project-specific heading may precede it.
   - If both markers already exist in the correct order, replace only the inclusive marked block.
   - If neither marker exists, append one blank line and this block.
   - If only one marker exists, or the end marker precedes the begin marker, stop and report the malformed file instead of rewriting it.
   - Preserve all bytes outside the managed block; do not trim, reformat, or normalize unrelated content.

\`\`\`markdown
${AGENTS_MD_MANAGED_SECTION}
\`\`\`

7. Finish by manually changing task.json status to ready_to_commit; commit remains a user handoff.

## Validation

- Search .pi/snflows/spec/ for "(To be filled)" and confirm there are no matches.
- Confirm each material convention cites at least one real project path.
- Confirm AGENTS.md contains exactly one well-ordered SnFlow managed section.
- If AGENTS.md existed before, compare the prefix and suffix outside the markers and confirm they are byte-for-byte unchanged.
`,
} as const;
