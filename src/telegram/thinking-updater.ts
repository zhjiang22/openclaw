import type { Bot } from "grammy";
import { logVerbose } from "../globals.js";

export type ThinkingCompletionMode = "delete" | "summary" | "keep";

export type ThinkingConfig = {
  enabled?: boolean;
  mode?: "stream" | "off";
  updateInterval?: number;
  maxLength?: number;
  completionMode?: ThinkingCompletionMode;
};

export type ToolDisplayConfig = {
  enabled?: boolean;
  mode?: "inline" | "separate";
  showArgs?: boolean;
  maxArgsLength?: number;
};

type ToolEntry = {
  name: string;
  args?: Record<string, unknown>;
  startedAt: number;
};

type CompletedToolEntry = ToolEntry & {
  failed: boolean;
  duration: number;
};

const TOOL_ARG_EXTRACTORS: Record<string, string[]> = {
  read: ["path"],
  write: ["path"],
  edit: ["file_path"],
  exec: ["command"],
  bash: ["command"],
  search: ["pattern", "query"],
  grep: ["pattern"],
  glob: ["pattern"],
  web_search: ["query"],
  web_fetch: ["url"],
  list_directory: ["path"],
};

function extractToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  maxLen: number,
): string {
  if (!args) return "";
  const keys = TOOL_ARG_EXTRACTORS[name.toLowerCase()];
  if (keys) {
    for (const key of keys) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) {
        const trimmed = val.trim();
        return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
      }
    }
  }
  // Fallback: first string arg
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.trim()) {
      const trimmed = val.trim();
      return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
    }
  }
  return "";
}

function buildMessage(
  thinkingText: string | undefined,
  activeTools: Map<string, ToolEntry>,
  completedTools: CompletedToolEntry[],
  toolDisplay: ToolDisplayConfig,
  maxLength: number,
): string {
  const parts: string[] = [];

  if (thinkingText) {
    parts.push("🧠 <b>Thinking</b>");
    parts.push("");
    const trimmed =
      thinkingText.length > maxLength - 200
        ? "…" + thinkingText.slice(-(maxLength - 200))
        : thinkingText;
    parts.push(`<blockquote>${escapeHtml(trimmed)}</blockquote>`);
  }

  if (toolDisplay.enabled !== false && (activeTools.size > 0 || completedTools.length > 0)) {
    if (parts.length > 0) parts.push("");

    for (const completed of completedTools.slice(-10)) {
      const icon = completed.failed ? "❌" : "✅";
      const argStr =
        toolDisplay.showArgs !== false
          ? extractToolArgs(completed.name, completed.args, toolDisplay.maxArgsLength ?? 150)
          : "";
      const line = argStr
        ? `${icon} <code>${escapeHtml(completed.name)}</code> ${escapeHtml(argStr)}`
        : `${icon} <code>${escapeHtml(completed.name)}</code>`;
      parts.push(line);
    }

    for (const [, entry] of activeTools) {
      const argStr =
        toolDisplay.showArgs !== false
          ? extractToolArgs(entry.name, entry.args, toolDisplay.maxArgsLength ?? 150)
          : "";
      const line = argStr
        ? `⏳ <code>${escapeHtml(entry.name)}</code> ${escapeHtml(argStr)}`
        : `⏳ <code>${escapeHtml(entry.name)}</code>`;
      parts.push(line);
    }
  }

  if (parts.length === 0) {
    parts.push("🧠 <b>Thinking…</b>");
  }

  const result = parts.join("\n");
  return result.length > 4096 ? result.slice(0, 4093) + "…" : result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type ThinkingUpdater = {
  start: () => void;
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  delete: () => Promise<void>;
  collapse: (summary?: string) => Promise<void>;
  toolStart: (id: string, name: string, args?: Record<string, unknown>) => void;
  toolEnd: (id: string, failed?: boolean) => void;
};

export function createThinkingUpdater(params: {
  api: Bot["api"];
  chatId: number;
  messageThreadId?: number;
  thinkingConfig: ThinkingConfig;
  toolDisplay: ToolDisplayConfig;
}): ThinkingUpdater {
  const { api, chatId, thinkingConfig, toolDisplay } = params;
  const updateInterval = thinkingConfig.updateInterval ?? 800;
  const maxLength = thinkingConfig.maxLength ?? 3800;
  const threadParams =
    typeof params.messageThreadId === "number"
      ? { message_thread_id: Math.trunc(params.messageThreadId) }
      : {};

  let messageId: number | undefined;
  let thinkingText: string | undefined;
  const activeTools = new Map<string, ToolEntry>();
  const completedTools: CompletedToolEntry[] = [];
  let lastSentContent = "";
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let stopped = false;
  let pendingUpdate = false;

  const sendOrEdit = async (content: string) => {
    if (stopped || content === lastSentContent) return;
    lastSentContent = content;
    lastSentAt = Date.now();
    try {
      if (!messageId) {
        const sent = await api.sendMessage(chatId, content, {
          parse_mode: "HTML",
          ...threadParams,
        });
        messageId = sent.message_id;
      } else {
        await api.editMessageText(chatId, messageId, content, {
          parse_mode: "HTML",
        });
      }
    } catch (err) {
      logVerbose(
        `thinking-updater: ${messageId ? "edit" : "send"} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const doFlush = async () => {
    if (stopped) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) {
      pendingUpdate = true;
      return;
    }
    const content = buildMessage(thinkingText, activeTools, completedTools, toolDisplay, maxLength);
    inFlight = true;
    try {
      await sendOrEdit(content);
    } finally {
      inFlight = false;
    }
    if (pendingUpdate) {
      pendingUpdate = false;
      schedule();
    }
  };

  const schedule = () => {
    if (timer || stopped) return;
    const delay = Math.max(0, updateInterval - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void doFlush();
    }, delay);
  };

  const triggerUpdate = () => {
    if (stopped) return;
    if (inFlight) {
      pendingUpdate = true;
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= updateInterval) {
      void doFlush();
      return;
    }
    schedule();
  };

  return {
    start() {
      triggerUpdate();
    },
    update(text: string) {
      thinkingText = text;
      triggerUpdate();
    },
    async flush() {
      await doFlush();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    async delete() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (messageId) {
        try {
          await api.deleteMessage(chatId, messageId);
        } catch (err) {
          logVerbose(
            `thinking-updater: delete failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        messageId = undefined;
      }
    },
    async collapse(summary?: string) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!messageId) return;
      const text =
        summary ||
        `🧠 <b>Thinking complete</b> — ${completedTools.length} tool${completedTools.length !== 1 ? "s" : ""} used`;
      try {
        await api.editMessageText(chatId, messageId, text, {
          parse_mode: "HTML",
        });
      } catch (err) {
        logVerbose(
          `thinking-updater: collapse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    toolStart(id: string, name: string, args?: Record<string, unknown>) {
      activeTools.set(id, { name, args, startedAt: Date.now() });
      triggerUpdate();
    },
    toolEnd(id: string, failed = false) {
      const entry = activeTools.get(id);
      if (entry) {
        activeTools.delete(id);
        completedTools.push({
          ...entry,
          failed,
          duration: Date.now() - entry.startedAt,
        });
      }
      triggerUpdate();
    },
  };
}
