# Brand

Logo direction **D**: chamfered "GH." with a two-tone G and H, redrawn from the
owner's sketch. The G and the dot take the active theme's accent colour; in code
use `logoSvg()` from `@store/ui`, which reads the theme's CSS variables.

| File | Use |
| --- | --- |
| `logo-on-dark.svg` / `logo-on-light.svg` | Headers, documents, social posts |
| `app-icon.svg` | Hexagon icon: PWA icon, store listings |
| `favicon.svg` | Browser tab (simplified G only, readable at 16 px) |
| `telegram-avatar.svg` / `.png` | Bot profile photo, 640 px (Telegram crops it to a circle; upload the PNG in @BotFather) |
| `icon-192.png` / `icon-512.png` | Web app (PWA) icons |
| `apple-touch-icon.png` | iPhone home-screen icon, 180 px |

The PNGs are rendered from the SVGs; re-render them after changing an SVG.

To make another store from this template, replace these files and update
`store.config.ts`.
