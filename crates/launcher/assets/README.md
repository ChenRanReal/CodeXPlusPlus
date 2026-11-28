# Application icons

`codexhost.png` is a 1024px render of the application icon. The ChatGPT knot
from `packages/renderer-extension/src/assets/chatgpt-mark.png` sits in black on
a light gray rounded tile, with a blue `++` monogram beside it. That knot is
the mark shipped with Codex Desktop. Settings, the console header, and the Web
sidebar keep the colored otter.

macOS packaging creates its ICNS sizes directly from this PNG. Windows launchers
and the Inno Setup installer use `codexhost.ico`, with 16, 24, 32, 48, 64, 128,
and 256 pixel PNG frames. Desktop and Start menu shortcuts, and the uninstall
listing, use the launcher icon.

After changing the icon layout, regenerate the native icon, Web app icons, and
the Desktop shell icon using Playwright Chromium:

```sh
npx playwright install chromium
node scripts/release/generate-brand-icons.mjs
```

An installed Chrome or Microsoft Edge can also render the assets, for example:

```sh
node scripts/release/generate-brand-icons.mjs --channel msedge
```
