/**
 * Lightweight local Cordis plugin loaded via DSH `--patch` in Mode A headless runs.
 * Subscribes to `agent/assistant-stream` and forwards token-level reasoning/text/tool/usage
 * deltas to stderr with a dedicated prefix so LilaS MCP server can stream typewriter updates
 * without touching stdout (`--json`) or modifying any DSH core files.
 */
export const name = "lilas-stream-probe";
export const inject = [];

const PREFIX = "__LILAS_STREAM__";

export function apply(ctx) {
  const emit = (payload) => {
    try {
      process.stderr.write(`${PREFIX}${JSON.stringify(payload)}\n`);
    } catch {
      // ignore stream write errors
    }
  };

  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (!frame) return;
    const sessionId = agent?.session?.id || null;
    if (frame.type === "start") {
      emit({ type: "stream_start", sessionId });
      return;
    }
    if (frame.type === "end") {
      emit({ type: "stream_end", sessionId });
      return;
    }
    const chunk = frame.chunk;
    if (!chunk || typeof chunk !== "object") return;

    if (chunk.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text) {
      emit({ type: "reasoning_delta", sessionId, text: chunk.text });
    } else if (chunk.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
      emit({ type: "text_delta", sessionId, text: chunk.text });
    } else if (chunk.type === "tool-call-delta") {
      const toolName = chunk.toolName || chunk.name || "";
      if (toolName) emit({ type: "tool_delta", sessionId, toolName });
    } else if (chunk.type === "usage" && chunk.usage) {
      emit({ type: "usage", sessionId, usage: chunk.usage });
    }
  });
}
