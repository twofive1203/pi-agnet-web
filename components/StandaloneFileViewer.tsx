"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useState } from "react";
import { FileViewer } from "./FileViewer";
import { getFileName } from "@/lib/file-paths";
import { buildStandaloneFileUrl } from "@/lib/file-viewer-url";
import { useT } from "./I18nProvider";

interface StandaloneFileViewerProps {
  filePath: string;
  cwd?: string;
  initialLine?: number;
}

export function StandaloneFileViewer({ filePath, cwd, initialLine }: StandaloneFileViewerProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard?.writeText(filePath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  }, [filePath]);

  const handleOpenFile = useCallback((nextPath: string, _fileName: string, line?: number) => {
    window.location.href = buildStandaloneFileUrl(nextPath, { cwd, line });
  }, [cwd]);

  return (
    <main style={{ width: "100%", height: "100dvh", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      <header
        style={{
          height: 48,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <Link
          href="/"
          title={t("panels.fileViewer.backWorkspace")}
          aria-label={t("panels.fileViewer.backWorkspace")}
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            textDecoration: "none",
            background: "var(--bg)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <Image src="/snail-pi-logo.svg" alt="" width={22} height={22} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <strong style={{ fontSize: 13, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {getFileName(filePath)}
          </strong>
          <span title={filePath} style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {filePath}
          </span>
        </div>
        {initialLine && (
          <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {t("panels.fileViewer.line", { line: initialLine })}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopyPath}
          title={t("panels.fileViewer.copyPath")}
          style={{
            marginLeft: initialLine ? 0 : "auto",
            flexShrink: 0,
            padding: "4px 9px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg)",
            color: copied ? "var(--accent)" : "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {copied ? t("panels.fileViewer.copied") : t("panels.fileViewer.copyPath")}
        </button>
      </header>
      <section style={{ flex: 1, minHeight: 0, overflow: "hidden" }} aria-label={t("panels.fileViewer.standaloneTitle")}>
        <FileViewer filePath={filePath} cwd={cwd} initialLine={initialLine} onOpenFile={handleOpenFile} />
      </section>
    </main>
  );
}
