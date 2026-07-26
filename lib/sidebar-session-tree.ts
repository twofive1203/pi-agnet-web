import type { SessionInfo } from "./types";

export interface SidebarSessionTreeNode {
  session: SessionInfo;
  children: SidebarSessionTreeNode[];
}

/**
 * Build a fork tree from loaded SessionInfo rows using header parentSessionId.
 * Missing parents are skipped (nearest loaded ancestor wins); cycles are guarded.
 */
export function buildSessionTree(sessions: SessionInfo[]): SidebarSessionTreeNode[] {
  const byId = new Map<string, SidebarSessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SidebarSessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SidebarSessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Merge session pages by id (later entries win field updates; order prefers existing then append). */
export function mergeSessionsById(
  existing: SessionInfo[],
  incoming: SessionInfo[],
  mode: "replace" | "append"
): SessionInfo[] {
  if (mode === "replace") {
    const byId = new Map<string, SessionInfo>();
    for (const s of incoming) byId.set(s.id, s);
    // Preserve selected/patched rows from existing that belong to the same set and are missing.
    for (const s of existing) {
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
    return [...byId.values()].sort((a, b) => {
      const cmp = b.modified.localeCompare(a.modified);
      if (cmp !== 0) return cmp;
      return b.path.localeCompare(a.path);
    });
  }

  const byId = new Map<string, SessionInfo>();
  for (const s of existing) byId.set(s.id, s);
  for (const s of incoming) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => {
    const cmp = b.modified.localeCompare(a.modified);
    if (cmp !== 0) return cmp;
    return b.path.localeCompare(a.path);
  });
}
