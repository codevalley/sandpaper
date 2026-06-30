---
description: Start the Sandpaper server and open the brain in your browser
---

Open the project's brain dashboard:

1. Check whether a server is already on port 4848 (`lsof -ti :4848`). If not, start one in the
   background from the repo root: `node bin/cli.js .` (serving the repo so the brain's `spec ↗` /
   `engg ↗` links resolve), or `node bin/cli.js brain/` for the brain alone.
2. Open the cover in the default browser — `open http://127.0.0.1:4848/brain/index.html` on macOS
   (`xdg-open` on Linux, `start` on Windows).
3. Tell the user the URL. Every page carries the on-page toolbar — **Sand** (scoped AI edit),
   **✎ Hands** (direct edit, no AI), **❯ Sling** (copy a terminal-ready instruction).

The file on disk stays the single source of truth; the page always reflects disk.
