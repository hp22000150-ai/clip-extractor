import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Busboy from "busboy";
import { Readable } from "stream";
import { resolveFfmpeg, transcodeForAnalysis, getVideoDurationSec } from "@/lib/ffmpeg";
import { makeTimedSrt } from "@/lib/srt";
import { withRetry } from "@/lib/retry";

export const maxDuration = 300;

const INLINE_LIMIT = 10 * 1024 * 1024;

interface SubEntry { start: string; end: string; text: string; }

// ─── 타임코드 정규화 ─────────────────────────────────────────────────────────
// Gemini가 반환하는 다양한 형식을 SRT 표준(HH:MM:SS,mmm)으로 변환
function normalizeTimecode(tc: unknown): string {
  if (typeof tc !== "string" || !tc.trim()) return "00:00:00,000";
  let t = tc.trim().replace(".", ","); // HH:MM:SS.mmm → HH:MM:SS,mmm

  // 이미 올바른 형식
  if (/^\d{2}:\d{2}:\d{2},\d{3}$/.test(t)) return t;

  // HH:MM:SS (밀리초 없음)
  if (/^\d{2}:\d{2}:\d{2}$/.test(t)) return t + ",000";

  // M:SS,mmm 또는 MM:SS,mmm (시간 없음)
  const mmss = t.match(/^(\d{1,2}):(\d{2}),(\d{1,3})$/);
  if (mmss) {
    const ms = mmss[3].padEnd(3, "0");
    return `00:${mmss[1].padStart(2, "0")}:${mmss[2]},${ms}`;
  }

  // MM:SS (시간·밀리초 없음)
  const ms2 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (ms2) return `00:${ms2[1].padStart(2, "0")}:${ms2[2]},000`;

  // 순수 초 숫자
  if (/^\d+$/.test(t)) {
    const s = parseInt(t);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},000`;
  }

  return "00:00:00,000";
}

function tcToMs(tc: string): number {
  const m = tc.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]);
}

function msToTc(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
}

// ─── 입력값 검증 ─────────────────────────────────────────────────────────────
function toSubEntries(raw: unknown, textField: string): SubEntry[] {
  if (!Array.isArray(raw)) return [];
  const MIN_DURATION_MS = 300; // 최소 300ms 보장

  return raw
    .filter(e => e && typeof e === "object")
    .map(e => {
      const rec = e as Record<string, unknown>;
      const text = String(rec[textField] ?? "").trim();
      if (!text) return null;
      const start = normalizeTimecode(rec.start);
      let end = normalizeTimecode(rec.end);
      // end가 start보다 빠르거나 같으면 start + min_duration으로 보정
      if (tcToMs(end) <= tcToMs(start)) {
        end = msToTc(tcToMs(start) + Math.max(MIN_DURATION_MS, 1500));
      }
      return { start, end, text };
    })
    .filter((e): e is SubEntry => e !== null);
}

// ─── 폼 파싱 ─────────────────────────────────────────────────────────────────
function parseFormData(req: NextRequest): Promise<{ filePath: string; density: string; moods: string[] }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const bb = Busboy({ headers });

    let filePath = "";
    let density = "보통";
    let moods: string[] = [];
    let writeFinish: Promise<void> | null = null;

    bb.on("file", (_field, stream, info) => {
      const ext = (info.filename.split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4";
      filePath = path.join(os.tmpdir(), `ce_sub_${Date.now()}.${ext}`);
      const ws = fs.createWriteStream(filePath);
      writeFinish = new Promise<void>((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
      stream.pipe(ws);
    });

    bb.on("field", (name, val) => {
      if (name === "density") density = val;
      if (name === "moods") { try { moods = JSON.parse(val); } catch {} }
    });

    bb.on("finish", async () => {
      try {
        if (writeFinish) await writeFinish;
        if (!filePath) { reject(new Error("파일을 받지 못했습니다.")); return; }
        resolve({ filePath, density, moods });
      } catch (e) { reject(e); }
    });

    bb.on("error", reject);
    const body = req.body;
    if (!body) { reject(new Error("요청 바디가 없습니다.")); return; }
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(bb);
  });
}

// ─── Gemini Files API ─────────────────────────────────────────────────────────
async function uploadToGeminiFiles(apiKey: string, filePath: string, mimeType: string): Promise<string> {
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = `----FormBoundary${Date.now()}`;
  const metaPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"file":{"mimeType":"${mimeType}"}}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const closePart = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([metaPart, fileBuffer, closePart]);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(body.length) },
      body,
    }
  );
  if (!res.ok) throw new Error(`Files API 업로드 실패: ${await res.text()}`);
  const data = await res.json() as { file?: { uri?: string } };
  const uri = data.file?.uri;
  if (!uri) throw new Error("Files API URI를 받지 못했습니다.");
  return uri;
}

async function waitForActive(apiKey: string, fileUri: string, sizeMb = 20): Promise<void> {
  const name = fileUri.split("/files/")[1];
  if (!name) return;
  const timeoutMs = Math.min(600000, Math.max(60000, Math.ceil(sizeMb / 100) * 120000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${apiKey}`);
    const data = await res.json() as { state?: string };
    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED") throw new Error("Gemini Files API 처리 실패");
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Gemini Files API 처리 시간 초과");
}

async function deleteGeminiFile(apiKey: string, uri: string): Promise<void> {
  const name = uri.split("/files/")[1];
  if (!name) return;
  await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${apiKey}`, { method: "DELETE" }).catch(() => {});
}

// ─── 프롬프트 ─────────────────────────────────────────────────────────────────
function buildPrompt(durationSec: number, density: string, moods: string[]): string {
  const densityMap: Record<string, string> = {
    "촘촘": "1~2초 간격으로 빽빽하게, 영상 전체 커버",
    "보통": "3~4초 간격, 중요 장면 위주",
    "띄엄": "5~8초 간격, 임팩트 있는 핵심 순간만",
  };
  const densityGuide = densityMap[density] ?? densityMap["보통"];
  const moodLine = moods.length > 0 ? `분위기: ${moods.join(", ")} 스타일.\n` : "";

  return `영상에는 대사 없이 BGM만 있습니다. 시각적 장면(색감·움직임·분위기·감정)을 분석해 창작 한국어 자막을 만드세요.
${moodLine}
영상 길이: ${Math.round(durationSec)}초

[규칙]
• subtitles: 장면 분위기·감정 전달 문장. 밀도=${densityGuide}. 1문장 최대 15자.
• pointWords: 가장 강렬한 순간의 핵심 단어 1~2자. 전체 3~7개.
• pointSentences: 핵심 메시지 압축 문장 15자 이내. 전체 3~7개.
• 타임코드 형식 반드시: HH:MM:SS,mmm (예: 00:00:03,500 / 00:01:12,000)
• end는 반드시 start보다 나중. 최소 1초 간격.
• 자막끼리 시간 겹침 없이 배치.
• 한국어만 사용.

JSON 형식으로만 응답:
{
  "subtitles": [
    {"start":"00:00:01,000","end":"00:00:03,000","text":"봄이 찾아온 오후"},
    {"start":"00:00:04,000","end":"00:00:06,000","text":"아무것도 몰랐던 그 날"}
  ],
  "pointWords": [
    {"start":"00:00:02,500","end":"00:00:03,500","word":"봄"}
  ],
  "pointSentences": [
    {"start":"00:00:05,000","end":"00:00:08,000","text":"아무도 모르는 그 순간"}
  ]
}`;
}

// ─── SRT 조립 ─────────────────────────────────────────────────────────────────
function buildSrtFiles(raw: Record<string, unknown>): { subtitle: string; pointSubtitle: string } {
  const subtitles = toSubEntries(raw.subtitles, "text");
  const pointWordEntries = toSubEntries(raw.pointWords, "word").map(e => ({
    ...e,
    text: `<b><font color="#FF4444">${e.text}</font></b>`,
  }));
  const pointSentenceEntries = toSubEntries(raw.pointSentences, "text").map(e => ({
    ...e,
    text: `<b><font color="#FFD700">${e.text}</font></b>`,
  }));

  // 시간순 정렬 — 정규화된 타임코드는 문자열 비교로 정렬 가능
  const pointEntries = [...pointWordEntries, ...pointSentenceEntries]
    .sort((a, b) => a.start.localeCompare(b.start));

  if (subtitles.length === 0 && pointEntries.length === 0) {
    throw new Error("AI가 자막을 생성하지 못했습니다. 영상 파일을 확인하거나 다시 시도해 주세요.");
  }

  return {
    subtitle: makeTimedSrt(subtitles),
    pointSubtitle: makeTimedSrt(pointEntries),
  };
}

// ─── 핸들러 ──────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "API 키가 설정되지 않았습니다." }, { status: 500 });

  const ts = Date.now();
  let tempInput = "";
  const tempVideo = path.join(os.tmpdir(), `ce_sub_v_${ts}.mp4`);
  let geminiFileUri = "";

  try {
    const { filePath, density, moods } = await parseFormData(req);
    tempInput = filePath;

    const ffmpeg = resolveFfmpeg();
    const durationSec = await getVideoDurationSec(ffmpeg, tempInput);
    if (durationSec <= 0) throw new Error("영상 길이를 읽을 수 없습니다. 지원하는 영상 형식인지 확인해 주세요.");

    console.log(`[subtitle-gen] duration=${Math.round(durationSec)}s, density=${density}, transcoding...`);
    await transcodeForAnalysis(ffmpeg, tempInput, tempVideo);

    if (!fs.existsSync(tempVideo)) throw new Error("영상 변환에 실패했습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.");

    const videoSize = fs.statSync(tempVideo).size;
    const videoSizeMb = videoSize / 1024 / 1024;
    console.log(`[subtitle-gen] transcoded (${videoSizeMb.toFixed(1)}MB)`);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: "당신은 영상 자막 전문 크리에이터입니다. BGM만 있고 대사 없는 영상을 시각 분석해 창작 한국어 자막을 만듭니다. 반드시 유효한 JSON만 반환하세요.",
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 32768,
        responseMimeType: "application/json",
      },
    });

    const prompt = buildPrompt(durationSec, density, moods);

    let videoPart: Part;
    if (videoSize <= INLINE_LIMIT) {
      const base64 = fs.readFileSync(tempVideo).toString("base64");
      videoPart = { inlineData: { mimeType: "video/mp4", data: base64 } };
    } else {
      console.log(`[subtitle-gen] large file (${videoSizeMb.toFixed(1)}MB), using Files API`);
      geminiFileUri = await withRetry(() => uploadToGeminiFiles(apiKey, tempVideo, "video/mp4"));
      await waitForActive(apiKey, geminiFileUri, videoSizeMb);
      videoPart = { fileData: { mimeType: "video/mp4", fileUri: geminiFileUri } };
    }

    const responseText = await withRetry(() =>
      model.generateContent([videoPart, prompt]).then(r => r.response.text())
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonrepair(responseText)) as Record<string, unknown>;
    } catch {
      console.error("[subtitle-gen] JSON 파싱 실패. 응답 앞 300자:", responseText.slice(0, 300));
      throw new Error("AI 응답을 파싱하지 못했습니다. 다시 시도해 주세요.");
    }

    const { subtitle, pointSubtitle } = buildSrtFiles(parsed);
    return NextResponse.json({ subtitle, pointSubtitle });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[subtitle-gen] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (geminiFileUri) await deleteGeminiFile(apiKey!, geminiFileUri);
    try { if (tempInput && fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
    try { if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo); } catch {}
  }
}
