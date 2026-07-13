# Open workflow

Open the project's brain dashboard:

1. Check whether a server already occupies port 4848 with `lsof -ti :4848`. If not, start one in
   the background from the repository root using `node bin/cli.js .`, which serves the repository so
   the brain's source links resolve, or use `node bin/cli.js brain/` for the brain alone.
2. Open `http://127.0.0.1:4848/brain/index.html` in the default browser: use `open` on macOS,
   `xdg-open` on Linux, or `start` on Windows.
3. Tell the user the URL. Explain that every page includes the on-page toolbar: **Sand** for a scoped
   AI edit, **✎ Hands** for a direct edit without AI, and **❯ Sling** for a terminal-ready instruction.

The file on disk remains the single source of truth and the page always reflects disk.
