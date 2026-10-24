/**
 * The AI assistant's dock: a one-line prompt bar that sits under a node
 * graph, so a request and the graph it changes are on screen together. The
 * conversation opens as a drawer over the bottom of the canvas, and the
 * provider / API key settings as a popover from the bar's gear button.
 *
 * The dock knows nothing about what the assistant edits. Its host hands it a
 * `run` function that sends one request and applies what comes back — the
 * viewer's pipeline editor (`PipelineChatBox`) and the Builder's Flow panel
 * (`builder/flow/FlowChatBox`) each bring their own — and the dock keeps the
 * transcript, streams the reply into it (showing only the prose after the
 * JSON, never the payload), and offers "Undo" on the reply whose undo
 * checkpoint is still the latest one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAIConfigStore, PROVIDER_MODELS, isDemoProviderAvailable } from "../ai/config";
import type { AIConfig, AIProvider } from "../ai/config";
import { extractTrailingExplanation } from "../ai/generation";
import type { ChatTurn } from "../ai/editContext";
import { isImeComposing } from "../utils/ime";

export interface ChatMessage {
  role: "user" | "assistant" | "error";
  content: string;
  /** Undo checkpoint recorded when this reply's result was applied. */
  checkpointId?: number | null;
  /** Set once the user undid what this reply applied. */
  undone?: boolean;
  /** The reply is the generic "applied" summary (the model wrote no prose): drawn as a success. */
  summary?: boolean;
}

/** One request, as the dock hands it to its host's `run`. */
export interface AssistantRequest {
  /** The request as typed, trimmed. */
  prompt: string;
  /** The finished turns before this request, oldest first. */
  history: ChatTurn[];
  /** The provider settings to send it with (the free demo or the user's key). */
  config: AIConfig;
  signal: AbortSignal;
  /** Model text as it streams in. */
  onChunk: (chunk: string) => void;
  /** A repair round is starting: the reply streamed so far is dropped. */
  onRestart: () => void;
  /** The result was applied, recording the undo checkpoint `id`. */
  onCheckpoint: (id: number | null) => void;
}

/** What a finished request shows as its reply. */
export interface AssistantReply {
  content: string;
  /** `content` is the generic "applied" summary rather than the model's own words. */
  summary?: boolean;
}

export interface AssistantDockProps {
  /** Send one request and apply its result; rejects with the error to show. */
  run: (request: AssistantRequest) => Promise<AssistantReply>;
  /** The prompt bar's placeholder. */
  placeholder: string;
  /** What the empty conversation says. */
  emptyHint: string;
  /** The newest undo checkpoint the host holds, or null. */
  latestCheckpointId: number | null;
  /** Undo the newest checkpoint; returns whether anything was undone. */
  onUndo: () => boolean;
  /** Why a request cannot be sent right now (shown on Generate), or null. */
  blockedReason?: string | null;
  /** Prefix of the dock's test ids (`pipeline-chat`, `builder-flow-chat`). */
  testId: string;
}

/**
 * Replace the trailing assistant placeholder with `message` (or append it when
 * the last message isn't an assistant placeholder). Used to swap the raw
 * streaming JSON for the final action summary or error, so the user never sees
 * the raw JSON.
 */
export function replaceTrailingAssistant(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    return [...messages.slice(0, -1), message];
  }
  return [...messages, message];
}

/** The finished user / assistant turns of a transcript, for the edit context. */
export function chatHistory(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role === "error" || !m.content) continue;
    turns.push({ role: m.role, content: m.content });
  }
  return turns;
}

/** The prompt grows with its content up to this many rows, then scrolls. */
const MAX_PROMPT_ROWS = 4;

// ─── Styles ──────────────────────────────────────────────────────────

const dockStyle: React.CSSProperties = {
  position: "relative",
  flex: "0 0 auto",
  borderTop: "1px solid var(--megane-border-solid)",
  background: "var(--megane-surface-solid)",
};

const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 4,
  padding: "6px 8px",
};

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "100%",
  zIndex: 10,
  background: "var(--megane-surface-solid)",
  border: "1px solid var(--megane-border-solid)",
  borderBottom: "none",
  boxShadow: "0 -6px 16px rgba(15, 23, 42, 0.12)",
};

const drawerStyle: React.CSSProperties = {
  ...overlayStyle,
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "column",
  maxHeight: 260,
  borderRadius: "8px 8px 0 0",
};

const drawerHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderBottom: "1px solid var(--megane-border)",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--megane-text-body)",
};

const messagesAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "6px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  lineHeight: 1.5,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  resize: "none",
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 11,
  fontFamily: "inherit",
  lineHeight: 1.5,
  outline: "none",
  background: "var(--megane-surface-raised)",
  color: "var(--megane-text)",
};

const iconBtnStyle: React.CSSProperties = {
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
  width: 28,
  height: 28,
  background: "rgba(100, 116, 139, 0.08)",
  border: "1px solid rgba(100, 116, 139, 0.25)",
  borderRadius: 6,
  padding: 0,
  cursor: "pointer",
  color: "var(--megane-text-secondary)",
};

const activeIconBtnStyle: React.CSSProperties = {
  ...iconBtnStyle,
  background: "rgba(59, 130, 246, 0.1)",
  borderColor: "rgba(59, 130, 246, 0.35)",
  color: "var(--megane-primary)",
};

const sendBtnStyle: React.CSSProperties = {
  flex: "0 0 auto",
  height: 28,
  background: "rgba(59, 130, 246, 0.1)",
  border: "1px solid rgba(59, 130, 246, 0.25)",
  borderRadius: 6,
  padding: "0 10px",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--megane-primary)",
  whiteSpace: "nowrap",
};

const cancelBtnStyle: React.CSSProperties = {
  ...sendBtnStyle,
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  color: "var(--megane-danger)",
};

const textBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: "1px 4px",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 500,
  color: "var(--megane-text-secondary)",
};

const undoBtnStyle: React.CSSProperties = {
  ...textBtnStyle,
  marginLeft: 6,
  fontWeight: 600,
  color: "var(--megane-primary)",
  textDecoration: "underline",
};

const configPanelStyle: React.CSSProperties = {
  ...overlayStyle,
  right: 0,
  width: "min(100%, 320px)",
  padding: "8px 10px",
  borderRadius: "8px 0 0 0",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 11,
};

const configRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const configLabelStyle: React.CSSProperties = {
  width: 60,
  fontWeight: 600,
  color: "var(--megane-text-body)",
  fontSize: 11,
  flexShrink: 0,
};

const configSelectStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "1px solid var(--megane-border-solid)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  background: "var(--megane-surface-raised)",
  color: "var(--megane-text)",
  outline: "none",
};

const configInputStyle: React.CSSProperties = {
  ...configSelectStyle,
  fontFamily: "monospace",
};

const bubbleStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  borderRadius: "8px 8px 8px 2px",
  padding: "4px 8px",
  maxWidth: "85%",
  wordBreak: "break-word",
};

const userMsgStyle: React.CSSProperties = {
  ...bubbleStyle,
  alignSelf: "flex-end",
  background: "rgba(59, 130, 246, 0.1)",
  color: "var(--megane-primary-text)",
  borderRadius: "8px 8px 2px 8px",
};

const assistantMsgStyle: React.CSSProperties = {
  ...bubbleStyle,
  background: "rgba(100, 116, 139, 0.08)",
  color: "var(--megane-text-body)",
};

const errorMsgStyle: React.CSSProperties = {
  ...bubbleStyle,
  background: "rgba(239, 68, 68, 0.08)",
  color: "var(--megane-danger-text)",
};

const successMsgStyle: React.CSSProperties = {
  ...bubbleStyle,
  background: "rgba(16, 185, 129, 0.08)",
  color: "var(--megane-success-text)",
  fontWeight: 500,
};

function DockIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────

export function AssistantDock({
  run,
  placeholder,
  emptyHint,
  latestCheckpointId,
  onUndo,
  blockedReason = null,
  testId,
}: AssistantDockProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const provider = useAIConfigStore((s) => s.provider);
  const model = useAIConfigStore((s) => s.model);
  const apiKey = useAIConfigStore((s) => s.apiKey);
  const useOwnKey = useAIConfigStore((s) => s.useOwnKey);
  const setProvider = useAIConfigStore((s) => s.setProvider);
  const setModel = useAIConfigStore((s) => s.setModel);
  const setApiKey = useAIConfigStore((s) => s.setApiKey);
  const setUseOwnKey = useAIConfigStore((s) => s.setUseOwnKey);

  const demoAvailable = isDemoProviderAvailable();
  // Use the shared free demo unless the visitor opted into BYOK (or no
  // demo proxy is configured in this build, which forces BYOK).
  const useDemo = demoAvailable && !useOwnKey;
  const effectiveConfig: AIConfig = useMemo(
    () => (useDemo ? { provider: "demo", model: "demo", apiKey: "" } : { provider, model, apiKey }),
    [useDemo, provider, model, apiKey],
  );

  // Keep the newest message in view while the drawer is open.
  useEffect(() => {
    if (showHistory) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, showHistory]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || blockedReason) return;

    if (!useDemo && !apiKey) {
      // The settings popover and the conversation share the space over the
      // canvas; the key field is what the user needs now.
      setShowConfig(true);
      setShowHistory(false);
      setMessages((prev) => [
        ...prev,
        { role: "error", content: "Please set your API key in the AI settings." },
      ]);
      return;
    }

    const history = chatHistory(messages);
    setInput("");
    setShowConfig(false);
    setShowHistory(true);
    // Add a placeholder assistant message after the user's. The model streams
    // raw JSON into it, which we never surface — it is replaced by the reply
    // (or an error) once the request settles.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: trimmed },
      { role: "assistant", content: "" },
    ]);
    setIsStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;
    let checkpointId: number | null = null;

    try {
      const reply = await run({
        prompt: trimmed,
        history,
        config: effectiveConfig,
        signal: abort.signal,
        onChunk: (chunk) =>
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === "assistant") {
              updated[updated.length - 1] = { ...last, content: last.content + chunk };
            }
            return updated;
          }),
        // A repair round replaces the reply streamed so far: leaving it would
        // splice the old explanation onto the new one.
        onRestart: () =>
          setMessages((prev) => replaceTrailingAssistant(prev, { role: "assistant", content: "" })),
        onCheckpoint: (id) => {
          checkpointId = id;
        },
      });
      setMessages((prev) =>
        replaceTrailingAssistant(prev, {
          role: "assistant",
          content: reply.content,
          checkpointId,
          ...(reply.summary ? { summary: true } : {}),
        }),
      );
    } catch (e: unknown) {
      let content: string;
      const name = (e as Error)?.name;
      if (name === "RateLimitError") {
        content = (e as Error).message;
      } else if (name === "AbortError") {
        content = "Generation cancelled.";
      } else {
        content = "Something went wrong. Please try again.";
      }
      // A result applied before the failure stays undoable.
      setMessages((prev) =>
        replaceTrailingAssistant(prev, { role: "error", content, checkpointId }),
      );
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, blockedReason, apiKey, useDemo, effectiveConfig, messages, run]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleUndo = useCallback(
    (index: number) => {
      if (!onUndo()) return;
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, undone: true } : m)));
    },
    [onUndo],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        setShowHistory(false);
        setShowConfig(false);
      }
    },
    [handleSubmit],
  );

  const rows = Math.min(MAX_PROMPT_ROWS, Math.max(1, input.split("\n").length));
  const canSend = input.trim() !== "" && !blockedReason;

  function renderUndo(msg: ChatMessage, index: number) {
    if (msg.undone) {
      return <span style={{ ...textBtnStyle, marginLeft: 6, cursor: "default" }}>(undone)</span>;
    }
    if (msg.checkpointId == null || msg.checkpointId !== latestCheckpointId) return null;
    return (
      <button
        type="button"
        style={undoBtnStyle}
        onClick={() => handleUndo(index)}
        title="Restore what was there before this request"
        data-testid={`${testId}-undo`}
      >
        Undo
      </button>
    );
  }

  return (
    <div style={dockStyle} data-testid={testId}>
      {showHistory && (
        <div style={drawerStyle} data-testid={`${testId}-history`}>
          <div style={drawerHeaderStyle}>
            <span style={{ flex: 1 }}>Assistant</span>
            {messages.length > 0 && !isStreaming && (
              <button type="button" style={textBtnStyle} onClick={() => setMessages([])}>
                Clear
              </button>
            )}
            <button
              type="button"
              style={textBtnStyle}
              onClick={() => setShowHistory(false)}
              aria-label="Hide conversation"
              title="Hide conversation"
            >
              &#x2715;
            </button>
          </div>
          <div style={messagesAreaStyle} data-testid={`${testId}-messages`}>
            {messages.length === 0 ? (
              <div
                style={{
                  color: "var(--megane-text-muted)",
                  fontStyle: "italic",
                  padding: "4px 0",
                }}
              >
                {emptyHint}
              </div>
            ) : (
              messages.map((msg, i) => {
                if (msg.role === "user") {
                  return (
                    <div key={i} style={userMsgStyle}>
                      {msg.content}
                    </div>
                  );
                }
                if (msg.role === "error") {
                  return (
                    <div key={i} style={errorMsgStyle}>
                      {msg.content}
                      {renderUndo(msg, i)}
                    </div>
                  );
                }
                // The live placeholder (last message while streaming) holds raw
                // model output that may include fenced JSON — show only the
                // trailing prose that follows the last closed fence, falling
                // back to a neutral status while the JSON is still streaming.
                if (isStreaming && i === messages.length - 1) {
                  const prose = extractTrailingExplanation(msg.content);
                  return (
                    <div key={i} style={assistantMsgStyle}>
                      {prose || "Generating…"}
                    </div>
                  );
                }
                // Completed messages already hold their final text (an action
                // summary or the assistant's explanation) — render it as-is.
                const style = msg.summary ? successMsgStyle : assistantMsgStyle;
                return (
                  <div key={i} style={style}>
                    {msg.content}
                    {renderUndo(msg, i)}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {showConfig && (
        <div style={configPanelStyle} data-testid={`${testId}-settings`}>
          {demoAvailable && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={useOwnKey}
                onChange={(e) => setUseOwnKey(e.target.checked)}
              />
              <span style={{ color: "var(--megane-text-body)" }}>Use my own API key</span>
            </label>
          )}
          {useDemo ? (
            <div style={{ color: "var(--megane-text-secondary)", fontStyle: "italic" }}>
              The free demo runs through Megane&apos;s shared proxy — no API key needed. It uses a
              rate-limited free-tier model, so responses may be slower or lower quality than your
              own API key.
            </div>
          ) : (
            <>
              <div style={configRowStyle}>
                <span style={configLabelStyle}>Provider</span>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as AIProvider)}
                  style={configSelectStyle}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div style={configRowStyle}>
                <span style={configLabelStyle}>Model</span>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  style={configSelectStyle}
                >
                  {PROVIDER_MODELS[provider].map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={configRowStyle}>
                <span style={configLabelStyle}>API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                  style={configInputStyle}
                />
              </div>
            </>
          )}
        </div>
      )}

      <div style={barStyle}>
        <button
          type="button"
          onClick={() => {
            setShowHistory(!showHistory);
            setShowConfig(false);
          }}
          style={showHistory ? activeIconBtnStyle : iconBtnStyle}
          title={showHistory ? "Hide conversation" : "Show conversation"}
          aria-expanded={showHistory}
          data-testid={`${testId}-toggle`}
        >
          <DockIcon>
            <path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20.5l1.4-4.6A7.5 7.5 0 1 1 20 12.5z" />
            <path d="M9 11h6M9 14.5h4" />
          </DockIcon>
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Ask the AI assistant"
          data-testid={`${testId}-input`}
          style={textareaStyle}
          rows={rows}
          disabled={isStreaming}
        />
        <button
          type="button"
          onClick={() => {
            setShowConfig(!showConfig);
            setShowHistory(false);
          }}
          style={showConfig ? activeIconBtnStyle : iconBtnStyle}
          title="AI Settings"
          aria-expanded={showConfig}
        >
          <DockIcon>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
          </DockIcon>
        </button>
        {isStreaming ? (
          <button type="button" onClick={handleCancel} style={cancelBtnStyle}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            style={{
              ...sendBtnStyle,
              opacity: canSend ? 1 : 0.5,
              cursor: canSend ? "pointer" : "default",
            }}
            disabled={!canSend}
            title={blockedReason ?? undefined}
            data-testid={`${testId}-send`}
          >
            Generate
          </button>
        )}
      </div>
    </div>
  );
}
