import path from "node:path";
import { headers } from "next/headers";
import { DateTime } from "luxon";
import { AlertTriangle, CheckCircle2, CircleAlert, Download, KeyRound, LifeBuoy, QrCode, Users } from "lucide-react";
import type { ReactNode } from "react";
import { getSettings, today } from "@/server/services/settings";
import { listCategories, listRules } from "@/server/services/categories";
import { dataCounts, transactionCountsByCategory, uncategorizedCount } from "@/server/services/export";
import { listPasskeys } from "@/server/services/passkeys";
import { currenciesInUse, knownCurrencies, latestFxDate, latestRates } from "@/server/services/fx";
import { countUsers, listUsers } from "@/server/services/users";
import { agentStatus } from "@/server/agent/runner";
import { agentReadOnly, enabledTools } from "@/server/agent/tools";
import { allowedChatIds, botUsername } from "@/server/telegram/api";
import { apiTokenEnabled, signupAllowed, tokenlessAccess } from "@/server/auth";
import { dbPath } from "@/server/db/client";
import { COMMON_CURRENCIES } from "@/lib/domain";
import { addDays } from "@/lib/dates";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";
import { Snippet } from "@/components/settings-kit";
import { PreferencesForm } from "@/components/settings-preferences";
import { CategoriesEditor, type CategoryItem } from "@/components/settings-categories";
import { RulesEditor } from "@/components/settings-rules";
import { PasskeyList, type PasskeyItem } from "@/components/settings-security";
import { RefreshRatesButton } from "@/components/settings-currency";
import { TelegramLink } from "@/components/settings-telegram";
import { AddPasskey, SignOutButton } from "@/components/passkey-auth";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const PROVIDER_LABEL = { anthropic: "Anthropic API", "claude-code": "Claude Code CLI", codex: "Codex CLI", none: "Off" } as const;

const FX_SOURCE = "currency-api (fawazahmed0), with Frankfurter (ECB) as fallback";

export default async function SettingsPage() {
  const user = await requireUser();
  const uid = user.id;
  const isOwner = user.role === "owner";
  const prefs = getSettings(uid);
  const base = prefs.currency;
  const todayISO = today(uid);

  const sections: [string, string][] = [
    ["preferences", "Preferences"],
    ["currency", "Exchange rates"],
    ["security", "Security"],
    ["telegram", "Telegram"],
    ["categories", "Categories"],
    ["rules", "Rules"],
    ["integrations", "Integrations"],
    ...(isOwner ? ([["members", "Members"]] as [string, string][]) : []),
    ["data", "Data"],
  ];

  // ── Dates in the user's zone ──
  const zone = prefs.timezone;
  const dateFmt = new Intl.DateTimeFormat(prefs.locale, { day: "numeric", month: "short", year: "numeric", timeZone: zone });
  const timeFmt = new Intl.DateTimeFormat(prefs.locale, { hour: "2-digit", minute: "2-digit", timeZone: zone });
  const fmtDate = (d: Date | string) => dateFmt.format(typeof d === "string" ? new Date(`${d}T12:00:00Z`) : d);
  const relative = (d: Date) => {
    const days = Math.round(
      DateTime.now().setZone(zone).startOf("day").diff(DateTime.fromJSDate(d).setZone(zone).startOf("day"), "days").days,
    );
    if (days <= 0) return `today, ${timeFmt.format(d)}`;
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return fmtDate(d);
  };

  // ── Security ──
  const passkeys: PasskeyItem[] = listPasskeys(uid)
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .map((p) => ({
      id: p.id,
      name: p.name || "Passkey",
      deviceType: p.deviceType,
      backedUp: p.backedUp,
      created: p.createdAt ? fmtDate(p.createdAt) : "—",
      lastUsed: p.lastUsedAt ? relative(p.lastUsedAt) : null,
    }));

  // ── Currency & rates ──
  const fxDate = latestFxDate();
  const known = knownCurrencies();
  const fresh = !!fxDate && fxDate >= addDays(todayISO, -1);
  const fxAge = fxDate
    ? Math.round(DateTime.fromISO(todayISO).diff(DateTime.fromISO(fxDate), "days").days)
    : null;
  const usage = new Map<string, Set<"accounts" | "transactions" | "holdings">>();
  const use = (c: string, where: "accounts" | "transactions" | "holdings") => {
    const code = c.toUpperCase();
    if (!usage.has(code)) usage.set(code, new Set());
    usage.get(code)!.add(where);
  };
  for (const { currency, usedIn } of currenciesInUse(uid)) for (const where of usedIn) use(currency, where);
  const foreign = [...usage.keys()].filter((c) => c !== base).sort();
  const { rates } = latestRates(base, foreign);
  const names = currencyNames(prefs.locale, [...new Set([...COMMON_CURRENCIES, ...known, ...usage.keys(), base])]);
  const otherCurrencies = known.filter((c) => !(COMMON_CURRENCIES as readonly string[]).includes(c));
  const rateFmt = (n: number) =>
    new Intl.NumberFormat(prefs.locale, n >= 100 ? { maximumFractionDigits: 2 } : n >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 }).format(n);

  // ── Categories & rules ──
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

  // ── Telegram ──
  const botTokenSet = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const ownerChats = isOwner ? allowedChatIds().filter((id) => id !== user.telegramChatId) : [];

  // ── Members (owner only) ──
  const members = isOwner
    ? listUsers().map((u) => ({ ...u, passkeys: u.id === uid ? passkeys.length : listPasskeys(u.id).length }))
    : [];
  const signupsOpen = signupAllowed(countUsers());
  const owner = isOwner ? user : listUsers().find((u) => u.role === "owner");

  // ── Integrations ──
  const agent = agentStatus();
  const toolCount = enabledTools().length;
  const readOnly = agentReadOnly();
  const tokenSet = apiTokenEnabled();

  const h = await headers();
  // Would a token-less API/MCP call to this same address be accepted? (loopback host, no proxy, same site)
  const local = tokenlessAccess(h);
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const origin = process.env.WALLET_PUBLIC_URL?.replace(/\/+$/, "") || `${proto}://${host}`;
  const repo = process.cwd();
  const dbFile = path.resolve(dbPath());
  const dbEnv = process.env.WALLET_DB_PATH ? dbFile : null;
  const counts = dataCounts(uid);
  const timezones = Intl.supportedValuesOf("timeZone");

  // Local MCP acts as the owner unless WALLET_USER_ID says otherwise: members get their id baked in.
  const launcher = path.join(repo, "bin", "wallet-mcp.mjs");
  const mcpEnv: [string, string][] = [
    ...(dbEnv ? ([["WALLET_DB_PATH", dbEnv]] as [string, string][]) : []),
    ...(!isOwner ? ([["WALLET_USER_ID", uid]] as [string, string][]) : []),
  ];
  const stdio = `claude mcp add wallet${mcpEnv.map(([k, v]) => ` -e ${k}=${v}`).join("")} -- node ${launcher}`;
  const codex = [
    "[mcp_servers.wallet]",
    'command = "node"',
    `args = ["${launcher}"]`,
    ...(mcpEnv.length ? [`env = { ${mcpEnv.map(([k, v]) => `${k} = "${v}"`).join(", ")} }`] : []),
  ].join("\n");
  const bearer = tokenSet ? ' -H "Authorization: Bearer $WALLET_API_TOKEN"' : "";
  const remote = `claude mcp add --transport http wallet ${origin}/api/mcp${tokenSet ? ' --header "Authorization: Bearer $WALLET_API_TOKEN"' : ""}`;
  const rest = [
    `curl${bearer} ${origin}/api/tools`,
    `curl -X POST${bearer} -H "Content-Type: application/json" \\`,
    `  -d '{}' ${origin}/api/tools/<name>`,
  ].join("\n");
  const chat = [
    `curl -X POST ${origin}/api/agent${bearer} \\`,
    `  -H "Content-Type: application/json" -d '{"message": "How much did I spend on groceries?"}'`,
  ].join("\n");
  const actsAs = isOwner ? "you (the owner)" : `the owner${owner ? ` (${owner.name})` : ""}`;

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Currency, sign-in, Telegram, categories, integrations and your data." />

      <nav aria-label="Settings sections" className="-mt-2 flex flex-wrap gap-1.5">
        {sections.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-ink-2 hover:text-ink">
            {label}
          </a>
        ))}
      </nav>

      {passkeys.length === 0 && (
        <div role="alert" className="flex gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-card">
          <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <p className="text-ink-2">
            <span className="font-medium text-ink">You don’t have a passkey yet.</span> You’re signed in with a one-time link —{" "}
            <a href="#security" className="font-medium text-accent hover:underline">
              add a passkey
            </a>{" "}
            so you can sign in next time.
          </p>
        </div>
      )}

      <Card id="preferences" className="scroll-mt-20">
        <CardHeader title="Preferences" subtitle="Used everywhere: amounts, dates, reminders" />
        <PreferencesForm initial={prefs} timezones={timezones} otherCurrencies={otherCurrencies} currencyNames={names} />
      </Card>

      <Card id="currency" className="scroll-mt-20">
        <CardHeader
          title="Exchange rates"
          subtitle={`Accounts and transactions keep their own currency; totals are converted to ${base} with daily rates`}
        />
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          <StatusItem
            ok={fresh}
            warn={!fresh}
            label="Latest rates"
            value={fxDate ? fmtDate(fxDate) : "None yet"}
            detail={
              !fxDate
                ? "Amounts in other currencies can’t be converted until rates are downloaded"
                : fxAge !== null && fxAge <= 0
                  ? "today"
                  : fxAge === 1
                    ? "yesterday"
                    : `${fxAge} days old`
            }
          />
          <StatusItem ok label="Currencies" value={`${known.length} with rates`} detail="fiat, crypto and metals" />
          <StatusItem ok label="Source" value="Free, no API key" detail={`${FX_SOURCE}, refreshed daily`} />
        </div>
        <div className="mt-4">
          <RefreshRatesButton />
        </div>

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-medium text-ink-2">Currencies you use</h3>
          {foreign.length === 0 ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
              Everything is in {base} so far — nothing to convert. Accounts and transactions can use any currency.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {foreign.map((c) => {
                const r = rates[c] ?? null;
                return (
                  <li key={c} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm">
                        <span className="font-mono font-semibold text-ink">{c}</span>
                        {names[c] && names[c] !== c && <span className="text-ink-2"> · {names[c]}</span>}
                      </div>
                      <div className="text-xs text-muted">in {[...usage.get(c)!].join(", ")}</div>
                    </div>
                    {r ? (
                      <div className="tabular text-right text-sm">
                        <div className="text-ink">
                          1 {c} = <span className="font-semibold">{rateFmt(r)}</span> {base}
                        </div>
                        <div className="text-xs text-muted">
                          1 {base} = {rateFmt(1 / r)} {c}
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-critical-text">
                        <AlertTriangle size={13} aria-hidden /> No rate yet: counted as 0 in totals
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card id="security" className="scroll-mt-20">
        <CardHeader
          title="Security"
          subtitle="Sign in with a passkey: Face ID, Touch ID, Windows Hello or a security key."
          action={
            <SignOutButton className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-ink hover:bg-surface-2" />
          }
        />
        {passkeys.length > 0 ? (
          <PasskeyList passkeys={passkeys} />
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-ink-2">
            No passkeys yet. Add one below, then you can sign in without a link.
          </p>
        )}

        <div className="mt-5 space-y-2.5 border-t border-border pt-4">
          <h3 className="text-xs font-medium text-ink-2">Add a passkey</h3>
          <AddPasskey />
          <p className="flex max-w-2xl gap-1.5 text-xs leading-relaxed text-muted">
            <QrCode size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              On a computer, <span className="text-ink-2">Add an iPhone (QR)</span> shows a QR code: scan it with your iPhone’s camera
              and the passkey is saved in iCloud Keychain, so you can sign in with Face ID from any device.
            </span>
          </p>
        </div>

        <p className="mt-4 flex gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <LifeBuoy size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <span>
            Lost every passkey? On the machine running wallet, <Code>npm run auth:link</Code> prints a one-time sign-in link.
          </span>
        </p>
      </Card>

      <Card id="telegram" className="scroll-mt-20">
        <CardHeader
          title="Telegram"
          subtitle="Reminders, balance updates and the assistant, right in a chat"
          action={
            <span className="shrink-0 whitespace-nowrap">
              {user.telegramChatId !== null ? <Badge tone="good">Linked</Badge> : <Badge>Not linked</Badge>}
            </span>
          }
        />
        <p className="mb-3 text-sm text-ink-2">
          {user.telegramChatId !== null ? (
            <>
              Linked to chat <Code>{String(user.telegramChatId)}</Code>: reminders and bot replies go there.
            </>
          ) : (
            <>Generate a code, then send it to your bot to link your chat. One chat per person.</>
          )}
        </p>
        <TelegramLink linked={user.telegramChatId !== null} chatId={user.telegramChatId} bot={await botUsername()} />
        <div className="mt-4 flex gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
          {botTokenSet ? (
            <CheckCircle2 size={14} className="mt-px shrink-0 text-good-text" aria-label="OK" />
          ) : (
            <CircleAlert size={14} className="mt-px shrink-0 text-muted" aria-hidden />
          )}
          <p className="min-w-0">
            The bot runs as its own process: put <Code>TELEGRAM_BOT_TOKEN</Code> (from @BotFather) in <Code>.env</Code> and start{" "}
            <Code>npm run worker</Code>.{" "}
            {botTokenSet ? (
              <span className="text-good-text">The token is set.</span>
            ) : (
              <span className="text-muted">No token in this app’s environment yet.</span>
            )}
            {ownerChats.length > 0 && (
              <span className="mt-1 block text-muted">
                Also acting as you: chat{ownerChats.length > 1 ? "s" : ""} {ownerChats.join(", ")} from <Code>TELEGRAM_CHAT_ID</Code>.
              </span>
            )}
          </p>
        </div>
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
            ok
            label="API & MCP access"
            value={tokenSet ? "Bearer token required" : "No token needed on localhost"}
            detail={
              tokenSet ? (
                "WALLET_API_TOKEN is set: HTTP clients send it as Authorization: Bearer"
              ) : (
                <>
                  Set <Code>WALLET_API_TOKEN</Code> to use the API/MCP from another machine or behind a proxy.
                  <span className={local.ok ? "mt-0.5 block text-good-text" : "mt-0.5 block text-muted"}>
                    {local.ok ? `✓ ${host} qualifies: the snippets below work as they are.` : `This address doesn’t qualify: ${local.reason}.`}
                  </span>
                </>
              )
            }
          />
          <StatusItem
            ok={passkeys.length > 0}
            label="Web sign-in"
            value={`Passkeys · ${passkeys.length} registered`}
            detail={passkeys.length > 0 ? "phishing-resistant, nothing to remember" : "add one under Security"}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Snippet label="Claude Code (local MCP over stdio)" code={stdio} />
            <p className="text-xs text-muted">
              Same server as <Code>npm run mcp</Code>, from any folder, on this app’s database. Acts as {actsAs}
              {isOwner ? (
                <>
                  ; add <Code>-e WALLET_USER_ID=&lt;id&gt;</Code> to act as another member.
                </>
              ) : (
                <> unless <Code>WALLET_USER_ID</Code> is set, so the snippet sets it to your id.</>
              )}
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Snippet label="Codex — ~/.codex/config.toml" code={codex} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Snippet label="MCP over HTTP" code={remote} />
            <p className="text-xs text-muted">
              {tokenSet ? (
                <>
                  Export the same <Code>WALLET_API_TOKEN</Code> in your shell.
                </>
              ) : (
                <>
                  No header needed on localhost while <Code>WALLET_API_TOKEN</Code> is empty (the default). With a token, add{" "}
                  <Code>--header &quot;Authorization: Bearer $WALLET_API_TOKEN&quot;</Code>.
                </>
              )}{" "}
              Acts as the owner unless the server sets <Code>WALLET_USER_ID</Code>.
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

      {isOwner && (
        <Card id="members" className="scroll-mt-20">
          <CardHeader
            title="Members"
            subtitle="Everyone gets a separate, private wallet on this server"
            action={
              <span className="shrink-0 whitespace-nowrap">
                {signupsOpen ? <Badge tone="accent">Sign-ups open</Badge> : <Badge>Sign-ups closed</Badge>}
              </span>
            }
          />
          <ul className="divide-y divide-border rounded-xl border border-border">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-tint text-xs font-semibold text-accent"
                    aria-hidden
                  >
                    {m.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium [overflow-wrap:anywhere] text-ink">
                      {m.name}
                      {m.id === uid && <span className="font-normal text-muted"> (you)</span>}
                    </div>
                    <div className="text-xs text-muted">
                      Joined {m.createdAt ? fmtDate(m.createdAt) : "—"} · {m.passkeys} passkey{m.passkeys === 1 ? "" : "s"}
                      {m.telegramChatId !== null ? " · Telegram linked" : ""}
                    </div>
                  </div>
                </div>
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role === "owner" ? "Owner" : "Member"}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 flex gap-1.5 text-xs text-ink-2">
            <Users size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <span>
              {signupsOpen ? (
                <>
                  <Code>WALLET_ALLOW_SIGNUP</Code> is on: anyone who can reach this address can create their own wallet at{" "}
                  <Code>{`${origin}/signup`}</Code>. Remove it to close sign-ups.
                </>
              ) : (
                <>
                  Only existing members can sign in. To let someone create their own wallet at <Code>/signup</Code>, set{" "}
                  <Code>WALLET_ALLOW_SIGNUP=1</Code> and restart.
                </>
              )}
            </span>
          </p>
        </Card>
      )}

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

/** Localized currency names ("EUR" → "Euro"); codes without a name are left out. */
function currencyNames(locale: string, codes: string[]): Record<string, string> {
  let dn: Intl.DisplayNames;
  try {
    dn = new Intl.DisplayNames([locale, "en"], { type: "currency" });
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const c of codes) {
    try {
      const name = dn.of(c);
      if (name && name !== c) out[c] = name;
    } catch {
      // Not a well-formed code: skip.
    }
  }
  return out;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-ink [overflow-wrap:anywhere]">{children}</code>;
}

function StatusItem({ ok, warn, label, value, detail }: { ok: boolean; warn?: boolean; label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2.5">
      {ok ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good-text" aria-label="OK" />
      ) : warn ? (
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-muted" aria-label="Check" />
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
