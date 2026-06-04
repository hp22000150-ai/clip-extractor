import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

export const maxDuration = 120;

function findYtDlp(): string | null {
  const candidates = [
    path.join(process.cwd(), "yt-dlp.exe"),
    path.join(process.cwd(), "yt-dlp"),
    "yt-dlp",
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "pipe", windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}

function findFfmpeg(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p: string = require("ffmpeg-static");
    if (typeof p === "string" && p && fs.existsSync(p)) return p;
  } catch {}
  const bin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const local = path.join(process.cwd(), "node_modules", "ffmpeg-static", bin);
  if (fs.existsSync(local)) return local;
  return undefined;
}

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(shorts\/|watch)|youtu\.be\/)/.test(url);
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json() as { url: string };

    if (!url || !isYouTubeUrl(url)) {
      return NextResponse.json(
        { error: "유효한 YouTube 또는 YouTube Shorts URL을 입력해 주세요." },
        { status: 400 }
      );
    }

    const ytdlp = findYtDlp();
    if (!ytdlp) {
      return NextResponse.json(
        {
          error: "yt-dlp가 설치되지 않았습니다.\n" +
            "설치 방법: https://github.com/yt-dlp/yt-dlp/releases 에서\n" +
            "yt-dlp.exe 를 다운로드 후 앱 폴더에 넣으세요.",
        },
        { status: 500 }
      );
    }

    const ts = Date.now();
    const outTemplate = path.join(os.tmpdir(), `ce_ref_${ts}.%(ext)s`);
    const outPath = path.join(os.tmpdir(), `ce_ref_${ts}.mp3`);

    const ffmpeg = findFfmpeg();
    const ffmpegArgs = ffmpeg ? ["--ffmpeg-location", ffmpeg] : [];

    // JS 런타임 없이 동작하는 YouTube 클라이언트 사용
    const extractorArgs = ["--extractor-args", "youtube:player_client=android,ios"];

    const spawnOpts = {
      stdio: "pipe" as const,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    };

    // 제목 가져오기 — JSON dump 사용 (Python이 \uXXXX 이스케이프로 출력 → 인코딩 무관)
    const metaResult = spawnSync(ytdlp, [
      "-j", "--skip-download", "--no-playlist",
      ...extractorArgs,
      ...ffmpegArgs,
      url,
    ], { ...spawnOpts, timeout: 20000 });
    let title = "참고 쇼츠";
    if (metaResult.status === 0 && metaResult.stdout) {
      try {
        const meta = JSON.parse((metaResult.stdout as Buffer).toString("utf-8"));
        title = (meta.title as string) || "참고 쇼츠";
      } catch {}
    }

    // 오디오 다운로드 (32k MP3, 최대 5분)
    const dlResult = spawnSync(ytdlp, [
      url,
      "-x", "--audio-format", "mp3",
      "--audio-quality", "32K",
      "--match-filter", "duration <= 300",
      "--no-playlist",
      ...extractorArgs,
      ...ffmpegArgs,
      "-o", outTemplate,
    ], { ...spawnOpts, timeout: 60000 });

    if (dlResult.status !== 0 || !fs.existsSync(outPath)) {
      const msg = (dlResult.stderr as Buffer | null)?.toString("utf-8") ?? "";
      if (msg.includes("duration")) {
        return NextResponse.json({ error: "5분 이하의 영상만 참고로 사용할 수 있습니다." }, { status: 400 });
      }
      throw new Error("다운로드 실패: " + msg.slice(0, 400));
    }

    const audio = fs.readFileSync(outPath).toString("base64");
    fs.unlinkSync(outPath);

    return NextResponse.json({ audio, title });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[reference] error:", msg);
    return NextResponse.json({ error: `오류: ${msg}` }, { status: 500 });
  }
}
