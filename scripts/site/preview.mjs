#!/usr/bin/env node
/**
 * Serve site-dist/ for a local look: `npm run site:preview` (PORT=4321 by
 * default). The site is also mounted under /wallet/ to mimic GitHub Pages.
 * No dependencies; supports Range requests so videos can seek.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", process.env.SITE_OUT || "site-dist");
const port = Number(process.env.PORT || 4321);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

if (!fs.existsSync(root)) {
  console.error(`${root} does not exist: run \`npm run site:build\` first.`);
  process.exit(1);
}

http
  .createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    if (pathname === "/wallet") {
      res.writeHead(301, { Location: "/wallet/" }).end();
      return;
    }
    if (pathname.startsWith("/wallet/")) pathname = pathname.slice("/wallet".length);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.join(root, path.normalize(pathname));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end(`Not found: ${pathname}`);
        return;
      }
      const headers = {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
          return;
        }
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
        if (req.method === "HEAD") res.end();
        else fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    });
  })
  .listen(port, () => {
    console.log(`wallet docs → http://localhost:${port}/  (also at http://localhost:${port}/wallet/)`);
  });
