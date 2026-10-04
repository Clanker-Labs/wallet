# Demo videos

Scripts that record the videos in `site/media/` from the real app: the production build, a seeded demo database, a real browser. Run them again whenever the UI changes.

```bash
npm run build                                  # the recordings use `next start`
node scripts/demo/sections/net-worth.mjs       # one section → site/media/net-worth.mp4 + .jpg poster
node scripts/demo/record-all.mjs               # every section, then the demo and promo cuts
```

Requirements: ffmpeg with libx264, plus Playwright with Chromium. Set `PLAYWRIGHT_MODULE` or `CHROMIUM_PATH` if they aren't in the default places. The assistant clips also need a logged-in `claude` CLI, because they run the real `claude-code` provider.

## How it works (`lib.mjs`)

- **`startServer({ name, port, empty?, env? })`** runs `next start` on a private copy of the demo database (`data/rec-<name>.db`). The demo user is seeded once a day. `loginUrl()` returns a one-time sign-in link, and `stop()` cleans up.
- **`record(name, async (rec) => …, opts)`** captures Chromium's screencast at 1920×1080 (a 1280×720 viewport at 1.5×) and encodes H.264 with ffmpeg. Frames only arrive when the screen changes, so idle time costs nothing.
  - **Starting:** call `rec.start()` once the first screen is ready.
  - **Mouse and keyboard:** `rec.click(sel)`, `rec.move(sel)`, `rec.type(sel, text)` and `rec.scroll(dy)` move a visible cursor smoothly, with click ripples.
  - **Captions:** `rec.caption(html, holdMs)` shows a caption at the bottom; `<b>` renders gold, and an empty string hides it.
  - **Fast-forward:** `rec.fastForward(fn, 8)` plays everything inside `fn` 8× faster, with a "⏩ 8× faster" badge. Use it for waiting on the assistant.
  - **Zoom:** `rec.zoom(sel, 1.4)` zooms the page toward an element; `rec.zoom()` resets it.
  - **Poster:** `rec.poster()` marks the frame used for the `.jpg` poster.
- **Fonts:** the overlays and the app text use Inter (`site/assets`, SIL OFL), which looks like what macOS and iOS users see. The app itself keeps `system-ui`.
- **`joinClips(clips, out)`** crossfades clips of the same size into one file.

Keep captions short, one line and under ~60 characters, and say what the viewer gets, not which button is clicked.
