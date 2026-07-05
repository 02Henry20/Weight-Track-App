# Ascend / CalStat icon pack and guided tutorial update

## What is included

This zip contains two things:

1. A complete production-ready app icon pack generated from the uploaded example icon.
2. An updated copy of the uploaded web app files with a guided tutorial system and isolated tutorial sample dataset.

## Important note

The text instructions mention **Ascend**, but the uploaded source files are the current **CalStat** weight/body-composition tracker. The icon manifest and standalone head snippet follow the requested Ascend metadata. The implemented tutorial targets the actual uploaded CalStat sections: Overview, Log data, Trends, Body, Goals and Settings.

## Icon folders

- `icons/icon-*.png` — standard square app/PWA icons from 16x16 through 1024x1024.
- `icons/android/android-circle-*` — Android round/circle launcher assets.
- `icons/android/maskable-icon-*` — Android maskable PWA icons with safe padding.
- `icons/apple/apple-touch-icon-180x180.png` — primary Apple touch icon.
- `icons/favicon.ico` and `icons/favicon-*` — transparent-background browser favicon assets.
- `icons/favicon.svg` — transparent SVG favicon fallback.
- `icons/safari-pinned-tab.svg` — Safari pinned tab mask.
- `icons/mstile-150x150.png` — Windows tile icon.

## Manifest/head files

- `manifest.webmanifest` — production PWA manifest using the requested Ascend metadata, dark theme colors, maskable icons, circle icons and standard icons.
- `site.webmanifest` — duplicate compatibility manifest.
- `head-snippet.html` / `index-head-snippet.html` — copy these tags into your HTML `<head>` if you only want the icon/PWA tags.
- `browserconfig.xml` — Windows tile metadata.

## Tutorial implementation

Files changed/added:

- `index.html`
  - added a Settings button: **Start guided tutorial**
  - added the full-screen tutorial overlay markup
  - updated PWA icon/head tags
- `styles/components.css`
  - added tutorial overlay, spotlight, progress and responsive styling
- `js/app.js`
  - added tutorial step engine
  - switches views automatically
  - scrolls targets near the top before highlighting
  - recomputes spotlight on resize/scroll/view changes
  - blocks tutorial sample writes/sync behavior
  - restores real state on close/finish
- `js/tutorial-data.js`
  - rich local sample dataset for weights, calories, body composition, settings and goals
- `service-worker.js`
  - cache version bumped and new assets added

## Installation

Use the folder structure exactly as provided:

```text
index.html
manifest.webmanifest
service-worker.js
browserconfig.xml
styles/
js/
icons/
```

Deploy the whole folder to your hosting root. If your project already has the same files, replace them with these updated versions or copy over the specific changes above.
