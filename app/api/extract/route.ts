import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Busboy from "busboy";
import { Readable } from "stream";
import { resolveFfmpeg, extractClip, extractClipVertical, extractClipSquare, extractThumbnail, mmssToSecs } from "@/lib/ffmpeg";
import { makeZip } from "@/lib/zip";
import { makeSrt } from "@/lib/srt";

export const maxDuration = 3600;

interface SubtitleItem { time: string; text: string; type: string; desc: string; }
interface Clip {
  start: string; end: string; title: string;
  hook?: string; highlight?: string; hashtags?: string[];
  subtitleGuide?: SubtitleItem[];
}

type OutputFormat = "original" | "vertical" | "square";

function parseFormData(req: NextRequest): Promise<{ filePath: string; clips: Clip[]; format: OutputFormat; minDuration: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const bb = Busboy({ headers });
    let filePath = ""; let clipsJson = "";
    let format: OutputFormat = "original"; let minDuration = 120;
    let writeFinish: Promise<void> | null = null;

    bb.on("file", (_field, stream, info) => {
      const ext = (path.basename(info.filename).split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4";
      filePath = path.join(os.tmpdir(), `ce_src_${Date.now()}.${ext}`);
      const ws = fs.createWriteStream(filePath);
      writeFinish = new Promise<void>((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
      stream.pipe(ws);
    });

    bb.on("field", (name, val) => {
      if (name === "clips") clipsJson = val;
      if (name === "format" && (val === "original" || val === "vertical" || val === "square")) format = val;
      if (name === "minDuration") { const d = parseInt(val); if (d >= 15) minDuration = d; }
    });

    bb.on("finish", async () => {
      try {
        if (writeFinish) await writeFinish;
        if (!filePath || !clipsJson) { reject(new Error("파일 또는 클립 정보가 없습니다.")); return; }
        resolve({ filePath, clips: JSON.parse(clipsJson), format, minDuration });
      } catch (e) { reject(e); }
    });

    bb.on("error", reject);
    const body = req.body;
    if (!body) { reject(new Error("요청 바디가 없습니다.")); return; }
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(bb);
  });
}

export async function POST(req: NextRequest) {
  const ts = Date.now();
  let tempInput = "";
  const clipPaths: string[] = [];
  const thumbPaths: string[] = [];

  try {
    const { filePath, clips, format, minDuration } = await parseFormData(req);
    tempInput = filePath;
    if (!clips.length) return NextResponse.json({ error: "클립을 선택해 주세요." }, { status: 400 });

    const ffmpeg = resolveFfmpeg();

    // 타임스탬프 유효성 검사
    for (let i = 0; i < clips.length; i++) {
      const { start, end } = clips[i];
      const startSec = Math.max(0, mmssToSecs(start));
      const endSec = mmssToSecs(end);
      if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) {
        throw new Error(`클립 ${i + 1}의 타임스탬프가 잘못됐습니다: ${start} → ${end}`);
      }
    }

    // 클립 + 썸네일 병렬 추출
    await Promise.all(clips.map(async (clip, i) => {
      const startSec = Math.max(0, mmssToSecs(clip.start));
      const endSec = mmssToSecs(clip.end);
      const duration = Math.max(minDuration, endSec - startSec);
      const outPath = path.join(os.tmpdir(), `ce_clip_${ts}_${i + 1}.mp4`);
      const thumbPath = path.join(os.tmpdir(), `ce_thumb_${ts}_${i + 1}.jpg`);
      clipPaths[i] = outPath;
      thumbPaths[i] = thumbPath;

      const extractFn =
        format === "vertical" ? extractClipVertical :
        format === "square"   ? extractClipSquare :
                                extractClip;

      await Promise.all([
        extractFn(ffmpeg, tempInput, startSec, duration, outPath),
        extractThumbnail(ffmpeg, tempInput, startSec + 2, thumbPath),
      ]);
    }));

    const zipFiles: { name: string; data: Buffer }[] = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const safeTitle = clips[i].title.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
      const prefix = String(i + 1).padStart(2, "0");
      zipFiles.push({ name: `${prefix}_${safeTitle}.mp4`, data: fs.readFileSync(clipPaths[i]) });
      if (fs.existsSync(thumbPaths[i])) {
        zipFiles.push({ name: `${prefix}_${safeTitle}_thumb.jpg`, data: fs.readFileSync(thumbPaths[i]) });
      }
      if (clips[i].subtitleGuide?.length) {
        const guide = clips[i].subtitleGuide!;
        const subtitleTxt = [
          `[${clips[i].title}] 포인트 자막 가이드`,
          "",
          "캡컷에서 타임라인의 해당 시간대에 텍스트 레이어를 추가하세요.",
          "권장: 0.5~1초, 임팩트 있게 배치",
          "",
          ...guide.map(s => `${s.time}  |  ${s.text}  |  ${s.desc}`),
        ].join("\n");
        zipFiles.push({ name: `${prefix}_${safeTitle}_포인트자막.txt`, data: Buffer.from(subtitleTxt, "utf8") });
        zipFiles.push({ name: `${prefix}_${safeTitle}.srt`, data: Buffer.from(makeSrt(guide), "utf8") });
      }
    }

    const meta = [
      `Clip Extractor — 클립 메타데이터${format === "vertical" ? " [세로 9:16]" : format === "square" ? " [정사각형 1:1]" : ""}`,
      new Date().toLocaleString("ko-KR"), "",
      ...clips.flatMap((c, i) => [
        `── 클립 ${i + 1}: ${c.title} ──`,
        `시간: ${c.start} → ${c.end}`,
        c.hook ? `훅: ${c.hook}` : "",
        c.highlight ? `핵심: ${c.highlight}` : "",
        c.hashtags?.length ? `태그: ${c.hashtags.join(" ")}` : "",
        "",
      ].filter(Boolean)),
    ].join("\n");
    zipFiles.push({ name: "메타데이터.txt", data: Buffer.from(meta, "utf8") });

    const zipBuffer = makeZip(zipFiles);
    return new NextResponse(zipBuffer.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="clips_${ts}.zip"`,
      },
    });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[extract] error:", msg);
    return NextResponse.json({ error: `클립 추출 오류: ${msg}` }, { status: 500 });
  } finally {
    try { if (tempInput && fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
    clipPaths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
    thumbPaths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
  }
}
