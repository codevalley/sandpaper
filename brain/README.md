# Deploying the brain

## What this folder is

This folder is Sandpaper's own living brain: a small static site the terminal agent stamps
after each substantive turn (see `../CLAUDE.md` → "The project brain").

- `index.html` — the cover: NOW, the canvas (boards), digest, recent log, browse.
- `log.html` — append-only work log (the heartbeat).
- `decisions.html` — decisions + open questions (the why).
- `map.html` — components, architecture (linked), glossary.
- `learnings.html` — gotchas & verdicts.
- `product/` · `engineering/` · `project/` — the lenses; `wiki/` — the settled prose docs.

Styled by `assets/theme.css` + `assets/brain.css`, with a little vanilla JS in
`assets/brain.js`. No framework, no build step, no server-side anything. It is
**always publishable**: point any static host at this folder as-is and it works.

One design choice shapes everything below: the brain **links, never copies**. Canonical
truth lives in the parent repo — the spec docs (`../sandpaper.html`, `../engg-spec.html`),
source files, `package.json` — and the brain references them with relative paths (`../…`)
so they resolve on disk and whenever the whole repo is served.

## Two deploy shapes

### 1. Whole-repo deploy (recommended for public repos)

Serve the repo root and visit `/brain/`. Every out-of-brain link resolves: spec HTML docs
render with working `#anchors`, source files are viewable. GitHub Pages serving the repo
root does this perfectly.

### 2. Brain-only deploy (site root = this folder)

The relative `../` refs can't resolve — there's nothing above the root. The built-in
resolver in `assets/brain.js` handles it. Each page's head carries:

```html
<meta name="sandpaper:source" content="https://github.com/codevalley/sandpaper/blob/HEAD/" data-pkg="@nynb/sandpaper" />
```

On load, the page probes `../package.json` and checks its `name` against `data-pkg`.
If the probe fails (or the name doesn't match), the page knows it is detached, and
out-links open the source-host copy instead (rewritten at click time). Source and meta
files render fine on GitHub's blob view; spec **HTML** docs land on blob *source* view —
unrendered. Use the whole-repo shape if you want rendered specs. With no meta configured,
out-links dim with a tooltip instead of 404ing.

The meta is written automatically by `npx sandpaper init` / `upgrade` from the git origin
(or `package.json` → `"repository"`). `npx sandpaper doctor` verifies every page against
that independently derived URL and the exact package name; agreement between stale pages
is not enough.

## Deployed brains are read-only

The refine toolbar (Sand / Hands / Sling) is injected only by the local `sandpaper`
server — a deployed brain has no toolbar and can't be edited from the page. By design:
the public copy is for reading.

## Recipes

**GitHub Pages (simplest)** — Settings → Pages → Source: *Deploy from a branch*, branch
`main`, folder `/ (root)`. That's the whole-repo shape — visit
`https://<owner>.github.io/<repo>/brain/`. For the brain-only shape, use Source:
*GitHub Actions* with this workflow:

```yaml
name: Deploy brain
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: brain }          # 'path: .' switches to the whole-repo shape
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Vercel** — New Project → import the repo. Root Directory = repo root (or `brain/` for
brain-only), Framework Preset = *Other*, no build command, Output Directory = `./`.

**Netlify** — New site from Git. No build command. Publish directory: `brain` (or the
repo root).

**Cloudflare Pages** — Connect the repo. No build command. Build output directory:
`brain` (or `/`).

## Privacy

Deploying the whole repo publishes **all** of its files, not just the brain. Brain-only
publishes just this folder — but its out-links point at the source host, which must be
public for them to work. Either way, assume everything the brain links to is visible.
Don't deploy a brain whose repo isn't ready to be read.

Remember what the brain *is*: distilled internal state. The canvas boards are derived
from working conversations, and the log/decisions/learnings record real reasoning —
read them with publishing eyes before pointing a host at this folder.
