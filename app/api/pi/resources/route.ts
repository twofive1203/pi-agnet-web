import { NextResponse } from "next/server";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { ExtensionWebUiBridge } from "@/lib/extension-web-ui";

export const dynamic = "force-dynamic";

type SourceInfo = {
  path?: string;
  source?: string;
  scope?: string;
  origin?: string;
  baseDir?: string;
};

type ExtensionLike = {
  path: string;
  resolvedPath?: string;
  sourceInfo?: SourceInfo;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd") ?? process.cwd();

  let session: { dispose?: () => void } | undefined;
  try {
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();

    const extensionResult = loader.getExtensions();

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

    const extensions = (extensionResult.extensions as ExtensionLike[]).map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      sourceInfo: extension.sourceInfo,
    }));

    const commands = result.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
      sourceInfo: command.sourceInfo,
    }));

    const tools = result.session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      sourceInfo: (tool as { sourceInfo?: SourceInfo }).sourceInfo,
    }));

    return NextResponse.json({
      cwd,
      agentDir,
      extensions,
      tools,
      commands,
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description, sourceInfo: skill.sourceInfo, filePath: skill.filePath })),
      prompts: prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, sourceInfo: prompt.sourceInfo, filePath: prompt.filePath })),
      diagnostics: [...extensionDiagnostics, ...skillDiagnostics, ...promptDiagnostics],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    session?.dispose?.();
  }
}
