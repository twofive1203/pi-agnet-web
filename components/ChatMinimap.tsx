"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

const MINIMAP_WIDTH = 36;

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;   // 0–1 within total scroll height
  heightRatio: number;
  msg: AgentMessage | Partial<AgentMessage>;
  index: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs }: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  const updatePositionsRef = useRef<() => void>(null!);
  updatePositionsRef.current = () => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;

    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;

    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }

    // Build node positions from real DOM refs
    const refs = messageRefs.current;
    const newNodes: NodeInfo[] = [];
    let refIndex = 0;

    const allMessages = allMessagesRef.current;
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const el = refs?.[refIndex];
      refIndex++;

      if (!hasTextContent(msg)) continue;

      if (el && totalH > 0) {
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollEl.getBoundingClientRect();
        const top = elRect.top - containerRect.top + scrollEl.scrollTop;
        const h = elRect.height;
        newNodes.push({
          topRatio: top / totalH,
          heightRatio: h / totalH,
          msg,
          index: newNodes.length,
        });
      }
    }
    setNodes(newNodes);
  };

  const updatePositions = useCallback(() => updatePositionsRef.current(), []);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updatePositions, { passive: true });
    const ro = new ResizeObserver(updatePositions);
    ro.observe(el);
    // Also observe the scroll content for height changes
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updatePositions();
    return () => {
      el.removeEventListener("scroll", updatePositions);
      ro.disconnect();
    };
  }, [scrollContainer, updatePositions]);

  // Re-measure when message count changes (new messages arrive)
  useEffect(() => {
    const t = setTimeout(updatePositions, 50);
    return () => clearTimeout(t);
  }, [messages.length, updatePositions]);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;

    scrollToMinimapRatio(clickRatio - offset);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const r = (ev.clientY - rect.top) / rect.height;
      scrollToMinimapRatio(r - offset);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]);



  // Compute collision-free tooltip positions for all nodes
  const TOOLTIP_HEIGHT = 22;
  const TOOLTIP_GAP = 2;
  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;

  const tooltipPositions = useMemo(() => {
    if (!minimapHovered || nodes.length === 0) return [];
    // Initial positions: centered on the dot
    const positions = nodes.map((node) =>
      Math.round(node.topRatio * minimapHeightPx - TOOLTIP_HEIGHT / 2)
    );
    // Iterative push-apart to resolve overlaps (top-to-bottom pass, then bottom-to-top)
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < positions.length; i++) {
        const minTop = positions[i - 1] + TOOLTIP_HEIGHT + TOOLTIP_GAP;
        if (positions[i] < minTop) positions[i] = minTop;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        const maxTop = positions[i + 1] - TOOLTIP_HEIGHT - TOOLTIP_GAP;
        if (positions[i] > maxTop) positions[i] = maxTop;
      }
    }
    // Clamp all to minimap bounds
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.max(0, Math.min(minimapHeightPx - TOOLTIP_HEIGHT, positions[i]));
    }
    return positions;
  }, [minimapHovered, nodes, minimapHeightPx]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;

  // Find the node closest to the current mouse position
  const nearestIndex = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => {
        return Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? node.index : best;
      }, 0)
    : null;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => { setMinimapHovered(false); setMouseYRatio(null); }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMouseYRatio((e.clientY - rect.top) / rect.height);
      }}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        borderLeft: "1px solid var(--border-subtle, var(--border))",
        background: "transparent",
        overflow: "visible",
      }}
    >
      {/* Viewport indicator: rounded pill following the theme accent */}
      <div
        style={{
          position: "absolute",
          left: 6,
          right: 6,
          top: `${viewportBoxTop}%`,
          height: `${viewportBoxHeight}%`,
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-border)",
          borderRadius: 10,
          boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent-primary) 8%, transparent)",
          pointerEvents: "none",
          zIndex: 1,
          transition: "top 0.08s ease-out, height 0.08s ease-out",
        }}
      />

      {/* Message nodes */}
      {nodes.map((node) => {
        const isNearest = minimapHovered && nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        const dotTop = node.topRatio * 100;

        return (
          <div
            key={node.index}

            style={{
              position: "absolute",
              top: `${dotTop}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            {/* Dot: user messages render as an accent bar, assistant as a dot */}
            <div
              style={{
                width: isUser ? 14 : 6,
                height: isUser ? 4 : 6,
                borderRadius: isUser ? 999 : "50%",
                background: isUser
                  ? "color-mix(in srgb, var(--accent-primary) 72%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 42%, transparent)",
                border: "none",
                flexShrink: 0,
                transition: "transform 0.15s ease-out, box-shadow 0.15s ease-out, background 0.15s",
                transform: isNearest ? "scale(1.5)" : "scale(1)",
                boxShadow: isNearest
                  ? `0 0 8px 1px ${isUser ? "color-mix(in srgb, var(--accent-primary) 45%, transparent)" : "color-mix(in srgb, var(--text-muted) 35%, transparent)"}`
                  : "none",
              }}
            />


          </div>
        );
      })}

      {/* Center rail: soft rounded track that fades at both ends */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 6,
          bottom: 6,
          width: 2,
          borderRadius: 999,
          background:
            "linear-gradient(to bottom, transparent, color-mix(in srgb, var(--text-muted) 26%, transparent) 12%, color-mix(in srgb, var(--text-muted) 26%, transparent) 88%, transparent)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {/* Tooltips for all nodes, collision-free positions */}
      {minimapHovered && nodes.map((node, i) => {
        const preview = getMessagePreview(node.msg);
        const isNearest = nearestIndex === node.index;
        if (!preview || tooltipPositions.length === 0) return null;
        return (
          <div
            key={node.index}
            style={{
              position: "absolute",
              top: tooltipPositions[i],
              right: "100%",
              marginRight: 8,
              background: "var(--bg-panel)",
              border: `1px solid ${isNearest ? "var(--accent-border)" : "var(--border)"}`,
              borderLeft: `3px solid ${isNearest ? "var(--accent-primary)" : "color-mix(in srgb, var(--text-muted) 45%, transparent)"}`,
              borderRadius: 8,
              padding: "4px 9px",
              width: 200,
              zIndex: 100,
              pointerEvents: "none",
              opacity: isNearest ? 1 : 0.4,
              boxShadow: "0 4px 16px color-mix(in srgb, var(--text, #000) 14%, transparent)",
              backdropFilter: "blur(8px)",
              transition: "top 0.1s, opacity 0.1s",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: isNearest ? 500 : 400,
                color: isNearest ? "var(--text)" : "var(--text-muted)",
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {preview}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
