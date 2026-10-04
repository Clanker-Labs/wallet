/** Events streamed from an agent run to the web UI (as SSE) or other callers. */
export type AgentEvent =
  | { type: "conversation"; id: string; provider: string }
  | { type: "text"; delta: string }
  /** Discard text streamed so far in the current step (retry or model fallback). */
  | { type: "text_reset" }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean }
  /** One model step finished; more may follow. */
  | { type: "step" }
  | { type: "error"; message: string }
  | { type: "done"; text: string };
