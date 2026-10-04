import type { CSSProperties, ReactNode } from "react";
import { SECTIONS, type Page } from "./content";
import { REPO } from "./markdown";

export const SITE_URL = "https://clanker-labs.github.io/wallet/";

export interface MediaInfo {
  mp4: boolean;
  jpg: boolean;
  /** Poster dimensions (read from the JPEG header), when there is one. */
  size: { width: number; height: number } | null;
}

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

// ── Icons (inline, stroke = currentColor) ───────────────────────────────

const ICONS = {
  github: (
    <path
      fill="currentColor"
      stroke="none"
      d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
    />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  moon: <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  edit: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  arrowLeft: <path d="M19 12H5M12 19l-7-7 7-7" />,
  play: <path d="M7 4.5v15l13-7.5Z" fill="currentColor" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 13v2M15 13v2M2 14h2M20 14h2" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M9 14l2 2 4-4" />
    </>
  ),
  diagram: (
    <>
      <rect x="3" y="3" width="7" height="6" rx="1.5" />
      <rect x="14" y="15" width="7" height="6" rx="1.5" />
      <path d="M6.5 9v4a2 2 0 0 0 2 2H14" />
    </>
  ),
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      className={`icon i-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────

const THEME_BOOT = `(function(){try{var t=localStorage.getItem("wallet-docs-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})();`;

function Html({ page, bodyClass, children }: { page: Page; bodyClass: string; children: ReactNode }) {
  const title = page.slug === "index" ? `wallet · ${page.title}` : `${page.title} · wallet docs`;
  const url = page.slug === "index" ? SITE_URL : `${SITE_URL}${page.slug}.html`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={page.description} />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#f5f6fa" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#070b14" media="(prefers-color-scheme: dark)" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={page.description} />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={`${SITE_URL}media/promo.jpg`} />
        <link rel="canonical" href={url} />
        <link rel="icon" href="assets/logo.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="assets/site.css" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script src="assets/site.js" defer />
      </head>
      <body className={bodyClass}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}

function TopBar({ pages, current }: { pages: Page[]; current: Page }) {
  const first = (section: string) => pages.find((p) => p.section === section && p.slug !== "index");
  const links = [
    { label: "Get started", page: pages.find((p) => p.slug === "getting-started") },
    { label: "Features", page: first("features") },
    { label: "Technical", page: first("technical") },
    { label: "Reference", page: first("reference") },
  ].filter((l) => l.page);
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <button type="button" className="icon-btn menu-btn" data-menu-toggle aria-controls="sidebar" aria-expanded="false" aria-label="Open menu">
          <Icon name="menu" />
        </button>
        <a className="brand" href="index.html" aria-label="wallet docs home">
          <img src="assets/logo.svg" width={28} height={28} alt="" />
          <span className="brand-name">wallet</span>
          <span className="brand-tag">docs</span>
        </a>
        <nav className="toplinks" aria-label="Primary">
          {links.map((l) => (
            <a key={l.label} href={`${l.page!.slug}.html`} aria-current={l.page!.section === current.section && current.slug !== "index" ? "true" : undefined}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className="topbar-actions">
          <a className="icon-btn" href={REPO} aria-label="wallet on GitHub" rel="noopener">
            <Icon name="github" />
          </a>
          <button type="button" className="icon-btn theme-toggle" data-theme-toggle aria-label="Toggle light or dark theme">
            <Icon name="moon" />
            <Icon name="sun" />
          </button>
        </div>
      </div>
    </header>
  );
}

function Sidebar({ pages, current, media }: { pages: Page[]; current: Page; media: Map<string, MediaInfo> }) {
  return (
    <nav className="sidebar" id="sidebar" aria-label="Documentation">
      <div className="sidebar-head">
        <span>Menu</span>
        <button type="button" className="icon-btn" data-menu-close aria-label="Close menu">
          <Icon name="close" />
        </button>
      </div>
      {SECTIONS.map((s) => {
        const items = pages.filter((p) => p.section === s.id);
        if (!items.length) return null;
        return (
          <div className="nav-group" key={s.id}>
            <p className="nav-title">{s.label}</p>
            <ul>
              {items.map((p) => (
                <li key={p.slug}>
                  <a href={`${p.slug}.html`} aria-current={p.slug === current.slug ? "page" : undefined}>
                    {p.nav}
                    {p.video && media.get(p.video)?.mp4 ? <span className="nav-video" title="Has a demo video" aria-label="(video)" /> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <span className="footer-brand">
          <img src="assets/logo.svg" width={20} height={20} alt="" /> wallet
        </span>
        <span>
          MIT licensed · <a href={REPO}>GitHub</a> · Inter typeface under the <a href="assets/Inter-OFL.txt">SIL Open Font License</a>
        </span>
      </div>
    </footer>
  );
}

// ── Media ────────────────────────────────────────────────────────────────

export function Video({ name, info, label }: { name: string; info: MediaInfo | undefined; label: string }) {
  // Clips are recorded separately (scripts/demo): until one exists, the page simply has no video.
  if (!info?.mp4) return null;
  const portrait = !!info.size && info.size.height > info.size.width;
  const style: CSSProperties | undefined = info.size ? { aspectRatio: `${info.size.width} / ${info.size.height}` } : undefined;
  return (
    <figure className={portrait ? "video video-portrait" : "video"}>
      <video
        controls
        preload={info.jpg ? "none" : "metadata"}
        playsInline
        poster={info.jpg ? `media/${name}.jpg` : undefined}
        width={info.size?.width}
        height={info.size?.height}
        style={style}
        aria-label={`${label} demo video`}
      >
        <source src={`media/${name}.mp4`} type="video/mp4" />
        <a href={`media/${name}.mp4`}>Download the {label} demo video</a>
      </video>
    </figure>
  );
}

// ── Documentation page ───────────────────────────────────────────────────

export function DocPage(props: {
  page: Page;
  pages: Page[];
  bodyHtml: string;
  toc: TocEntry[];
  media: Map<string, MediaInfo>;
  generatedFrom?: { label: string; href: string }[];
}) {
  const { page, pages, bodyHtml, toc, media } = props;
  const docs = pages.filter((p) => p.layout === "doc");
  const i = docs.findIndex((p) => p.slug === page.slug);
  const prev = i > 0 ? docs[i - 1] : null;
  const next = i >= 0 && i < docs.length - 1 ? docs[i + 1] : null;
  const section = SECTIONS.find((s) => s.id === page.section)!;
  return (
    <Html page={page} bodyClass="layout-doc">
      <TopBar pages={pages} current={page} />
      <div className="backdrop" data-menu-close hidden />
      <div className="shell">
        <Sidebar pages={pages} current={page} media={media} />
        <main id="main" className="content">
          <article className="doc">
            <p className="eyebrow">{section.label}</p>
            <h1>{page.title}</h1>
            <p className="lead">{page.description}</p>
            {page.video ? <Video name={page.video} info={media.get(page.video)} label={page.nav} /> : null}
            <div className="prose" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            <div className="doc-foot">
              <a className="edit-link" href={`${REPO}/edit/main/${page.source}`} rel="noopener">
                <Icon name="edit" size={15} /> Edit this page on GitHub
              </a>
              {props.generatedFrom?.length ? (
                <span className="generated-note">
                  Reference generated from{" "}
                  {props.generatedFrom.map((g, k) => (
                    <span key={g.href}>
                      {k ? ", " : ""}
                      <a href={g.href}>{g.label}</a>
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
            <nav className="pager" aria-label="Previous and next page">
              {prev ? (
                <a className="pager-prev" href={`${prev.slug}.html`}>
                  <span className="pager-dir">
                    <Icon name="arrowLeft" size={14} /> Previous
                  </span>
                  <span className="pager-title">{prev.nav}</span>
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a className="pager-next" href={`${next.slug}.html`}>
                  <span className="pager-dir">
                    Next <Icon name="arrowRight" size={14} />
                  </span>
                  <span className="pager-title">{next.nav}</span>
                </a>
              ) : null}
            </nav>
          </article>
        </main>
        <aside className="toc" aria-label="On this page">
          {toc.length ? (
            <>
              <p className="toc-title">On this page</p>
              <ul>
                {toc.map((t) => (
                  <li key={t.id} className={t.level === 3 ? "toc-sub" : undefined}>
                    <a href={`#${t.id}`}>{t.text}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
      <Footer />
    </Html>
  );
}

// ── Landing page ─────────────────────────────────────────────────────────

const WHY: { icon: keyof typeof ICONS; title: string; text: ReactNode }[] = [
  {
    icon: "lock",
    title: "Private",
    text: "Everything lives in one SQLite file on your machine. No account with us, no tracking, no cloud. Back it up by copying a file.",
  },
  {
    icon: "server",
    title: "Self-hosted",
    text: "npm run dev, or docker compose up. Sign in with a passkey (Face ID, Touch ID, or your iPhone via QR code). No passwords.",
  },
  {
    icon: "globe",
    title: "Any currency",
    text: "Each account keeps its own currency: 200+ fiat currencies plus BTC, ETH and gold. Totals use free daily rates, no API key.",
  },
  {
    icon: "bot",
    title: "AI that does things",
    text: "34 tools for reading, simulating and writing your data, shared by the chat, Telegram, an MCP server and a REST API.",
  },
  {
    icon: "file",
    title: "No bank sync needed",
    text: "Drop a CSV or PDF statement, or a screenshot, anywhere in the app or on the Telegram bot. The assistant imports it.",
  },
  {
    icon: "diagram",
    title: "Open source",
    text: "MIT licensed TypeScript: Next.js, React and SQLite, with tests. Read every line that touches your money, and change it.",
  },
];

export function LandingPage(props: { page: Page; pages: Page[]; bodyHtml: string; media: Map<string, MediaInfo> }) {
  const { page, pages, bodyHtml, media } = props;
  const promo = media.get("promo");
  const demo = media.get("demo");
  const features = pages.filter((p) => p.section === "features" && p.video);
  const heroPoster = ["promo", "demo", ...features.map((p) => p.video!)].find((n) => media.get(n)?.jpg);
  return (
    <Html page={page} bodyClass="layout-landing">
      <TopBar pages={pages} current={page} />
      <div className="backdrop" data-menu-close hidden />
      <div className="shell shell-landing">
        <Sidebar pages={pages} current={page} media={media} />
        <main id="main" className="landing">
          <section className="hero">
            <div className="hero-copy">
              <img className="hero-logo" src="assets/logo.svg" width={64} height={64} alt="wallet" />
              <p className="eyebrow">Self-hosted · open source · MIT</p>
              <h1>
                Your net worth, budgets and investments. <span className="hero-accent">On your own machine.</span>
              </h1>
              <p className="lead">{page.description}</p>
              <div className="cta">
                <a className="btn btn-primary" href="getting-started.html">
                  Get started <Icon name="arrowRight" size={16} />
                </a>
                <a className="btn btn-ghost" href={REPO} rel="noopener">
                  <Icon name="github" size={16} /> GitHub
                </a>
              </div>
            </div>
            <div className="hero-media">
              {promo?.mp4 ? (
                <video
                  className="hero-video"
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  poster={promo.jpg ? "media/promo.jpg" : undefined}
                  width={promo.size?.width}
                  height={promo.size?.height}
                  aria-label="wallet in 30 seconds"
                >
                  <source src="media/promo.mp4" type="video/mp4" />
                </video>
              ) : heroPoster ? (
                <img className="hero-video" src={`media/${heroPoster}.jpg`} alt="The wallet dashboard" width={media.get(heroPoster)?.size?.width} height={media.get(heroPoster)?.size?.height} />
              ) : null}
            </div>
          </section>

          {demo?.mp4 ? (
            <section className="band" aria-labelledby="full-demo">
              <div className="band-head">
                <h2 id="full-demo">Watch the full demo</h2>
                <p>Every section of the app, recorded from a real install with demo data: accounts in several currencies, a brokerage, a mortgage, and an assistant importing a statement.</p>
              </div>
              <Video name="demo" info={demo} label="Full" />
            </section>
          ) : null}

          <section className="band" aria-labelledby="tour">
            <div className="band-head">
              <h2 id="tour">Tour each section</h2>
              <p>Short clips, each with the page that explains how it works.</p>
            </div>
            <ul className="tour-grid">
              {features.map((p) => {
                const info = p.video ? media.get(p.video) : undefined;
                return (
                  <li key={p.slug}>
                    <a className="tour-card" href={`${p.slug}.html`}>
                      <span className="tour-thumb">
                        {info?.jpg ? (
                          <img src={`media/${p.video}.jpg`} alt="" loading="lazy" width={info.size?.width} height={info.size?.height} />
                        ) : (
                          <span className="tour-placeholder">
                            <Icon name="play" size={22} />
                          </span>
                        )}
                        {info?.mp4 ? (
                          <span className="tour-play">
                            <Icon name="play" size={14} />
                          </span>
                        ) : null}
                      </span>
                      <span className="tour-title">{p.nav}</span>
                      <span className="tour-blurb">{p.blurb ?? p.description}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="band" aria-labelledby="why">
            <div className="band-head">
              <h2 id="why">Why wallet</h2>
            </div>
            <ul className="why-grid">
              {WHY.map((w) => (
                <li key={w.title} className="why-card">
                  <span className="why-icon">
                    <Icon name={w.icon} size={20} />
                  </span>
                  <h3>{w.title}</h3>
                  <p>{w.text}</p>
                </li>
              ))}
            </ul>
          </section>

          {bodyHtml.trim() ? (
            <section className="band">
              <div className="prose prose-landing" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
            </section>
          ) : null}

          <section className="band cta-band">
            <h2>Up and running in two commands</h2>
            <div className="cta-code">
              <code>npm install &amp;&amp; npm run dev</code>
            </div>
            <div className="cta">
              <a className="btn btn-primary" href="getting-started.html">
                Read the getting started guide <Icon name="arrowRight" size={16} />
              </a>
              <a className="btn btn-ghost" href="architecture.html">
                How it&apos;s built
              </a>
            </div>
          </section>
        </main>
      </div>
      <Footer />
    </Html>
  );
}
