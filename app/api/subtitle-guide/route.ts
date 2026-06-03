import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Busboy from "busboy";
import { Readable } from "stream";
import { resolveFfmpeg, extractAudioSegment } from "@/lib/ffmpeg";

export const maxDuration = 300;

interface FormFields {
  filePath: string;
  start: string;
  end: string;
  title: string;
}

function parseFormData(req: NextRequest): Promise<FormFields> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const bb = Busboy({ headers });
    let filePath = ""; let start = "00:00"; let end = "02:00"; let title = "";
    let writeFinish: Promise<void> | null = null;

    bb.on("file", (_field, stream, info) => {
      const ext = (info.filename.split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "mp4";
      filePath = path.join(os.tmpdir(), `sg_input_${Date.now()}.${ext}`);
      const ws = fs.createWriteStream(filePath);
      writeFinish = new Promise<void>((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
      stream.pipe(ws);
    });
    bb.on("field", (name, val) => {
      if (name === "start") start = val;
      if (name === "end") end = val;
      if (name === "title") title = val;
    });
    bb.on("finish", async () => {
      try { if (writeFinish) await writeFinish; resolve({ filePath, start, end, title }); }
      catch (e) { reject(e); }
    });
    bb.on("error", reject);
    const body = req.body;
    if (!body) { reject(new Error("요청 바디가 없습니다.")); return; }
    Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).pipe(bb);
  });
}

function mmssToSecs(t: string): number {
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] ?? 0);
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "API 키 없음" }, { status: 500 });

  const ts = Date.now();
  let tempInput = "";
  const tempAudio = path.join(os.tmpdir(), `sg_audio_${ts}.mp3`);

  try {
    const { filePath, start, end, title } = await parseFormData(req);
    tempInput = filePath;

    const ffmpeg = resolveFfmpeg();
    const startSec = Math.max(0, mmssToSecs(start));
    const endSec = mmssToSecs(end);
    if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) {
      return NextResponse.json({ error: `타임스탬프가 잘못됐습니다: ${start} → ${end}` }, { status: 400 });
    }
    const duration = Math.max(10, endSec - startSec);

    await extractAudioSegment(ffmpeg, tempInput, startSec, duration, tempAudio);

    const audioBase64 = fs.readFileSync(tempAudio).toString("base64");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: "너는 예능 포인트 자막 전문가야. 반드시 한국어로만 답해.",
      generationConfig: { temperature: 1.0, maxOutputTokens: 8192, responseMimeType: "application/json" },
    });

    const prompt = `이 오디오 클립("${title}")을 듣고 캡컷 포인트 자막을 넣을 타이밍과 텍스트를 제안해.

[포인트 자막이란]
예능에서 장면에 웃음·임팩트·감정을 더하기 위해 화면에 띄우는 짧은 텍스트.
편집자의 "감각"이 들어가는 부분이야.

[유형별 예시]
- 웃음: 웃음이 터지는 순간 → "ㅋㅋㅋ", "ㄷㄷㄷ", "ㅎㅎ"
- 반응: 놀라거나 당황하는 순간 → "헐", "대박", "실화?", "미쳤다", "진짜요?"
- 정적: 어색하거나 말 끊기는 순간 → "...", "(정적)", "(침묵)"
- 강조: 핵심 대사·임팩트 있는 말 → 그 말을 그대로 텍스트로
- 상황: 상황을 설명하는 캡션 → "[당황]", "[멘붕]", "[뿌듯]", "[흐뭇]", "[억울]"
- 효과음: 상황에 맞는 효과음 표기 → "빠밤~", "뚜둥", "짠!", "...?"

[규칙]
- 5~10개 제안 (너무 많으면 오히려 이상함)
- 타임스탬프는 클립 시작(00:00)부터의 상대 시간
- 텍스트는 짧고 임팩트 있게 (5글자 이내 권장)
- 실제로 그 순간에 소리·말·상황이 있을 때만 제안

{"subtitles":[
  {"time":"00:08","text":"ㅋㅋㅋ","type":"웃음","desc":"이 부분에서 웃음 터짐"},
  {"time":"00:23","text":"헐","type":"반응","desc":"예상 밖 발언에 당황"},
  {"time":"01:12","text":"...","type":"정적","desc":"어색한 침묵"},
  {"time":"01:35","text":"[멘붕]","type":"상황","desc":"멘탈 붕괴 상황"},
  {"time":"02:04","text":"대박","type":"반응","desc":"놀라운 결과 공개 순간"}
]}`;

    const result = await model.generateContent([
      { inlineData: { mimeType: "audio/mpeg", data: audioBase64 } },
      prompt,
    ]);

    interface SubtitleItem { time: string; text: string; type: string; desc: string; }
    let data: { subtitles?: SubtitleItem[] };
    try {
      data = JSON.parse(jsonrepair(result.response.text()));
    } catch {
      throw new Error("AI 응답을 파싱하지 못했습니다. 다시 시도해 주세요.");
    }
    if (!Array.isArray(data.subtitles)) throw new Error("자막 형식이 올바르지 않습니다. 다시 시도해 주세요.");
    return NextResponse.json(data);

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[subtitle-guide] error:", msg);
    return NextResponse.json({ error: `오류: ${msg}` }, { status: 500 });
  } finally {
    try { if (tempInput && fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch {}
    try { if (fs.existsSync(tempAudio)) fs.unlinkSync(tempAudio); } catch {}
  }
}
