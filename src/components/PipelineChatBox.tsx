/**
 * Chat interface for AI-powered pipeline generation.
 * Renders inside the Chat tab of the PipelineEditor panel.
 * Includes inline config panel for API key and model settings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAIConfigStore, PROVIDER_MODELS, isDemoProviderAvailable } from "../ai/config";
import type { AIConfig, AIProvider } from "../ai/config";
import {
  generatePipeline,
  extractPipelineJSON,
  tryExtractPipeline,
  formatActionSummary,
  extractTrailingExplanation,
  RateLimitError,
} from "../ai/client";
import { summarizeStructure } from "../ai/structureSummary";
import type { NodeSnapshotData } from "../pipeline/execute";
import type { LoadStructureParams, SerializedPipeline } from "../pipeline/types";
import {
  useScopedPipelineStore,
  usePipelineStoreApi,
  usePipelineUIStoreApi,
} from "../stores/MeganeProvider";

interface ChatMessage {
  role: "user" | "assistant" | "error";
  content: string;
}

/**
 * Snapshot of the structure the user currently has loaded, captured before an
 * AI-generated pipeline replaces the graph so it can be re-applied afterwards.
 */
export interface PreservedStructure {
  snapshot: NodeSnapshotData;
  fileName: string | null;
  hasTrajectory: boolean;
  hasCell: boolean;
}

/**
 * Capture the first load_structure node's loaded data + file params, or null
 * when no structure is loaded. The AI returns a fresh graph whose loaders have
 * `fileName: null`, and `deserialize()` clears `nodeSnapshots`, so without
 * re-applying this the loaded structure would disappear from the viewport.
 */
export function captureLoadedStructure(
  nodes: Array<{ id: string; type?: string; data: { params: unknown } }>,
  nodeSnapshots: Record<string, NodeSnapshotData>,
): PreservedStructure | null {
  const loader = nodes.find((n) => n.type === "load_structure");
  if (!loader) return null;
  const snapshot = nodeSnapshots[loader.id];
  if (!snapshot) return null;
  const params = loader.data.params as Partial<LoadStructureParams>;
  return {
    snapshot,
    fileName: params.fileName ?? null,
    hasTrajectory: !!params.hasTrajectory,
    hasCell: !!params.hasCell,
  };
}

/**
 * Replace the trailing assistant placeholder with `message` (or append it when
 * the last message isn't an assistant placeholder). Used to swap the raw
 * streaming JSON for the final action summary or error, so the user never sees
 * the raw pipeline JSON.
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

// ─── Styles ──────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "rgba(248, 250, 252, 0.95)",
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

const inputRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 4,
  padding: "6px 10px 8px",
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  resize: "none",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "inherit",
  lineHeight: 1.5,
  outline: "none",
  background: "white",
  minHeight: 95,
  maxHeight: 160,
};

const sendBtnStyle: React.CSSProperties = {
  background: "rgba(59, 130, 246, 0.1)",
  border: "1px solid rgba(59, 130, 246, 0.25)",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  color: "#3b82f6",
  whiteSpace: "nowrap",
};

const cancelBtnStyle: React.CSSProperties = {
  background: "rgba(239, 68, 68, 0.1)",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  color: "#ef4444",
  whiteSpace: "nowrap",
};

const gearBtnStyle: React.CSSProperties = {
  background: "rgba(100, 116, 139, 0.08)",
  border: "1px solid rgba(100, 116, 139, 0.25)",
  borderRadius: 6,
  padding: "6px 8px",
  cursor: "pointer",
  fontSize: 13,
  color: "#64748b",
  lineHeight: 1,
};

const configPanelStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderTop: "1px solid rgba(226,232,240,0.6)",
  background: "rgba(241, 245, 249, 0.95)",
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
  color: "#475569",
  fontSize: 11,
  flexShrink: 0,
};

const configSelectStyle: React.CSSProperties = {
  flex: 1,
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  background: "white",
  outline: "none",
};

const configInputStyle: React.CSSProperties = {
  flex: 1,
  border: "1px solid #e2e8f0",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  background: "white",
  outline: "none",
  fontFamily: "monospace",
};

const userMsgStyle: React.CSSProperties = {
  alignSelf: "flex-end",
  background: "rgba(59, 130, 246, 0.1)",
  color: "#1e40af",
  borderRadius: "8px 8px 2px 8px",
  padding: "4px 8px",
  maxWidth: "85%",
  wordBreak: "break-word",
};

const assistantMsgStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "rgba(100, 116, 139, 0.08)",
  color: "#334155",
  borderRadius: "8px 8px 8px 2px",
  padding: "4px 8px",
  maxWidth: "85%",
  wordBreak: "break-word",
};

const errorMsgStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "rgba(239, 68, 68, 0.08)",
  color: "#dc2626",
  borderRadius: "8px 8px 8px 2px",
  padding: "4px 8px",
  maxWidth: "85%",
  wordBreak: "break-word",
};

const successMsgStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "rgba(16, 185, 129, 0.08)",
  color: "#059669",
  borderRadius: "8px 8px 8px 2px",
  padding: "4px 8px",
  maxWidth: "85%",
  fontWeight: 500,
};

// ─── Component ───────────────────────────────────────────────────────

export function PipelineChatBox({ onPipelineApplied }: { onPipelineApplied?: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
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

  const pipelineApi = usePipelineStoreApi();
  const pipelineUIApi = usePipelineUIStoreApi();
  const deserialize = useScopedPipelineStore((s) => s.deserialize);
  const autoLayout = useScopedPipelineStore((s) => s.autoLayout);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    if (!useDemo && !apiKey) {
      setShowConfig(true);
      setMessages((prev) => [
        ...prev,
        { role: "error", content: "Please set your API key in the config panel." },
      ]);
      return;
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setIsStreaming(true);

    // Add a placeholder assistant message. The model streams raw pipeline JSON
    // into it, which we never surface — it is replaced by an action summary (or
    // error) once the request settles.
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const abort = new AbortController();
    abortRef.current = abort;

    // Apply a generated pipeline. The AI returns a fresh graph whose
    // load_structure node has `fileName: null`, and deserialize() clears
    // nodeSnapshots, so we capture the currently loaded structure first and
    // re-attach it to the new loader afterwards — otherwise the loaded
    // structure would disappear from the viewport. `appliedJSON` doubles as
    // a "have we applied yet?" guard (null = not applied) and lets us detect
    // when a later fence supersedes an earlier one (e.g. a template echoed
    // before the model's final, customized pipeline).
    let appliedNodeCount = -1;
    let appliedJSON: string | null = null;
    const applyPipeline = (pipeline: SerializedPipeline) => {
      const preState = pipelineApi.getState();
      const preserved = captureLoadedStructure(preState.nodes, preState.nodeSnapshots);

      deserialize(pipeline);
      autoLayout();

      if (preserved) {
        const postState = pipelineApi.getState();
        const newLoader = postState.nodes.find((n) => n.type === "load_structure");
        if (newLoader) {
          postState.setNodeSnapshot(newLoader.id, preserved.snapshot);
          postState.updateNodeParams(newLoader.id, {
            fileName: preserved.fileName,
            hasTrajectory: preserved.hasTrajectory,
            hasCell: preserved.hasCell,
          });
        }
      }

      appliedNodeCount = pipeline.nodes.length;
      appliedJSON = JSON.stringify(pipeline);
      // Surface the result on the editor tab and trigger fitView via the
      // panel's mode-change effect.
      pipelineUIApi.getState().markPipelineApplied();
      onPipelineApplied?.();
    };

    // Summarize the currently loaded structure so the model can build filter
    // queries from the real elements/resnames present rather than guessing.
    const { snapshot, atomLabels } = pipelineApi.getState();
    const structureSummary = summarizeStructure(snapshot, atomLabels);

    try {
      let streamBuffer = "";
      const fullResponse = await generatePipeline(
        effectiveConfig,
        trimmed,
        (chunk) => {
          streamBuffer += chunk;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === "assistant") {
              updated[updated.length - 1] = { ...last, content: last.content + chunk };
            }
            return updated;
          });
          // Apply (or re-apply) the graph as soon as a complete JSON block has
          // streamed in. The model emits the JSON first, so the viewport
          // updates without waiting for the trailing one-sentence explanation
          // to finish. A later fence (e.g. the model's final, customized
          // pipeline after echoing a template) can supersede an earlier one —
          // re-apply whenever the latest valid fence differs from what's applied.
          const candidate = tryExtractPipeline(streamBuffer);
          if (candidate) {
            const candidateJSON = JSON.stringify(candidate);
            if (candidateJSON !== appliedJSON) {
              applyPipeline(candidate);
            }
          }
        },
        abort.signal,
        structureSummary,
      );

      // Fallback: the JSON may only have closed in the final, non-streamed text
      // (or arrived after a tool round trip), so apply it now if we haven't yet.
      if (appliedJSON === null) {
        applyPipeline(extractPipelineJSON(fullResponse));
      }

      // Show the assistant's own explanation (the sentence that follows the
      // JSON payload); fall back to a generic summary if the model returned
      // only JSON with no prose.
      const explanation = extractTrailingExplanation(fullResponse);
      setMessages((prev) =>
        replaceTrailingAssistant(prev, {
          role: "assistant",
          content: explanation || formatActionSummary(appliedNodeCount),
        }),
      );
    } catch (e: unknown) {
      let content: string;
      if (e instanceof RateLimitError) {
        content = e.message;
      } else if ((e as Error).name === "AbortError") {
        content = "Generation cancelled.";
      } else {
        content = "Something went wrong. Please try again.";
      }
      setMessages((prev) => replaceTrailingAssistant(prev, { role: "error", content }));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [
    input,
    isStreaming,
    apiKey,
    useDemo,
    effectiveConfig,
    deserialize,
    autoLayout,
    onPipelineApplied,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div style={containerStyle}>
      {/* Config panel */}
      {showConfig && (
        <div style={configPanelStyle}>
          {demoAvailable && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={useOwnKey}
                onChange={(e) => setUseOwnKey(e.target.checked)}
              />
              <span style={{ color: "#475569" }}>Use my own API key</span>
            </label>
          )}
          {useDemo ? (
            <div style={{ color: "#64748b", fontSize: 11, fontStyle: "italic" }}>
              The free demo runs through megane&apos;s shared proxy — no API key needed. It uses a
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

      {/* Messages area (always rendered so the chat tab fills the panel) */}
      <div style={messagesAreaStyle} data-testid="pipeline-chat-messages">
        {messages.length === 0 ? (
          <div
            style={{
              color: "var(--megane-text-muted)",
              fontStyle: "italic",
              fontSize: 11,
              padding: "8px 0",
            }}
          >
            Ask the assistant to build or edit the pipeline.
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
            // Action summary lines start with "Pipeline applied".
            if (msg.content.startsWith("Pipeline applied")) {
              return (
                <div key={i} style={successMsgStyle}>
                  {msg.content}
                </div>
              );
            }
            return (
              <div key={i} style={assistantMsgStyle}>
                {msg.content}
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input row */}
      <div style={inputRowStyle}>
        <button
          onClick={() => setShowConfig(!showConfig)}
          style={{
            ...gearBtnStyle,
            background: showConfig ? "rgba(59, 130, 246, 0.1)" : gearBtnStyle.background,
            color: showConfig ? "#3b82f6" : gearBtnStyle.color,
          }}
          title="AI Settings"
        >
          &#9881;
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the pipeline you want..."
          style={textareaStyle}
          rows={5}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button onClick={handleCancel} style={cancelBtnStyle}>
            Cancel
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            style={{
              ...sendBtnStyle,
              opacity: input.trim() ? 1 : 0.5,
              cursor: input.trim() ? "pointer" : "default",
            }}
            disabled={!input.trim()}
          >
            Generate
          </button>
        )}
      </div>
    </div>
  );
}
