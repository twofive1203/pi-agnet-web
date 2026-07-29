#!/usr/bin/env node
/**
 * Fresh production catalog probe:
 * - unapproved sentinel must not execute
 * - reviewed-registry extension returns actual tool/schema/hooks/packageClosure
 * - server log must not contain new createRequire warnings
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const port = Number(process.env.PROBE_PORT || 62941);
const agentDir = mkdtempSync(join(tmpdir(), "auto-prod-cat-"));
const cwd = join(agentDir, "cwd");
const extRoot = join(cwd, ".pi", "extensions", "prod-sentinel");
mkdirSync(extRoot, { recursive: true });
writeFileSync(
  join(extRoot, "package.json"),
  JSON.stringify({ name: "prod-sentinel", main: "index.js" }),
);
const reviewedMarker = join(agentDir, "prod-sentinel-ran.txt");
writeFileSync(
  join(extRoot, "index.js"),
  `const fs=require("fs");module.exports=function(pi){fs.writeFileSync(${JSON.stringify(reviewedMarker)},"factory");pi.registerTool({name:"prod_actual_tool",description:"prod",parameters:{type:"object",properties:{q:{type:"string"}}}});pi.on("tool_call");};\n`,
);

function hashPathClosure(rootPath) {
  if (!existsSync(rootPath)) return createHash("sha256").update(`missing:${rootPath}`).digest("hex");
  const st = statSync(rootPath);
  if (st.isFile()) return createHash("sha256").update(readFileSync(rootPath)).digest("hex");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === ".hg" || name === ".svn") continue;
      const full = join(dir, name);
      const child = statSync(full);
      if (child.isDirectory()) walk(full);
      else if (child.isFile()) files.push(full);
    }
  };
  walk(rootPath);
  files.sort((a, b) => a.replace(/\\/g, "/").localeCompare(b.replace(/\\/g, "/")));
  const h = createHash("sha256");
  h.update("dir-closure:v2\0");
  for (const f of files) {
    const rel = f.slice(rootPath.length).replace(/\\/g, "/").replace(/^\//, "");
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

const digest = hashPathClosure(extRoot);
mkdirSync(join(agentDir, "automations"), { recursive: true });
writeFileSync(
  join(agentDir, "automations", "reviewed-extension-registry.v1.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      trustSource: "operator_curated",
      updatedAt: new Date().toISOString(),
      entries: {
        [digest]: {
          closureDigest: digest,
          label: "prod-sentinel",
          reviewedAt: new Date().toISOString(),
          registryVersion: 1,
        },
      },
    },
    null,
    2,
  )}\n`,
);

// Unapproved sentinel beside reviewed one
const evilMarker = join(agentDir, "evil-ran.txt");
writeFileSync(
  join(cwd, ".pi", "extensions", "evil.js"),
  `const fs=require("fs");fs.writeFileSync(${JSON.stringify(evilMarker)},"import");module.exports=function(pi){fs.writeFileSync(${JSON.stringify(evilMarker)},"factory");pi.registerTool({name:"evil_tool"});};\n`,
);

const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PORT: String(port),
  AUTOMATION_WORKER_HOST_PATH: join(root, "lib", "automation-worker-runtime.cjs"),
  AUTOMATION_DISCOVERY_WORKER_PATH: join(root, "lib", "automation-extension-discovery-runtime.cjs"),
};

const server = spawn(
  process.execPath,
  [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
server.stdout.on("data", (d) => {
  log += d.toString();
});
server.stderr.on("data", (d) => {
  log += d.toString();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => {
          b += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: b,
            setCookie: res.headers["set-cookie"],
          }),
        );
      },
    );
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

try {
  for (let i = 0; i < 40; i += 1) {
    try {
      const h = await req("GET", "/api/home");
      if (h.status && h.status < 500) break;
    } catch {
      // wait
    }
    await sleep(500);
  }

  const sess = await req("POST", "/api/automations/session", {});
  const cookies = (sess.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  const origin = `http://127.0.0.1:${port}`;
  const cat = await req("GET", `/api/automations/catalog?cwd=${encodeURIComponent(cwd)}`, null, {
    cookie: cookies,
    origin,
  });
  let tools = [];
  try {
    const parsed = JSON.parse(cat.body);
    tools = parsed.tools || parsed.catalog || [];
  } catch {
    console.error("catalog parse fail", cat.status, cat.body.slice(0, 800));
    process.exitCode = 2;
  }

  const actual = tools.find((t) => t.name === "prod_actual_tool");
  const evilTool = tools.find((t) => t.name === "evil_tool");
  const schema = actual?.schema || {};
  const result = {
    catalogStatus: cat.status,
    hasProdActual: Boolean(actual),
    hasEvilTool: Boolean(evilTool),
    parameters: schema.parameters || null,
    hooks: actual?.hookInventory || schema.hooks || null,
    packageClosure: schema.packageClosure || null,
    reviewedFactoryRan: existsSync(reviewedMarker),
    evilFactoryRan: existsSync(evilMarker),
    createRequireInLog: /createRequire/.test(log),
    sampleNames: tools.map((t) => t.name).slice(0, 25),
  };
  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.hasProdActual &&
    !result.hasEvilTool &&
    !result.evilFactoryRan &&
    result.parameters &&
    (Array.isArray(result.hooks) || Array.isArray(actual?.hookInventory)) &&
    Array.isArray(result.packageClosure) &&
    !result.createRequireInLog;
  process.exitCode = ok ? 0 : 2;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    server.kill("SIGTERM");
  } catch {
    // ignore
  }
  await sleep(500);
  try {
    server.kill("SIGKILL");
  } catch {
    // ignore
  }
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
