# Dark Helmet icons

Clean vector reconstruction of approved concept 02: black oversized helmet and chess pedestal on ivory (#F8F5EB).

- `darkhelmet.svg`: editable, scalable master and modern browser favicon.
- `icon-16.png`, `icon-32.png`, `icon-48.png`: browser favicon sizes.
- `apple-touch-icon.png`: 180×180 iOS home-screen icon.
- `icon-192.png`, `icon-512.png`: Android/web app icons.
- `icon-maskable-192.png`, `icon-maskable-512.png`: padded Android icons for launcher masks.
- `icon-1024.png`: high-resolution master export.
- `../favicon.ico`: multi-resolution ICO (16, 32, 48).
- `../manifest.webmanifest`: web app metadata and Android icon declarations.

PNG files are opaque squares; the operating system applies its own mask. The maskable mark stays inside the central safe circle. Paths in the manifest and HTML support deployment under a subdirectory.

Regenerate on macOS from `webapp`:

```sh
swift -module-cache-path /tmp/darkhelmet-swift-cache tools/generate-icons.swift
```

The manifest enables standalone home-screen presentation; it does not add offline support.
