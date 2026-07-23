/** Project-owned SnFlow specification skeleton and bootstrap task content. */

export const SNFLOW_SPEC_DIR = ".pi/snflows/spec";

export interface SnflowSpecFile {
  /** Project-relative path using forward slashes. */
  path: string;
  content: string;
}

const SKELETON_NOTICE =
  "> Skeleton installed by SnFlow setup. Fill via the 00-bootstrap-spec task. Never overwritten by SnFlow update.";

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

Replace the placeholder skeleton under .pi/snflows/spec/ with specifications grounded in this project's real code.

## Requirements

1. Scan the codebase to identify the technology stack, directory structure, and established conventions.
2. Replace every "(To be filled)" placeholder with project-specific content.
3. Remove or rename layers that do not apply. Every added layer must have an index.md.
4. Keep the root and layer status tables synchronized with the resulting specification files.

## Acceptance Criteria

- No "(To be filled)" placeholder remains under .pi/snflows/spec/.
- Material conclusions cite real project file paths as evidence.
- The root and layer indexes accurately describe the final specification structure.

## Out Of Scope

- Changing product source code.
`,
  design: `# Design

## Approach

Read the project source and configuration without modifying product files, then write the findings under .pi/snflows/spec/**.

## Decisions

- Complete this task directly in the main session; specification files are the explicit main-session write exception.
- Do not dispatch implement/check agents or other subagents for this bootstrap task.
- Preserve the guideline structure of required rules, forbidden patterns, and grounded examples where applicable.
`,
  plan: `# Plan

1. Inventory the technology stack, package layout, and main entry points.
2. Fill the frontend specification layer from real frontend code, or remove/rename it if inapplicable.
3. Fill the backend specification layer from real server code, or remove/rename it if inapplicable.
4. Fill the development guides with project-specific working principles.
5. Update every layer index and the root status table to match the final files.
6. Finish by manually changing task.json status to ready_to_commit; commit remains a user handoff.

## Validation

- Search .pi/snflows/spec/ for "(To be filled)" and confirm there are no matches.
- Confirm each material convention cites at least one real project path.
`,
} as const;
