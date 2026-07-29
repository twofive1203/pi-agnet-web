import {
  assertUrlAllowedForAutomation,
  evaluateUrlForTests,
  expandIpv6Hextets,
  isIpv6LinkLocal,
  isPrivateOrSpecialIp,
  AutomationNetworkError,
} from "../lib/automation-network-policy";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(isPrivateOrSpecialIp("127.0.0.1"), "loopback");
assert(isPrivateOrSpecialIp("10.0.0.1"), "10/8");
assert(isPrivateOrSpecialIp("192.168.1.1"), "192.168");
assert(isPrivateOrSpecialIp("169.254.169.254"), "link local metadata");
assert(isPrivateOrSpecialIp("::1"), "v6 loopback");
assert(!isPrivateOrSpecialIp("8.8.8.8"), "public");

// IPv6 link-local is fe80::/10 — reject the full range, not only the fe80 hextet prefix string.
assert(isPrivateOrSpecialIp("fe80::1"), "fe80::1 link-local");
assert(isPrivateOrSpecialIp("fe80::"), "fe80:: link-local");
assert(isPrivateOrSpecialIp("FE80::1"), "FE80 uppercase");
assert(isPrivateOrSpecialIp("fe90::1"), "fe90::1 still fe80::/10");
assert(isPrivateOrSpecialIp("fea0::1"), "fea0::1 still fe80::/10");
assert(isPrivateOrSpecialIp("febf::1"), "febf::1 upper edge of fe80::/10");
assert(isPrivateOrSpecialIp("fe80:0:0:0:0:0:0:1"), "expanded fe80");
assert(isPrivateOrSpecialIp("fe80::1%eth0"), "zone id link-local");
assert(isIpv6LinkLocal("fe80::1"), "helper fe80");
assert(isIpv6LinkLocal("fe90::1"), "helper fe90");
assert(isIpv6LinkLocal("febf::abcd"), "helper febf");
assert(!isIpv6LinkLocal("fec0::1"), "fec0 is deprecated site-local, not link-local /10");
// Policy: fec0 is not in fe80::/10; treat as non-link-local (public-ish) unless other rules apply.
assert(!isPrivateOrSpecialIp("fec0::1"), "fec0 not blocked as link-local per policy");
assert(!isPrivateOrSpecialIp("2001:4860:4860::8888"), "public v6");
// IPv4-mapped private must still deny.
assert(isPrivateOrSpecialIp("::ffff:127.0.0.1"), "v4-mapped loopback");
assert(isPrivateOrSpecialIp("::ffff:169.254.169.254"), "v4-mapped metadata");
assert(isPrivateOrSpecialIp("::ffff:10.0.0.1"), "v4-mapped 10/8");
const expanded = expandIpv6Hextets("fe90::1");
assert(expanded && expanded[0] === "fe90", `expand fe90 got ${expanded?.[0]}`);

const cases: Array<[string, boolean]> = [
  ["https://example.com/a", true],
  ["http://example.com", true],
  ["ftp://example.com", false],
  ["http://localhost/x", false],
  ["http://127.0.0.1/x", false],
  ["http://169.254.169.254/latest/meta-data", false],
  ["http://metadata.google.internal/", false],
  ["http://user:pass@example.com/", false],
  ["http://[fe80::1]/", false],
  ["http://[fe90::1]/", false],
  ["http://[febf::1]/", false],
];

for (const [url, ok] of cases) {
  const result = evaluateUrlForTests(url);
  assert(result.ok === ok, `url ${url} expected ok=${ok} got ${result.ok} ${result.reason ?? ""}`);
}

try {
  assertUrlAllowedForAutomation("http://127.0.0.1/");
  throw new Error("should block loopback url");
} catch (e) {
  assert(e instanceof AutomationNetworkError, "network error type");
}
// Some URL parsers normalize IPv6 forms differently; assert pure IP helper instead.
assert(isPrivateOrSpecialIp("::1"), "v6 loopback ip helper");

console.log("smoke-automation-network-policy: ok");
