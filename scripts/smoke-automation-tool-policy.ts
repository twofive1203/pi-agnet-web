import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  buildToolSnapshot,
  classifyBuiltinTool,
  classifyExtensionTool,
  defaultBuiltinCatalog,
  digestFile,
} from "../lib/automation-resource-catalog";
import {
  buildAuthorityConfig,
  createApprovedExtensionPathAllowlist,
  filterExtensionsBeforeImport,
  intersectAuthorityWithLive,
  staticPreflight,
} from "../lib/automation-tool-policy";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(classifyBuiltinTool("bash").blocked, "bash blocked");
assert(classifyBuiltinTool("read").headlessCompatible, "read ok");
assert(!classifyBuiltinTool("write").blocked, "write not always blocked");

const catalog = defaultBuiltinCatalog();
// Authority must bind the same actual schema as the live catalog (not name-only).
const readDesc = catalog.find((t) => t.name === "read")!;
const read = buildToolSnapshot({
  name: "read",
  origin: "builtin",
  schema: readDesc.schema,
  risks: classifyBuiltinTool("read"),
});
const authority = buildAuthorityConfig({ tools: [read] });
assert(authority.tools.length === 1, "authority tools");
assert(authority.policyHash.length > 10, "policy hash");

const liveOk = {
  tools: catalog.filter((t) => t.name === "read"),
  cwdConfinementProven: true,
};
const eff = intersectAuthorityWithLive(authority, liveOk);
assert(!eff.blocked && eff.tools.length === 1, "intersect ok");

// Drift blocks
// rebuild snapshot path uses sourceIdentity from live builder via intersect
const auth2 = buildAuthorityConfig({
  tools: [
    {
      ...read,
      executableDigest: "deadbeef",
    },
  ],
});
const drift = intersectAuthorityWithLive(auth2, liveOk);
assert(drift.blocked && drift.blockedReason === "reauthorization_required", "digest drift");

// Empty tools stay empty (no all fallback)
const emptyAuth = buildAuthorityConfig({ tools: [] });
const emptyEff = intersectAuthorityWithLive(emptyAuth, { tools: catalog, cwdConfinementProven: false });
assert(!emptyEff.blocked && emptyEff.tools.length === 0, "no-tools stays empty");

// write/edit blocked when confinement unproven
const writeDesc = catalog.find((t) => t.name === "write")!;
const writeSnap = buildToolSnapshot({
  name: "write",
  origin: "builtin",
  schema: writeDesc.schema,
  risks: classifyBuiltinTool("write"),
});
const writeAuth = buildAuthorityConfig({ tools: [writeSnap] });
const writeBlocked = intersectAuthorityWithLive(writeAuth, {
  tools: catalog.filter((t) => t.name === "write"),
  cwdConfinementProven: false,
});
assert(writeBlocked.blocked, "write requires proven confinement");

// Pre-import filter
const dir = mkdtempSync(path.join(tmpdir(), "auto-ext-"));
const approved = path.join(dir, "approved.js");
const evil = path.join(dir, "evil.js");
writeFileSync(approved, "export default function(){return {}}");
writeFileSync(evil, "throw new Error('factory ran')");
const extSnap = {
  sourceIdentity: `path:${approved.replace(/\\/g, "/")}`,
  sourcePath: approved,
  executableDigest: digestFile(approved),
  hookInventory: [],
  configHash: "x",
};
const allow = createApprovedExtensionPathAllowlist([extSnap]);
const filtered = filterExtensionsBeforeImport(
  [{ path: approved }, { path: evil }],
  allow,
);
assert(filtered.length === 1 && filtered[0]!.path === approved, "filter before import");

const pre = staticPreflight({
  cwd: dir,
  cwdExists: true,
  modelAvailable: true,
  credentialHandlesOk: true,
  authority,
  live: liveOk,
});
assert(pre.ok, "preflight ok");

// Reviewed actual classification is headless-compatible (not unknown_extension_forbidden).
{
  const blocked = classifyExtensionTool("evil", "/tmp/x");
  assert(blocked.blocked && blocked.blockedReason === "unknown_extension_forbidden", "unreviewed blocked");
  const reviewed = classifyExtensionTool("reviewed_tool", "/tmp/x", { reviewedActual: true });
  assert(!reviewed.blocked, "reviewed actual not blocked");
  assert(reviewed.headlessCompatible, "reviewed actual headless compatible");
}

rmSync(dir, { recursive: true, force: true });
console.log("smoke-automation-tool-policy: ok");
