const { spawnSync } = require("child_process");
const path = require("path");

const scripts = [
  "smoke-automation-store.ts",
  "fault-inject-automation-store.ts",
  "smoke-automation-schedule.ts",
  "smoke-automation-tool-policy.ts",
  "smoke-automation-network-policy.ts",
  "smoke-automation-runner.ts",
  "smoke-automation-session.ts",
  "fault-inject-automation-promotion.ts",
  "smoke-automation-scheduler.ts",
  "smoke-automation-api.ts",
  "smoke-automation-approval.ts",
  "smoke-automation-tools.ts",
  "smoke-automation-ui-state.ts",
  "smoke-automation-retention.ts",
  "smoke-automation-security-regressions.ts",
];

const root = path.resolve(__dirname, "..");
let failed = 0;

for (const script of scripts) {
  const full = path.join(root, "scripts", script);
  console.log(`\n=== ${script} ===`);
  const result = spawnSync("npx", ["--yes", "tsx@4.23.1", full], {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${script}`);
  } else {
    console.log(`OK: ${script}`);
  }
}

if (failed) {
  console.error(`\n${failed}/${scripts.length} automation smokes failed`);
  process.exit(1);
}
console.log(`\nAll ${scripts.length} automation smokes passed`);
