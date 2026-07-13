# Theme workflow

Use the brand colour or preset in the remaining user arguments to re-skin the brain by editing only
`brain/assets/theme.css`, the single token file.

Derive a coherent palette from a brand hex: a paper and ink base, an accent, and supporting green,
amber, and red hues. Keep text contrast and legibility at WCAG AA. Touch no other brain file because
every surface reads colour from `theme.css`. If the owner also wants the injected toolbar reskinned,
keep the host-independent `#sp-panel` `--sp-*` mirror in `public/toolbar.css` synchronized.
