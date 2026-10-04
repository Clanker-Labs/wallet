import type { ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Diagram } from "./diagrams";

export const REPO = "https://github.com/Clanker-Labs/wallet";
export const BLOB = `${REPO}/blob/main/`;

// ── Minimal hast shapes (the tree react-markdown hands to rehype plugins) ──

interface HText {
  type: "text";
  value: string;
}
interface HElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HNode[];
}
type HNode = HText | HElement | { type: string; children?: HNode[]; value?: string };
interface HRoot {
  type: "root";
  children: HNode[];
}

const isElement = (n: HNode | undefined, tag?: string): n is HElement =>
  !!n && n.type === "element" && (!tag || (n as HElement).tagName === tag);

export function textOf(n: HNode): string {
  if (n.type === "text") return (n as HText).value;
  return ((n as { children?: HNode[] }).children ?? []).map(textOf).join("");
}

/** GitHub-style heading slugs, deduplicated per page. */
export function createSlugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-") || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/**
 * Rehype plugin: ids + anchor links on h2/h3, and GitHub-style callouts
 * (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`) turned into styled asides.
 */
function rehypeDocs(options: { slug: (text: string) => string }) {
  return (tree: HRoot) => {
    const visit = (parent: { children?: HNode[] }) => {
      for (const node of parent.children ?? []) {
        if (!isElement(node)) continue;
        if (node.tagName === "h2" || node.tagName === "h3") {
          const id = options.slug(textOf(node));
          node.properties.id = id;
          node.children.push({
            type: "element",
            tagName: "a",
            properties: { className: ["anchor"], href: `#${id}`, ariaHidden: "true", tabIndex: -1 },
            children: [{ type: "text", value: "#" }],
          });
        } else if (node.tagName === "blockquote") {
          const firstP = node.children.find((c): c is HElement => isElement(c, "p"));
          const first = firstP?.children[0];
          const m = first?.type === "text" ? (first as HText).value.match(/^\[!(NOTE|TIP|WARNING|IMPORTANT)\]\s*/) : null;
          if (firstP && first && m) {
            (first as HText).value = (first as HText).value.slice(m[0].length);
            const kind = m[1].toLowerCase();
            node.tagName = "aside";
            node.properties.className = ["callout", `callout-${kind}`];
            firstP.children.unshift({
              type: "element",
              tagName: "strong",
              properties: { className: ["callout-label"] },
              children: [{ type: "text", value: { note: "Note", tip: "Tip", warning: "Warning", important: "Important" }[kind]! }],
            });
          }
        }
        visit(node);
      }
    };
    visit(tree);
  };
}

/** `gh:src/x.ts` → GitHub blob URL; `page.md` → `page.html`; everything else as usual. */
export function transformUrl(url: string): string {
  if (url.startsWith("gh:")) return BLOB + url.slice(3);
  const md = url.match(/^([\w-]+)\.md(#.*)?$/);
  if (md) return `${md[1]}.html${md[2] ?? ""}`;
  return defaultUrlTransform(url);
}

const COMMENT_LANGS = new Set(["bash", "sh", "shell", "toml", "yaml", "yml", "dotenv", "ini", "env"]);

/** Dim `# comments` in shell-like code (cheap, line-based: enough for docs snippets). */
function dimComments(code: string): ReactNode[] {
  return code.split("\n").flatMap((line, i) => {
    const m = line.match(/^(.*?)(^|\s)(#(?!!).*)$/);
    const parts: ReactNode[] = i ? ["\n"] : [];
    if (!m || /["'][^"']*$/.test(m[1])) parts.push(line);
    else
      parts.push(
        m[1] + m[2],
        <span key={i} className="tok-comment">
          {m[3]}
        </span>,
      );
    return parts;
  });
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="code">
      <button type="button" className="copy" aria-label="Copy code">
        Copy
      </button>
      <pre>
        <code className={lang ? `language-${lang}` : undefined}>{lang && COMMENT_LANGS.has(lang) ? dimComments(code) : code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre({ node }) {
    const code = (node?.children ?? [])[0] as unknown as HElement | undefined;
    const cls = (code?.properties?.className as string[] | undefined) ?? [];
    const lang = cls.find((c) => c.startsWith("language-"))?.slice("language-".length);
    const text = code ? textOf(code).replace(/\n$/, "") : "";
    if (lang === "diagram") return <Diagram name={text.trim()} />;
    return <CodeBlock code={text} lang={lang} />;
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  a({ node: _node, href, children, ...rest }) {
    const external = !!href && /^https?:\/\//.test(href);
    return (
      <a href={href} {...rest} {...(external ? { rel: "noopener" } : {})}>
        {children}
      </a>
    );
  },
};

/** Render a Markdown body. `slug` is the page's heading slugger (shared with generated sections). */
export function MarkdownBody({ source, slug }: { source: string; slug: (text: string) => string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeDocs, { slug }]]} components={components} urlTransform={transformUrl}>
      {source}
    </Markdown>
  );
}

/** A heading with the same id/anchor treatment as Markdown headings (for generated content). */
export function Heading({ level, id, children }: { level: 2 | 3; id: string; children: ReactNode }) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag id={id}>
      {children}
      <a className="anchor" href={`#${id}`} aria-hidden="true" tabIndex={-1}>
        #
      </a>
    </Tag>
  );
}
