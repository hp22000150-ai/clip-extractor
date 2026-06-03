import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

export const maxDuration = 120;

function findYtDlp(): string | null {
  const candidates = [
    // Electron 패키지 내 standalone 폴더 옆
    path.join(process.cwd(), "yt-dlp.exe"),
    path.join(process.cwd(), "yt-dlp"),
    // 시스템 PATH
    "yt-dlp",
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "pipe" });
    if (r.status === 0) return c;
  }
  return null;
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

    // 제목 먼저 가져오기
    const titleResult = spawnSync(ytdlp, [
      "--get-title", "--no-playlist", url,
    ], { stdio: "pipe", encoding: "utf-8", timeout: 15000 });
    const title = (titleResult.stdout || "").trim() || "참고 쇼츠";

    // 오디오 다운로드 (32k MP3, 최대 5분)
    const dlResult = spawnSync(ytdlp, [
      url,
      "-x", "--audio-format", "mp3",
      "--audio-quality", "32K",
      "--match-filter", "duration <= 300",
      "--no-playlist",
      "-o", outTemplate,
    ], { stdio: "pipe", timeout: 60000 });

    if (dlResult.status !== 0 || !fs.existsSync(outPath)) {
      const msg = dlResult.stderr?.toString("utf-8") ?? "";
      if (msg.includes("duration")) {
        return NextResponse.json({ error: "5분 이하의 영상만 참고로 사용할 수 있습니다." }, { status: 400 });
      }
      throw new Error("다운로드 실패: " + msg.slice(0, 200));
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
