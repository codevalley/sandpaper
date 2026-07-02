# sandpaper.sh — the landing page

Static, zero-build, self-contained: `index.html` + `site.css` + `site.js` + `favicon.svg`
+ `og.png` (social card; regenerate by rendering `og-source.html` at 1200×630 and
screenshotting). No framework, no bundler — edit the files, refresh.

## Deploy

Two sites, one repo:

| host | Vercel project | root directory | serves |
|---|---|---|---|
| `sandpaper.sh` | project 1 | `site/` | this landing page |
| `brain.sandpaper.sh` | project 2 | `brain/` | the live project brain |

Both: Framework Preset = **Other**, no build command, output `./`. Add the domains under
each project's settings. (Netlify / Cloudflare Pages: same shape — publish directory
`site` and `brain` respectively.)

The brain deploy works detached from the repo because of the out-link resolver in
`brain/assets/brain.js` — see `brain/README.md` for the details.

## Local preview

```bash
python3 -m http.server 4870 --bind 127.0.0.1 -d site/
# or: npx sandpaper site/index.html   (adds the refine toolbar)
```

## Notes

- The hero demo re-enacts a real stamp (log entry `w-0193` — the turn this repo went
  public). If you change it, keep it honest: use a real entry.
- The page respects `prefers-reduced-motion` (demo renders its final state, no loops)
  and works with JavaScript disabled (reveals are scoped to `html.js`).
- Copy voice: concrete beats clever; no growth-hack vocabulary; never promise more than
  a stamp-per-session delivers.
