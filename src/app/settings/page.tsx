import path from "node:path";
import { headers } from "next/headers";
import { AlertTriangle, CheckCircle2, CircleAlert, Download } from "lucide-react";
import type { ReactNode } from "react";
import { getSettings } from "@/server/services/settings";
import { listCategories, listRules } from "@/server/services/categories";
import { dataCounts, transactionCountsByCategory, uncategorizedCount } from "@/server/services/export";
import { agentStatus } from "@/server/agent/runner";
import { agentReadOnly, enabledTools } from "@/server/agent/tools";
import { apiTokenEnabled } from "@/server/auth";
import { dbPath } from "@/server/db/client";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { Snippet } from "@/components/settings-kit";
import { PreferencesForm } from "@/components/settings-preferences";
import { CategoriesEditor, type CategoryItem } from "@/components/settings-categories";
import { RulesEditor } from "@/components/settings-rules";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const PROVIDER_LABEL = { anthropic: "Anthropic API", "claude-code": "Claude Code CLI", codex: "Codex CLI", none: "Off" } as const;

const SECTIONS = [
  ["preferences", "Preferences"],
  ["categories", "Categories"],
  ["rules", "Rules"],
  ["integrations", "Integrations"],
  ["data", "Data"],
] as const;

export default async function SettingsPage() {
  const uid = (await requireUser()).id;
  const prefs = getSettings(uid);
  const txCounts = transactionCountsByCategory(uid);
  const categories: CategoryItem[] = listCategories(uid).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
    txCount: txCounts[c.id] ?? 0,
  }));
  const rules = listRules(uid);
  const uncategorized = uncategorizedCount(uid);

  const agent = agentStatus();
  const toolCount = enabledTools().length;
  const readOnly = agentReadOnly();
  const tokenSet = apiTokenEnabled();
  const passwordSet = true; // replaced by passkeys (see Security section)

  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const origin = process.env.WALLET_PUBLIC_URL?.replace(/\/+$/, "") || `${proto}://${host}`;
  const repo = process.cwd();
  const dbFile = path.resolve(dbPath());
  const dbEnv = process.env.WALLET_DB_PATH ? dbFile : null;
  const counts = dataCounts(uid);
  const timezones = Intl.supportedValuesOf("timeZone");

  const launcher = path.join(repo, "bin", "wallet-mcp.mjs");
  const stdio = `claude mcp add wallet${dbEnv ? ` -e WALLET_DB_PATH=${dbEnv}` : ""} -- node ${launcher}`;
  const codex = [
    "[mcp_servers.wallet]",
    'command = "node"',
    `args = ["${launcher}"]`,
    ...(dbEnv ? [`env = { WALLET_DB_PATH = "${dbEnv}" }`] : []),
  ].join("\n");
  const remote = `claude mcp add --transport http wallet ${origin}/api/mcp --header "Authorization: Bearer $WALLET_API_TOKEN"`;
  const rest = [
    `curl -H "Authorization: Bearer $WALLET_API_TOKEN" ${origin}/api/tools`,
    `curl -X POST -H "Authorization: Bearer $WALLET_API_TOKEN" -H "Content-Type: application/json" \\`,
    `  -d '{}' ${origin}/api/tools/<name>`,
  ].join("\n");
  const chat = [
    `curl -X POST ${origin}/api/agent -H "Authorization: Bearer $WALLET_API_TOKEN" \\`,
    `  -H "Content-Type: application/json" -d '{"message": "How much did I spend on groceries?"}'`,
  ].join("\n");

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Formats, categories, auto-categorization, integrations and your data." />

      <nav aria-label="Settings sections" className="-mt-2 flex flex-wrap gap-1.5">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-ink-2 hover:text-ink">
            {label}
          </a>
        ))}
      </nav>

      {!passwordSet && (
        <div role="alert" className="flex gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-critical-text" aria-hidden />
          <p className="text-ink-2">
            <span className="font-medium text-ink">The web UI has no password.</span> Anyone who can reach this address sees your
            finances. Set <Code>WALLET_PASSWORD</Code> in <Code>.env</Code> and restart the app.
          </p>
        </div>
      )}

      <Card id="preferences" className="scroll-mt-20">
        <CardHeader title="Preferences" subtitle="Used everywhere: amounts, dates, reminders" />
        <PreferencesForm initial={prefs} timezones={timezones} />
      </Card>

      <Card id="categories" className="scroll-mt-20">
        <CardHeader title="Categories" subtitle={`${categories.length} categories`} />
        <CategoriesEditor categories={categories} />
      </Card>

      <Card id="rules" className="scroll-mt-20">
        <CardHeader title="Categorization rules" subtitle="Longest matching text wins · applied on CSV import and on demand" />
        <RulesEditor rules={rules} categories={categories} uncategorized={uncategorized} />
      </Card>

      <Card id="integrations" className="scroll-mt-20">
        <CardHeader title="Integrations" subtitle="Read-only status — secrets live in .env and are never shown here" />
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <StatusItem
            ok={agent.ready}
            label="Assistant"
            value={`${PROVIDER_LABEL[agent.provider]}${agent.model ? ` · ${agent.model}` : ""}`}
            detail={agent.ready ? "ready" : agent.reason}
          />
          <StatusItem
            ok
            label="Agent tools"
            value={`${toolCount} tools`}
            detail={readOnly ? "read-only mode (WALLET_AGENT_READONLY)" : "read & write — set WALLET_AGENT_READONLY=1 to block writes"}
          />
          <StatusItem
            ok={tokenSet}
            label="API token"
            value={tokenSet ? "WALLET_API_TOKEN set" : "WALLET_API_TOKEN not set"}
            detail={tokenSet ? "remote MCP, REST tools and API access enabled" : "remote MCP and /api/tools answer 503 until you set it"}
          />
          <StatusItem
            ok={passwordSet}
            label="Web UI password"
            value={passwordSet ? "WALLET_PASSWORD set" : "not set"}
            detail={passwordSet ? "pages need a login" : "the app is unprotected"}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Snippet label="Claude Code (local MCP over stdio)" code={stdio} />
            <p className="text-xs text-muted">Works from any folder; reads the same database as this app.</p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Snippet label="Codex — ~/.codex/config.toml" code={codex} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Snippet label="Remote MCP over HTTP" code={remote} />
            <p className="text-xs text-muted">
              Needs <Code>WALLET_API_TOKEN</Code> ({tokenSet ? "set ✓" : "not set yet"}) in this app&apos;s .env and in your shell.
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Snippet label="REST tools — list, then call one" code={rest} />
            <p className="text-xs text-muted">
              <Code>GET /api/tools</Code> lists tools with JSON Schemas; <Code>POST /api/tools/&lt;name&gt;</Code> runs one.
            </p>
          </div>
          <div className="min-w-0 space-y-1.5 lg:col-span-2">
            <Snippet label="Chat with the assistant" code={chat} />
            <p className="text-xs text-muted">
              <Code>POST /api/agent</Code> returns JSON <Code>{"{conversationId, text}"}</Code>; add <Code>&quot;stream&quot;: true</Code> (or{" "}
              <Code>Accept: text/event-stream</Code>) for server-sent events. Pass <Code>conversationId</Code> to continue a thread.
            </p>
          </div>
        </div>
      </Card>

      <Card id="data" className="scroll-mt-20">
        <CardHeader title="Your data" subtitle="One SQLite file — back it up, or export everything as JSON" />
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/api/export"
            download
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            <Download size={15} /> Export all data (JSON)
          </a>
          <span className="text-xs text-muted">Everything except assistant chat transcripts.</span>
        </div>
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-y-2">
          <dt className="text-muted">Database file</dt>
          <dd className="min-w-0">
            <Code>{dbFile}</Code>
          </dd>
          <dt className="text-muted">Contents</dt>
          <dd className="text-ink-2">
            {counts.accounts} accounts · {counts.balance_snapshots} balance updates · {counts.transactions} transactions ·{" "}
            {counts.categories} categories · {counts.reminders} reminders · {counts.simulations} saved scenarios
          </dd>
        </dl>
      </Card>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-ink [overflow-wrap:anywhere]">{children}</code>;
}

function StatusItem({ ok, label, value, detail }: { ok: boolean; label: string; value: string; detail?: string }) {
  return (
    <div className="flex min-w-0 gap-2.5">
      {ok ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good-text" aria-label="OK" />
      ) : (
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-critical-text" aria-label="Needs attention" />
      )}
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        <div className="text-sm font-medium [overflow-wrap:anywhere]">{value}</div>
        {detail && <div className="text-xs text-ink-2">{detail}</div>}
      </div>
    </div>
  );
}
