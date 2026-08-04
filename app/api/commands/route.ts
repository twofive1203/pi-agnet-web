import { NextResponse } from "next/server";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { ExtensionWebUiBridge } from "@/lib/extension-web-ui";
import {
  createBundledPiResourceLoader,
  projectBundledPiSourceInfo,
} from "@/lib/bundled-pi-extensions";
import { disposeAgentSession, type DisposableAgentSession } from "@/lib/pi-session-lifecycle";
import { annotateExtensionCommandWebSupport, type ExtensionCommandWebSupport } from "@/lib/extension-command-web-support";

export const dynamic = "force-dynamic";

export type SlashCommandSource = "extension" | "prompt" | "skill";
export type { ExtensionCommandWebSupport };

export interface SlashCommandEntry {
  name: string;
  source: SlashCommandSource;
  description?: string;
  argumentHint?: string;
  location?: "user" | "project" | "temporary";
  path?: string;
  sourceInfo?: SlashCommandInfo["sourceInfo"];
  /** Web usability for extension commands (skills/prompts omit this). */
  webSupport?: ExtensionCommandWebSupport;
  webSupportReason?: string;
}

function locationFromSourceInfo(sourceInfo: SlashCommandInfo["sourceInfo"] | undefined): SlashCommandEntry["location"] {
  return sourceInfo?.scope;
}

function pathFromSourceInfo(sourceInfo: SlashCommandInfo["sourceInfo"] | undefined): string | undefined {
  return sourceInfo?.path;
}

/**
 * 获取当前工作目录可用的 Web 斜杠命令。
 *
 * @param req - Next.js 请求对象，必须包含 cwd 查询参数。
 * @returns extension commands、skills 与 prompt templates 的命令列表；内置 TUI 命令不在此处暴露。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  let session: DisposableAgentSession | undefined;
  try {
    const agentDir = getAgentDir();
    const loader = createBundledPiResourceLoader(DefaultResourceLoader, { cwd, agentDir });
    await loader.reload();

    const result = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = result.session;

    const extensionDiagnostics = result.extensionsResult.errors.map((error) => ({
      type: "error",
      message: error.error,
      path: error.path,
    }));
    const bridge = new ExtensionWebUiBridge((event) => {
      if (event.type === "extension_error") {
        extensionDiagnostics.push({
          type: "warning",
          message: String(event.error ?? "Extension UI request was not handled"),
          path: String(event.extensionPath ?? "<webui-extension-host>"),
        });
      }
    });
    await result.session.bindExtensions?.({
      uiContext: bridge.createContext() as never,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: async () => {},
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => {},
      },
      onError: (error: { extensionPath: string; event: string; error: string }) => {
        extensionDiagnostics.push({ type: "error", message: error.error, path: error.extensionPath });
      },
    });

    const { skills, diagnostics: skillDiagnostics } = loader.getSkills();
    const { prompts, diagnostics: promptDiagnostics } = loader.getPrompts();

    const extensionCommands: SlashCommandEntry[] = result.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      source: "extension" as const,
      description: command.description,
      location: locationFromSourceInfo(command.sourceInfo),
      path: pathFromSourceInfo(command.sourceInfo),
      sourceInfo: projectBundledPiSourceInfo(command.sourceInfo),
    }));

    const commands: SlashCommandEntry[] = [
      ...extensionCommands,
      ...prompts.map((prompt) => ({
        name: prompt.name,
        source: "prompt" as const,
        description: prompt.description,
        argumentHint: prompt.argumentHint,
        location: prompt.sourceInfo.scope,
        path: prompt.filePath,
        sourceInfo: prompt.sourceInfo,
      })),
      ...skills.map((skill) => ({
        name: `skill:${skill.name}`,
        source: "skill" as const,
        description: skill.description,
        location: skill.sourceInfo.scope,
        path: skill.filePath,
        sourceInfo: skill.sourceInfo,
      })),
    ].sort((a, b) => {
      const order: Record<SlashCommandSource, number> = { extension: 0, prompt: 1, skill: 2 };
      if (a.source !== b.source) return order[a.source] - order[b.source];
      return a.name.localeCompare(b.name);
    }).map((command) => annotateExtensionCommandWebSupport(command));

    return NextResponse.json({ commands, diagnostics: [...extensionDiagnostics, ...skillDiagnostics, ...promptDiagnostics] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    await disposeAgentSession(session);
  }
}
