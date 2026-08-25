import type { Metadata } from "next";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { GitWorkbench } from "@/components/git-workbench/GitWorkbench";
import { I18nProvider } from "@/components/I18nProvider";

interface GitPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.trim() || null;
}

export const metadata: Metadata = {
  title: "Git Workbench · Snail Pi",
};

export default async function GitPage({ searchParams }: GitPageProps) {
  const params = await searchParams;
  const cwd = firstParam(params.cwd);
  return (
    <I18nProvider>
      <AppDialogProvider>
        <GitWorkbench cwd={cwd} />
      </AppDialogProvider>
    </I18nProvider>
  );
}
