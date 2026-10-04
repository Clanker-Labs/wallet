// Re-record every section clip, then cut the full demo, the promo and the README GIF.
//   node scripts/demo/record-all.mjs            # everything
//   node scripts/demo/record-all.mjs --cuts     # only re-cut demo/promo/GIF from existing clips
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildDemo } from "./demo.mjs";
import { buildGif, buildPromo } from "./promo.mjs";

const dir = path.join(import.meta.dirname, "sections");
if (!process.argv.includes("--cuts")) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    console.log(`\n▶ ${file}`);
    execFileSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" });
  }
}
await buildDemo();
await buildPromo();
buildGif();
