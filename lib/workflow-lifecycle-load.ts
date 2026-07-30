import { statSync } from "fs";
import path from "path";
import { canonicalizeCwd } from "./cwd";

const SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH = "<inline:snflow-chat-lifecycle>";

interface ExtensionLoadProjection {
  extensions: Array<{ path: string }>;
  errors: Array<{ path: string; error: string }>;
}

export function isSnflowLifecycleRequired(cwd: string): boolean {
  try {
    return statSync(path.join(canonicalizeCwd(cwd), ".pi", "snflows", "tasks")).isDirectory();
  } catch {
    return false;
  }
}

export function getSnflowChatLifecycleLoadDiagnostic(result: ExtensionLoadProjection): string | null {
  const matchingErrors = result.errors
    .filter((error) => error.path === SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH)
    .map((error) => error.error);
  if (matchingErrors.length > 0) {
    return `${SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH} failed to load: ${matchingErrors.join("; ")}`;
  }
  if (!result.extensions.some((extension) => extension.path === SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH)) {
    return `${SNFLOW_CHAT_LIFECYCLE_EXTENSION_PATH} was not loaded`;
  }
  return null;
}
