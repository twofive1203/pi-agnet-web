import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { I18nProvider } from "@/components/I18nProvider";
import { StandaloneFileViewer } from "@/components/StandaloneFileViewer";
import { getFileName, normalizeFilePathSlashes } from "@/lib/file-paths";
import { isAbsoluteFilePath } from "@/lib/file-viewer-url";

interface FilePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function generateMetadata({ searchParams }: FilePageProps): Promise<Metadata> {
  const params = await searchParams;
  const filePath = firstParam(params.path);
  return {
    title: filePath ? `${getFileName(filePath)} · Snail Pi` : "File · Snail Pi",
  };
}

export default async function FilePage({ searchParams }: FilePageProps) {
  const params = await searchParams;
  const rawPath = firstParam(params.path);
  if (!rawPath || !isAbsoluteFilePath(rawPath)) notFound();

  const filePath = normalizeFilePathSlashes(rawPath);
  const rawCwd = firstParam(params.cwd);
  const cwd = rawCwd && isAbsoluteFilePath(rawCwd) ? normalizeFilePathSlashes(rawCwd) : undefined;
  const initialLine = positiveInteger(firstParam(params.line));

  return (
    <I18nProvider>
      <AppDialogProvider>
        <StandaloneFileViewer filePath={filePath} cwd={cwd} initialLine={initialLine} />
      </AppDialogProvider>
    </I18nProvider>
  );
}
