import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/components/I18nProvider";

export default function Home() {
  return (
    <I18nProvider>
      <Suspense>
        <AppShell />
      </Suspense>
    </I18nProvider>
  );
}
