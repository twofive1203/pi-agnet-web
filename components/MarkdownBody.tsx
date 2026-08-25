"use client";

import { useI18n } from "@/components/I18nProvider";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown";
import { buildStandaloneFileUrl, parseLocalFileHref } from "@/lib/file-viewer-url";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  /** File preview starts Mermaid in the rendered view; chat keeps source-first. */
  autoPreviewMermaid?: boolean;
}

/** Large fenced blocks stay collapsed until expanded; highlight only after expand. */
const LARGE_CODE_LINE_THRESHOLD = 80;
const LARGE_CODE_CHAR_THRESHOLD = 4000;
const COLLAPSED_CODE_PREVIEW_LINES = 24;

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

function markdownBodyPropsEqual(prev: MarkdownBodyProps, next: MarkdownBodyProps): boolean {
  return (
    prev.children === next.children &&
    prev.className === next.className &&
    prev.isStreaming === next.isStreaming &&
    prev.autoPreviewMermaid === next.autoPreviewMermaid
  );
}

export const MarkdownBody = memo(function MarkdownBody({
  children,
  className,
  isStreaming,
  autoPreviewMermaid,
}: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={{
          code({ className: codeClassName, children: codeChildren, ...props }) {
            const lang = codeClassName?.replace("language-", "").toLowerCase() ?? "";
            const raw = String(codeChildren);
            const isBlock = codeClassName?.includes("language-") || raw.includes("\n");
            if (isBlock) {
              if (lang === "mermaid") {
                return (
                  <MermaidBlock
                    code={raw.replace(/\n$/, "")}
                    isStreaming={isStreaming}
                    autoPreview={autoPreviewMermaid}
                  />
                );
              }
              return (
                <CodeBlock
                  code={raw.replace(/\n$/, "")}
                  lang={lang}
                  isStreaming={isStreaming}
                />
              );
            }
            return (
              <code className="markdown-inline-code" {...props}>
                {codeChildren}
              </code>
            );
          },
          pre({ children: preChildren }) {
            return <>{preChildren}</>;
          },
          table({ children: tableChildren }) {
            return (
              <div className="markdown-table-wrap">
                <table>{tableChildren}</table>
              </div>
            );
          },
          a({ href, children: linkChildren, ...props }) {
            const fileLocation = parseLocalFileHref(href);
            if (fileLocation) {
              return (
                <a
                  {...props}
                  href={buildStandaloneFileUrl(fileLocation.filePath, fileLocation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={fileLocation.filePath}
                >
                  {linkChildren}
                </a>
              );
            }
            return (
              <a {...props} href={href}>
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}, markdownBodyPropsEqual);

function normalizeDisplayMath(markdown: string): string {
  const lineBreak = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  let fence: { marker: string; size: number } | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        const size = fenceMatch[1].length;
        if (!fence) fence = { marker, size };
        else if (marker === fence.marker && size >= fence.size) fence = null;
        return line;
      }

      if (fence) return line;

      const displayMathMatch = line.match(/^([ \t]{0,3})\$\$(.+)\$\$[ \t]*$/);
      if (!displayMathMatch) return line;

      const math = displayMathMatch[2].trim();
      if (!math) return line;

      return `${displayMathMatch[1]}$$${lineBreak}${math}${lineBreak}${displayMathMatch[1]}$$`;
    })
    .join(lineBreak);
}

function MermaidBlock({
  code,
  isStreaming,
  autoPreview,
}: {
  code: string;
  isStreaming?: boolean;
  autoPreview?: boolean;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [showPreview, setShowPreview] = useState(() => Boolean(autoPreview) && !isStreaming);
  const [svg, setSvg] = useState<string | null>(null);
  const [renderedKey, setRenderedKey] = useState("");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;

  useEffect(() => {
    if (!showPreview || isStreaming) return;

    let cancelled = false;
    setFailedKey(null);

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: isDark ? "dark" : "default",
      });

      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `mermaid-${crypto.randomUUID()}`
          : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) {
        setSvg(result.svg);
        setRenderedKey(currentKey);
      }
    };

    render().catch(() => {
      if (!cancelled) setFailedKey(currentKey);
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, isStreaming, showPreview]);

  const previewButton = (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={
        isStreaming
          ? t("panels.mermaid.previewAfterStream")
          : showPreview
            ? t("panels.mermaid.showSource")
            : t("panels.mermaid.previewDiagram")
      }
      className={["markdown-code-action", showPreview ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {showPreview ? t("panels.mermaid.source") : t("panels.mermaid.preview")}
    </button>
  );

  if (!showPreview || isStreaming) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body =
    failedKey === currentKey ? (
      <div className="mermaid-block mermaid-block-error">{t("panels.mermaid.invalid")}</div>
    ) : !svg || renderedKey !== currentKey ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("panels.mermaid.rendering")} />
    ) : (
      <div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}

function isLargeCodeBlock(code: string): boolean {
  if (code.length >= LARGE_CODE_CHAR_THRESHOLD) return true;
  // Count lines without allocating a full split when clearly short.
  if (code.length < LARGE_CODE_LINE_THRESHOLD) return false;
  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) {
      lines += 1;
      if (lines >= LARGE_CODE_LINE_THRESHOLD) return true;
    }
  }
  return false;
}

function countCodeLines(code: string): number {
  if (!code) return 0;
  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function LightweightCode({ code }: { code: string }) {
  return (
    <pre className="markdown-code-lightweight">
      <code className="markdown-code-lightweight-code">{code}</code>
    </pre>
  );
}

function CodeBlock({
  code,
  lang,
  headerAction,
  isStreaming,
}: {
  code: string;
  lang: string;
  headerAction?: ReactNode;
  isStreaming?: boolean;
}) {
  const { isDark } = useTheme();
  const [copied, setCopied] = useState(false);
  const large = useMemo(() => isLargeCodeBlock(code), [code]);
  const lineCount = useMemo(() => countCodeLines(code), [code]);
  // Large settled blocks start collapsed; streaming always stays lightweight.
  const [expanded, setExpanded] = useState(() => !large);

  useEffect(() => {
    if (!large) setExpanded(true);
  }, [large]);

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const useHighlight = !isStreaming && expanded;
  const previewCode =
    !expanded && large
      ? code.split("\n").slice(0, COLLAPSED_CODE_PREVIEW_LINES).join("\n") +
        (lineCount > COLLAPSED_CODE_PREVIEW_LINES ? "\n…" : "")
      : code;

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">
          {lang || "text"}
          {large ? ` · ${lineCount} lines` : ""}
        </span>
        <div className="markdown-code-actions">
          {headerAction}
          {large && !isStreaming && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={["markdown-code-action", expanded ? "is-active" : ""].filter(Boolean).join(" ")}
            >
              {expanded ? "collapse" : "expand"}
            </button>
          )}
          <button type="button" onClick={copy} className="markdown-code-action">
            {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      {useHighlight ? (
        <SyntaxHighlighter
          language={lang || "text"}
          style={isDark ? vscDarkPlus : vs}
          showLineNumbers
          lineNumberStyle={{ color: "var(--text-tertiary)", fontStyle: "normal" }}
          customStyle={{
            margin: 0,
            padding: "11px 13px",
            fontSize: 12.5,
            lineHeight: 1.62,
            borderRadius: 0,
            background: "color-mix(in srgb, var(--surface-app) 92%, var(--surface-panel))",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <LightweightCode code={previewCode} />
      )}
    </div>
  );
}
