"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from "react";
import { createPortal } from "react-dom";
import type { SlashCommandEntry } from "@/app/api/commands/route";
import type { AttachedFile, GitStatusInfo } from "@/lib/types";
import type { ToolPreset } from "@/components/ToolPanel";
import { BrowserBindingTrigger } from "@/components/BrowserBindingTrigger";
import { encodeFilePathForApi, getFileName, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { buildWorkflowTaskResumePrompt, type WorkflowTaskChatContext } from "@/lib/workflow-chat-context";
import { clearChatDraft, readChatDraft, writeChatDraft } from "@/lib/chat-draft";
import type { CompletionNotificationState } from "@/hooks/useCompletionNotification";
import { useI18n } from "@/components/I18nProvider";
import { classifyChatProviderError } from "@/lib/chat-provider-errors";
import { localizeError } from "@/lib/i18n";
import {
  chatSendBlockMessageKey,
  chatSendBlockOffersModelsFix,
  getChatSendBlockReason,
} from "@/lib/chat-send-readiness";
import {
  buildDefaultModelPickerOptions,
  groupModelOptionsByProvider,
  type ModelPickerOption,
} from "@/lib/model-primary-candidates";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

type ModelOption = ModelPickerOption;

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  cwd?: string | null;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; primaryCandidate?: boolean }[];
  /** False until the first models metadata fetch settles for the active cwd. */
  modelsReady?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  /** Open Models configuration when send is blocked or auth/model setup is needed. */
  onOpenModels?: () => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  notificationState?: CompletionNotificationState;
  onNotificationToggle?: () => void | Promise<void>;
  autoScrollEnabled?: boolean;
  onAutoScrollToggle?: () => void;
  browserSessionId?: string | null;
  browserSessionLabel?: string;
  draftScope: string;
  /** Another browser tab holds write ownership for this session. */
  writeLocked?: boolean;
}

type GitBranchDisplay = Pick<GitStatusInfo, "branch" | "isDetached" | "isDirty" | "isWorktree">;

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  addImages: (files: File[]) => void;
  addFiles: (files: File[]) => void;
  addFileReference: (relativePath: string, lines?: { startLine: number; endLine: number }) => void;
  /** Inject a plain-text SnFlow task resume prompt for the active task binding. */
  addWorkflowTaskContext: (context: WorkflowTaskChatContext) => void;
}

const TOOL_PRESET_OPTIONS = [
  { preset: "all", labelKey: "chat.toolPresetAll", descKey: "chat.toolPresetAllDesc" },
  { preset: "read-only", labelKey: "chat.toolPresetReadOnly", descKey: "chat.toolPresetReadOnlyDesc" },
  { preset: "none", labelKey: "chat.toolPresetOff", descKey: "chat.toolPresetOffDesc" },
] as const satisfies readonly { preset: ToolPreset; labelKey: string; descKey: string }[];
const TOOL_PRESET_LABEL_KEYS: Record<ToolPreset, string> = {
  all: "chat.toolPresetAll",
  "read-only": "chat.toolPresetReadOnly",
  none: "chat.toolPresetOff",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const MODEL_DROPDOWN_ID = "chat-input-model-dropdown";
const THINKING_DROPDOWN_ID = "chat-input-thinking-dropdown";
const TOOL_DROPDOWN_ID = "chat-input-tool-dropdown";

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface SlashCommandMatch {
  start: number;
  query: string;
}

interface SlashCommandOption extends SlashCommandEntry {
  priority: number;
}

interface AtMatch {
  start: number;
  query: string;
}

interface FileSuggestion {
  name: string;
  fullPath: string;
  isDir: boolean;
}

interface DropdownAnchorRect {
  top: number;
  left: number;
  width: number;
}

function getDropdownPanelMetrics(rect: DropdownAnchorRect): { bottom: number; right: number; maxHeight: number } {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  return {
    bottom: viewportHeight - rect.top + 6,
    right: Math.max(8, window.innerWidth - rect.left - rect.width),
    maxHeight: Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6)),
  };
}

/**
 * 解析光标前是否处于斜杠命令输入状态。
 *
 * @param value - 输入框完整文本。
 * @param caretIndex - 当前光标位置。
 * @returns 匹配到的命令起点与查询文本；否则返回 null。
 */
function getSlashCommandMatch(value: string, caretIndex: number): SlashCommandMatch | null {
  const beforeCursor = value.slice(0, caretIndex);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const currentLineBeforeCursor = beforeCursor.slice(lineStart);
  const match = currentLineBeforeCursor.match(/^(\s*)\/([^\s]*)$/);
  if (!match) return null;
  return { start: lineStart + match[1].length, query: match[2] };
}

/**
 * 解析光标前是否处于 @ 文件引用输入状态。
 *
 * @param value - 输入框完整文本。
 * @param caretIndex - 当前光标位置。
 * @returns 匹配到的命令起点与查询文本；否则返回 null。
 */
function getAtMatch(value: string, caretIndex: number): AtMatch | null {
  const beforeCursor = value.slice(0, caretIndex);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return null;

  // Only trigger when @ is at word boundary (after space, newline, etc.)
  if (atIndex > 0) {
    const prev = beforeCursor[atIndex - 1];
    if (prev !== " " && prev !== "\n" && prev !== "\t" && prev !== "(" && prev !== "[" && prev !== "{" && prev !== ">" && prev !== ":" && prev !== "`") {
      return null;
    }
  }

  const afterAt = beforeCursor.slice(atIndex + 1);
  const spaceMatch = afterAt.match(/^([^\s\n]*)/);
  const query = spaceMatch ? spaceMatch[1] : "";

  return { start: atIndex, query };
}

/**
 * 按当前查询过滤文件建议：解析 query 中的目录路径与文件名前缀，过滤出匹配的文件。
 */
function filterAtSuggestions(entries: FileSuggestion[], query: string): FileSuggestion[] {
  const lastSlash = query.lastIndexOf("/");
  const prefix = lastSlash === -1 ? query : query.slice(lastSlash + 1);
  if (!prefix) return entries;
  const lowerPrefix = prefix.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(lowerPrefix));
}

/**
 * 按当前查询过滤并排序斜杠命令。
 *
 * @param commands - 服务端发现的 skills 与 prompt templates。
 * @param query - 用户在斜杠后输入的查询文本。
 * @returns 已排序的候选命令，优先精确前缀，同时保留模板可见性。
 */
function filterSlashCommands(commands: SlashCommandEntry[], query: string): SlashCommandOption[] {
  const normalizedQuery = query.toLowerCase();
  const skillPrefixQuery = normalizedQuery.startsWith("skill:");

  return commands
    .map((command): SlashCommandOption | null => {
      const name = command.name.toLowerCase();
      const bareSkillName = command.source === "skill" ? name.replace(/^skill:/, "") : name;

      if (!normalizedQuery) return { ...command, priority: command.source === "extension" ? 0 : command.source === "prompt" ? 1 : 2 };
      if (skillPrefixQuery) {
        return name.startsWith(normalizedQuery) ? { ...command, priority: 0 } : null;
      }
      if (command.source === "extension" && name.startsWith(normalizedQuery)) return { ...command, priority: 0 };
      if (command.source === "prompt" && name.startsWith(normalizedQuery)) return { ...command, priority: 1 };
      if (command.source === "skill" && bareSkillName.startsWith(normalizedQuery)) return { ...command, priority: 2 };
      if (command.source === "extension" && name.includes(normalizedQuery)) return { ...command, priority: 3 };
      if (command.source === "prompt" && name.includes(normalizedQuery)) return { ...command, priority: 4 };
      if (command.source === "skill" && bareSkillName.includes(normalizedQuery)) return { ...command, priority: 5 };
      return null;
    })
    .filter((command): command is SlashCommandOption => command !== null)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.source !== b.source) {
        const order = { extension: 0, prompt: 1, skill: 2 } as const;
        return order[a.source] - order[b.source];
      }
      return a.name.localeCompare(b.name);
    });
}

function describeSlashCommand(
  command: SlashCommandEntry,
  t: (key: string) => string,
): string {
  if (command.description) return command.description;
  if (command.source === "extension") return t("chat.cmdExtension");
  if (command.source === "skill") return t("chat.cmdSkill");
  return t("chat.cmdTemplate");
}

function slashCommandSupportBadge(command: SlashCommandEntry, t: (key: string) => string): { text: string; title: string; tone: "warning" | "muted" } | null {
  if (command.source !== "extension" || !command.webSupport || command.webSupport === "full") return null;
  if (command.webSupport === "cli-only") {
    return { text: t("chat.cmdCliOnly"), title: command.webSupportReason || t("chat.cmdCliOnlyHint"), tone: "warning" };
  }
  return { text: t("chat.cmdPartial"), title: command.webSupportReason || t("chat.cmdPartialHint"), tone: "muted" };
}

function slashCommandSourceLabel(command: SlashCommandEntry): string {
  const label = command.source === "extension" ? "extension" : command.source === "skill" ? "skill" : "template";
  return `${label}${command.location ? ` · ${command.location}` : ""}`;
}

const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingAuto",
  off: "chat.thinkingOff",
  minimal: "chat.thinkingMinimal",
  low: "chat.thinkingLow",
  medium: "chat.thinkingMedium",
  high: "chat.thinkingHigh",
  xhigh: "chat.thinkingXhigh",
  max: "chat.thinkingMax",
};

function chipInsertAtCursor(container: HTMLElement, relativePath: string, lines?: { startLine: number; endLine: number }): void {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.chip = "file-ref";
  chip.dataset.relativePath = relativePath;
  if (lines) {
    chip.dataset.startLine = String(lines.startLine);
    chip.dataset.endLine = String(lines.endLine);
  }
  const displayText = `${getFileName(relativePath)}${lines ? `:${lines.startLine}-${lines.endLine}` : ""}`;
  chip.textContent = displayText;
  chip.className = "chat-input-inline-file-ref";

  const wasFocused = document.activeElement === container;
  container.focus();
  const sel = window.getSelection();

  if (!wasFocused || !sel || !sel.rangeCount) {
    // Container wasn't focused (e.g. Add Chat from file viewer): append to end
    const spaceBefore = container.lastChild?.nodeType === Node.TEXT_NODE &&
      (container.lastChild.textContent ?? "").length > 0 &&
      !(container.lastChild.textContent ?? "").endsWith(" ");
    if (spaceBefore) container.appendChild(document.createTextNode(" "));
    container.appendChild(chip);
    container.appendChild(document.createTextNode(" "));
    // Move cursor after the newly appended content
    const r = document.createRange();
    r.selectNodeContents(container);
    r.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(r);
  } else {
    // Already had focus: insert at current cursor position
    const range = sel.getRangeAt(0);

    // If the cursor is on a text node, check for a space separator before inserting
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const beforeText = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
      if (beforeText.length > 0 && !beforeText.endsWith(" ")) {
        const space = document.createTextNode(" ");
        range.insertNode(space);
        range.setStartAfter(space);
        range.collapse(true);
      }
    }

    range.deleteContents();
    range.insertNode(chip);
    range.setStartAfter(chip);
    range.collapse(true);

    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function getTextBeforeCursor(container: Node): string {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let text = "";
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    if (node === range.startContainer) {
      text += (node.textContent ?? "").slice(0, range.startOffset);
      break;
    }
    text += node.textContent ?? "";
  }
  return text;
}

function serializeNodes(nodes: NodeListOf<ChildNode>): string {
  let text = "";
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement && node.dataset.chip === "file-ref") {
      const path = node.dataset.relativePath ?? "";
      const start = node.dataset.startLine;
      const end = node.dataset.endLine;
      if (start && end) {
        text += `\`${path} [line ${start}-${end}]\``;
      } else {
        text += `\`${path}\``;
      }
    } else if (node instanceof HTMLElement) {
      text += serializeNodes(node.childNodes);
    }
  }
  return text;
}

function hasContent(el: HTMLElement): boolean {
  const text = el.textContent ?? "";
  if (text.trim().length > 0) return true;
  return el.querySelector('[data-chip]') !== null;
}

function formatRetryReason(errorMessage: string | undefined, t: (key: string) => string): string | undefined {
  if (!errorMessage) return undefined;
  const classified = classifyChatProviderError(errorMessage);
  return localizeError(t, {
    code: classified.code,
    message: classified.englishSummary,
    fallback: classified.technicalDetails,
  });
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, cwd, onAbort, onSteer, onFollowUp, isStreaming, model, modelNames, modelList, modelsReady, onModelChange,
  onOpenModels,
  onCompact, onAbortCompaction, isCompacting, compactError, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  soundEnabled, onSoundToggle,
  notificationState, onNotificationToggle,
  autoScrollEnabled, onAutoScrollToggle,
  browserSessionId, browserSessionLabel,
  draftScope,
  writeLocked = false,
}: Props, ref) {
  const { t } = useI18n();
  const retryReason = formatRetryReason(retryInfo?.errorMessage, t);
  const [slashCommands, setSlashCommands] = useState<SlashCommandEntry[]>([]);

  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [slashCommandsError, setSlashCommandsError] = useState<string | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashDismissedKey, setSlashDismissedKey] = useState<string | null>(null);
  const [atSuggestions, setAtSuggestions] = useState<FileSuggestion[]>([]);
  const [atSuggestionsLoading, setAtSuggestionsLoading] = useState(false);
  const [atSuggestionsError, setAtSuggestionsError] = useState<string | null>(null);
  const [atSelectedIndex, setAtSelectedIndex] = useState(0);
  const [atDismissedKey, setAtDismissedKey] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelAllSubmenuOpen, setModelAllSubmenuOpen] = useState(false);
  const [modelAllSubmenuPos, setModelAllSubmenuPos] = useState<{ left: number; bottom: number; maxHeight: number; minWidth: number } | null>(null);
  const [modelDropdownRect, setModelDropdownRect] = useState<DropdownAnchorRect | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [toolDropdownRect, setToolDropdownRect] = useState<DropdownAnchorRect | null>(null);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [thinkingDropdownRect, setThinkingDropdownRect] = useState<DropdownAnchorRect | null>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);
  const [gitBranch, setGitBranch] = useState<GitBranchDisplay | null>(null);

  const inputRef = useRef<HTMLDivElement>(null);
  const slashSelectedItemRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const modelAllTriggerRef = useRef<HTMLButtonElement>(null);
  const modelAllSubmenuRef = useRef<HTMLDivElement>(null);
  const modelAllCloseTimerRef = useRef<number | null>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const toolDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownPanelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  // DOM-based: text before cursor, synced on every input/selection change
  const [beforeCursorText, setBeforeCursorText] = useState("");
  const [hasEditorContent, setHasEditorContent] = useState(false);
  const [editorDraftText, setEditorDraftText] = useState("");
  const hydratedDraftScopeRef = useRef<string | null>(null);

  const syncFromDom = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const beforeText = getTextBeforeCursor(el);
    setBeforeCursorText(beforeText);
    setHasEditorContent(hasContent(el));
    setEditorDraftText(serializeNodes(el.childNodes));
  }, []);

  const slashMatch = useMemo(() => getSlashCommandMatch(beforeCursorText, beforeCursorText.length), [beforeCursorText]);
  const slashMatchKey = slashMatch ? `${slashMatch.start}:${slashMatch.query}` : null;
  const filteredSlashCommands = useMemo(() => {
    if (!slashMatch) return [];
    return filterSlashCommands(slashCommands, slashMatch.query);
  }, [slashCommands, slashMatch]);
  const slashMenuVisible = Boolean(
    slashMatch &&
    slashMatchKey !== slashDismissedKey &&
    (filteredSlashCommands.length > 0 || slashCommandsLoading || slashCommandsError)
  );

  const atMatch = useMemo(() => getAtMatch(beforeCursorText, beforeCursorText.length), [beforeCursorText]);
  const atMatchKey = atMatch ? `${atMatch.start}:${atMatch.query}` : null;
  const atMenuVisible = Boolean(
    atMatch &&
    atMatchKey !== atDismissedKey &&
    cwd &&
    (atSuggestions.length > 0 || atSuggestionsLoading || atSuggestionsError)
  );

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [slashMatch?.query, filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuVisible) return;
    slashSelectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [slashMenuVisible, slashSelectedIndex, slashMatch?.query]);

  useEffect(() => {
    setAtSelectedIndex(0);
  }, [atMatch?.query, atSuggestions.length]);

  useEffect(() => {
    if (!cwd) {
      setSlashCommands([]);
      setSlashCommandsLoading(false);
      setSlashCommandsError(null);
      return;
    }

    const controller = new AbortController();
    setSlashCommandsLoading(true);
    setSlashCommandsError(null);
    fetch(`/api/commands?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as { commands?: SlashCommandEntry[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setSlashCommands(data.commands ?? []);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setSlashCommands([]);
        setSlashCommandsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSlashCommandsLoading(false);
      });

    return () => controller.abort();
  }, [cwd]);

  // @-mention：当 atMatch 变化时获取文件列表
  // - 查询含 "/" → 目录浏览模式，只列当前目录内容
  // - 查询为空    → 显示根目录文件
  // - 查询无 "/"  → 递归搜索整个项目（文件名前缀匹配）
  useEffect(() => {
    if (!atMatch || !cwd) {
      setAtSuggestions([]);
      setAtSuggestionsLoading(false);
      setAtSuggestionsError(null);
      return;
    }

    setAtSuggestions([]);
    const query = atMatch.query;
    const hasSlash = query.includes("/");

    const controller = new AbortController();
    setAtSuggestionsLoading(true);
    setAtSuggestionsError(null);

    if (hasSlash) {
      // ── 目录浏览模式 ──
      const lastSlash = query.lastIndexOf("/");
      const targetDir = joinFilePath(cwd, query.slice(0, lastSlash));
      const encoded = encodeFilePathForApi(targetDir);
      fetch(`/api/files/${encoded}?type=list`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json() as { entries?: { name: string; isDir: boolean; size: number; modified: string }[] };
          if (controller.signal.aborted) return;
          const entries = (data.entries ?? []).map((e) => ({
            name: e.name,
            fullPath: joinFilePath(targetDir, e.name),
            isDir: e.isDir,
          }));
          const filtered = filterAtSuggestions(entries, query);
          setAtSuggestions(filtered);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setAtSuggestions([]);
          setAtSuggestionsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setAtSuggestionsLoading(false);
        });
    } else if (!query) {
      // ── 空查询：显示根目录文件 + 文件夹 ──
      const encoded = encodeFilePathForApi(cwd);
      fetch(`/api/files/${encoded}?type=list`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json() as { entries?: { name: string; isDir: boolean; size: number; modified: string }[] };
          if (controller.signal.aborted) return;
          const entries = (data.entries ?? []).map((e) => ({
            name: e.name,
            fullPath: joinFilePath(cwd, e.name),
            isDir: e.isDir,
          }));
          setAtSuggestions(entries);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setAtSuggestions([]);
          setAtSuggestionsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setAtSuggestionsLoading(false);
        });
    } else {
      // ── 递归搜索模式：跨目录查找文件名匹配的文件 ──
      fetch(`/api/files/search?cwd=${encodeURIComponent(cwd)}&prefix=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json() as { files: { name: string; fullPath: string; relativePath: string }[]; total: number };
          if (controller.signal.aborted) return;
          const suggestions = data.files.map((f) => ({
            name: f.relativePath,  // 显示相对路径，帮助区分同名文件
            fullPath: f.fullPath,
            isDir: false,
          }));
          setAtSuggestions(suggestions);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setAtSuggestions([]);
          setAtSuggestionsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setAtSuggestionsLoading(false);
        });
    }

    return () => controller.abort();
  }, [atMatch, cwd]);

  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const draft = readChatDraft(window.localStorage, draftScope);
    el.textContent = draft?.text ?? "";
    setAttachedFiles(draft?.files ?? []);
    setBeforeCursorText(draft?.text ?? "");
    setEditorDraftText(draft?.text ?? "");
    setHasEditorContent(hasContent(el));
    hydratedDraftScopeRef.current = draftScope;
    window.requestAnimationFrame(resizeInput);
  }, [draftScope, resizeInput]);

  useEffect(() => {
    if (hydratedDraftScopeRef.current !== draftScope) return;
    const timer = window.setTimeout(() => {
      writeChatDraft(window.localStorage, draftScope, { text: editorDraftText, files: attachedFiles });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [attachedFiles, draftScope, editorDraftText]);

  /** Insert text into the contentEditable div at the current cursor position. */
  const insertTextAtCursor = useCallback((text: string, addSpaceSep = true) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      el.appendChild(document.createTextNode(text));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      syncFromDom();
      return;
    }
    const range = sel.getRangeAt(0);
    if (addSpaceSep && range.startContainer.nodeType === Node.TEXT_NODE) {
      const beforeText = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
      if (beforeText.length > 0 && !beforeText.endsWith(" ")) {
        range.insertNode(document.createTextNode(" "));
        range.setStartAfter(range.endContainer);
        range.collapse(true);
      }
    }
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    syncFromDom();
    resizeInput();
  }, [syncFromDom, resizeInput]);

  const insertSlashCommand = useCallback((command: SlashCommandEntry) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const offset = range.startOffset;
    const slashIdx = text.lastIndexOf("/", offset - 1);
    if (slashIdx === -1) return;

    const insertion = `/${command.name} `;
    node.textContent = text.slice(0, slashIdx) + insertion + text.slice(offset);
    const newOffset = slashIdx + insertion.length;
    range.setStart(node, newOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    setSlashDismissedKey(null);
    syncFromDom();
    resizeInput();
  }, [syncFromDom, resizeInput]);

  const insertAtMention = useCallback((suggestion: FileSuggestion) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();

    if (suggestion.isDir) {
      // Navigate into directory: replace @query with @dirname/
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent ?? "";
      const offset = range.startOffset;
      const atIdx = text.lastIndexOf("@", offset - 1);
      if (atIdx === -1) return;

      const insertion = `@${suggestion.name}/`;
      node.textContent = text.slice(0, atIdx) + insertion + text.slice(offset);
      const newOffset = atIdx + insertion.length;
      range.setStart(node, newOffset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      setAtDismissedKey(null);
      syncFromDom();
      resizeInput();
      return;
    }

    // Insert as a file reference chip — first remove the @query text
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const offset = range.startOffset;
    const atIdx = text.lastIndexOf("@", offset - 1);
    if (atIdx === -1) {
      // Fallback: just insert at cursor without removing @
      const relativePath = getRelativeFilePath(suggestion.fullPath, cwd ?? undefined);
      chipInsertAtCursor(el, relativePath);
    } else {
      // Remove the @query text first, then insert chip
      node.textContent = text.slice(0, atIdx) + text.slice(offset);
      const relativePath = getRelativeFilePath(suggestion.fullPath, cwd ?? undefined);
      // Set cursor at the @ position and use chipInsertAtCursor
      range.setStart(node, atIdx);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      chipInsertAtCursor(el, relativePath);
    }
    setAtDismissedKey(null);
    syncFromDom();
    resizeInput();
  }, [syncFromDom, cwd, resizeInput]);

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const el = inputRef.current;
      if (!el) return;
      if (hasContent(el)) return;
      el.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      syncFromDom();
      resizeInput();
    },
    insertText(text: string) {
      insertTextAtCursor(text);
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    addFiles(files: File[]) {
      processFileUploads(files);
    },
    addFileReference(relativePath: string, lines?: { startLine: number; endLine: number }) {
      const el = inputRef.current;
      if (!el) return;
      chipInsertAtCursor(el, relativePath, lines);
      syncFromDom();
      resizeInput();
    },
    addWorkflowTaskContext(context: WorkflowTaskChatContext) {
      const el = inputRef.current;
      if (!el) return;
      const prompt = buildWorkflowTaskResumePrompt(context);
      // Prefer filling an empty composer; otherwise append as a new block.
      if (!hasContent(el)) {
        el.textContent = prompt;
      } else {
        const existing = el.innerText || el.textContent || "";
        el.textContent = `${existing.replace(/\s+$/, "")}\n\n${prompt}`;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      syncFromDom();
      resizeInput();
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<AttachedImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>"
              const base64 = result.split(",")[1];
              resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].previewUrl);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
  }, []);

    // ── File attachment ──

  const uploadFile = useCallback(async (file: File): Promise<AttachedFile> => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/files/upload", { method: "POST", body: formData });
    const data = await res.json().catch(() => ({})) as { name?: string; path?: string; size?: number; error?: string };
    if (!res.ok || !data.name || !data.path || typeof data.size !== "number") {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return { name: data.name, size: data.size, path: data.path };
  }, []);

  const processFileUploads = useCallback(async (files: File[]) => {
    const textFiles = files.filter((f) => !f.type.startsWith("image/"));
    if (!textFiles.length) return;
    setUploadingFiles(true);
    setFileUploadError(null);
    const results: AttachedFile[] = [];
    const failures: string[] = [];
    for (const file of textFiles) {
      try {
        results.push(await uploadFile(file));
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (results.length > 0) {
      setAttachedFiles((prev) => [...prev, ...results]);
    }
    if (failures.length > 0) setFileUploadError(failures.join("; "));
    setUploadingFiles(false);
  }, [uploadFile]);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearFiles = useCallback(() => {
    setAttachedFiles([]);
  }, []);

  /** Build the final message: serialize the contentEditable div + append attached files/images. */
  const buildFinalMessage = useCallback((): string => {
    const parts: string[] = [];

    // Content from the contentEditable div (text + inline file chips)
    const el = inputRef.current;
    if (el) {
      const inputText = serializeNodes(el.childNodes);
      if (inputText) parts.push(inputText);
    }

    // Attached files: name + size + path
    if (attachedFiles.length > 0) {
      const fileText = attachedFiles.map((f) => {
        const sizeStr = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
        return `📎 ${f.name} (${sizeStr}) — \`${f.path}\``;
      }).join("\n");
      parts.push(fileText);
    }

    return parts.join("\n\n");
  }, [attachedFiles]);

  const sendActive = useCallback((): boolean => {
    if (attachedImages.length > 0 || attachedFiles.length > 0) return true;
    const el = inputRef.current;
    if (!el) return false;
    return hasContent(el);
  }, [attachedImages, attachedFiles]);

  const clearEditor = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.textContent = "";
    el.style.height = "auto";
    setSlashDismissedKey(null);
    setAtDismissedKey(null);
    clearImages();
    clearFiles();
    setFileUploadError(null);
    clearChatDraft(window.localStorage, draftScope);
    syncFromDom();
  }, [clearImages, clearFiles, draftScope, syncFromDom]);

  const sendBlockReason = useMemo(
    () => getChatSendBlockReason({
      cwd,
      modelsReady,
      modelList,
      selectedModel: model ?? null,
    }),
    [cwd, modelsReady, modelList, model],
  );
  // writeLocked is multi-tab coordination; model readiness remains separate.
  const sendBlocked = ((sendBlockReason != null) || Boolean(writeLocked)) && !isStreaming;

  const handleSend = useCallback(() => {
    if (!sendActive()) return;
    if (isStreaming) return;
    if (sendBlocked) return;
    const finalMsg = buildFinalMessage();
    onSend(finalMsg, attachedImages.length ? attachedImages : undefined);
    clearEditor();
  }, [sendActive, isStreaming, sendBlocked, onSend, attachedImages, buildFinalMessage, clearEditor]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    if (!sendActive()) return;
    const finalMsg = buildFinalMessage();
    if (mode === "steer" && onSteer) {
      onSteer(finalMsg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(finalMsg, attachedImages.length ? attachedImages : undefined);
    }
    clearEditor();
  }, [sendActive, onSteer, onFollowUp, attachedImages, buildFinalMessage, clearEditor]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      // @-mention menu
      if (atMenuVisible && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtSelectedIndex((i) => Math.min(i + 1, Math.max(atSuggestions.length - 1, 0)));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const selected = atSuggestions[Math.min(atSelectedIndex, atSuggestions.length - 1)];
          if (selected?.isDir) {
            insertAtMention(selected);
          }
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          const selected = atSuggestions[Math.min(atSelectedIndex, atSuggestions.length - 1)];
          if (selected) {
            insertAtMention(selected);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtDismissedKey(atMatchKey);
          return;
        }
      }

      if (slashMenuVisible && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashSelectedIndex((i) => Math.min(i + 1, Math.max(filteredSlashCommands.length - 1, 0)));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          const selected = filteredSlashCommands[Math.min(slashSelectedIndex, filteredSlashCommands.length - 1)];
          if (selected) {
            insertSlashCommand(selected);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashDismissedKey(slashMatchKey);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup");
        } else if (!sendBlocked) {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, sendQueued, handleSend, sendBlocked, atMenuVisible, atSuggestions, atSelectedIndex, insertAtMention, atMatchKey, slashMenuVisible, filteredSlashCommands, slashSelectedIndex, insertSlashCommand, slashMatchKey]
  );

  const handleInput = useCallback(() => {
    syncFromDom();
    resizeInput();
  }, [syncFromDom, resizeInput]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
    }
    // Handle non-image file pastes (e.g. files copied from Finder)
    const fileItems = items.filter((item) => item.kind === "file" && !item.type.startsWith("image/"));
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processFileUploads(files);
    }
  }, [processImageFiles, processFileUploads]);



  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = useMemo(() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({
        provider: m.provider,
        modelId: m.id,
        name: m.name,
        primaryCandidate: m.primaryCandidate === true,
      }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  }, [modelList, modelNames, model?.provider]);

  const { hasPrimaryCandidates, defaultOptions: defaultModelOptions } = useMemo(
    () => buildDefaultModelPickerOptions(modelOptions, model ?? null),
    [modelOptions, model],
  );

  // Favorites stay in the primary panel; full list opens as a flyout from the top "All" row.
  const primaryModelsByProvider = useMemo(
    () => groupModelOptionsByProvider(hasPrimaryCandidates ? defaultModelOptions : modelOptions),
    [hasPrimaryCandidates, defaultModelOptions, modelOptions],
  );
  const allModelsByProvider = useMemo(
    () => groupModelOptionsByProvider(modelOptions),
    [modelOptions],
  );

  const currentModelOption = model
    ? modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)
    : modelOptions[0];
  const currentModelLabel = currentModelOption
    ? `${currentModelOption.provider}/${currentModelOption.name}`
    : model ? `${model.provider}/${model.modelId}` : null;

  const clearModelAllCloseTimer = useCallback(() => {
    if (modelAllCloseTimerRef.current !== null) {
      window.clearTimeout(modelAllCloseTimerRef.current);
      modelAllCloseTimerRef.current = null;
    }
  }, []);

  const closeModelAllSubmenu = useCallback(() => {
    clearModelAllCloseTimer();
    setModelAllSubmenuOpen(false);
    setModelAllSubmenuPos(null);
  }, [clearModelAllCloseTimer]);

  const positionModelAllSubmenu = useCallback(() => {
    const mainPanel = modelDropdownPanelRef.current;
    if (!mainPanel) return null;
    const mainRect = mainPanel.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportWidth = window.innerWidth;
    const gap = 4;
    const minWidth = Math.max(mainRect.width, 180);
    const spaceRight = viewportWidth - mainRect.right - 8;
    const openOnRight = spaceRight >= Math.min(minWidth, 160);
    const left = openOnRight
      ? Math.min(mainRect.right + gap, viewportWidth - minWidth - 8)
      : Math.max(8, mainRect.left - minWidth - gap);
    return {
      left,
      bottom: Math.max(8, viewportHeight - mainRect.bottom),
      maxHeight: Math.max(120, Math.min(mainRect.height || 240, viewportHeight * 0.6)),
      minWidth,
    };
  }, []);

  const openModelAllSubmenu = useCallback(() => {
    clearModelAllCloseTimer();
    const pos = positionModelAllSubmenu();
    if (!pos) return;
    setModelAllSubmenuPos(pos);
    setModelAllSubmenuOpen(true);
  }, [clearModelAllCloseTimer, positionModelAllSubmenu]);

  const scheduleCloseModelAllSubmenu = useCallback(() => {
    clearModelAllCloseTimer();
    modelAllCloseTimerRef.current = window.setTimeout(() => {
      setModelAllSubmenuOpen(false);
      setModelAllSubmenuPos(null);
      modelAllCloseTimerRef.current = null;
    }, 140);
  }, [clearModelAllCloseTimer]);

  useEffect(() => {
    if (!modelDropdownOpen) closeModelAllSubmenu();
  }, [modelDropdownOpen, closeModelAllSubmenu]);

  useEffect(() => () => clearModelAllCloseTimer(), [clearModelAllCloseTimer]);
  const gitBranchInfo = gitBranch;
  const gitBranchLabel = gitBranchInfo?.isDetached ? "detached" : gitBranchInfo?.branch ?? null;
  const gitBranchTitle = gitBranchInfo && gitBranchLabel
    ? `${gitBranchInfo.isWorktree ? "Worktree branch" : "Git branch"}: ${gitBranchLabel}${gitBranchInfo.isDirty ? " (dirty)" : ""}`
    : undefined;

  useEffect(() => {
    if (!cwd) {
      setGitBranch(null);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as { status?: GitStatusInfo | null };
        if (!res.ok || !data.status) {
          setGitBranch(null);
          return;
        }
        const { branch, isDetached, isDirty, isWorktree } = data.status;
        setGitBranch({ branch, isDetached, isDirty, isWorktree });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setGitBranch(null);
      });

    return () => controller.abort();
  }, [cwd]);

  const handleDropdownOptionKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const panel = event.currentTarget.closest(".chat-input-dropdown-panel");
    if (!panel) return;
    const options = Array.from(panel.querySelectorAll<HTMLButtonElement>(".chat-input-dropdown-option:not(:disabled)"));
    const currentIndex = options.indexOf(event.currentTarget);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % options.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    options[nextIndex]?.focus();
  }, []);

  useEffect(() => {
    const panel = modelDropdownOpen
      ? modelDropdownPanelRef.current
      : thinkingDropdownOpen
        ? thinkingDropdownPanelRef.current
        : toolDropdownOpen
          ? toolDropdownPanelRef.current
          : null;
    if (!panel) return;
    const frame = window.requestAnimationFrame(() => {
      // Prefer real model options over the top "All" flyout trigger so opening the picker
      // does not auto-expand the full-model submenu.
      const activeOption = panel.querySelector<HTMLButtonElement>(
        ".chat-input-dropdown-option.is-active:not(.chat-input-model-all-trigger)",
      );
      const firstOption = panel.querySelector<HTMLButtonElement>(
        ".chat-input-dropdown-option:not(.chat-input-model-all-trigger)",
      ) ?? panel.querySelector<HTMLButtonElement>(".chat-input-dropdown-option");
      (activeOption ?? firstOption)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [modelDropdownOpen, thinkingDropdownOpen, toolDropdownOpen]);

  // Body-portaled dropdowns close on outside pointer/focus and return focus on Escape.
  useEffect(() => {
    const closeOutside = (target: Node) => {
      const insideModelDropdown = Boolean(
        dropdownRef.current?.contains(target)
        || modelDropdownPanelRef.current?.contains(target)
        || modelAllSubmenuRef.current?.contains(target),
      );
      const insideToolDropdown = Boolean(toolDropdownRef.current?.contains(target) || toolDropdownPanelRef.current?.contains(target));
      const insideThinkingDropdown = Boolean(thinkingDropdownRef.current?.contains(target) || thinkingDropdownPanelRef.current?.contains(target));

      if (!insideModelDropdown) setModelDropdownOpen(false);
      if (!insideToolDropdown) setToolDropdownOpen(false);
      if (!insideThinkingDropdown) setThinkingDropdownOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => closeOutside(event.target as Node);
    const handleFocusIn = (event: FocusEvent) => closeOutside(event.target as Node);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as Node;
      const insideModelAllSubmenu = Boolean(modelAllSubmenuRef.current?.contains(target));
      const modelOpen = Boolean(
        dropdownRef.current?.contains(target)
        || modelDropdownPanelRef.current?.contains(target)
        || insideModelAllSubmenu,
      );
      const thinkingOpen = Boolean(thinkingDropdownRef.current?.contains(target) || thinkingDropdownPanelRef.current?.contains(target));
      const toolOpen = Boolean(toolDropdownRef.current?.contains(target) || toolDropdownPanelRef.current?.contains(target));
      if (!modelOpen && !thinkingOpen && !toolOpen) return;
      event.preventDefault();
      if (modelOpen) {
        // Collapse the All flyout first; a second Escape closes the whole picker.
        if (modelAllSubmenuOpen || insideModelAllSubmenu) {
          closeModelAllSubmenu();
          window.requestAnimationFrame(() => modelAllTriggerRef.current?.focus());
        } else {
          setModelDropdownOpen(false);
          window.requestAnimationFrame(() => dropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
        }
      }
      if (thinkingOpen) {
        setThinkingDropdownOpen(false);
        window.requestAnimationFrame(() => thinkingDropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
      }
      if (toolOpen) {
        setToolDropdownOpen(false);
        window.requestAnimationFrame(() => toolDropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelAllSubmenuOpen, closeModelAllSubmenu]);

  const hasPendingMessage = hasEditorContent || attachedImages.length > 0 || attachedFiles.length > 0;
  const canSendNow = hasPendingMessage && !sendBlocked;

  return (
    <div className="chat-input-shell">
      {sendBlocked && (writeLocked || sendBlockReason) && (
        <div className="chat-input-send-block" role="status">
          <span className="chat-input-send-block-message">
            {writeLocked
              ? t("chat.multiTabWriteLocked")
              : t(chatSendBlockMessageKey(sendBlockReason!))}
          </span>
          {!writeLocked && onOpenModels && sendBlockReason && chatSendBlockOffersModelsFix(sendBlockReason) && (
            <button
              type="button"
              className="chat-input-send-block-action"
              onClick={onOpenModels}
            >
              {t("chat.sendBlockedFixModels")}
            </button>
          )}
        </div>
      )}
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="chat-input-hidden-file"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />
      <input
        ref={filePickerRef}
        type="file"
        multiple
        className="chat-input-hidden-file"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processFileUploads(files);
          e.target.value = "";
        }}
      />
      <div className="chat-input-inner">
        {/* Retry banner */}
        {retryInfo && (
          <div className="chat-input-retry-notice">
            <svg className="chat-input-flex-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            {retryReason
              ? t("chat.retryingWithReason", {
                  reason: retryReason,
                  attempt: retryInfo.attempt,
                  max: retryInfo.maxAttempts,
                })
              : t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}
          </div>
        )}
        {fileUploadError && (
          <div className="chat-input-retry-notice" role="alert">
            <span>{t("chat.uploadFailed", { details: fileUploadError })}</span>
            <button
              type="button"
              className="chat-input-attachment-remove"
              onClick={() => setFileUploadError(null)}
              aria-label={t("chat.dismissUploadError")}
            >
              ×
            </button>
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div className="chat-input-attachments">
            {attachedImages.map((img, i) => (
              <div key={i} className="chat-input-image-attachment">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  className="chat-input-image-preview"
                />
                <button
                  className="chat-input-attachment-remove chat-input-image-remove"
                  onClick={() => removeImage(i)}
                  aria-label={t("chat.removeAttachment")}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* File chips */}
        {attachedFiles.length > 0 && (
          <div className="chat-input-attachments">
            {attachedFiles.map((f, i) => (
              <div
                key={i}
                className="chat-input-file-attachment"
              >
                {/* Unified file icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
                <span className="chat-input-file-name">
                  {f.name}
                </span>
                <span className="chat-input-file-size">
                  {f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                </span>
                <button
                  className="chat-input-attachment-remove"
                  onClick={() => removeFile(i)}
                  aria-label={t("chat.removeAttachment")}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div className={isStreaming && (onSteer || onFollowUp) ? "chat-input-main-row is-streaming-action" : "chat-input-main-row"}>
          {slashMenuVisible && slashMatch && (
            <div className="chat-input-suggestion-menu">
              <div className="chat-input-suggestion-header">{t("chat.slashCommandsHint")}</div>
              {slashCommandsLoading ? (
                <div className="chat-input-suggestion-state">{t("chat.loadingCommands")}</div>
              ) : slashCommandsError ? (
                <div className="chat-input-suggestion-state is-error">{t("chat.commandsLoadFailed")}: {slashCommandsError}</div>
              ) : filteredSlashCommands.length === 0 ? (
                <div className="chat-input-suggestion-state">{t("chat.noCommands")}</div>
              ) : (
                <div className="chat-input-suggestion-list">
                  {filteredSlashCommands.map((command, index) => {
                    const selected = index === slashSelectedIndex;
                    const sourceLabel = slashCommandSourceLabel(command);
                    const supportBadge = slashCommandSupportBadge(command, t);
                    const cliOnly = command.webSupport === "cli-only";
                    return (
                      <button
                        ref={selected ? slashSelectedItemRef : undefined}
                        key={`${command.source}:${command.name}:${command.path ?? ""}`}
                        type="button"
                        title={supportBadge?.title}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          insertSlashCommand(command);
                        }}
                        onMouseEnter={() => setSlashSelectedIndex(index)}
                        className={[
                          "chat-input-suggestion-option",
                          selected ? "is-selected" : "",
                          cliOnly ? "is-disabled-capability" : "",
                        ].filter(Boolean).join(" ")}
                      >
                        <span
                          title={`/${command.name}`}
                          className={cliOnly ? "chat-input-command-name is-muted" : "chat-input-command-name"}
                        >
                          /{command.name}
                        </span>
                        <span className="chat-input-command-details">
                          <span className="chat-input-command-description">
                            {command.argumentHint && (
                              <span className="chat-input-command-argument">{command.argumentHint}</span>
                            )}
                            {describeSlashCommand(command, t)}
                          </span>
                          <span className="chat-input-command-meta">
                            <span
                              title={sourceLabel}
                              className="chat-input-command-source"
                            >
                              {sourceLabel}
                            </span>
                            {supportBadge && (
                              <span
                                title={supportBadge.title}
                                className={`chat-input-support-badge is-${supportBadge.tone}`}
                              >
                                {supportBadge.text}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {atMenuVisible && atMatch && (
            <div className="chat-input-suggestion-menu chat-input-file-suggestion-menu">
              <div className="chat-input-suggestion-header">{t("chat.filesHint")}</div>
              {atSuggestionsLoading ? (
                <div className="chat-input-suggestion-state">{t("chat.loadingFiles")}</div>
              ) : atSuggestionsError ? (
                <div className="chat-input-suggestion-state is-error">{t("chat.filesLoadFailed")}: {atSuggestionsError}</div>
              ) : atSuggestions.length === 0 ? (
                <div className="chat-input-suggestion-state">{t("chat.noFiles")}</div>
              ) : (
                atSuggestions.map((suggestion, index) => {
                  const selected = index === atSelectedIndex;
                  return (
                    <button
                      key={suggestion.fullPath}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertAtMention(suggestion);
                      }}
                      onMouseEnter={() => setAtSelectedIndex(index)}
                      className={selected ? "chat-input-suggestion-option chat-input-file-option is-selected" : "chat-input-suggestion-option chat-input-file-option"}
                    >
                      {suggestion.isDir ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                          <polyline points="13 2 13 9 20 9" />
                        </svg>
                      )}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                        {suggestion.name}
                      </span>
                      {suggestion.isDir && (
                        <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                          dir
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}

          <div
            ref={inputRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onKeyUp={syncFromDom}
            onMouseUp={syncFromDom}
            onPaste={handlePaste}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
            }}
            className="ce-input chat-input-editor"
            data-placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("chat.placeholderSteer")
                : isStreaming
                  ? t("chat.placeholderRunning")
                  : t("chat.placeholder")
            }

          />

          {isStreaming ? (
            <div className="chat-input-send-row">
              {onSteer && (
                <button
                  onClick={() => sendQueued("steer")}
                  disabled={!hasPendingMessage}
                  title={t("chat.steerTitle")}
                  className="chat-input-action-button is-steer"
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  {t("chat.steer")}
                </button>
              )}
              {onFollowUp && (
                <button
                  onClick={() => sendQueued("followup")}
                  disabled={!hasPendingMessage}
                  title={t("chat.followUpTitle")}
                  className="chat-input-action-button is-followup"
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                  {t("chat.followUp")}
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSendNow}
              title={sendBlocked && sendBlockReason ? t(chatSendBlockMessageKey(sendBlockReason)) : undefined}
              className="chat-input-action-button is-send"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {t("chat.send")}
            </button>
          )}
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div className="chat-input-controls">

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div className="chat-input-control-group chat-input-control-group-left">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              title={t("chat.attachImage")}
              aria-label={t("chat.attachImage")}
              className={attachedImages.length ? "chat-input-icon-button is-active" : "chat-input-icon-button"}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            <button
              onClick={() => filePickerRef.current?.click()}
              disabled={isStreaming || uploadingFiles}
              title={uploadingFiles ? t("chat.uploading") : t("chat.attachFile")}
              aria-label={uploadingFiles ? t("chat.uploading") : t("chat.attachFile")}
              className={attachedFiles.length ? "chat-input-icon-button is-active" : "chat-input-icon-button"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
            </button>
            <BrowserBindingTrigger
              sessionId={browserSessionId ?? null}
              sessionLabel={browserSessionLabel}
            />
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentModelLabel && onModelChange && (
                <div ref={dropdownRef} className="chat-input-control-anchor">
                  <button
                    onPointerDown={(e) => {
                      if (isStreaming) return;
                      e.preventDefault();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    onKeyDown={(e) => {
                      if (isStreaming || (e.key !== "Enter" && e.key !== " ")) return;
                      e.preventDefault();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    className={modelDropdownOpen ? "chat-input-control-button chat-input-model-button is-open" : "chat-input-control-button chat-input-model-button"}
                    aria-expanded={modelDropdownOpen}
                    aria-haspopup="listbox"
                    aria-controls={MODEL_DROPDOWN_ID}
                    aria-label={t("chat.model")}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                    <span className="chat-input-control-label">{currentModelLabel}</span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && typeof document !== "undefined" && (() => {
                    const { bottom, maxHeight } = getDropdownPanelMetrics(modelDropdownRect);
                    const selectModel = (opt: ModelOption, isActive: boolean) => {
                      closeModelAllSubmenu();
                      setModelDropdownOpen(false);
                      if (!isActive) onModelChange(opt.provider, opt.modelId);
                      window.requestAnimationFrame(() => dropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
                    };
                    const handleSubmenuOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        closeModelAllSubmenu();
                        window.requestAnimationFrame(() => modelAllTriggerRef.current?.focus());
                        return;
                      }
                      handleDropdownOptionKeyDown(event);
                    };
                    const renderModelOption = (
                      opt: ModelOption,
                      keyPrefix = "",
                      onOptionKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void = handleDropdownOptionKeyDown,
                    ) => {
                      const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                      return (
                        <button
                          key={`${keyPrefix}${opt.provider}:${opt.modelId}`}
                          role="option"
                          aria-selected={isActive}
                          onKeyDown={onOptionKeyDown}
                          onClick={() => selectModel(opt, isActive)}
                          className={isActive ? "chat-input-dropdown-option is-active" : "chat-input-dropdown-option"}
                        >
                          {isActive
                            ? <svg className="chat-input-option-check" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span className="chat-input-option-check-placeholder" />}
                          <span className="chat-input-model-option-label">
                            <span className="chat-input-model-option-name">{opt.name}</span>
                            {opt.primaryCandidate ? (
                              <span className="chat-input-model-option-star" aria-hidden="true">★</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    };
                    const renderGroupedModels = (
                      groups: { provider: string; options: ModelOption[] }[],
                      keyPrefix = "",
                      onOptionKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void,
                    ) => groups.map((group, gi) => (
                      <div key={`${keyPrefix}${group.provider}`}>
                        {(groups.length > 1) && (
                          <div className={gi > 0 ? "chat-input-dropdown-group has-divider" : "chat-input-dropdown-group"}>
                            {group.provider}
                          </div>
                        )}
                        {group.options.map((opt) => renderModelOption(opt, keyPrefix, onOptionKeyDown))}
                      </div>
                    ));
                    const handleAllTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
                      if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openModelAllSubmenu();
                        window.requestAnimationFrame(() => {
                          modelAllSubmenuRef.current
                            ?.querySelector<HTMLButtonElement>(".chat-input-dropdown-option")
                            ?.focus({ preventScroll: true });
                        });
                        return;
                      }
                      if (event.key === "ArrowLeft" && modelAllSubmenuOpen) {
                        event.preventDefault();
                        closeModelAllSubmenu();
                        return;
                      }
                      handleDropdownOptionKeyDown(event);
                    };
                    return createPortal((
                    <>
                    <div
                      ref={modelDropdownPanelRef}
                      id={MODEL_DROPDOWN_ID}
                      className="chat-input-dropdown-panel"
                      role="listbox"
                      aria-label={t("chat.model")}
                      style={{
                        position: "fixed",
                        bottom, left: modelDropdownRect.left,
                        width: "max-content", minWidth: modelDropdownRect.width, maxHeight,
                      }}
                    >
                      {hasPrimaryCandidates && (
                        <div
                          className="chat-input-model-all-slot is-top"
                          onMouseEnter={openModelAllSubmenu}
                          onMouseLeave={scheduleCloseModelAllSubmenu}
                        >
                          <button
                            ref={modelAllTriggerRef}
                            type="button"
                            className={modelAllSubmenuOpen
                              ? "chat-input-dropdown-option chat-input-model-all-trigger is-open"
                              : "chat-input-dropdown-option chat-input-model-all-trigger"}
                            aria-label={t("chat.modelAll")}
                            aria-haspopup="menu"
                            aria-expanded={modelAllSubmenuOpen}
                            onFocus={openModelAllSubmenu}
                            onKeyDown={handleAllTriggerKeyDown}
                            onClick={openModelAllSubmenu}
                          >
                            <span className="chat-input-option-check-placeholder" aria-hidden="true" />
                            <span className="chat-input-model-all-label">{t("chat.modelAll")}</span>
                            <span className="chat-input-model-all-chevron" aria-hidden="true">›</span>
                          </button>
                        </div>
                      )}
                      <div onMouseEnter={closeModelAllSubmenu}>
                        {renderGroupedModels(primaryModelsByProvider, hasPrimaryCandidates ? "primary:" : "")}
                      </div>
                    </div>
                    {hasPrimaryCandidates && modelAllSubmenuOpen && modelAllSubmenuPos && (
                      <div
                        ref={modelAllSubmenuRef}
                        className="chat-input-dropdown-panel chat-input-model-all-submenu"
                        role="menu"
                        aria-label={t("chat.modelAll")}
                        style={{
                          position: "fixed",
                          left: modelAllSubmenuPos.left,
                          bottom: modelAllSubmenuPos.bottom,
                          width: "max-content",
                          minWidth: modelAllSubmenuPos.minWidth,
                          maxHeight: modelAllSubmenuPos.maxHeight,
                        }}
                        onMouseEnter={openModelAllSubmenu}
                        onMouseLeave={scheduleCloseModelAllSubmenu}
                      >
                        {renderGroupedModels(allModelsByProvider, "all:", handleSubmenuOptionKeyDown)}
                      </div>
                    )}
                    </>
                    ), document.body);
                  })()}
                </div>
            )}
            {gitBranchInfo && gitBranchLabel && (
              <div className="chat-input-branch" title={gitBranchTitle} aria-label={gitBranchTitle}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span className="chat-input-control-label">{gitBranchLabel}</span>
                {gitBranchInfo.isDirty && <span className="chat-input-branch-dirty">*</span>}
              </div>
            )}
          </div>

          {/* spacer */}
          <div className="chat-input-control-spacer" />

          {/* RIGHT: thinking + tools preset + compact + scroll/sound toggles (idle) | Stop + toggles (streaming) */}
          <div className="chat-input-control-group chat-input-control-group-right">
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} className="chat-input-control-anchor">
                <button
                  onPointerDown={(e) => {
                    if (isStreaming) return;
                    e.preventDefault();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setThinkingDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setThinkingDropdownOpen((v) => !v);
                  }}
                  onKeyDown={(e) => {
                    if (isStreaming || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setThinkingDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setThinkingDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  title={t("chat.thinkingTitle")}
                  className={thinkingDropdownOpen ? "chat-input-control-button is-open" : "chat-input-control-button"}
                  aria-expanded={thinkingDropdownOpen}
                  aria-haspopup="listbox"
                  aria-controls={THINKING_DROPDOWN_ID}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span>{(() => {
                    const lvl = thinkingLevel ?? "auto";
                    if (lvl === "auto" || !thinkingLevelMap) return lvl;
                    const mapped = thinkingLevelMap[lvl];
                    return mapped != null ? mapped : lvl;
                  })()}</span>
                </button>
                {thinkingDropdownOpen && thinkingDropdownRect && typeof document !== "undefined" && (() => {
                  const { bottom, right, maxHeight } = getDropdownPanelMetrics(thinkingDropdownRect);
                  return createPortal((
                  <div ref={thinkingDropdownPanelRef} id={THINKING_DROPDOWN_ID} className="chat-input-dropdown-panel" role="listbox" aria-label={t("chat.thinkingTitle")} style={{
                    position: "fixed", bottom, right,
                    minWidth: 180, maxHeight,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          role="option"
                          aria-selected={isActive}
                          onKeyDown={handleDropdownOptionKeyDown}
                          onClick={() => {
                            setThinkingDropdownOpen(false);
                            if (!isActive) onThinkingLevelChange(lvl);
                            window.requestAnimationFrame(() => thinkingDropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
                          }}
                          className={isActive ? "chat-input-dropdown-option is-active" : "chat-input-dropdown-option"}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                  ), document.body);
                })()}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} className="chat-input-control-anchor">
                <button
                  onPointerDown={(e) => {
                    if (isStreaming) return;
                    e.preventDefault();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setToolDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setToolDropdownOpen((v) => !v);
                  }}
                  onKeyDown={(e) => {
                    if (isStreaming || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setToolDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setToolDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  title={t("chat.toolsTitle")}
                  className={toolDropdownOpen ? "chat-input-control-button is-open" : "chat-input-control-button"}
                  aria-expanded={toolDropdownOpen}
                  aria-haspopup="listbox"
                  aria-controls={TOOL_DROPDOWN_ID}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span>{t(TOOL_PRESET_LABEL_KEYS[toolPreset ?? "all"])}</span>
                </button>
                {toolDropdownOpen && toolDropdownRect && typeof document !== "undefined" && (() => {
                  const { bottom, right, maxHeight } = getDropdownPanelMetrics(toolDropdownRect);
                  return createPortal((
                  <div ref={toolDropdownPanelRef} id={TOOL_DROPDOWN_ID} className="chat-input-dropdown-panel" role="listbox" aria-label={t("chat.toolsTitle")} style={{
                    position: "fixed", bottom, right,
                    minWidth: 220, maxHeight,
                  }}>
                    {TOOL_PRESET_OPTIONS.map((option) => {
                      const isActive = (toolPreset ?? "all") === option.preset;
                      return (
                        <button
                          key={option.preset}
                          role="option"
                          aria-selected={isActive}
                          onKeyDown={handleDropdownOptionKeyDown}
                          onClick={() => {
                            setToolDropdownOpen(false);
                            if (!isActive) onToolPresetChange(option.preset);
                            window.requestAnimationFrame(() => toolDropdownRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
                          }}
                          className={isActive ? "chat-input-dropdown-option is-active" : "chat-input-dropdown-option"}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{t(option.labelKey)}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{t(option.descKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                  ), document.body);
                })()}
              </div>
            )}

            {!isStreaming && onCompact && (
              <div className="chat-input-control-anchor">
                {compactError && <div className="chat-input-compact-error">{compactError}</div>}
                <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  className={isCompacting ? "chat-input-control-button is-danger" : "chat-input-control-button"}
                  title={isCompacting ? t("chat.stopCompact") : t("chat.compact")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>{t("chat.compacting")}</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>{t("chat.compact")}</>
                  )}
                </button>
              </div>
            )}

            {isStreaming && (
              <button
                onClick={onAbort}
                title={t("chat.stopAgent")}
                className="chat-input-control-button chat-input-stop-button is-danger"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                {t("chat.stopAgent")}
              </button>
            )}

            {onAutoScrollToggle !== undefined && (
              <button
                onClick={onAutoScrollToggle}
                title={autoScrollEnabled ? t("chat.autoScrollOff") : t("chat.autoScrollOn")}
                aria-label={autoScrollEnabled ? t("chat.autoScrollOff") : t("chat.autoScrollOn")}
                className={autoScrollEnabled ? "chat-input-icon-button" : "chat-input-icon-button is-muted"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v14" />
                  <path d="m6 11 6 6 6-6" />
                  <path d="M5 21h14" />
                  {!autoScrollEnabled && <line x1="4" y1="4" x2="20" y2="20" />}
                </svg>
              </button>
            )}

            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                title={soundEnabled ? t("chat.soundOff") : t("chat.soundOn")}
                aria-label={soundEnabled ? t("chat.soundOff") : t("chat.soundOn")}
                className={soundEnabled ? "chat-input-icon-button" : "chat-input-icon-button is-muted"}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}

            {onNotificationToggle !== undefined && notificationState && (
              <button
                type="button"
                onClick={() => { void onNotificationToggle(); }}
                disabled={notificationState === "unsupported"}
                title={t(`chat.notificationState.${notificationState}`)}
                aria-label={t(`chat.notificationState.${notificationState}`)}
                className={notificationState === "enabled" ? "chat-input-icon-button" : "chat-input-icon-button is-muted"}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  {notificationState !== "enabled" && <line x1="4" y1="4" x2="20" y2="20" />}
                </svg>
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
});
