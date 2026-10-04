/**
 * Runs a real Claude Code session against the wallet MCP server (on a copy of
 * the demo database) and saves its stream-json events, trimmed, with timings,
 * to scripts/demo/replay/mcp-session.json for terminal.html to replay.
 *
 *   node scripts/demo/replay/mcp-capture.mjs ["question"]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ROOT, baseDb } from "../lib.mjs";

const QUESTION =
  process.argv[2] ?? "How much did I spend on restaurants this year vs last year, and how's my savings rate trending?";
const OUT = path.join(ROOT, "scripts/demo/replay/mcp-session.json");
const TMP = path.join(os.tmpdir(), "wallet-demo", "mcp");
fs.mkdirSync(TMP, { recursive: true });

const db = path.join(TMP, "wallet.db");
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(baseDb(), db);

const mcpConfig = {
  mcpServers: {
    wallet: { type: "stdio", command: process.execPath, args: [path.join(ROOT, "bin/wallet-mcp.mjs")], env: { WALLET_DB_PATH: db } },
  },
};

const args = [
  "-p",
  QUESTION,
  "--output-format",
  "stream-json",
  "--verbose",
  "--mcp-config",
  JSON.stringify(mcpConfig),
  "--strict-mcp-config",
  "--allowedTools",
  "mcp__wallet__*",
];
if (process.env.MCP_CAPTURE_MODEL) args.push("--model", process.env.MCP_CAPTURE_MODEL);

const t0 = Date.now();
// A neutral working directory, so no project instructions leak into the session.
const child = spawn("claude", args, { cwd: TMP, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
const events = [];
const trim = (s, n = 1500) => (s.length > n ? s.slice(0, n) + "…" : s);
for await (const line of readline.createInterface({ input: child.stdout })) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const t = Date.now() - t0;
  if (ev.type === "system" && ev.subtype === "init") {
    events.push({ t, type: "init", tools: (ev.tools ?? []).filter((n) => n.startsWith("mcp__wallet__")).length, mcp: ev.mcp_servers });
  } else if (ev.type === "assistant") {
    for (const b of ev.message?.content ?? []) {
      if (b.type === "text") events.push({ t, type: "text", text: b.text });
      else if (b.type === "tool_use") events.push({ t, type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
  } else if (ev.type === "user") {
    for (const b of ev.message?.content ?? []) {
      if (b.type !== "tool_result") continue;
      const content = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("\n") : String(b.content ?? "");
      events.push({ t, type: "tool_result", id: b.tool_use_id, error: !!b.is_error, content: trim(content) });
    }
  } else if (ev.type === "result") {
    events.push({ t, type: "result", ok: !ev.is_error, durationMs: ev.duration_ms, turns: ev.num_turns, costUsd: ev.total_cost_usd });
  }
}
const code = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("close", r)));
for (const f of [db, `${db}-wal`, `${db}-shm`]) fs.rmSync(f, { force: true });
const session = { question: QUESTION, capturedAt: new Date().toISOString(), exitCode: code, events };
fs.writeFileSync(OUT, JSON.stringify(session, null, 2) + "\n");
console.log(`saved ${events.length} events to ${path.relative(ROOT, OUT)} (exit ${code})`);
for (const e of events) console.log(e.t, e.type, e.name ?? "", e.type === "text" ? e.text.slice(0, 200) : "");
