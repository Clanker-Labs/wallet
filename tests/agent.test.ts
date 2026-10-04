import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshUser } from "./helpers";
import { createAccount } from "@/server/services/accounts";
import { callTool, enabledTools, present, TOOLS } from "@/server/agent/tools";
import { runAgent } from "@/server/agent/runner";
import { appendMessage, createConversation, loadMessages, transcript } from "@/server/agent/conversations";
import type { AgentEvent } from "@/server/agent/events";

let uid: string;
let ctx: { userId: string };

beforeEach(() => {
  process.env.WALLET_TIMEZONE = "UTC";
  uid = freshUser();
  ctx = { userId: uid };
});

describe("tool layer", () => {
  it("exposes object JSON schemas for every tool", async () => {
    const { z } = await import("zod");
    for (const t of TOOLS) {
      const schema = z.toJSONSchema(t.input, { io: "input" }) as { type: string };
      expect(schema.type, t.name).toBe("object");
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });

  it("validates input and reports errors as tool errors", async () => {
    const bad = await callTool(ctx, "record_balance", { accountId: "nope" });
    expect(bad.ok).toBe(false);
    expect(bad.content).toMatch(/Invalid input/);
    expect((await callTool(ctx, "does_not_exist", {})).ok).toBe(false);
  });

  it("converts cents to units for the model", async () => {
    createAccount(uid, { name: "Checking", type: "checking", initialBalance: 1234.5 });
    const res = await callTool(ctx, "get_net_worth", {});
    const data = JSON.parse(res.content);
    expect(data.net).toBe(1234.5);
    expect(data.byClass.cash).toBe(1234.5);
    expect(present({ amountCents: 199, nested: [{ fooCents: 1 }], at: new Date(0) })).toEqual({
      amount: 1.99,
      nested: [{ foo: 0.01 }],
      at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("only allows read-only SQL", async () => {
    const ok = await callTool(ctx, "query_sql", { sql: "SELECT count(*) AS n FROM categories" });
    expect(JSON.parse(ok.content).rows[0].n).toBeGreaterThan(10);
    for (const sql of ["SELECT * FROM sessions", "SELECT * FROM passkeys", "SELECT * FROM users"]) {
      expect((await callTool(ctx, "query_sql", { sql })).ok, sql).toBe(false);
    }
    for (const sql of ["DELETE FROM accounts", "UPDATE accounts SET name = 'x'", "SELECT 1; DROP TABLE accounts"]) {
      expect((await callTool(ctx, "query_sql", { sql })).ok, sql).toBe(false);
    }
  });

  it("fills projection defaults from the user's data", async () => {
    createAccount(uid, { name: "PEA", type: "pea", initialBalance: 50_000 });
    const res = JSON.parse((await callTool(ctx, "project_net_worth", { horizonYears: 5 })).content);
    expect(res.assumptions.startingNetWorth).toBe(50_000);
    expect(res.assumptions.annualReturnPct).toBe(6);
    expect(res.result.yearly).toHaveLength(6);
  });

  it("hides write tools in read-only mode", () => {
    process.env.WALLET_AGENT_READONLY = "1";
    expect(enabledTools().every((t) => t.readOnly)).toBe(true);
    delete process.env.WALLET_AGENT_READONLY;
    expect(enabledTools().some((t) => !t.readOnly)).toBe(true);
  });
});

// ── Claude API loop against a fake Messages API ─────────────────────────

type Turn = { blocks: Record<string, unknown>[]; stop: string };
const requests: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let script: Turn[] = [];
let server: http.Server;

function sse(turn: Turn): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", {
    message: { id: "msg_x", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  turn.blocks.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { ...b, input: {} } });
      out += ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", { delta: { stop_reason: turn.stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  out += ev("message_stop", {});
  return out;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const turn = script.shift();
      if (!turn) {
        res.writeHead(500).end("no scripted turn");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(turn));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.WALLET_AGENT_PROVIDER = "anthropic";
});

afterAll(() => {
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("Claude API agent loop", () => {
  beforeEach(() => {
    requests.length = 0;
  });

  it("runs tools, appends history and streams events", async () => {
    createAccount(uid, { name: "Checking", type: "checking", initialBalance: 5_000 });
    script = [
      { blocks: [{ type: "text", text: "Checking…" }, { type: "tool_use", id: "toolu_1", name: "get_overview", input: {} }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Your net worth is €5,000." }], stop: "end_turn" },
    ];
    const events: AgentEvent[] = [];
    const res = await runAgent({ userId: uid, message: "What's my net worth?", channel: "web", onEvent: (e) => events.push(e) });

    expect(res.text).toBe("Your net worth is €5,000.");
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["conversation", "text", "tool_start", "tool_end", "step", "done"]),
    );

    const first = requests[0];
    expect(first.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(first.body).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
    });
    const tools = first.body.tools as { eager_input_streaming: boolean; input_schema: { type: string } }[];
    expect(tools.every((t) => t.eager_input_streaming && t.input_schema.type === "object")).toBe(true);

    // Second request replays the tool call and its result.
    const msgs = requests[1].body.messages as { role: string; content: { type: string; content?: string }[] }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const result = msgs[2].content[0];
    expect(result.type).toBe("tool_result");
    expect(JSON.parse(result.content!).netWorth.net).toBe(5_000);

    // Follow-up turn: history is append-only (the earlier messages are replayed unchanged).
    script = [{ blocks: [{ type: "text", text: "Still €5,000." }], stop: "end_turn" }];
    await runAgent({ userId: uid, conversationId: res.conversationId, message: "And now?", channel: "web" });
    const replay = requests[2].body.messages as unknown[];
    expect(replay.slice(0, 3)).toEqual(msgs);
    expect(transcript(res.conversationId).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("answers a dangling tool call left by a crash before continuing", async () => {
    const conv = createConversation({ userId: uid, channel: "web", provider: "anthropic", title: "t" });
    appendMessage(conv.id, { role: "user", content: [{ type: "text", text: "hi" }] });
    appendMessage(conv.id, { role: "assistant", content: [{ type: "tool_use", id: "toolu_dead", name: "get_overview", input: {} }] });
    script = [{ blocks: [{ type: "text", text: "ok" }], stop: "end_turn" }];
    await runAgent({ userId: uid, conversationId: conv.id, message: "again", channel: "web" });
    const roles = loadMessages(conv.id).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "user", "assistant"]);
    const repaired = loadMessages(conv.id)[2].content as { type: string; is_error?: boolean }[];
    expect(repaired[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("surfaces refusals without storing the refused turn", async () => {
    script = [{ blocks: [], stop: "refusal" }];
    await expect(runAgent({ userId: uid, message: "something", channel: "web" })).rejects.toThrow(/declined/);
  });
});
