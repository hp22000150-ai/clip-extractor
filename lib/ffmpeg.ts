import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function resolveFfmpeg(): string {
  // 1순위: ffmpeg-static 패키지가 반환하는 경로 (가장 정확)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p: string = require("ffmpeg-static");
    if (typeof p === "string" && p && fs.existsSync(p)) return p;
  } catch {}

  // 2순위: process.cwd() 기준 (개발 및 standalone 서버 실행 시)
  const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const local = path.join(process.cwd(), "node_modules", "ffmpeg-static", bin);
  if (fs.existsSync(local)) return local;

  // 3순위: __dirname 기준 (경로가 달라지는 경우 대비)
  const fromDir = path.join(__dirname, "..", "node_modules", "ffmpeg-static", bin);
  if (fs.existsSync(fromDir)) return fromDir;

  throw new Error(`ffmpeg를 찾을 수 없습니다.\n시도한 경로:\n  - ${local}\n  - ${fromDir}`);
}

function spawnAsync(ffmpeg: string, args: string[], timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    proc.stderr?.on("data", (d: Buffer) => stderr.push(d));

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs) {
      timer = setTimeout(() => { proc.kill(); reject(new Error("ffmpeg 시간 초과")); }, timeoutMs);
    }

    proc.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8") || `exit ${code}`));
      else resolve();
    });
    proc.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
  });
}

export function getVideoDurationSec(ffmpegPath: string, inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-i", inputPath], { stdio: ["ignore", "ignore", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", () => {
      const out = Buffer.concat(chunks).toString("utf8");
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)/);
      resolve(m ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) : 0);
    });
    proc.on("error", () => resolve(0));
  });
}

// Gemini 영상 분석용: 1FPS·360p 저화질 변환 (분석 전송용, 원본 영상과 무관)
export function transcodeForAnalysis(ffmpeg: string, inputPath: string, outputPath: string): Promise<void> {
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-i", inputPath,
    "-vf", "fps=1,scale=360:-2",
    "-c:v", "libx264", "-crf", "35", "-preset", "ultrafast",
    "-c:a", "aac", "-ar", "22050", "-ac", "1", "-b:a", "32k",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], 600000);
}

export function extractAudio(ffmpeg: string, inputPath: string, outputPath: string): Promise<void> {
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-i", inputPath,
    "-vn", "-ar", "22050", "-ac", "1", "-b:a", "32k",
    "-y", outputPath,
  ]);
}

export function extractAudioSegment(ffmpeg: string, inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<void> {
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-i", inputPath,
    "-ss", String(startSec),
    "-t", String(durationSec),
    "-vn", "-ar", "22050", "-ac", "1", "-b:a", "32k",
    "-y", outputPath,
  ]);
}

export function extractClip(ffmpeg: string, inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<void> {
  // double-ss: 5초 앞에서 입력 시킹 → 출력 시킹으로 정확한 첫 프레임 보장
  const preSec = Math.min(5, startSec);
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-ss", String(startSec - preSec),
    "-i", inputPath,
    "-ss", String(preSec),
    "-t", String(durationSec),
    "-c:v", "libx264", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], 300000);
}

// 세로 변환 (9:16): 블러 배경에 원본 오버레이
export function extractClipVertical(ffmpeg: string, inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<void> {
  const filter = [
    "[0:v]split=2[src1][src2]",
    "[src1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:20[bg]",
    "[src2]scale=1080:1920:force_original_aspect_ratio=decrease[fg]",
    "[bg][fg]overlay=(W-w)/2:(H-h)/2[out]",
  ].join(";");
  const preSec = Math.min(5, startSec);
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-ss", String(startSec - preSec),
    "-i", inputPath,
    "-ss", String(preSec),
    "-t", String(durationSec),
    "-filter_complex", filter,
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], 300000);
}

// 1:1 정사각형 (1080×1080): 블러 배경에 원본 오버레이
export function extractClipSquare(ffmpeg: string, inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<void> {
  const filter = [
    "[0:v]split=2[src1][src2]",
    "[src1]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,boxblur=20:20[bg]",
    "[src2]scale=1080:1080:force_original_aspect_ratio=decrease[fg]",
    "[bg][fg]overlay=(W-w)/2:(H-h)/2[out]",
  ].join(";");
  const preSec = Math.min(5, startSec);
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-ss", String(startSec - preSec),
    "-i", inputPath,
    "-ss", String(preSec),
    "-t", String(durationSec),
    "-filter_complex", filter,
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264", "-c:a", "aac",
    "-movflags", "+faststart",
    "-y", outputPath,
  ], 300000);
}

export function extractThumbnail(ffmpeg: string, inputPath: string, seekSec: number, outputPath: string): Promise<void> {
  return spawnAsync(ffmpeg, [
    "-loglevel", "error",
    "-ss", String(seekSec),
    "-i", inputPath,
    "-vframes", "1",
    "-q:v", "3",
    "-y", outputPath,
  ]);
}

export function secsToMMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function mmssToSecs(t: string): number {
  const p = t.split(":").map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return p[0] * 60 + (p[1] ?? 0);
}
