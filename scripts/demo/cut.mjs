/** ffmpeg helpers for the demo and promo cuts. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { duration, ROOT } from "./lib.mjs";

const X264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "21", "-tune", "animation", "-pix_fmt", "yuv420p", "-r", "30", "-an"];

function ff(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
}

/** A piece of `clip` from `start` lasting `dur` output seconds, played `speed`× faster. */
export function excerpt(clip, start, dur, out, { speed = 1 } = {}) {
  ff(["-ss", String(start), "-t", String(dur * speed), "-i", clip, "-vf", `setpts=PTS/${speed},fps=30,scale=1920:1080,format=yuv420p`, ...X264, out]);
  return out;
}

/**
 * Overlay a portrait clip into the phone slot of a card clip (slot in device
 * pixels), with rounded corners. The phone video is trimmed to the card's length.
 */
export function phoneComposite(cardClip, phoneClip, out, slot, { start = 0, speed = 1 } = {}) {
  const len = duration(cardClip);
  const r = slot.r ?? 66;
  const mask = `if(gt(hypot(max(0,max(${r}-X,X-(W-1-${r}))),max(0,max(${r}-Y,Y-(H-1-${r})))),${r}),0,255)`;
  ff([
    "-i", cardClip,
    "-ss", String(start), "-t", String(len * speed), "-i", phoneClip,
    "-filter_complex",
    `[1:v]setpts=PTS/${speed},scale=${slot.w}:${slot.h},format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${mask}'[ph];` +
      `[0:v][ph]overlay=${slot.x}:${slot.y}:eof_action=repeat:shortest=0,format=yuv420p[v]`,
    "-map", "[v]", "-t", String(len), ...X264, out,
  ]);
  return out;
}

/** Animated GIF for the README: palette per clip, `width` px wide, `fps` frames/s. */
export function gif(clip, out, { start = 0, dur, width = 960, fps = 12 } = {}) {
  const trim = dur ? ["-ss", String(start), "-t", String(dur)] : ["-ss", String(start)];
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  ff([...trim, "-i", clip, "-filter_complex", `${vf},split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, out]);
  console.log(`✓ ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}
