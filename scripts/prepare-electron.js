/**
 * next build 후 standalone 디렉터리에 필요한 파일들을 복사합니다.
 * electron-builder 실행 전에 반드시 먼저 실행해야 합니다.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

function copy(src, dst) {
  if (!fs.existsSync(src)) {
    console.log(`  skip (없음): ${path.relative(ROOT, src)}`);
    return;
  }
  fs.cpSync(src, dst, { recursive: true, force: true });
  console.log(`  ✓ ${path.relative(ROOT, src)}  →  ${path.relative(ROOT, dst)}`);
}

if (!fs.existsSync(STANDALONE)) {
  console.error("❌ .next/standalone 가 없습니다. 먼저 npm run build 를 실행하세요.");
  process.exit(1);
}

console.log("\n📦 Electron 빌드 준비 중...\n");

// .next/static → standalone/.next/static
copy(
  path.join(ROOT, ".next", "static"),
  path.join(STANDALONE, ".next", "static")
);

// public → standalone/public
copy(
  path.join(ROOT, "public"),
  path.join(STANDALONE, "public")
);

// ffmpeg-static 패키지 전체 복사
// Next.js standalone은 JS만 트레이싱하므로 바이너리(.exe)는 별도 복사 필요
try {
  const pkgJson = require.resolve("ffmpeg-static/package.json");
  const ffmpegPkgDir = path.dirname(pkgJson);
  const ffmpegDst = path.join(STANDALONE, "node_modules", "ffmpeg-static");
  fs.cpSync(ffmpegPkgDir, ffmpegDst, { recursive: true, force: true });
  console.log(`  ✓ ffmpeg-static 패키지 (바이너리 포함) 복사 완료`);
} catch (e) {
  console.error("  ❌ ffmpeg-static 복사 실패:", e.message);
  process.exit(1);
}

// yt-dlp.exe 다운로드 (없을 때만)
const ytdlpDst = path.join(STANDALONE, "yt-dlp.exe");
if (!fs.existsSync(ytdlpDst)) {
  console.log("  ⬇ yt-dlp.exe 다운로드 중... (최초 1회)");
  try {
    const { execSync } = require("child_process");
    execSync(
      `curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -o "${ytdlpDst}"`,
      { stdio: "inherit" }
    );
    console.log("  ✓ yt-dlp.exe 다운로드 완료");
  } catch (e) {
    console.warn("  ⚠ yt-dlp.exe 다운로드 실패 (레퍼런스 기능 사용 불가):", e.message);
  }
} else {
  console.log("  ✓ yt-dlp.exe 이미 존재함 (skip)");
}

console.log("\n✅ 완료. electron-builder 를 실행해도 됩니다.\n");
