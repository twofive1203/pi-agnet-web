"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IntercomSessionInfo } from "@/lib/intercom-hub";

type ListResponse = {
  connected?: boolean;
  selfId?: string | null;
  sessions?: IntercomSessionInfo[];
  socketPath?: string;
  error?: string;
};

function shorten(path: string): string {
  // Windows named pipe: show just the segment after the last \ (e.g. pi-intercom-...)
  if (path.startsWith("\\\\\\.\\pipe\\")) {
    const segments = path.split("-");
    if (segments.length >= 2) return "pipe:" + segments.slice(1).join("-");
    return "pipe:" + path.split("\\\\").pop()!;
  }
  // Unix socket or regular path: abbreviate home directory
  return path
    .replace(/^[/\\]?Users[/\\][^/\\]+/i, "~")
    .replace(/^[/\\]?home[/\\][^/\\]+/i, "~")
    .replace(/^C:\\Users\\[^\\]+/i, "~");
}

function formatAge(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m`;
  return `${Math.round(delta / 3_600_000)}h`;
}

/**
 * Top-bar panel listing local pi-intercom peers and sending one-shot messages.
 */
export function IntercomPanel({ cwd }: { cwd: string | null }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/intercom/sessions${qs}`, { signal });
      const json = (await res.json()) as ListResponse;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json);
      if (!json.connected && json.error) setError(json.error);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(), 8_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const peers = useMemo(() => {
    const selfId = data?.selfId;
    return (data?.sessions ?? []).filter((session) => session.id !== selfId);
  }, [data?.selfId, data?.sessions]);

  useEffect(() => {
    if (selectedId && !peers.some((p) => p.id === selectedId)) setSelectedId(null);
  }, [peers, selectedId]);

  const send = useCallback(async () => {
    if (!selectedId || !draft.trim()) return;
    setSending(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/intercom/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: selectedId, text: draft.trim(), cwd: cwd ?? undefined }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; reason?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? json.reason ?? `HTTP ${res.status}`);
      setStatus("Delivered");
      setDraft("");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [cwd, draft, load, selectedId]);

  return (
    <div style={{
      background: "var(--bg-panel)",
      borderBottom: "1px solid var(--border)",
      maxHeight: "min(520px, 65vh)",
      display: "flex",
      flexDirection: "column",
      minWidth: 320,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Intercom</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data?.connected
            ? `${peers.length} peer(s)`
            : "Broker offline"}
            {data?.socketPath && data?.connected
              ? ` · ${shorten(data.socketPath)}`
              : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text-muted)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 11,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {(error || status) && (
        <div style={{
          padding: "6px 14px",
          fontSize: 11,
          color: error ? "#ef4444" : "var(--accent)",
          borderBottom: "1px solid var(--border)",
        }}>
          {error ?? status}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {loading && !data && (
          <div style={{ padding: 14, fontSize: 12, color: "var(--text-muted)" }}>Connecting…</div>
        )}
        {!loading && peers.length === 0 && (
          <div style={{ padding: 14, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {data?.connected
              ? "No other intercom sessions on this machine. Open another Pi CLI/Web session with pi-intercom loaded."
              : "Intercom broker is not running. Start a Pi session with the pi-intercom package enabled."}
          </div>
        )}
        {peers.map((session) => {
          const active = session.id === selectedId;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedId(session.id)}
              style={{
                width: "100%",
                textAlign: "left",
                border: "none",
                borderBottom: "1px solid var(--border)",
                background: active ? "var(--bg-selected)" : "transparent",
                padding: "10px 14px",
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                  {session.name || session.id.slice(0, 8)}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{session.status || "online"}</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>
                  {formatAge(session.lastActivity)}
                </span>
              </div>
              <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {shorten(session.cwd)} · {session.model}
              </div>
              <div style={{ marginTop: 2, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {session.id}
              </div>
            </button>
          );
        })}
      </div>

      <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={selectedId ? "Message selected session…" : "Select a peer first…"}
          disabled={!selectedId || sending}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 10px",
            background: "var(--bg)",
            color: "var(--text)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!selectedId || !draft.trim() || sending}
          style={{
            alignSelf: "flex-end",
            border: "1px solid var(--accent)",
            background: !selectedId || !draft.trim() ? "var(--bg)" : "var(--accent)",
            color: !selectedId || !draft.trim() ? "var(--text-muted)" : "#fff",
            borderRadius: 7,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            cursor: !selectedId || !draft.trim() || sending ? "not-allowed" : "pointer",
          }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
