import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Busboy from "busboy";
import { Readable } from "stream";
import { resolveFfmpeg, extractAudio } from "@/lib/ffmpeg";
import { withRetry } from "@/lib/retry";

export const maxDuration = 3600;

// 인라인 한도: base64 인코딩 시 ~33% 증가하므로 10MB 원본 = ~13MB base64로 안전하게 유지
// 40분 이하 영상은 인라인, 그 이상은 Files API (2시간도 단일 분석으로 처리)
const INLINE_LIMIT = 10 * 1024 * 1024;

interface Moment {
  start: string; end: string; type: string;
  title: string; highlight: string; reason: string;
  hook: string; hashtags: string[]; score?: number;
}

const DURATION_GUIDE: Record<number, string> = {
  30: "최소 30초~최대 1분",
  60: "최소 1분~최대 2분",
  120: "최소 2분~최대 3분",
  180: "최소 3분~최대 5분",
};

interface ExcludeRange { start: string; end: string; }

interface FormFields {
  filePath: string; fileName: string;
  aiRole: string; persona: string;
  sceneHint: string; types: string[];
  clipCount: number; minDuration: number;
  excludeRanges: ExcludeRange[];
}

function parseFormData(req: NextRequest): Promise<FormFields> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const bb = Busboy({ headers });

    let filePath = ""; let fileName = "";
    let aiRole = ""; let persona = "20대 직장인";
    let sceneHint = ""; let types: string[] = [];
    let clipCount = 5; let minDuration = 120;
    let excludeRanges: ExcludeRange[] = [];
    let writeFinish: Promise<void> | null = null;

    bb.on("file", (_field, stream, info) => {
      fileName = info.filename;
      const ext = (fileName.split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4";
      filePath = path.join(os.tmpdir(), `ce_input_${Date.now()}.${ext}`);
      const ws = fs.createWriteStream(filePath);
      writeFinish = new Promise<void>((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
      stream.pipe(ws);
    });

    bb.on("field", (name, val) => {
      if (name === "aiRole") aiRole = val;
      if (name === "persona") persona = val;
      if (name === "sceneHint") sceneHint = val;
      if (name === "types") { try { types = JSON.parse(val); } catch {} }
      if (name === "clipCount") { const n = parseInt(val); if (n >= 1 && n <= 15) clipCount = n; }
      if (name === "minDuration") { const d = parseInt(val); if (d >= 15) minDuration = d; }
      if (name === "excludeRanges") { try { excludeRanges = JSON.parse(val); } catch {} }
    });

    bb.on("finish", async () => {
      try {
        if (writeFinish) await writeFinish;
        if (!filePath) { reject(new Error("파일을 받지 못했습니다.")); return; }
        resolve({ filePath, fileName, aiRole, persona, sceneHint, types, clipCount, minDuration, excludeRanges });
      } catch (e) { reject(e); }
    });

    bb.on("error", reject);
    const body = req.body;
    if (!body) { reject(new Error("요청 바디가 없습니다.")); return; }
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(bb);
  });
}

async function uploadToGeminiFiles(apiKey: string, audioPath: string): Promise<string> {
  const audioBuffer = fs.readFileSync(audioPath);
  const boundary = `----FormBoundary${Date.now()}`;
  const metaPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"file":{"mimeType":"audio/mpeg"}}\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\n\r\n`
  );
  const closePart = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([metaPart, audioBuffer, closePart]);

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

async function deleteGeminiFile(apiKey: string, uri: string): Promise<void> {
  const name = uri.split("/files/")[1];
  if (!name) return;
  await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${apiKey}`, { method: "DELETE" }).catch(() => {});
}

function buildPrompts(aiRole: string, persona: string, sceneHint: string, typeEnum: string, typePreference: string, clipCount: number, minDuration: number, excludeRanges: ExcludeRange[] = []) {
  const roleInstruction = aiRole.trim()
    ? `[AI 역할]\n${aiRole.trim()}\n이 역할의 시각과 전문성으로 영상을 분석하세요.\n`
    : "";

  const emotionGuide = `[감정 유형 정의 — 시청자 반응 기준]
- 감동: 가슴 뭉클·눈물·훈훈함이 느껴지는 순간
- 웃음: 실제로 웃음이 터지거나 피식하게 되는 순간
- 반전: "헉" 하거나 예상을 완전히 벗어나 놀라는 순간
- 명대사: 공감되거나 저장하고 싶어지는 말
- 하이라이트: 가장 긴장감·에너지가 높은 클라이맥스`;

  const sceneHintLine = sceneHint.trim()
    ? `\n[제작자 요청] 특히 이런 장면을 우선 찾아주세요: "${sceneHint}" — 이 조건에 맞는 장면이 있으면 반드시 포함.`
    : "";

  const momentSlot = (n: number) =>
    `{"start":"MM:SS","end":"MM:SS","type":"${typeEnum} 중 하나","title":"장면${n} 제목(한국어)","highlight":"시청자가 느낄 감정 위주 핵심 내용(한국어)","reason":"일반 시청자가 실제로 반응하는 이유(한국어)","hook":"첫 3초 훅 멘트(한국어, 질문형·충격형·공감형 중 효과적인 것)","hashtags":["#태그1","#태그2","#태그3","#태그4","#태그5"],"score":8}`;

  const momentSlotsStr = Array.from({ length: clipCount }, (_, i) => momentSlot(i + 1)).join(",\n    ");
  const durationGuide = DURATION_GUIDE[minDuration] ?? "최소 2분~최대 3분";

  const excludeSection = excludeRanges.length > 0
    ? `\n[재분석 — 이미 추출된 구간 제외 필수]\n아래 시간대는 이전에 이미 선정된 장면입니다. 이 구간과 조금이라도 겹치는 장면은 선정하지 마세요:\n${excludeRanges.map(r => `- ${r.start} ~ ${r.end}`).join("\n")}\n이 구간들과 완전히 다른 새로운 장면 ${clipCount}개를 찾으세요.\n`
    : "";

  const fullPrompt = `[필수 규칙] 모든 텍스트는 한국어. moments는 반드시 ${clipCount}개.${excludeSection}

${roleInstruction}[분석 순서]
1. 오디오 전체를 처음부터 끝까지 완전히 듣고 전사한다
2. 전체 내용·흐름·감정선을 파악한다
3. 그 후 [${persona}]의 시각으로 최적의 장면 ${clipCount}개를 선정한다

"${persona}이(가) 이 장면에서 댓글을 달겠다", "다시 돌려보겠다" 싶은 순간을 찾으세요.
${sceneHintLine}

${emotionGuide}

${persona}의 반응이 폭발할 장면 ${clipCount}개를 아래 JSON으로 반환:

{
  "summary": "영상 전체 내용 2~3줄 요약(등장인물·상황 포함, 한국어)",
  "moments": [
    ${momentSlotsStr}
  ]
}

[선정 기준]
- 초반·중반·후반 고르게 선정 (초반 편중 금지)
- 각 장면 ${durationGuide} (start→end 기준)
- 선정된 장면들의 시간대가 서로 겹치지 않아야 함
- start는 장면이 실제로 시작되는 정확한 시점 (느슨하게 잡지 말 것)
- end는 이야기·감정이 자연스럽게 마무리되는 시점
- type은 [${typeEnum}] 중 가장 잘 맞는 것
- score(1~10): 쇼츠 바이럴 가능성. 10=즉시 공유하고 싶은 수준
${typePreference ? `- ${typePreference}` : ""}`;

  return { fullPrompt };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "API 키가 설정되지 않았습니다 (.env.local 확인)." }, { status: 500 });

  const ts = Date.now();
  let tempInput = "";
  const tempAudio = path.join(os.tmpdir(), `ce_audio_${ts}.mp3`);
  let geminiFileUri = "";

  try {
    const { filePath, types, aiRole, persona, sceneHint, clipCount, minDuration, excludeRanges } = await parseFormData(req);
    tempInput = filePath;

    const ffmpeg = resolveFfmpeg();
    await extractAudio(ffmpeg, tempInput, tempAudio);

    const audioSize = fs.statSync(tempAudio).size;
    const TYPE_MAP: Record<string, string> = {
      "케미": "케미와 매력이 넘치는", "열정": "뜨겁고 자극적인",
    };
    const typeEnum = types.length > 0 ? types.join("|") : "감동|웃음|반전|명대사|하이라이트";
    const typePreference = types.length > 0
      ? `${types.map(t => TYPE_MAP[t] ?? t).join("·")} 장면 위주로 선정.`
      : "";

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: "당신은 10년 경력의 유튜브 쇼츠 전문 편집자입니다. 바이럴되는 장면의 패턴을 정확히 파악하고, 시청자의 감정을 자극하는 순간을 본능적으로 포착합니다. 오디오를 정확히 전사하고 내용을 완전히 이해한 뒤 장면을 선정합니다. 모든 분석 내용은 한국어로 작성하세요.",
      generationConfig: { temperature: 0.8, maxOutputTokens: 65536, responseMimeType: "application/json" },
    });

    const { fullPrompt } = buildPrompts(aiRole, persona, sceneHint, typeEnum, typePreference, clipCount, minDuration, excludeRanges);

    let result;
    if (audioSize <= INLINE_LIMIT) {
      console.log(`[analyze] inline mode (${(audioSize / 1024 / 1024).toFixed(1)}MB)`);
      const audioBase64 = fs.readFileSync(tempAudio).toString("base64");
      result = await withRetry(() => model.generateContent([
        { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } },
        fullPrompt,
      ]));
    } else {
      console.log(`[analyze] Files API mode (${(audioSize / 1024 / 1024).toFixed(1)}MB)`);
      geminiFileUri = await withRetry(() => uploadToGeminiFiles(apiKey, tempAudio));
      result = await withRetry(() => model.generateContent([
        { fileData: { mimeType: "audio/mpeg", fileUri: geminiFileUri } },
        fullPrompt,
      ]));
    }

    try {
      return NextResponse.json(JSON.parse(jsonrepair(result.response.text())));
    } catch {
      throw new Error("AI 응답을 파싱하지 못했습니다. 다시 시도해 주세요.");
    }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[analyze] error:", msg);
    return NextResponse.json({ error: `분석 중 오류: ${msg}` }, { status: 500 });
  } finally {
    if (geminiFileUri) await deleteGeminiFile(apiKey!, geminiFileUri);
    try { if (tempInput && fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
    try { if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio); } catch {};
  }
}
