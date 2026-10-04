/**
 * Static documentation site: `npm run site:build` → site-dist/.
 *
 * Pages are Markdown in site/content (front matter: title, description,
 * section, order, optional nav, video, blurb, layout, generate). Reference
 * pages append blocks generated from the code itself: the agent tool
 * registry, the drizzle schema, .env.example and the API route files.
 * Every link is relative, so the output works under any base path
 * (https://clanker-labs.github.io/wallet/) and straight from file://.
 */
import fs from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPages, type Page } from "./content";
import { BLOB, MarkdownBody, createSlugger } from "./markdown";
import { DocPage, LandingPage, type MediaInfo, type TocEntry } from "./layout";
import {
  ConfigurationReference,
  DataModelReference,
  RouteIndex,
  ToolsReference,
  describeTsType,
  parseEnvExample,
  parseSchemaSource,
  scanApiRoutes,
  scanEnvUsage,
  type ColumnDoc,
  type ExtraEnv,
  type JsonSchema,
  type TableDoc,
  type ToolDoc,
} from "./reference";

// Importing the tool registry pulls in the services; they open the database
// lazily, but make sure nothing could ever touch a real file from here.
process.env.WALLET_DB_PATH = ":memory:";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SITE = path.join(ROOT, "site");
const OUT = path.resolve(ROOT, process.env.SITE_OUT || "site-dist");
const started = Date.now();
const warnings: string[] = [];
const warn = (msg: string) => {
  warnings.push(msg);
  console.warn(`⚠ ${msg}`);
};

// ── Inputs ───────────────────────────────────────────────────────────────

const pages = loadPages(path.join(SITE, "content"), ROOT);
for (const required of ["index", "getting-started", "configuration", "architecture", "security", "tools", "api", "data-model"]) {
  if (!pages.some((p) => p.slug === required)) throw new Error(`site/content/${required}.md is missing (linked from the README)`);
}

/** Width and height from a baseline or progressive JPEG's SOF segment. */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const MEDIA_DIR = path.join(SITE, "media");
function mediaInfo(name: string): MediaInfo {
  const mp4 = fs.existsSync(path.join(MEDIA_DIR, `${name}.mp4`));
  const jpgPath = path.join(MEDIA_DIR, `${name}.jpg`);
  const jpg = fs.existsSync(jpgPath);
  return { mp4, jpg, size: jpg ? jpegSize(fs.readFileSync(jpgPath)) : null };
}
const mediaNames = new Set(["promo", "demo", ...pages.flatMap((p) => (p.video ? [p.video] : []))]);
const media = new Map([...mediaNames].map((n) => [n, mediaInfo(n)]));
const missingMedia = [...media].filter(([, m]) => !m.mp4).map(([n]) => n);

// ── Generated reference data ─────────────────────────────────────────────

async function toolDocs(): Promise<ToolDoc[]> {
  const { z } = await import("zod");
  const { TOOLS } = await import("@/server/agent/tools");
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return { name: t.name, title: t.title, description: t.description, readOnly: t.readOnly, schema: schema as JsonSchema };
  });
}

async function tableDocs(): Promise<TableDoc[]> {
  const schema = await import("@/server/db/schema");
  const domain = await import("@/lib/domain");
  const { is, SQL } = await import("drizzle-orm");
  const { getTableConfig, SQLiteTable, SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
  const dialect = new SQLiteSyncDialect();
  const source = parseSchemaSource(fs.readFileSync(path.join(ROOT, "src/server/db/schema.ts"), "utf8"));
  const named = new Map<string, string[]>([
    ["AccountType", [...domain.ACCOUNT_TYPE_KEYS]],
    ["AssetClass", [...domain.ASSET_CLASSES]],
    ["HoldingType", [...domain.HOLDING_TYPE_KEYS]],
    ...source.aliases,
  ]);
  const MODES: Record<string, string> = {
    SQLiteTimestamp: "integer · ms epoch",
    SQLiteBoolean: "integer · boolean",
    SQLiteTextJson: "text · JSON",
    SQLiteBlobBuffer: "blob",
  };
  const docs: TableDoc[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const cfg = getTableConfig(value);
    const src = source.tables.get(cfg.name);
    if (!src) warn(`schema.ts: could not read comments for table ${cfg.name}`);
    const fks = new Map<string, string>();
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const target = `${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns.map((c) => c.name).join(", ")}`;
      const onDelete = fk.onDelete ? ` (on delete ${fk.onDelete})` : "";
      ref.columns.forEach((c) => fks.set(c.name, `${target}${onDelete}`));
    }
    const columns: ColumnDoc[] = cfg.columns.map((c) => {
      const info = src?.columns.get(c.name);
      const { values, note } = describeTsType(info?.tsType ?? null, named);
      let defaultValue: string | null = null;
      if (c.hasDefault && c.default !== undefined) {
        defaultValue = is(c.default, SQL) ? dialect.sqlToQuery(c.default as InstanceType<typeof SQL>).sql : typeof c.default === "string" ? `'${c.default}'` : String(c.default);
      }
      return {
        name: c.name,
        type: MODES[c.columnType] ?? c.getSQLType(),
        notNull: c.notNull,
        primary: c.primary,
        autoIncrement: Boolean((c as { autoIncrement?: boolean }).autoIncrement),
        unique: c.isUnique,
        defaultValue,
        references: fks.get(c.name) ?? null,
        comment: info?.comment ?? null,
        values,
        valuesNote: note,
      };
    });
    const names = new Set(columns.map((c) => c.name));
    const scope = names.has("user_id")
      ? "user (user_id)"
      : fks.get("account_id")?.startsWith("accounts.")
        ? "user (via account)"
        : fks.get("conversation_id")
          ? "user (via conversation)"
          : cfg.name === "users"
            ? "n/a"
            : "shared";
    docs.push({
      name: cfg.name,
      exportName,
      group: src?.group ?? "Tables",
      comment: src?.comment ?? null,
      columns,
      primaryKey: cfg.primaryKeys.length ? cfg.primaryKeys[0].columns.map((c) => c.name) : null,
      indexes: cfg.indexes.map((ix) => ({
        name: ix.config.name,
        unique: Boolean(ix.config.unique),
        columns: ix.config.columns.map((c) => ("name" in c ? String(c.name) : "expr")),
      })),
      scope,
    });
  }
  // Module namespaces list exports alphabetically: restore the schema file's order.
  const order = [...source.tables.keys()];
  return docs.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** Defaults verified against the code (shown next to each variable). */
const ENV_DEFAULTS: Record<string, string> = {
  WALLET_DB_PATH: "./data/wallet.db",
  WALLET_CURRENCY: "USD",
  WALLET_LOCALE: "en-US",
  WALLET_TIMEZONE: "the system time zone",
  WALLET_PUBLIC_URL: "derived from the request",
  WALLET_ALLOW_SIGNUP: "off",
  WALLET_RP_ID: "the host of WALLET_PUBLIC_URL",
  WALLET_USER_ID: "the owner",
  WALLET_AGENT_PROVIDER: "anthropic",
  WALLET_AGENT_MODEL: "claude-opus-5-5",
  WALLET_AGENT_EFFORT: "medium",
  WALLET_AGENT_READONLY: "0",
  WALLET_CLAUDE_BIN: "claude",
  WALLET_CODEX_BIN: "codex",
};

/** Variables the code reads that .env.example doesn't list. */
const EXTRA_ENV: Record<string, string> = {
  PORT: "Port of `next start` (3000 in the Docker image). `npm run auth:link` also uses it to print `http://localhost:$PORT/…` when `WALLET_PUBLIC_URL` is unset.",
  TELEGRAM_API_URL: "Base URL of a self-hosted Telegram Bot API server for the worker (default `https://api.telegram.org`).",
  ANTHROPIC_AUTH_TOKEN: "Accepted instead of `ANTHROPIC_API_KEY` by the anthropic provider (bearer-token auth in the SDK).",
  ANTHROPIC_PROFILE: "Accepted instead of `ANTHROPIC_API_KEY`: a credentials profile from `ant auth login` (a `~/.config/anthropic` directory also counts).",
  WALLET_MCP_COMMAND: "Command the claude-code / codex providers run to start the wallet MCP server, split on spaces (default: `node bin/wallet-mcp.mjs`).",
  WALLET_ROOT: "Repository root the CLI providers use to find `bin/wallet-mcp.mjs` (default: the working directory).",
  WALLET_MIGRATIONS_DIR: "Folder of drizzle migrations, tried before `./drizzle` (it must contain `meta/_journal.json`).",
};
const IGNORED_ENV = new Set(["PATH", "NODE_ENV"]);

// ── Render ───────────────────────────────────────────────────────────────

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

function extractToc(html: string): TocEntry[] {
  const toc: TocEntry[] = [];
  for (const m of html.matchAll(/<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const text = decode(m[3].replace(/<a [^>]*class="anchor"[^>]*>[\s\S]*?<\/a>/g, "").replace(/<[^>]+>/g, "")).trim();
    toc.push({ level: Number(m[1]) as 2 | 3, id: m[2], text });
  }
  return toc;
}

const doctype = (el: ReactElement) => `<!doctype html>\n${renderToStaticMarkup(el)}\n`;

async function generatedBlock(page: Page): Promise<{ node: ReactElement | null; from: { label: string; href: string }[] }> {
  switch (page.generate) {
    case "tools":
      return {
        node: <ToolsReference tools={await toolDocs()} />,
        from: [{ label: "src/server/agent/tools.ts", href: `${BLOB}src/server/agent/tools.ts` }],
      };
    case "data-model":
      return {
        node: <DataModelReference tables={await tableDocs()} />,
        from: [{ label: "src/server/db/schema.ts", href: `${BLOB}src/server/db/schema.ts` }],
      };
    case "configuration": {
      const sections = parseEnvExample(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8"));
      const documented = new Set(sections.flatMap((s) => s.vars.map((v) => v.name)));
      const extra: ExtraEnv[] = [];
      for (const [name, files] of scanEnvUsage(ROOT, ["src", "bin"])) {
        if (documented.has(name) || IGNORED_ENV.has(name)) continue;
        if (!EXTRA_ENV[name]) warn(`process.env.${name} is read in ${files.join(", ")} but not documented (.env.example or EXTRA_ENV in scripts/site/build.tsx)`);
        extra.push({ name, files, description: EXTRA_ENV[name] ?? "Undocumented." });
      }
      return {
        node: <ConfigurationReference sections={sections} defaults={ENV_DEFAULTS} extra={extra} />,
        from: [{ label: ".env.example", href: `${BLOB}.env.example` }],
      };
    }
    case "api": {
      const routes = scanApiRoutes(ROOT);
      for (const r of routes) {
        if (!page.body.includes(r.path)) warn(`api.md doesn't mention ${r.path} (${r.methods.join(", ")})`);
      }
      return { node: <RouteIndex routes={routes} />, from: [{ label: "src/app/api", href: `${BLOB}src/app/api` }] };
    }
    default:
      return { node: null, from: [] };
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const page of pages) {
  const slug = createSlugger();
  const generated = await generatedBlock(page);
  const bodyHtml = renderToStaticMarkup(
    <>
      <MarkdownBody source={page.body} slug={slug} />
      {generated.node}
    </>,
  );
  const html =
    page.layout === "landing"
      ? doctype(<LandingPage page={page} pages={pages} bodyHtml={bodyHtml} media={media} />)
      : doctype(<DocPage page={page} pages={pages} bodyHtml={bodyHtml} toc={extractToc(bodyHtml)} media={media} generatedFrom={generated.from} />);
  fs.writeFileSync(path.join(OUT, `${page.slug}.html`), html);
}

// ── Static files ─────────────────────────────────────────────────────────

fs.cpSync(path.join(SITE, "assets"), path.join(OUT, "assets"), { recursive: true });
let mediaCount = 0;
if (fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(path.join(OUT, "media"), { recursive: true });
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    // Only finished web media (recorders may leave temp files around while they work).
    if (!/\.(mp4|webm|jpg|jpeg|png|gif|webp|svg)$/i.test(f) || f.startsWith(".")) continue;
    fs.copyFileSync(path.join(MEDIA_DIR, f), path.join(OUT, "media", f));
    mediaCount++;
  }
}
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

// ── Checks: every relative link, asset and #fragment must resolve ────────

const htmlFiles = fs.readdirSync(OUT).filter((f) => f.endsWith(".html"));
const idsByFile = new Map<string, Set<string>>();
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(OUT, f), "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${f}: duplicate id "${id}"`);
    seen.add(id);
  }
  idsByFile.set(f, seen);
}
const broken: string[] = [];
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(OUT, f), "utf8");
  for (const m of html.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)) {
    const url = decode(m[1]);
    if (!url || /^(https?:|mailto:|data:)/.test(url)) continue;
    const [file, frag] = url.split("#");
    const target = file ? path.normalize(file) : f;
    if (target.startsWith("..") || path.isAbsolute(target)) {
      broken.push(`${f}: ${url} (not relative to the site root)`);
      continue;
    }
    if (!fs.existsSync(path.join(OUT, target))) broken.push(`${f}: ${url} (missing file)`);
    else if (frag && target.endsWith(".html") && !idsByFile.get(target)?.has(decodeURIComponent(frag))) broken.push(`${f}: ${url} (missing #${frag})`);
  }
}
if (broken.length) {
  console.error(`✖ ${broken.length} broken link(s):\n  ${broken.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `✔ site-dist: ${htmlFiles.length} pages, ${mediaCount} media files${missingMedia.length ? ` (videos not published yet: ${missingMedia.join(", ")})` : ""}, ${warnings.length} warning(s), ${Date.now() - started} ms → ${path.relative(ROOT, OUT) || OUT}`,
);
