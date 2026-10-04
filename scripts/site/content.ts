import fs from "node:fs";
import path from "node:path";

/** Sidebar groups, in display order. */
export const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "features", label: "Features" },
  { id: "technical", label: "Technical" },
  { id: "reference", label: "Reference" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

/** Generated reference blocks a page can append to its Markdown body. */
export type GeneratedKind = "tools" | "data-model" | "configuration" | "api";

export interface Page {
  /** Output file is `<slug>.html` at the site root. */
  slug: string;
  title: string;
  /** Shorter label for the sidebar (defaults to the title). */
  nav: string;
  description: string;
  section: SectionId;
  order: number;
  /** Clip name in site/media (`<video>.mp4` + `<video>.jpg`). */
  video?: string;
  /** Short line for the landing page's demo grid. */
  blurb?: string;
  layout: "doc" | "landing";
  generate?: GeneratedKind;
  /** Markdown body (after the front matter). */
  body: string;
  /** Repo-relative path of the Markdown source, for "Edit on GitHub". */
  source: string;
}

/**
 * Minimal front matter: `key: value` lines between `---` fences. Values are
 * plain strings (no YAML quoting rules beyond stripping matching quotes).
 */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new Error(`Bad front matter line: ${line}`);
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));
const GENERATED = new Set<string>(["tools", "data-model", "configuration", "api"]);

export function loadPages(contentDir: string, repoRoot: string): Page[] {
  const files = fs
    .readdirSync(contentDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const pages = files.map((file): Page => {
    const full = path.join(contentDir, file);
    const { data, body } = parseFrontMatter(fs.readFileSync(full, "utf8"));
    const slug = file.replace(/\.md$/, "");
    const where = `site/content/${file}`;
    if (!data.title) throw new Error(`${where}: missing "title"`);
    if (!data.description) throw new Error(`${where}: missing "description"`);
    if (!SECTION_IDS.has(data.section)) throw new Error(`${where}: "section" must be one of ${[...SECTION_IDS].join(", ")}`);
    if (data.generate && !GENERATED.has(data.generate)) throw new Error(`${where}: unknown "generate: ${data.generate}"`);
    const order = Number(data.order ?? 100);
    if (!Number.isFinite(order)) throw new Error(`${where}: "order" must be a number`);
    return {
      slug,
      title: data.title,
      nav: data.nav || data.title,
      description: data.description,
      section: data.section as SectionId,
      order,
      video: data.video || undefined,
      blurb: data.blurb || undefined,
      layout: data.layout === "landing" ? "landing" : "doc",
      generate: (data.generate as GeneratedKind) || undefined,
      body,
      source: path.relative(repoRoot, full).split(path.sep).join("/"),
    };
  });
  const sectionRank = (s: SectionId) => SECTIONS.findIndex((x) => x.id === s);
  return pages.sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.order - b.order || a.slug.localeCompare(b.slug));
}
