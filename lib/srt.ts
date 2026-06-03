// SRT 포맷 변환 — 클라이언트/서버 모두 사용 가능 (Node.js API 없음)

function toMs(time: string): number {
  const p = time.split(":").map(Number);
  return p.length === 3
    ? (p[0] * 3600 + p[1] * 60 + p[2]) * 1000
    : (p[0] * 60 + (p[1] ?? 0)) * 1000;
}

function toSrtTimecode(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(f).padStart(3, "0")}`;
}

export function makeSrt(subtitles: { time: string; text: string }[], displayMs = 800): string {
  return subtitles
    .map((sub, i) => {
      const startMs = toMs(sub.time);
      const endMs = startMs + displayMs;
      return `${i + 1}\n${toSrtTimecode(startMs)} --> ${toSrtTimecode(endMs)}\n${sub.text}`;
    })
    .join("\n\n") + "\n";
}
