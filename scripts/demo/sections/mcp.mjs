// MCP: a real Claude Code session using the wallet MCP server, replayed in a
// terminal from scripts/demo/replay/mcp-session.json (made by mcp-capture.mjs).
//
//   node scripts/demo/sections/mcp.mjs            # reuses the captured session
//   node scripts/demo/sections/mcp.mjs --capture  # runs claude again first
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, record, sleep } from "../lib.mjs";
import { REPLAY, REPLAY_ORIGIN, serveReplay } from "../helpers-ai.mjs";

const SESSION = path.join(REPLAY, "mcp-session.json");
if (!fs.existsSync(SESSION) || process.argv.includes("--capture")) {
  execFileSync(process.execPath, [path.join(REPLAY, "mcp-capture.mjs")], { cwd: ROOT, stdio: "inherit" });
}
const session = JSON.parse(fs.readFileSync(SESSION, "utf8"));
const init = session.events.find((e) => e.type === "init");
// Claude Code's deferred-tool lookup (ToolSearch) is plumbing; the replay shows the wallet calls.
const hidden = new Set(session.events.filter((e) => e.type === "tool_use" && !e.name.startsWith("mcp__")).map((e) => e.id));
const events = session.events.filter((e) => (e.type === "tool_use" || e.type === "tool_result" || e.type === "text") && !hidden.has(e.id));

await record("mcp", async (rec) => {
  const { page } = rec;
  const term = (fn, arg) => page.evaluate(fn, arg);
  await serveReplay(rec);
  await rec.goto(`${REPLAY_ORIGIN}/terminal.html`);
  await rec.start();

  // One command to connect.
  await rec.caption("Plug wallet into Claude Code with <b>one command</b>");
  await rec.pause(500);
  await term(() => window.term.shell("claude mcp add wallet -- node ~/wallet/bin/wallet-mcp.mjs", 34));
  await rec.pause(250);
  await term(() =>
    window.term.out(
      "Added stdio MCP server wallet with command: node ~/wallet/bin/wallet-mcp.mjs to local config\nFile modified: ~/.claude.json [project: ~]",
    ),
  );
  await rec.pause(1500);
  await term(() => window.term.blank());
  await term(() => window.term.shell("claude", 70));
  await term(() => window.term.setTitle("alex — claude — 120×28"));
  await term((i) => window.term.banner({ cwd: "~", tools: i.tools }), init ?? { tools: 0 });
  await rec.pause(900);

  // The question, then the real session's tool calls at their real pace.
  await rec.caption("Same tools over <b>MCP</b>: Claude Code, Codex &amp; more");
  await term((q) => window.term.ask(q, 30), session.question);
  await term(() => window.term.spinner(true));
  let clock = (init?.t ?? 0) + 400; // the question is sent once the CLI is up
  for (const [i, e] of events.entries()) {
    const gap = Math.max(0, e.t - clock);
    clock = e.t;
    if (gap > 1500) await rec.fastForward(() => sleep(gap), 6);
    else await sleep(gap);
    if (e.type === "tool_use") {
      await term(() => window.term.spinner(false));
      await term((ev) => window.term.toolStart(ev), e);
      if (events[i + 1]?.type !== "tool_use") await term(() => window.term.spinner(true));
    } else if (e.type === "tool_result") {
      await term(() => window.term.spinner(false));
      await term((ev) => window.term.toolEnd(ev), e);
      await term(() => window.term.spinner(true));
    } else if (e.type === "text") {
      await term(() => window.term.spinner(false));
      await rec.caption("Answers grounded in <b>your</b> numbers");
      const top = await term((md) => window.term.answer(md, 40), e.text);
      await rec.pause(600);
      // Back to the start of the answer, then read down to the end.
      await term(() => window.term.stopFollowing());
      await term((y) => window.term.scrollTo(y - 6, 1000), top);
      rec.poster();
      await rec.pause(3600);
      const end = await term(() => window.term.contentHeight() - window.term.viewHeight());
      if (end > top) {
        await term((y) => window.term.scrollTo(y, 2400), end);
        await rec.pause(2600);
      }
    }
  }
  await rec.caption("");
  await rec.pause(800);
});
