import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { dbPath } from "@/server/db/client";
import { systemPrompt, type AgentChannel } from "../prompt";
import type { AgentEvent } from "../events";

/**
 * Local agent backends: drive the user's own `claude` (Claude Code) or
 * `codex` CLI headlessly, with the wallet MCP server as their only tool.
 * Uses whatever login/subscription the CLI already has.
 */
export type CliKind = "claude-code" | "codex";

const BINARIES: Record<CliKind, string> = {
  "claude-code": process.env.WALLET_CLAUDE_BIN || "claude",
  codex: process.env.WALLET_CODEX_BIN || "codex",
};

// Paths below are runtime-only: `turbopackIgnore` keeps the build from tracing the whole project.
export function cliAvailable(kind: CliKind): boolean {
  const bin = BINARIES[kind];
  if (bin.includes(path.sep)) return fs.existsSync(/*turbopackIgnore: true*/ bin);
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dir, bin)));
}

/** How a CLI agent should launch the wallet MCP server (stdio), acting as `userId`. */
export function mcpServerSpec(userId: string) {
  const root = process.env.WALLET_ROOT || process.cwd();
  const custom = process.env.WALLET_MCP_COMMAND?.trim();
  // bin/wallet-mcp.mjs works from any cwd (it chdirs to the repo and registers tsx).
  const [command, ...args] = custom ? custom.split(/\s+/) : [process.execPath, path.join(root, "bin", "wallet-mcp.mjs")];
  const env: Record<string, string> = { WALLET_DB_PATH: path.resolve(dbPath()), WALLET_USER_ID: userId };
  for (const key of ["WALLET_AGENT_READONLY", "WALLET_TIMEZONE", "WALLET_CURRENCY", "WALLET_LOCALE"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { command, args, env };
}

function workDir() {
  // A neutral directory so the CLI doesn't pick up project instructions or files.
  const dir = path.join(os.tmpdir(), "wallet-agent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const toml = (s: string) => JSON.stringify(s); // TOML basic strings share JSON escaping

function buildArgs(kind: CliKind, userId: string, message: string, channel: AgentChannel, sessionId: string | null) {
  const mcp = mcpServerSpec(userId);
  if (kind === "claude-code") {
    const args = [
      "-p",
      message,
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      JSON.stringify({ mcpServers: { wallet: { type: "stdio", ...mcp } } }),
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__wallet",
      "--append-system-prompt",
      systemPrompt(userId, channel),
    ];
    if (sessionId) args.push("--resume", sessionId);
    if (process.env.WALLET_CLAUDE_MODEL) args.push("--model", process.env.WALLET_CLAUDE_MODEL);
    return args;
  }
  const envTable = `{${Object.entries(mcp.env)
    .map(([k, v]) => `${k}=${toml(v)}`)
    .join(", ")}}`;
  const flags = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    `mcp_servers.wallet.command=${toml(mcp.command)}`,
    "-c",
    `mcp_servers.wallet.args=[${mcp.args.map(toml).join(", ")}]`,
    "-c",
    `mcp_servers.wallet.env=${envTable}`,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="read-only"',
  ];
  if (process.env.WALLET_CODEX_MODEL) flags.push("-c", `model=${toml(process.env.WALLET_CODEX_MODEL)}`);
  // Codex has no system-prompt flag: the instructions lead the first message of a thread.
  const prompt = sessionId
    ? message
    : `<instructions>\n${systemPrompt(userId, channel)}\nUse only the wallet MCP tools; do not run shell commands or edit files.\n</instructions>\n\n${message}`;
  return sessionId ? ["exec", ...flags, "resume", sessionId, prompt] : ["exec", ...flags, prompt];
}

const stripPrefix = (name: string) => name.replace(/^mcp__wallet__/, "");

export async function runCliTurn(opts: {
  kind: CliKind;
  userId: string;
  message: string;
  channel: AgentChannel;
  sessionId: string | null;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<{ text: string; sessionId: string | null }> {
  const child = spawn(/*turbopackIgnore: true*/ BINARIES[opts.kind], buildArgs(opts.kind, opts.userId, opts.message, opts.channel, opts.sessionId), {
    cwd: workDir(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const abort = () => child.kill("SIGTERM");
  opts.signal?.addEventListener("abort", abort, { once: true });

  let sessionId = opts.sessionId;
  let text = "";
  let error: string | null = null;
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  const lines = readline.createInterface({ input: child.stdout });
  for await (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (opts.kind === "claude-code") handleClaudeEvent(ev);
    else handleCodexEvent(ev);
  }
  const code: number = await new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on("close", (c) => resolve(c ?? 0));
  });
  opts.signal?.removeEventListener("abort", abort);

  if (error) throw new Error(error);
  if (code !== 0 && !text) throw new Error(`${BINARIES[opts.kind]} exited with code ${code}: ${stderr.trim().slice(-500)}`);
  return { text: text.trim(), sessionId };

  function handleClaudeEvent(ev: Record<string, unknown>) {
    if (typeof ev.session_id === "string") sessionId = ev.session_id;
    if (ev.type === "assistant" || ev.type === "user") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const b of content) {
        if (b.type === "text" && typeof b.text === "string") {
          opts.onEvent({ type: "text", delta: b.text });
          text = b.text;
        } else if (b.type === "tool_use") {
          opts.onEvent({ type: "tool_start", id: String(b.id), name: stripPrefix(String(b.name)), input: b.input });
        } else if (b.type === "tool_result") {
          opts.onEvent({ type: "tool_end", id: String(b.tool_use_id), name: "", ok: !b.is_error });
          opts.onEvent({ type: "step" });
        }
      }
    } else if (ev.type === "result") {
      if (ev.is_error) error = String(ev.result ?? ev.subtype ?? "Claude Code failed");
      else if (typeof ev.result === "string") text = ev.result;
    }
  }

  function handleCodexEvent(ev: Record<string, unknown>) {
    const item = ev.item as Record<string, unknown> | undefined;
    switch (ev.type) {
      case "thread.started":
        sessionId = String(ev.thread_id);
        break;
      case "item.started":
        if (item?.type === "mcp_tool_call")
          opts.onEvent({ type: "tool_start", id: String(item.id), name: String(item.tool), input: item.arguments });
        break;
      case "item.completed":
        if (item?.type === "agent_message" && typeof item.text === "string") {
          opts.onEvent({ type: "text", delta: item.text });
          opts.onEvent({ type: "step" });
          text = item.text;
        } else if (item?.type === "mcp_tool_call") {
          opts.onEvent({ type: "tool_end", id: String(item.id), name: String(item.tool), ok: !item.error });
        }
        break;
      case "turn.failed":
        error = String((ev.error as { message?: string })?.message ?? "Codex turn failed");
        break;
      case "error":
        error = String(ev.message ?? "Codex error");
        break;
    }
  }
}
