# Vendored assets

Vendored here to avoid CDN runtime dependencies. No build step required.

## Tabulator v6.3.1 (MIT)

Two files vendored from the official Tabulator distribution:

| File | Source |
|------|--------|
| `tabulator.min.js` | https://github.com/olifolkerd/tabulator/releases/tag/6.3.1 |
| `tabulator.min.css` | https://github.com/olifolkerd/tabulator/releases/tag/6.3.1 |

License: MIT — https://github.com/olifolkerd/tabulator/blob/master/LICENSE
Copyright (c) 2015-2024 Oli Folkerd

Used as the data-grid engine for all 12 console panels. The vendor CSS is
supplemented by `pub-grid.css` which applies the console's --pub-* design
tokens via the kill-list override method.

## Open Props v1.7.6 (MIT)

Three files vendored from `unpkg.com/open-props@1.7.6/`:

| File | Source URL |
|------|-----------|
| `shadows.min.css` | https://unpkg.com/open-props@1.7.6/shadows.min.css |
| `easings.min.css` | https://unpkg.com/open-props@1.7.6/easings.min.css |
| `animations.min.css` | https://unpkg.com/open-props@1.7.6/animations.min.css |

License: MIT — https://github.com/argyleink/open-props/blob/main/LICENSE
Copyright (c) Adam Argyle

Only the shadow, easing, and animation modules are vendored.
Color, size, and typography modules are NOT included.

## Lucide v0.513.0 (ISC)

Lucide icons are inlined as `<svg>` elements directly in `index.html` — no
files are vendored. Icon path data is sourced from
`unpkg.com/lucide-static@0.513.0/icons/<name>.svg`.

License: ISC — https://github.com/lucide-icons/lucide/blob/main/LICENSE
Copyright (c) Lucide Contributors
