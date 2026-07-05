# CalStat Scheme D Icon Pack

This package contains ready-to-use browser, PWA, Apple, Android and Windows icon assets.

## Quick integration

1. Copy the `icons/` directory, `manifest.webmanifest`, and `browserconfig.xml` to your website root.
2. Replace the existing manifest/favicon lines inside your current `<head>` with the contents of `index-head-snippet.html`.
3. Add the paths from `service-worker-assets-snippet.txt` to your service worker's app-shell cache.
4. Increase the service worker cache name so installed devices download the new icons.
5. Redeploy. Existing installed PWAs may need to be removed and added to the home screen again before an operating system refreshes the icon.

`index.html` is a standalone integration example. `site.webmanifest` is an identical compatibility alias of `manifest.webmanifest`. It is not intended to replace the rest of the CalStat application.

## Files and intended use

### Browser tab / bookmarks

- `icons/favicon.svg` — preferred transparent scalable favicon.
- `icons/favicon.ico` — multi-resolution fallback for older browsers.
- `icons/favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png`, `favicon-96x96.png` — PNG fallbacks.
- `icons/safari-pinned-tab.svg` — monochrome Safari pinned-tab asset.

### PWA / Android browser installation

- `icons/icon-192.png` and `icons/icon-512.png` — regular smooth-square PWA icons.
- `icons/maskable-icon-192.png` and `icons/maskable-icon-512.png` — Android maskable icons. These contain a full-bleed background and keep the artwork within the safe zone, allowing Android to apply circle, squircle, rounded-square, or other launcher masks.
- Additional sizes from 48 through 1024 pixels are included for launchers and other devices.

### Explicit Android shape exports

Inside `icons/android/`:

- `android-circle-*` — circular PNG icons.
- `android-squircle-*` — transparent smooth-square PNG icons.
- `android-square-*` — opaque square PNG icons.
- `ic_launcher_foreground-432.png`, `ic_launcher_background-432.png`, `ic_launcher.xml`, and `colors.xml` — optional native Android adaptive-icon resources. These are not needed for a normal PWA.

### Apple

Inside `icons/apple/`:

- 120, 152, 167, and 180 pixel opaque Apple touch icons.
- `icons/apple-touch-icon.png` and `apple-touch-icon-precomposed.png` are 180-pixel convenience aliases.

Apple expects an opaque square source and applies its own rounded corners. Do not use the transparent favicon as the Apple touch icon.

### Windows

- `icons/mstile-150x150.png`
- `browserconfig.xml`

### Source assets

The `icons/source/` directory contains 1024-pixel smooth-square, square, circle, and maskable masters plus the transparent vector symbol.

## Manifest behavior

The manifest declares separate `any`, `maskable`, and `monochrome` assets. On Android, the maskable icon is the important one: the launcher can safely crop it into a circle or smooth square without cutting the torso, ring, or progress line.
