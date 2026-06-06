import { NextRequest, NextResponse } from "next/server";
import * as path from "path";
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

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/(shorts\/|watch|live\/)|youtu\.be\/)/.test(url);
}

function parseTimestampSec(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + (parts[1] ?? 0);
}

function secsToLabel(s: number): string {
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json() as { url: string };

    if (!url || !isYouTubeUrl(url)) {
      return NextResponse.json({ error: "유효한 YouTube URL을 입력해 주세요." }, { status: 400 });
    }

    const ytdlp = findYtDlp();
    if (!ytdlp) {
      return NextResponse.json({ error: "yt-dlp를 찾을 수 없습니다." }, { status: 500 });
    }

    const spawnOpts = {
      stdio: "pipe" as const,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    };

    const result = spawnSync(ytdlp, [
      "-j", "--write-comments", "--skip-download", "--no-playlist",
      "--max-comments", "300",
      "--extractor-args", "youtube:player_client=android,ios",
      url,
    ], { ...spawnOpts, timeout: 50000 });

    if (result.status !== 0 || !result.stdout) {
      const stderr = (result.stderr as Buffer | null)?.toString("utf-8") ?? "";
      return NextResponse.json(
        { error: "댓글 불러오기 실패: " + stderr.slice(0, 200) },
        { status: 500 }
      );
    }

    let meta: { comments?: Array<{ text?: string; like_count?: number }> };
    try {
      meta = JSON.parse((result.stdout as Buffer).toString("utf-8"));
    } catch {
      return NextResponse.json({ error: "응답 파싱 실패" }, { status: 500 });
    }

    const comments = meta.comments ?? [];
    if (comments.length === 0) {
      return NextResponse.json({ timestamps: [], total: 0, message: "댓글이 없거나 타임스탬프 언급이 없습니다." });
    }

    const TIMESTAMP_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
    const bucketMap = new Map<number, { label: string; count: number; likes: number; secs: number }>();

    for (const comment of comments) {
      const text = comment.text ?? "";
      const matches = Array.from(text.matchAll(TIMESTAMP_RE), m => m[1]);
      const seen = new Set<number>();
      for (const ts of matches) {
        const secs = parseTimestampSec(ts);
        if (secs < 5) continue;
        const bucket = Math.round(secs / 30) * 30;
        if (seen.has(bucket)) continue;
        seen.add(bucket);
        const existing = bucketMap.get(bucket);
        if (existing) {
          existing.count++;
          existing.likes += comment.like_count ?? 0;
        } else {
          bucketMap.set(bucket, { label: secsToLabel(secs), count: 1, likes: comment.like_count ?? 0, secs });
        }
      }
    }

    const timestamps = Array.from(bucketMap.values())
      .sort((a, b) => b.count - a.count || b.likes - a.likes)
      .slice(0, 12)
      .map(({ label, count, likes, secs }) => ({ label, count, likes, secs }));

    return NextResponse.json({ timestamps, total: comments.length });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[comments] error:", msg);
    return NextResponse.json({ error: `오류: ${msg}` }, { status: 500 });
  }
}
