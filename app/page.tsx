import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/components/I18nProvider";
import { AppDialogProvider } from "@/components/AppDialogProvider";

export default function Home() {
  return (
    <I18nProvider>
      <AppDialogProvider>
        <Suspense>
          <AppShell />
        </Suspense>
      </AppDialogProvider>
    </I18nProvider>
  );
}
