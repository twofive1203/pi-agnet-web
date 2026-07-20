# Implementation Plan

1. Read task artifacts and relevant Trellis/shared/project specs.
2. Map `trellis-implement` dispatch from UI/session context through the subagent runtime.
3. Reproduce or establish the mismatched cwd path from artifacts and code.
4. Implement explicit project-root propagation and invalid-context handling at the owning boundary.
5. Add focused regression coverage and update integration/module docs if the contract changes.
6. Run focused checks, full lint, TypeScript type-check, and a smoke dispatch where practical.
