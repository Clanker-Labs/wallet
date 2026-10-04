import type { ReactNode } from "react";

/**
 * Inline SVG diagrams, referenced from Markdown with a ```diagram fence
 * holding the name. Colors come from CSS classes (site.css) bound to the
 * theme variables, so the same markup reads in light and dark mode.
 */

type Tone = "plain" | "brand" | "gold" | "muted";

function Box(props: { x: number; y: number; w: number; h: number; title: string; sub?: string; sub2?: string; tone?: Tone; mono?: boolean }) {
  const { x, y, w, h, title, sub, sub2, tone = "plain" } = props;
  const lines = [sub, sub2].filter(Boolean) as string[];
  const titleY = y + h / 2 - (lines.length * 8) + 5;
  return (
    <g className={`dg-node dg-${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={10} />
      <text x={x + w / 2} y={titleY} className="dg-title" textAnchor="middle">
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={i} x={x + w / 2} y={titleY + 17 + i * 15} className={props.mono ? "dg-sub dg-mono" : "dg-sub"} textAnchor="middle">
          {l}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d, dashed, label, lx, ly, anchor = "start" }: { d: string; dashed?: boolean; label?: string; lx?: number; ly?: number; anchor?: "start" | "middle" | "end" }) {
  return (
    <g>
      <path d={d} className={dashed ? "dg-arrow dg-dashed" : "dg-arrow"} markerEnd="url(#dg-head)" />
      {label ? (
        <text x={lx} y={ly} className="dg-edge" textAnchor={anchor}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

function Lane({ y, label }: { y: number; label: string }) {
  return (
    <text x={0} y={y} className="dg-lane">
      {label}
    </text>
  );
}

function Frame({ w, h, title, children, minWidth }: { w: number; h: number; title: string; children: ReactNode; minWidth?: number }) {
  return (
    <figure className="diagram">
      <div className="diagram-scroll">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} style={minWidth ? { minWidth } : undefined}>
          <defs>
            <marker id="dg-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="dg-head" />
            </marker>
          </defs>
          {children}
        </svg>
      </div>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

function Architecture() {
  return (
    <Frame w={760} h={470} minWidth={560} title="Layers and request flow. Every entry point ends in the same services, scoped to one user.">
      <Lane y={44} label="CLIENTS" />
      <Box x={100} y={16} w={150} h={50} title="Browser · PWA" sub="pages, passkeys" />
      <Box x={266} y={16} w={150} h={50} title="curl · scripts" sub="REST /api/*" />
      <Box x={432} y={16} w={150} h={50} title="MCP clients" sub="Claude Code, Codex…" />
      <Box x={598} y={16} w={150} h={50} title="Telegram" sub="your chat" />

      <Lane y={136} label="ENTRY" />
      <Box x={100} y={106} w={316} h={62} title="Next.js server" sub="src/proxy.ts gate → pages," sub2="server actions, /api/* routes" tone="brand" />
      <Box x={432} y={106} w={150} h={62} title="stdio MCP" sub="bin/wallet-mcp.mjs" tone="brand" />
      <Box x={598} y={106} w={150} h={62} title="Worker" sub="bot · reminders" sub2="hourly FX + prices" tone="brand" />

      <Arrow d="M175,66 L175,104" />
      <Arrow d="M341,66 L341,104" />
      <Arrow d="M507,66 L507,104" />
      <Arrow d="M470,66 L400,104" dashed label="or HTTP /api/mcp" lx={392} ly={88} anchor="end" />
      <Arrow d="M673,66 L673,104" label="long poll" lx={680} ly={90} />

      <Lane y={236} label="AGENT" />
      <Box x={100} y={208} w={130} h={56} title="Model backends" sub="Claude API," sub2="claude · codex CLI" tone="muted" />
      <Box x={266} y={208} w={482} h={56} title="Tool registry · 34 tools" sub="src/server/agent/tools.ts → Claude API loop, CLI providers, MCP, /api/tools" tone="gold" />
      <Arrow d="M264,236 L232,236" />
      <Arrow d="M341,168 L341,206" label="/api/agent · tools · mcp" lx={348} ly={192} />
      <Arrow d="M507,168 L507,206" />
      <Arrow d="M673,168 L673,206" label="/ask, files" lx={680} ly={192} />

      <Lane y={326} label="SERVICES" />
      <Box x={100} y={298} w={648} h={56} title="Domain services · src/server/services" sub="every function takes uid first · the only code that touches the database" tone="brand" />
      <Arrow d="M248,168 L248,296" label="pages · actions" lx={242} ly={190} anchor="end" />
      <Arrow d="M507,264 L507,296" />

      <Lane y={420} label="DATA" />
      <Box x={100} y={392} w={316} h={56} title="SQLite · one file" sub="./data/wallet.db · drizzle + better-sqlite3" />
      <Box x={432} y={392} w={316} h={56} title="Keyless market data" sub="FX: currency-api → Frankfurter · prices: Yahoo" tone="muted" />
      <Arrow d="M258,354 L258,390" />
      <Arrow d="M590,354 L590,390" dashed label="fetch, degrade if down" lx={598} ly={377} />
    </Frame>
  );
}

function Currency() {
  return (
    <Frame w={640} h={420} minWidth={480} title="Rates are stored once per day as units per 1 USD; any pair is a ratio of two of them.">
      <Box x={20} y={14} w={600} h={56} title="Daily fetch (keyless, first source that answers)" sub="currency-api via jsDelivr → currency-api via pages.dev → Frankfurter (ECB)" tone="muted" />
      <Arrow d="M320,70 L320,104" label="ensureFreshRates(): at most once per 6 h, never throws" lx={330} ly={92} />
      <Box x={20} y={106} w={600} h={62} title="fx_rates (currency, date) → per_usd" sub="EUR 2026-09-30 → 0.92   ·   GBP 2026-09-30 → 0.79   ·   BTC → 0.0000158" sub2="shared by all users · 200+ fiat, crypto and metals" tone="brand" mono />
      <Arrow d="M320,168 L320,202" label="fxConverter(): latest rate on or before the date" lx={330} ly={190} />
      <Box x={20} y={204} w={600} h={62} title="rate(from, to, date) = perUsd(to) ÷ perUsd(from)" sub="100 EUR → GBP = 100 × 0.79 ÷ 0.92 = 85.87 GBP" sub2="unknown currency → null, added to fx.missing, converted as 0" tone="gold" mono />
      <Arrow d="M170,266 L170,312" />
      <Arrow d="M470,266 L470,312" dashed />
      <Box x={20} y={314} w={300} h={70} title="Totals in your base currency" sub="net worth, budgets, cash flow," sub2="holdings, transaction lists" tone="brand" />
      <Box x={340} y={314} w={280} h={70} title="Missing rates are visible" sub="“No exchange rate for XYZ yet”" sub2="in Needs attention, never mixed in" />
    </Frame>
  );
}

function AgentLoop() {
  return (
    <Frame w={640} h={474} minWidth={480} title="One user turn on the anthropic provider (runAnthropicTurn). Every message is appended, never edited.">
      <Box x={20} y={14} w={600} h={56} title="Load transcript · repair a dangling tool_use · append the user message" sub="attachments first (PDF document / image blocks, CSV preview text), then the text" tone="muted" />
      <Arrow d="M320,70 L320,100" />
      <Box x={20} y={102} w={600} h={74} title="Stream messages (beta API)" sub="thinking: adaptive · effort: WALLET_AGENT_EFFORT · cache_control: ephemeral" sub2="server-side fallback on a refusal · eager tool-input streaming" tone="brand" />
      <Arrow d="M320,176 L320,206" />
      <Box x={20} y={208} w={600} h={56} title="Append the assistant message (thinking + text + tool_use blocks, as returned)" tone="plain" />
      <Arrow d="M170,264 L170,302" label="no tool_use" lx={178} ly={288} />
      <Arrow d="M470,264 L470,302" label="tool_use blocks" lx={478} ly={288} />
      <Box x={20} y={304} w={300} h={60} title="Done: final text" sub="only text after the last fallback block" tone="gold" />
      <Box x={340} y={304} w={280} h={60} title="callTool() for each, in parallel" sub="zod-validate → run(ctx.userId) → present()" tone="brand" />
      <Arrow d="M480,364 L480,402" />
      <Box x={340} y={404} w={280} h={56} title="Append tool_result message" sub="errors come back as is_error: true" />
      <Arrow d="M620,432 L630,432 L630,139 L622,139" label="next step (max 16)" lx={612} ly={389} anchor="end" />
    </Frame>
  );
}

const DIAGRAMS: Record<string, () => ReactNode> = {
  architecture: Architecture,
  currency: Currency,
  "agent-loop": AgentLoop,
};

export function Diagram({ name }: { name: string }) {
  const D = DIAGRAMS[name];
  if (!D) throw new Error(`Unknown diagram "${name}" (known: ${Object.keys(DIAGRAMS).join(", ")})`);
  return <D />;
}
