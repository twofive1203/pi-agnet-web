import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  appendVisualEvidence,
  MAX_VISION_ATTACHMENTS,
  modelSupportsImageInput,
  resolveVisionForMessage,
  stripVisualEvidenceFromMessage,
  VisionResolutionError,
  type VisionAttachment,
  type VisionModelRuntime,
} from "../lib/vision-resolver";
import {
  readPiWebConfigForApi,
  writePiWebConfigPatch,
} from "../lib/pi-web-config";

function model(provider: string, id: string, input: string[]): Model<Api> {
  return { provider, id, input } as unknown as Model<Api>;
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "google-generative-ai",
    provider: "google",
    model: "vision-test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const image: VisionAttachment = {
  type: "image",
  mimeType: "image/png",
  data: "aW1hZ2U=",
};

const textModel = model("text", "text-only", ["text"]);
const visionModel = model("vision", "vision-capable", ["text", "image"]);
let completeCalls = 0;
let capturedContext: unknown;
const runtime = {
  getModel(provider: string, id: string) {
    return provider === visionModel.provider && id === visionModel.id ? visionModel : undefined;
  },
  async completeSimple(_model: Model<Api>, context: unknown) {
    completeCalls += 1;
    capturedContext = context;
    return assistant("Visible error: Module not found <script>");
  },
} as unknown as VisionModelRuntime;

async function main(): Promise<void> {
assert.equal(modelSupportsImageInput(textModel), false);
assert.equal(modelSupportsImageInput(visionModel), true);

const direct = await resolveVisionForMessage({
  runtime,
  mainModel: visionModel,
  config: { enabled: true, model: { provider: "vision", modelId: "vision-capable" } },
  message: "What is shown?",
  images: [image],
});
assert.equal(direct.usedVisionModel, false, "vision-capable main model stays on the direct path");
assert.equal(completeCalls, 0, "direct path does not call the configured resolver model");

await assert.rejects(
  () => resolveVisionForMessage({
    runtime,
    mainModel: textModel,
    config: { enabled: false, model: null },
    message: "What is shown?",
    images: [image],
  }),
  (error: unknown) => error instanceof VisionResolutionError && /Enable Vision/.test(error.message),
);

let startedWith = "";
const resolved = await resolveVisionForMessage({
  runtime,
  mainModel: textModel,
  config: { enabled: true, model: { provider: "vision", modelId: "vision-capable" } },
  message: "Why did this fail?",
  images: [image],
  onResolutionStart: (selected) => { startedWith = `${selected.provider}/${selected.modelId}`; },
});
assert.equal(completeCalls, 1);
assert.equal(startedWith, "vision/vision-capable");
assert.equal(resolved.usedVisionModel, true);
assert.match(resolved.message, /pi-web-visual-evidence/);
assert.match(resolved.message, /trust="untrusted"/);
assert.match(resolved.message, /Module not found &lt;script&gt;/, "model output is escaped before embedding");
assert.equal(stripVisualEvidenceFromMessage(resolved.message), "Why did this fail?", "internal evidence is hidden from WebUI display");
assert.deepEqual(
  ((capturedContext as { messages: Array<{ content: unknown[] }> }).messages[0].content).slice(-1)[0],
  image,
  "the configured visual model receives the original image payload",
);

const embedded = appendVisualEvidence("question", "facts", { provider: "p", modelId: "m" });
assert.equal(stripVisualEvidenceFromMessage(embedded), "question");
assert.equal(stripVisualEvidenceFromMessage("ordinary message"), "ordinary message");

await assert.rejects(
  () => resolveVisionForMessage({
    runtime,
    mainModel: textModel,
    config: { enabled: true, model: { provider: "vision", modelId: "vision-capable" } },
    message: "many",
    images: Array.from({ length: MAX_VISION_ATTACHMENTS + 1 }, () => image),
  }),
  (error: unknown) => error instanceof VisionResolutionError && /at most/.test(error.message),
);

const agentDir = mkdtempSync(path.join(tmpdir(), "pi-web-vision-config-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const defaults = readPiWebConfigForApi();
  assert.deepEqual(defaults.config.vision, { enabled: false, model: null });

  const saved = writePiWebConfigPatch({
    vision: { enabled: true, model: { provider: "vision", modelId: "vision-capable" } },
  });
  assert.deepEqual(saved.config.vision, {
    enabled: true,
    model: { provider: "vision", modelId: "vision-capable" },
  });

  assert.throws(
    () => writePiWebConfigPatch({ vision: { enabled: true, model: null } }),
    /vision.model is required/,
  );
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}

console.log("smoke-vision-resolver: OK");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
