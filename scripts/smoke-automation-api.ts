import {
  assertAutomationLocalAccess,
  assertAutomationMutationAccess,
  issueAutomationControlSession,
  AutomationAccessError,
} from "../lib/automation-local-access";
import { withTestRemoteAddress } from "../lib/automation-connection-context";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

// Without proven remote address, Host localhost alone is insufficient (fail closed).
let blocked = false;
try {
  assertAutomationLocalAccess(req("http://127.0.0.1:62666/api/automations/tasks"));
} catch (e) {
  blocked = e instanceof AutomationAccessError;
}
assert(blocked, "missing remote address blocked");

withTestRemoteAddress("127.0.0.1", () => {
  // loopback ok when remote is proven
  assertAutomationLocalAccess(req("http://127.0.0.1:62666/api/automations/tasks"));
  assertAutomationLocalAccess(req("http://localhost:62666/api/automations/tasks"));

  // non-loopback URL rejected even from loopback remote (consistency)
  blocked = false;
  try {
    assertAutomationLocalAccess(req("http://example.com/api/automations/tasks"));
  } catch (e) {
    blocked = e instanceof AutomationAccessError;
  }
  assert(blocked, "non-loopback url blocked");

  // forwarded headers rejected
  blocked = false;
  try {
    assertAutomationLocalAccess(
      req("http://127.0.0.1:62666/api/automations/tasks", { "x-forwarded-for": "1.2.3.4" }),
    );
  } catch (e) {
    blocked = e instanceof AutomationAccessError;
  }
  assert(blocked, "forwarded blocked");

  // control session required for mutation
  const issued = issueAutomationControlSession();
  blocked = false;
  try {
    assertAutomationMutationAccess(
      req("http://127.0.0.1:62666/api/automations/tasks", {
        origin: "http://127.0.0.1:62666",
      }),
    );
  } catch (e) {
    blocked = e instanceof AutomationAccessError;
  }
  assert(blocked, "missing control blocked");

  assertAutomationMutationAccess(
    req("http://127.0.0.1:62666/api/automations/tasks", {
      origin: "http://127.0.0.1:62666",
      cookie: issued.cookie.split(";")[0]!,
    }),
  );

  // cross-origin blocked
  blocked = false;
  try {
    assertAutomationMutationAccess(
      req("http://127.0.0.1:62666/api/automations/tasks", {
        origin: "http://evil.example",
        cookie: issued.cookie.split(";")[0]!,
      }),
    );
  } catch (e) {
    blocked = e instanceof AutomationAccessError;
  }
  assert(blocked, "cross origin blocked");
});

// Spoofed Host from non-loopback remote rejected
blocked = false;
try {
  withTestRemoteAddress("8.8.8.8", () => {
    assertAutomationLocalAccess(
      req("http://localhost:62666/api/automations/tasks", { host: "localhost:62666" }),
    );
  });
} catch (e) {
  blocked = e instanceof AutomationAccessError;
}
assert(blocked, "spoofed host from remote client blocked");

console.log("smoke-automation-api: ok");
