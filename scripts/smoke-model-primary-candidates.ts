import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultModelPickerOptions,
  groupModelOptionsByProvider,
  isPrimaryCandidateModel,
  modelPrimaryCandidateKey,
  readPrimaryCandidateKeysFromModelsJson,
} from "../lib/model-primary-candidates";
import {
  getModelFavoritesPath,
  ModelFavoritesValidationError,
  readModelFavorites,
  setModelFavorite,
} from "../lib/model-favorites";

async function main() {
  assert.equal(modelPrimaryCandidateKey(" OpenAI ", " gpt-4.1 "), "OpenAI\0gpt-4.1");
  assert.equal(isPrimaryCandidateModel({ primaryCandidate: true }), true);
  assert.equal(isPrimaryCandidateModel({ primaryCandidate: false }), false);
  assert.equal(isPrimaryCandidateModel({}), false);

  const keys = readPrimaryCandidateKeysFromModelsJson({
    providers: {
      openai: {
        models: [
          { id: "gpt-4.1", primaryCandidate: true },
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "o3", primaryCandidate: true },
          { id: "  ", primaryCandidate: true },
        ],
      },
      anthropic: {
        models: [{ id: "claude-sonnet", primaryCandidate: "yes" }],
      },
      empty: {},
    },
  });
  assert.deepEqual([...keys].sort(), [
    modelPrimaryCandidateKey("openai", "gpt-4.1"),
    modelPrimaryCandidateKey("openai", "o3"),
  ].sort());

  const options = [
    { provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
    { provider: "openai", modelId: "gpt-4.1", name: "GPT-4.1", primaryCandidate: true },
    { provider: "anthropic", modelId: "claude", name: "Claude", primaryCandidate: true },
    { provider: "openai", modelId: "o3", name: "o3", primaryCandidate: true },
  ];

  const noneMarked = buildDefaultModelPickerOptions(
    options.map(({ provider, modelId, name }) => ({ provider, modelId, name })),
  );
  assert.equal(noneMarked.hasPrimaryCandidates, false);
  assert.equal(noneMarked.defaultOptions.length, 4);

  const withCandidates = buildDefaultModelPickerOptions(options, {
    provider: "openai",
    modelId: "gpt-4o",
  });
  assert.equal(withCandidates.hasPrimaryCandidates, true);
  assert.deepEqual(
    withCandidates.defaultOptions.map((opt) => `${opt.provider}/${opt.modelId}`),
    ["openai/gpt-4o", "openai/gpt-4.1", "anthropic/claude", "openai/o3"],
  );

  const alreadyCandidate = buildDefaultModelPickerOptions(options, {
    provider: "openai",
    modelId: "o3",
  });
  assert.deepEqual(
    alreadyCandidate.defaultOptions.map((opt) => `${opt.provider}/${opt.modelId}`),
    ["openai/gpt-4.1", "anthropic/claude", "openai/o3"],
  );

  const groups = groupModelOptionsByProvider(withCandidates.defaultOptions);
  assert.deepEqual(groups.map((g) => g.provider), ["openai", "anthropic"]);
  assert.deepEqual(
    groups[0]?.options.map((opt) => opt.modelId),
    ["gpt-4o", "gpt-4.1", "o3"],
  );
  const collapsed = groupModelOptionsByProvider(options);
  assert.deepEqual(collapsed.map((g) => g.provider), ["openai", "anthropic"]);
  assert.equal(collapsed[0]?.options.length, 3);

  const agentDir = mkdtempSync(join(tmpdir(), "pi-model-favorites-"));
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        custom: {
          models: [
            { id: "legacy-a", primaryCandidate: true },
            { id: "legacy-b", primaryCandidate: true },
          ],
        },
      },
    }));

    const legacy = readModelFavorites(agentDir);
    assert.equal(legacy.source, "legacy");
    assert.deepEqual(legacy.favorites.map((entry) => `${entry.provider}/${entry.modelId}`), [
      "custom/legacy-a",
      "custom/legacy-b",
    ]);

    const migrated = await setModelFavorite(
      { provider: "custom", modelId: "legacy-a" },
      false,
      agentDir,
    );
    assert.equal(migrated.source, "sidecar");
    assert.deepEqual(migrated.favorites.map((entry) => `${entry.provider}/${entry.modelId}`), [
      "custom/legacy-b",
    ]);
    assert.equal(getModelFavoritesPath(agentDir), join(agentDir, "model-favorites.json"));

    await Promise.all([
      setModelFavorite({ provider: "openai-codex", modelId: "gpt-built-in" }, true, agentDir),
      setModelFavorite({ provider: "xai", modelId: "grok-built-in" }, true, agentDir),
    ]);
    const sidecar = readModelFavorites(agentDir);
    assert.equal(sidecar.source, "sidecar");
    assert.deepEqual(sidecar.favorites.map((entry) => `${entry.provider}/${entry.modelId}`), [
      "custom/legacy-b",
      "openai-codex/gpt-built-in",
      "xai/grok-built-in",
    ]);

    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { custom: { models: [{ id: "ignored-legacy", primaryCandidate: true }] } },
    }));
    assert.deepEqual(
      readModelFavorites(agentDir).favorites.map((entry) => `${entry.provider}/${entry.modelId}`),
      ["custom/legacy-b", "openai-codex/gpt-built-in", "xai/grok-built-in"],
    );

    assert.throws(
      () => setModelFavorite({ provider: "", modelId: "bad" }, true, agentDir),
      ModelFavoritesValidationError,
    );
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }

  console.log("smoke-model-primary-candidates: ok");
}

void main();
