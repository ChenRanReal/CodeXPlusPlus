// Generate the Codex++ application icon from the ChatGPT knot shipped with Codex Desktop.
// Usage: node scripts/release/generate-brand-icons.mjs [--channel chrome|msedge]
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { channel: { type: "string" } } });
const root = path.resolve(import.meta.dirname, "../..");
const logoPath = path.join(root, "packages/renderer-extension/src/assets/chatgpt-mark.png");
const launcherAssets = path.join(root, "crates/launcher/assets");
const webPublic = path.join(root, "apps/web-ui/apps/web/public");
const desktopIcons = path.join(root, "apps/desktop-shell/src-tauri/icons");

const view = 1024;
const inset = 28;
const plate = view - inset * 2;
const radius = 148;
const ink = "#3836b3";
const plateColor = "#f4f5f7";
const logoW = 520;
const logoH = logoW;
const plus = 168;
const thick = 52;
const plusGap = 16;
const groupGap = 26;
const plusesW = plus * 2 + plusGap;
const groupW = logoW + groupGap + plusesW;
const left = (view - groupW) / 2;
const logoTop = (view - logoH) / 2;
const plusTop = logoTop + (logoH - plus) / 2;
const plusLeft = left + logoW + groupGap;
const corner = 12;

const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function round(value) {
  return Math.round(value * 10) / 10;
}

function plusMarks(originX) {
  const armY = plusTop + (plus - thick) / 2;
  const stemX = originX + (plus - thick) / 2;
  return `<rect x="${round(originX)}" y="${round(armY)}" width="${plus}" height="${thick}" rx="${corner}"/>
    <rect x="${round(stemX)}" y="${round(plusTop)}" width="${thick}" height="${plus}" rx="${corner}"/>`;
}

function iconSvg(cutoutUrl) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${view} ${view}" role="img" aria-label="Codex++">
  <rect x="${round(inset)}" y="${round(inset)}" width="${round(plate)}" height="${round(plate)}" rx="${round(radius)}" fill="${plateColor}"/>
  <image href="${cutoutUrl}" xlink:href="${cutoutUrl}" x="${round(left)}" y="${round(logoTop)}" width="${round(logoW)}" height="${round(logoH)}"/>
  <g fill="${ink}">
    ${plusMarks(plusLeft)}
    ${plusMarks(plusLeft + plus + plusGap)}
  </g>
</svg>`;
}

function pageHtml(svg) {
  return `<!doctype html>
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  svg { display: block; width: 100%; height: 100%; }
</style>
${svg}`;
}

function faviconSvg(png) {
  const href = `data:image/png;base64,${png.toString("base64")}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 192 192" role="img" aria-label="Codex++">
  <image width="192" height="192" href="${href}" xlink:href="${href}"/>
</svg>
`;
}

function buildIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "latin1");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function buildIco(sizes, images) {
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  for (let index = 0; index < sizes.length; index += 1) {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index] % 256;
    directory[entry + 1] = sizes[index] % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(images[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  return Buffer.concat([directory, ...images]);
}

const logoDataUrl = `data:image/png;base64,${(await readFile(logoPath)).toString("base64")}`;
const browser = await chromium.launch({ channel: values.channel });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent("<!doctype html><body></body>");
  const cutoutUrl = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = Math.round(luminance);
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png");
  }, logoDataUrl);

  await page.setViewportSize({ width: view, height: view });
  await page.setContent(pageHtml(iconSvg(cutoutUrl)));
  await page.evaluate(async () => {
    const source = document.querySelector("image")?.getAttribute("href");
    if (!source) throw new Error("missing ChatGPT mark");
    const probe = new Image();
    probe.src = source;
    await probe.decode();
  });

  const renderSizes = [...new Set([view, 512, ...icoSizes, 192, 180])];
  const rendered = new Map();
  for (const size of renderSizes) {
    await page.setViewportSize({ width: size, height: size });
    rendered.set(size, await page.screenshot({ omitBackground: true }));
  }

  const ico = buildIco(
    icoSizes,
    icoSizes.map((size) => rendered.get(size)),
  );
  const icns = buildIcns(
    [
      ["ic11", 32],
      ["ic12", 64],
      ["ic07", 128],
      ["ic08", 256],
      ["ic13", 256],
      ["ic09", 512],
      ["ic14", 512],
      ["ic10", 1024],
    ].map(([type, size]) => ({ type, png: rendered.get(size) })),
  );
  const favicon = faviconSvg(rendered.get(192));
  await Promise.all([
    writeFile(path.join(launcherAssets, "codexhost.png"), rendered.get(view)),
    writeFile(path.join(launcherAssets, "codexhost.ico"), ico),
    writeFile(path.join(desktopIcons, "icon.ico"), ico),
    writeFile(path.join(desktopIcons, "AppIcon.icns"), icns),
    writeFile(path.join(desktopIcons, "dock.png"), rendered.get(256)),
    writeFile(path.join(desktopIcons, "tray.png"), rendered.get(32)),
    writeFile(path.join(root, "scripts/windows/CodeXPlusPlus.ico"), ico),
    writeFile(path.join(webPublic, "icon-512.png"), rendered.get(512)),
    writeFile(path.join(webPublic, "icon-192.png"), rendered.get(192)),
    writeFile(path.join(webPublic, "apple-touch-icon.png"), rendered.get(180)),
    writeFile(path.join(webPublic, "favicon.svg"), favicon),
    writeFile(path.join(webPublic, "favicon-dark.svg"), favicon),
  ]);
  console.log(`icon=${path.join(launcherAssets, "codexhost.png")}`);
  console.log(`favicon-bytes=${Buffer.byteLength(favicon)}`);
} finally {
  await browser.close();
}
