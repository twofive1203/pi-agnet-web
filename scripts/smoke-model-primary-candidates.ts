import assert from "node:assert/strict";
import {
  buildDefaultModelPickerOptions,
  groupModelOptionsByProvider,
  isPrimaryCandidateModel,
  modelPrimaryCandidateKey,
  readPrimaryCandidateKeysFromModelsJson,
} from "../lib/model-primary-candidates";

function main() {
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
    options.map(({ primaryCandidate: _pc, ...rest }) => rest),
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

  console.log("smoke-model-primary-candidates: ok");
}

main();
