// Generate .icns (macOS) and .ico (Windows) icons from SVG
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BUILD = path.join(__dirname, "..", "build");
const SVG = path.join(BUILD, "icon.svg");
const ICONSET = path.join(BUILD, "icon.iconset");

async function generate() {
  const svg = fs.readFileSync(SVG);

  // ── macOS .icns ──
  fs.mkdirSync(ICONSET, { recursive: true });

  // iconutil needs these exact files
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  for (const [size, name] of sizes) {
    await sharp(svg).resize(size, size).png().toFile(path.join(ICONSET, name));
  }

  execSync(`iconutil -c icns "${ICONSET}" -o "${path.join(BUILD, "icon.icns")}"`, {
    stdio: "inherit",
  });
  console.log("✓ Created build/icon.icns");

  // ── Windows .ico ──
  // Generate a 256px PNG — electron-builder can use this directly
  await sharp(svg)
    .resize(256, 256)
    .png()
    .toFile(path.join(BUILD, "icon.png"));

  // Try to make a proper .ico using png-to-ico if available
  try {
    const pngToIco = require("png-to-ico");
    const ico = await pngToIco(path.join(BUILD, "icon.png"));
    fs.writeFileSync(path.join(BUILD, "icon.ico"), ico);
    console.log("✓ Created build/icon.ico");
  } catch {
    // Fallback: just use the PNG — electron-builder accepts it
    console.log("⚠ png-to-ico not available, using PNG fallback");
  }

  // Cleanup
  fs.rmSync(ICONSET, { recursive: true, force: true });
}

generate().catch(console.error);
