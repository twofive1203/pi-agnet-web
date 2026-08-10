/**
 * Pre-send readiness gate for the chat composer.
 * Blocks ordinary sends when workspace/model prerequisites are missing so users
 * hit a fix path instead of a late provider/config failure.
 */

export type ChatSendBlockReason =
  | "no_workspace"
  | "models_loading"
  | "no_models"
  | "no_model_selected";

export interface ChatSendReadinessInput {
  cwd?: string | null;
  /** False until the first /api/models response for the active cwd settles. */
  modelsReady?: boolean;
  modelList?: ReadonlyArray<{ id: string; provider: string }> | null;
  selectedModel?: { provider: string; modelId: string } | null;
}

export function getChatSendBlockReason(input: ChatSendReadinessInput): ChatSendBlockReason | null {
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwd) return "no_workspace";

  if (input.modelsReady === false) return "models_loading";

  const models = input.modelList ?? [];
  if (models.length === 0) return "no_models";

  const selected = input.selectedModel;
  if (!selected?.provider || !selected?.modelId) return "no_model_selected";

  const match = models.some(
    (model) => model.provider === selected.provider && model.id === selected.modelId,
  );
  if (!match) return "no_model_selected";

  return null;
}

export function chatSendBlockMessageKey(reason: ChatSendBlockReason): string {
  switch (reason) {
    case "no_workspace":
      return "chat.sendBlockedNoWorkspace";
    case "models_loading":
      return "chat.sendBlockedModelsLoading";
    case "no_models":
      return "chat.sendBlockedNoModels";
    case "no_model_selected":
      return "chat.sendBlockedNoModelSelected";
  }
}

/** Reasons that should surface a Models configuration entry point. */
export function chatSendBlockOffersModelsFix(reason: ChatSendBlockReason | null | undefined): boolean {
  return reason === "no_models" || reason === "no_model_selected";
}
