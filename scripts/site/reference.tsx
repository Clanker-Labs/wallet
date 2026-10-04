import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { BLOB, CodeBlock, Heading } from "./markdown";

// ════════════════════════════════════════════════════════════════════════
// Agent tools
// ════════════════════════════════════════════════════════════════════════

export interface ToolDoc {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** `z.toJSONSchema(tool.input, { io: "input" })` without `$schema`. */
  schema: JsonSchema;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  additionalProperties?: unknown;
}

interface ParamRow {
  name: string;
  depth: number;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
  constraints: string[];
}

function typeLabel(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf) return s.anyOf.map(typeLabel).join(" | ");
  if (s.type === "array") {
    const inner = s.items ? typeLabel(s.items) : "any";
    return inner.includes("|") ? `(${inner})[]` : `${inner}[]`;
  }
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return s.type ?? "any";
}

const SAFE = Number.MAX_SAFE_INTEGER;

function constraintsOf(s: JsonSchema): string[] {
  const out: string[] = [];
  const min = s.minimum !== undefined && Math.abs(s.minimum) < SAFE ? s.minimum : undefined;
  const max = s.maximum !== undefined && Math.abs(s.maximum) < SAFE ? s.maximum : undefined;
  if (min !== undefined && max !== undefined) out.push(`${min} to ${max}`);
  else if (min !== undefined) out.push(`≥ ${min}`);
  else if (max !== undefined) out.push(`≤ ${max}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.exclusiveMaximum !== undefined) out.push(`< ${s.exclusiveMaximum}`);
  if (s.minLength !== undefined && s.maxLength !== undefined) out.push(`${s.minLength} to ${s.maxLength} chars`);
  else if (s.minLength !== undefined) out.push(`min ${s.minLength} chars`);
  else if (s.maxLength !== undefined) out.push(`max ${s.maxLength} chars`);
  if (s.minItems !== undefined && s.maxItems !== undefined) out.push(`${s.minItems} to ${s.maxItems} items`);
  else if (s.minItems !== undefined) out.push(`min ${s.minItems} items`);
  else if (s.maxItems !== undefined) out.push(`max ${s.maxItems} items`);
  if (s.pattern) out.push(`pattern ${s.pattern}`);
  if (s.format) out.push(s.format);
  return out;
}

/** The object schema nested in a property (directly, in an anyOf, or as array items). */
function nestedObject(s: JsonSchema): { schema: JsonSchema; suffix: string } | null {
  if (s.type === "object" && s.properties) return { schema: s, suffix: "" };
  const variant = s.anyOf?.find((v) => v.type === "object" && v.properties);
  if (variant) return { schema: variant, suffix: "" };
  if (s.type === "array" && s.items?.type === "object" && s.items.properties) return { schema: s.items, suffix: "[]" };
  return null;
}

function paramRows(schema: JsonSchema, prefix = "", depth = 0): ParamRow[] {
  const rows: ParamRow[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const name = prefix + key;
    // Constraints of a nullable/optional union live on its non-null variant.
    const main = prop.anyOf?.find((v) => v.type !== "null") ?? prop;
    rows.push({
      name,
      depth,
      type: typeLabel(prop),
      required: (schema.required ?? []).includes(key),
      defaultValue: prop.default,
      description: prop.description || main.description || undefined,
      constraints: constraintsOf(main === prop ? prop : { ...main, ...prop }),
    });
    const nested = nestedObject(prop);
    if (nested) rows.push(...paramRows(nested.schema, `${name}${nested.suffix}.`, depth + 1));
  }
  return rows;
}

/** Tool descriptions are prompts: keep their line breaks, render "- " lines as a list. */
function Description({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length} className="tool-desc-list">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) list.push(line.slice(2));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>);
    }
  }
  flush();
  return <div className="tool-desc">{blocks}</div>;
}

/** `"a" | "b" | null` → one chip per alternative, so long unions wrap between values. */
function TypeChips({ type }: { type: string }) {
  const parts = type.split(" | ");
  return (
    <span className="type-chips">
      {parts.map((p, i) => (
        <span key={i}>
          {i ? <span className="type-sep"> | </span> : null}
          <code>{p}</code>
        </span>
      ))}
    </span>
  );
}

function ParamTable({ schema }: { schema: JsonSchema }) {
  const rows = paramRows(schema);
  if (!rows.length) return <p className="muted">No parameters.</p>;
  return (
    <div className="table-wrap">
      <table className="params">
        <thead>
          <tr>
            <th>Parameter</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="param-name" style={r.depth ? { paddingLeft: `${0.75 + r.depth * 1}rem` } : undefined}>
                <code>{r.name}</code>
                {r.required ? <span className="req">required</span> : null}
              </td>
              <td className="param-type">
                <TypeChips type={r.type} />
              </td>
              <td>
                {r.description ? <span>{r.description}</span> : null}
                {r.constraints.length || r.defaultValue !== undefined ? (
                  <span className="param-meta">
                    {r.constraints.join(" · ")}
                    {r.constraints.length && r.defaultValue !== undefined ? " · " : ""}
                    {r.defaultValue !== undefined ? (
                      <>
                        default <code>{JSON.stringify(r.defaultValue)}</code>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolEntry({ t }: { t: ToolDoc }) {
  return (
    <section className="ref-entry">
      <Heading level={3} id={t.name}>
        <code>{t.name}</code>
      </Heading>
      <p className="ref-meta">
        <span className={t.readOnly ? "badge badge-read" : "badge badge-write"}>{t.readOnly ? "read-only" : "write"}</span>
        <span className="ref-title">{t.title}</span>
      </p>
      <Description text={t.description} />
      <ParamTable schema={t.schema} />
      <details className="schema">
        <summary>Input JSON Schema</summary>
        <CodeBlock code={JSON.stringify(t.schema, null, 2)} lang="json" />
      </details>
    </section>
  );
}

export function ToolsReference({ tools }: { tools: ToolDoc[] }) {
  const read = tools.filter((t) => t.readOnly);
  const write = tools.filter((t) => !t.readOnly);
  return (
    <>
      <Heading level={2} id="index">
        Index
      </Heading>
      <p>
        {tools.length} tools: {read.length} read-only, {write.length} write. Generated from{" "}
        <a href={`${BLOB}src/server/agent/tools.ts`}>src/server/agent/tools.ts</a> at build time.
      </p>
      <div className="table-wrap">
        <table className="tool-index">
          <thead>
            <tr>
              <th>Tool</th>
              <th>What it does</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td>
                  <a href={`#${t.name}`}>
                    <code>{t.name}</code>
                  </a>
                </td>
                <td>{t.title}</td>
                <td>
                  <span className={t.readOnly ? "badge badge-read" : "badge badge-write"}>{t.readOnly ? "read" : "write"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Heading level={2} id="read-tools">
        Read tools
      </Heading>
      {read.map((t) => (
        <ToolEntry key={t.name} t={t} />
      ))}
      <Heading level={2} id="write-tools">
        Write tools
      </Heading>
      <p>
        Hidden from every surface when <code>WALLET_AGENT_READONLY=1</code>. After a write, the agent&apos;s SQL sandbox for that
        user is dropped so the next <code>query_sql</code> sees the change.
      </p>
      {write.map((t) => (
        <ToolEntry key={t.name} t={t} />
      ))}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Data model
// ════════════════════════════════════════════════════════════════════════

export interface ColumnDoc {
  name: string;
  type: string;
  notNull: boolean;
  primary: boolean;
  autoIncrement: boolean;
  unique: boolean;
  defaultValue: string | null;
  references: string | null;
  comment: string | null;
  values: string[] | null;
  valuesNote: string | null;
}

export interface TableDoc {
  name: string;
  exportName: string;
  group: string;
  comment: string | null;
  columns: ColumnDoc[];
  primaryKey: string[] | null;
  indexes: { name: string; unique: boolean; columns: string[] }[];
  scope: string;
}

/** Comments and `$type<…>()` annotations, read from the schema source (drizzle doesn't keep them). */
export interface SchemaSourceInfo {
  tables: Map<string, { group: string; comment: string | null; columns: Map<string, { comment: string | null; tsType: string | null }> }>;
  aliases: Map<string, string[]>;
}

const cleanDoc = (raw: string) =>
  raw
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");

function docBefore(text: string): string | null {
  const m = text.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/);
  return m ? cleanDoc(m[1]) : null;
}

/** `$type<…>` with nested generics. */
function typeArg(def: string): string | null {
  const start = def.indexOf("$type<");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + 5; i < def.length; i++) {
    if (def[i] === "<") depth++;
    else if (def[i] === ">" && --depth === 0) return def.slice(start + 6, i).trim();
  }
  return null;
}

export function parseSchemaSource(src: string): SchemaSourceInfo {
  const tables: SchemaSourceInfo["tables"] = new Map();
  const starts = [...src.matchAll(/export const (\w+) = sqliteTable\(\s*"(\w+)"/g)];
  starts.forEach((m, i) => {
    const begin = m.index!;
    const end = i + 1 < starts.length ? starts[i + 1].index! : src.length;
    const before = src.slice(0, begin);
    const groups = [...before.matchAll(/\/\/ ── ([^─\n]+?) ─/g)];
    const group = groups.length ? groups[groups.length - 1][1].trim() : "Tables";
    const segment = src.slice(begin, end);
    const columns = new Map<string, { comment: string | null; tsType: string | null }>();
    const cols = [...segment.matchAll(/(\w+):\s*(?:text|integer|real|blob)\(\s*"(\w+)"/g)];
    cols.forEach((c, j) => {
      const defEnd = j + 1 < cols.length ? cols[j + 1].index! : segment.length;
      const def = segment.slice(c.index!, defEnd);
      columns.set(c[2], { comment: docBefore(segment.slice(0, c.index!)), tsType: typeArg(def) });
    });
    tables.set(m[2], { group, comment: docBefore(before), columns });
  });
  const aliases = new Map<string, string[]>();
  for (const m of src.matchAll(/export type (\w+) = ((?:"[^"]*"\s*\|?\s*)+);/g)) {
    aliases.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  return { tables, aliases };
}

/** Allowed values (or a note) for a `$type<…>` annotation. */
export function describeTsType(t: string | null, named: Map<string, string[]>): { values: string[] | null; note: string | null } {
  if (!t) return { values: null, note: null };
  const literals = [...t.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (literals.length && /^("[^"]*"\s*\|?\s*)+$/.test(t)) return { values: literals, note: null };
  if (named.has(t)) return { values: named.get(t)!, note: null };
  if (t === "string[]") return { values: null, note: "JSON array of strings" };
  if (t === "LoanParams") return { values: null, note: "JSON LoanParams: principal, annualRatePct, durationMonths, startDate, insuranceRatePct?" };
  if (t.startsWith("Record<")) return { values: null, note: "JSON object" };
  return { values: null, note: t };
}

function ColumnFlags({ c }: { c: ColumnDoc }) {
  const parts: ReactNode[] = [];
  if (c.autoIncrement) parts.push("auto-increment");
  if (c.unique) parts.push("unique");
  if (c.references) parts.push(`references ${c.references}`);
  if (c.defaultValue !== null)
    parts.push(
      <>
        default <code>{c.defaultValue}</code>
      </>,
    );
  if (!parts.length) return null;
  return (
    <span className="param-meta">
      {parts.map((p, i) => (
        <span key={i}>
          {i ? " · " : ""}
          {p}
        </span>
      ))}
    </span>
  );
}

function ColumnTable({ table }: { table: TableDoc }) {
  return (
    <div className="table-wrap">
      <table className="columns">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name}>
              <td className="param-name">
                <code>{c.name}</code>
                {c.primary ? <span className="req">PK</span> : null}
              </td>
              <td className="param-type">
                <code>{c.type}</code>
                <span className="param-meta">{c.notNull ? "not null" : "nullable"}</span>
              </td>
              <td>
                {c.comment ? <span>{c.comment}</span> : null}
                {c.values ? (
                  <span className="param-meta">
                    One of{" "}
                    {c.values.map((v, i) => (
                      <span key={v}>
                        {i ? ", " : ""}
                        <code>{v}</code>
                      </span>
                    ))}
                  </span>
                ) : null}
                {c.valuesNote ? <span className="param-meta">{c.valuesNote}</span> : null}
                <ColumnFlags c={c} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataModelReference({ tables }: { tables: TableDoc[] }) {
  const groups = [...new Set(tables.map((t) => t.group))];
  const groupId = (g: string) => g.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    <>
      <Heading level={2} id="tables">
        Tables
      </Heading>
      <p>
        {tables.length} tables, generated from <a href={`${BLOB}src/server/db/schema.ts`}>src/server/db/schema.ts</a> with drizzle&apos;s{" "}
        <code>getTableConfig</code>. Migrations live in <a href={`${BLOB}drizzle`}>drizzle/</a>.
      </p>
      <div className="table-wrap">
        <table className="tool-index">
          <thead>
            <tr>
              <th>Table</th>
              <th>Owner</th>
              <th>What it holds</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.name}>
                <td>
                  <a href={`#${t.name}`}>
                    <code>{t.name}</code>
                  </a>
                </td>
                <td className="nowrap">{t.scope}</td>
                <td>{t.comment ? firstSentence(t.comment) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {groups.map((g) => (
        <section key={g}>
          <Heading level={2} id={groupId(g)}>
            {g}
          </Heading>
          {tables
            .filter((t) => t.group === g)
            .map((t) => (
              <section key={t.name} className="ref-entry">
                <Heading level={3} id={t.name}>
                  <code>{t.name}</code>
                </Heading>
                {t.comment ? <p>{t.comment}</p> : null}
                <ColumnTable table={t} />
                {t.primaryKey || t.indexes.length ? (
                  <ul className="index-list">
                    {t.primaryKey ? (
                      <li>
                        Primary key <code>({t.primaryKey.join(", ")})</code>
                      </li>
                    ) : null}
                    {t.indexes.map((ix) => (
                      <li key={ix.name}>
                        {ix.unique ? "Unique index" : "Index"} <code>{ix.name}</code> on <code>({ix.columns.join(", ")})</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
        </section>
      ))}
    </>
  );
}

function firstSentence(s: string): string {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}

// ════════════════════════════════════════════════════════════════════════
// Configuration (.env.example)
// ════════════════════════════════════════════════════════════════════════

export interface EnvVar {
  name: string;
  /** Value written in .env.example (empty string when blank). */
  example: string;
  /** Set (uncommented) in .env.example. */
  active: boolean;
  description: string[];
}

export interface EnvSection {
  title: string;
  vars: EnvVar[];
  notes: string[];
}

/**
 * Parse `.env.example`: `# ── Title ──` starts a section, comment lines
 * describe the next variable, and variables listed back to back share the
 * description above them. Comments left at the end of a section are notes.
 */
export function parseEnvExample(text: string): EnvSection[] {
  const sections: EnvSection[] = [];
  let current: EnvSection | null = null;
  let pending: string[] = [];
  let lastDescription: string[] | null = null;
  const flushNotes = () => {
    if (current && pending.length) current.notes.push(...pending);
    pending = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      lastDescription = null;
      continue;
    }
    const section = line.match(/^#\s*──\s*(.+?)\s*─+\s*$/);
    if (section) {
      flushNotes();
      current = { title: section[1], vars: [], notes: [] };
      sections.push(current);
      lastDescription = null;
      continue;
    }
    if (!current) {
      current = { title: "General", vars: [], notes: [] };
      sections.push(current);
    }
    const v = line.match(/^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (v) {
      const description: string[] = pending.length ? pending : (lastDescription ?? []);
      current.vars.push({ name: v[2], example: v[3].trim(), active: !v[1], description });
      lastDescription = description;
      pending = [];
      continue;
    }
    if (line.startsWith("#")) {
      pending.push(line.replace(/^#\s?/, ""));
      lastDescription = null;
    }
  }
  flushNotes();
  return sections;
}

/** Inline `code` spans in .env.example comments. */
function inlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>,
  );
}

export interface ExtraEnv {
  name: string;
  description: string;
  files: string[];
}

export function ConfigurationReference({ sections, defaults, extra }: { sections: EnvSection[]; defaults: Record<string, string>; extra: ExtraEnv[] }) {
  const sectionId = (t: string) => t.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    <>
      {sections.map((s) => (
        <section key={s.title}>
          <Heading level={2} id={sectionId(s.title)}>
            {s.title}
          </Heading>
          <div className="env-list">
            {s.vars.map((v) => (
              <div className="env-var" key={v.name} id={v.name}>
                <div className="env-head">
                  <code className="env-name">{v.name}</code>
                  {v.active ? <span className="badge badge-read">set in .env.example</span> : null}
                  {defaults[v.name] ? (
                    <span className="env-default">
                      default {/\s/.test(defaults[v.name]) ? defaults[v.name] : <code>{defaults[v.name]}</code>}
                    </span>
                  ) : null}
                </div>
                {v.description.map((d, i) => (
                  <p key={i}>{inlineCode(d.replace(/:\s*$/, ""))}</p>
                ))}
                {v.example ? (
                  <p className="env-example">
                    Example: <code>{`${v.name}=${v.example}`}</code>
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {s.notes.length ? (
            <aside className="callout callout-note">
              {s.notes.map((n, i) => (
                <p key={i}>{inlineCode(n)}</p>
              ))}
            </aside>
          ) : null}
        </section>
      ))}
      {extra.length ? (
        <section>
          <Heading level={2} id="also-read-by-the-code">
            Also read by the code
          </Heading>
          <p>
            Not in <code>.env.example</code>, found by scanning <code>src/</code> and <code>bin/</code> for <code>process.env</code> at build time.
          </p>
          <div className="env-list">
            {extra.map((v) => (
              <div className="env-var" key={v.name} id={v.name}>
                <div className="env-head">
                  <code className="env-name">{v.name}</code>
                </div>
                <p>{inlineCode(v.description)}</p>
                <p className="env-example">
                  Read in{" "}
                  {v.files.map((f, i) => (
                    <span key={f}>
                      {i ? ", " : ""}
                      <a href={`${BLOB}${f}`}>{f}</a>
                    </span>
                  ))}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/** `process.env.NAME` / `process.env["NAME"]` across source files, with where each is read. */
export function scanEnvUsage(root: string, dirs: string[]): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) {
          const name = m[1] ?? m[2];
          const rel = path.relative(root, full).split(path.sep).join("/");
          if (!found.has(name)) found.set(name, new Set());
          found.get(name)!.add(rel);
        }
      }
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
}

// ════════════════════════════════════════════════════════════════════════
// HTTP API route index
// ════════════════════════════════════════════════════════════════════════

export interface RouteDoc {
  path: string;
  methods: string[];
  file: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Every `route.ts` under src/app/api with the HTTP methods it exports. */
export function scanApiRoutes(root: string): RouteDoc[] {
  const base = path.join(root, "src", "app");
  const out: RouteDoc[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts" || entry.name === "route.tsx") {
        const text = fs.readFileSync(full, "utf8");
        const methods = new Set<string>();
        for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g)) if (METHODS.includes(m[1])) methods.add(m[1]);
        for (const m of text.matchAll(/export\s*\{([^}]+)\}/g))
          for (const part of m[1].split(",")) {
            const name = part.split(/\s+as\s+/).pop()!.trim();
            if (METHODS.includes(name)) methods.add(name);
          }
        const rel = path.relative(base, path.dirname(full)).split(path.sep);
        const urlPath = "/" + rel.filter((s) => !s.startsWith("(")).map((s) => s.replace(/^\[(.+)\]$/, ":$1")).join("/");
        out.push({ path: urlPath, methods: METHODS.filter((m) => methods.has(m)), file: path.relative(root, full).split(path.sep).join("/") });
      }
    }
  };
  walk(path.join(base, "api"));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function RouteIndex({ routes }: { routes: RouteDoc[] }) {
  return (
    <>
      <Heading level={2} id="route-index">
        Route index
      </Heading>
      <p>Generated from the route files under <code>src/app/api</code> at build time.</p>
      <div className="table-wrap">
        <table className="tool-index">
          <thead>
            <tr>
              <th>Route</th>
              <th>Methods</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.path}>
                <td>
                  <code>{r.path}</code>
                </td>
                <td className="nowrap">
                  {r.methods.map((m) => (
                    <span key={m} className={`method method-${m.toLowerCase()}`}>
                      {m}
                    </span>
                  ))}
                </td>
                <td>
                  <a href={`${BLOB}${r.file}`}>{r.file.replace(/^src\/app/, "")}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
