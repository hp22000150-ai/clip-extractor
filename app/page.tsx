"use client";

import { useState, useRef, useEffect } from "react";
import { makeSrt } from "@/lib/srt";

interface Moment {
  start: string; end: string; type: string;
  title: string; highlight: string; reason: string;
  hook: string; hashtags: string[]; score?: number;
}

interface AnalysisResult {
  summary: string;
  moments: Moment[];
}

const TYPE_COLORS: Record<string, string> = {
  "감동": "text-pink-600 bg-pink-50 border-pink-200",
  "웃음": "text-yellow-600 bg-yellow-50 border-yellow-200",
  "반전": "text-purple-600 bg-purple-50 border-purple-200",
  "명대사": "text-blue-600 bg-blue-50 border-blue-200",
  "하이라이트": "text-green-600 bg-green-50 border-green-200",
};

const AI_ROLE_PRESETS = [
  { label: "예능 PD", value: "너는 10년 경력의 예능 PD야. 웃음 포인트, 케미, 반전 상황을 귀신같이 잡아내고 시청자가 다시 보고 싶어지는 장면을 본능적으로 선별해." },
  { label: "드라마 편집자", value: "너는 감성 드라마 전문 편집자야. 감동 순간, 인물 간의 감정 교류, 눈물이 날 것 같은 대사를 정확하게 포착해. 시청자의 가슴을 울리는 장면 위주로 분석해." },
  { label: "MZ 쇼츠 전문가", value: "너는 MZ세대 쇼츠 전문 크리에이터야. 트렌디하고 바이럴될 장면을 잡아내. 첫 3초 훅, 댓글 유발 포인트, 공유하고 싶은 장면에 집중해." },
  { label: "스포츠 하이라이터", value: "너는 스포츠 하이라이트 전문 편집자야. 극적인 순간, 클라이맥스, 감동적인 역전 장면을 정확히 포착해. 시청자의 심장을 뛰게 하는 장면 위주로 분석해." },
  { label: "직접 입력", value: "" },
];

const CONTENT_TYPES = [
  { id: "감동", emoji: "🥺" }, { id: "웃음", emoji: "😂" },
  { id: "반전", emoji: "😱" }, { id: "명대사", emoji: "💬" },
  { id: "하이라이트", emoji: "🔥" }, { id: "케미", emoji: "✨" },
  { id: "열정", emoji: "⚡" }, { id: "정보", emoji: "📚" },
];

const PERSONAS = ["10대 학생", "20대 직장인", "30대 부모", "40~50대 직장인", "주부", "MZ세대", "시니어"];

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}

function typeColor(type: string) {
  for (const key of Object.keys(TYPE_COLORS)) {
    if (type?.includes(key)) return TYPE_COLORS[key];
  }
  return "text-slate-600 bg-slate-50 border-slate-200";
}

function secsToMMSS(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function mmssToSecs(t: string) {
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] ?? 0);
}

export default function Page() {
  // 설정
  const [rolePreset, setRolePreset] = useState(0);
  const [aiRole, setAiRole] = useState(AI_ROLE_PRESETS[0].value);
  const [persona, setPersona] = useState("20대 직장인");
  const [customPersona, setCustomPersona] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [sceneHint, setSceneHint] = useState("");
  const [clipCount, setClipCount] = useState(5);
  const [minClipDuration, setMinClipDuration] = useState(120);
  const [outputFormat, setOutputFormat] = useState<"original" | "vertical" | "square">("original");
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  // 분석
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isReanalyzeRef = useRef(false);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const extractDoneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 결과
  const [times, setTimes] = useState<{ start: string; end: string }[]>([]);
  const [clipTitles, setClipTitles] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [extracting, setExtracting] = useState(false);
  const [extractDone, setExtractDone] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [historyLoadedToast, setHistoryLoadedToast] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 포인트 자막
  const [subtitleGuides, setSubtitleGuides] = useState<Record<number, { time: string; text: string; type: string; desc: string }[]>>({});
  const [subtitleLoading, setSubtitleLoading] = useState<Record<number, boolean>>({});
  const [subtitleErrors, setSubtitleErrors] = useState<Record<number, string>>({});

  // 기록
  const [showHistory, setShowHistory] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [historyItems, setHistoryItems] = useState<{ id: string; date: string; source: string; result: AnalysisResult; times: { start: string; end: string }[]; clipTitles?: string[] }[]>([]);
  const [historyCount, setHistoryCount] = useState(0);

  // 수동 클립
  const [manualClips, setManualClips] = useState<{ start: string; end: string; title: string }[]>([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("ce_history") ?? "[]");
      setHistoryItems(stored);
      setHistoryCount(stored.length);
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      if (progressTimer.current) clearInterval(progressTimer.current);
      if (extractDoneTimer.current) clearTimeout(extractDoneTimer.current);
      if (historyToastTimer.current) clearTimeout(historyToastTimer.current);
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 500);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const startProgress = (initialLabel?: string) => {
    setProgress(3); setProgressLabel(initialLabel ?? "오디오 추출 중...");
    const stages = [
      { until: 15, pct: 20, label: "오디오 추출 중..." },
      { until: 40, pct: 45, label: "AI 장면 분석 중..." },
      { until: 90, pct: 70, label: "AI 장면 분석 중..." },
      { until: 180, pct: 88, label: "AI 장면 분석 중..." },
      { until: Infinity, pct: 92, label: "AI 장면 분석 중..." },
    ];
    const start = Date.now();
    progressTimer.current = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const stage = stages.find(s => elapsed < s.until) ?? stages[stages.length - 1];
      const prev = stages[stages.indexOf(stage) - 1];
      const prevPct = prev?.pct ?? 3;
      const prevUntil = prev?.until ?? 0;
      const ratio = stage.until === Infinity ? 1 : Math.min(1, (elapsed - prevUntil) / (stage.until - prevUntil));
      setProgress(prevPct + ratio * (stage.pct - prevPct));
      setProgressLabel(stage.label);
    }, 1000);
  };

  const stopProgress = () => {
    if (progressTimer.current) clearInterval(progressTimer.current);
    setProgress(100); setProgressLabel("분석 완료!");
  };

  const handleAnalyze = async (excludeRanges?: { start: string; end: string }[]) => {
    if (!videoFile) return;
    const isReanalyze = (excludeRanges?.length ?? 0) > 0;
    isReanalyzeRef.current = isReanalyze;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true); setError(""); setResult(null); setSelected(new Set());
    startProgress(isReanalyze ? "다른 장면 찾는 중..." : undefined);

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    try {
      const fd = new FormData();
      fd.append("file", videoFile);
      fd.append("aiRole", aiRole);
      fd.append("persona", customPersona || persona);
      fd.append("sceneHint", sceneHint);
      fd.append("types", JSON.stringify(selectedTypes));
      fd.append("clipCount", String(clipCount));
      fd.append("minDuration", String(minClipDuration));
      if (excludeRanges && excludeRanges.length > 0) {
        fd.append("excludeRanges", JSON.stringify(excludeRanges));
      }

      const res = await fetch("/api/analyze", { method: "POST", body: fd, signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setResult(data as AnalysisResult);
      const newTimes = (data as AnalysisResult).moments?.map(m => {
        const endSecs = mmssToSecs(m.end ?? "00:00");
        return { start: m.start ?? "00:00", end: secsToMMSS(endSecs + 10) };
      }) ?? [];
      const newTitles = (data as AnalysisResult).moments?.map(m => m.title) ?? [];
      setClipTitles(newTitles);
      setTimes(newTimes);
      setSubtitleGuides({}); setSubtitleErrors({});
      saveHistory(videoFile?.name ?? "영상", data as AnalysisResult, newTimes, newTitles);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);

      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        new Notification("✅ 영상 분석 완료!", { body: `쇼츠 클립 ${(data as AnalysisResult).moments?.length}개가 준비됐습니다.` });
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "분석 중 오류가 발생했습니다.");
    } finally {
      stopProgress(); setLoading(false); abortRef.current = null;
    }
  };

  const handleExtract = async (clips: { start: string; end: string; title: string; hook?: string; highlight?: string; hashtags?: string[]; subtitleGuide?: { time: string; text: string; type: string; desc: string }[] }[]): Promise<boolean> => {
    if (!clips.length) return false;
    if (!videoFile) { setError("영상 파일을 먼저 선택해 주세요."); return false; }
    setExtracting(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", videoFile);
      fd.append("clips", JSON.stringify(clips));
      fd.append("format", outputFormat);
      fd.append("minDuration", String(minClipDuration));
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = videoFile.name.replace(/\.[^/.]+$/, "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 40);
      a.href = url; a.download = `clips_${base}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExtractDone(true);
      if (extractDoneTimer.current) clearTimeout(extractDoneTimer.current);
      extractDoneTimer.current = setTimeout(() => setExtractDone(false), 4000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "클립 추출 중 오류가 발생했습니다.");
      return false;
    } finally { setExtracting(false); }
  };

  const saveHistory = (source: string, res: AnalysisResult, t: { start: string; end: string }[], titles: string[]) => {
    try {
      const stored = JSON.parse(localStorage.getItem("ce_history") ?? "[]");
      const item = { id: Date.now().toString(), date: new Date().toLocaleString("ko-KR"), source, result: res, times: t, clipTitles: titles };
      let updated = [item, ...stored].slice(0, 20);
      while (updated.length > 1 && JSON.stringify(updated).length > 4 * 1024 * 1024) {
        updated = updated.slice(0, updated.length - 1);
      }
      localStorage.setItem("ce_history", JSON.stringify(updated));
      setHistoryItems(updated);
      setHistoryCount(updated.length);
    } catch {}
  };

  const loadHistory = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("ce_history") ?? "[]");
      setHistoryItems(stored);
    } catch {}
  };

  const deleteHistory = (id?: string) => {
    try {
      if (id) {
        const updated = historyItems.filter(h => h.id !== id);
        setHistoryItems(updated);
        localStorage.setItem("ce_history", JSON.stringify(updated));
        setHistoryCount(updated.length);
      } else {
        setHistoryItems([]);
        localStorage.removeItem("ce_history");
        setHistoryCount(0);
      }
    } catch {}
  };

  const isValidTime = (t: string) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());

  const exportMetadata = () => {
    if (!result) return;
    const lines = [
      "Clip Extractor — 분석 결과",
      new Date().toLocaleString("ko-KR"),
      videoFile ? `원본 파일: ${videoFile.name}` : "",
      "",
      `[ 영상 요약 ]`,
      result.summary,
      "",
      ...result.moments.flatMap((m, i) => {
        const t = times[i];
        const title = clipTitles[i] ?? m.title;
        return [
          `── 장면 ${i + 1}: ${title} ──`,
          `시간: ${t?.start ?? m.start} → ${t?.end ?? m.end}  |  유형: ${m.type}`,
          `핵심: ${m.highlight}`,
          `훅: ${m.hook}`,
          `이유: ${m.reason}`,
          `태그: ${m.hashtags?.join(" ")}`,
          "",
        ];
      }),
    ].filter(l => l !== undefined).join("\n");
    const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `분석결과_${new Date().toLocaleDateString("ko-KR").replace(/\. /g, "-").replace(".", "")}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-900">Clip Extractor</h1>
            <p className="text-xs text-slate-500 mt-0.5">긴 영상 → AI 하이라이트 추출 → 쇼츠 클립</p>
          </div>
          <div className="flex items-center gap-2">
            {(result || videoFile) && (
              <button onClick={() => {
                setVideoFile(null); setResult(null); setError("");
                setTimes([]); setClipTitles([]); setSelected(new Set());
                setSubtitleGuides({}); setSubtitleErrors({});
                setManualClips([]);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-200 transition-colors">
                초기화
              </button>
            )}
            <button onClick={() => setShowHelp(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300 transition-colors">
              도움말
            </button>
            <button onClick={() => { loadHistory(); setShowHistory(true); }}
              className="relative text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300 transition-colors">
              기록
              {historyCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 bg-slate-700 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
                  {historyCount}
                </span>
              )}
            </button>
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded-lg border border-slate-200">v1.0.3</span>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

        {/* ── AI 역할 설정 ── */}
        <section className="card p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-slate-800 mb-0.5">AI 역할 설정</p>
            <p className="text-xs text-slate-500">AI에게 역할을 주면 그 시각으로 장면을 분석합니다. 예능 PD는 웃음 포인트를, 드라마 편집자는 감동 장면을 더 잘 잡아냅니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {AI_ROLE_PRESETS.map((p, i) => (
              <button key={i} onClick={() => { setRolePreset(i); if (p.value) setAiRole(p.value); else setAiRole(""); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${rolePreset === i ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={aiRole}
            onChange={e => { setAiRole(e.target.value); setRolePreset(4); }}
            rows={3}
            placeholder="예) 너는 10년 경력의 예능 PD야. 웃음 포인트와 케미를 귀신같이 잡아내..."
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 resize-none"
          />
        </section>

        {/* ── 타겟 시청자 ── */}
        <section className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-slate-800">타겟 시청자 <span className="text-xs font-normal text-slate-500">— 이 사람의 시각으로 분석</span></p>
          <div className="flex flex-wrap gap-2">
            {PERSONAS.map(p => (
              <button key={p} onClick={() => { setPersona(p); setCustomPersona(""); }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${persona === p && !customPersona ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                {p}
              </button>
            ))}
            <input
              value={customPersona}
              onChange={e => setCustomPersona(e.target.value)}
              placeholder="직접 입력..."
              className="px-3 py-1.5 rounded-full border border-dashed border-slate-300 text-xs text-slate-600 placeholder-slate-300 focus:outline-none focus:border-blue-400 w-24"
            />
          </div>
        </section>

        {/* ── 영상 파일 선택 ── */}
        <section className="card p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-800">영상 파일</p>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-200 hover:border-blue-400 rounded-xl p-8 text-center cursor-pointer transition-all hover:bg-blue-50/30"
          >
            {videoFile ? (
              <>
                <p className="text-3xl mb-2">🎬</p>
                <p className="text-sm font-medium text-slate-900">{videoFile.name}</p>
                <p className="text-xs text-slate-500 mt-1">{(videoFile.size / 1024 / 1024).toFixed(0)} MB</p>
              </>
            ) : (
              <>
                <p className="text-3xl mb-2">🎬</p>
                <p className="text-sm font-medium text-slate-700">클릭하여 영상 파일 선택</p>
                <p className="text-xs text-slate-400 mt-1">MP4 · MOV · AVI · MKV · TS · WebM — 용량 제한 없음</p>
              </>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="video/*,audio/*,.ts,.m2ts,.mts" className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) {
                setVideoFile(f);
                setResult(null); setError("");
                setTimes([]); setClipTitles([]); setSelected(new Set());
                setSubtitleGuides({}); setSubtitleErrors({});
                setManualClips([]);
              }
              e.target.value = "";
            }} />
        </section>

        {/* ── 장면 묘사 + 유형 선택 ── */}
        <section className="card p-4 space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">찾고 싶은 장면 묘사 <span className="text-xs font-normal text-slate-500">(선택)</span></p>
            <input type="text" value={sceneHint} onChange={e => setSceneHint(e.target.value)}
              placeholder="예) 두 사람이 처음 만나는 장면, 클라이맥스에서 눈물 흘리는 장면..."
              className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-all" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">추출할 장면 유형 <span className="text-xs font-normal text-slate-500">(복수 선택 · 미선택 시 전체 분석)</span></p>
            <div className="flex flex-wrap gap-2">
              {CONTENT_TYPES.map(({ id, emoji }) => {
                const on = selectedTypes.includes(id);
                return (
                  <button key={id} onClick={() => setSelectedTypes(prev => on ? prev.filter(t => t !== id) : [...prev, id])}
                    className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${on ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                    {emoji} {id}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── 추출 설정 ── */}
        <section className="card p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-800">추출 설정</p>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <div className="space-y-1.5">
              <p className="text-xs text-slate-500">클립 개수</p>
              <div className="flex gap-1.5">
                {[3, 5, 7, 10].map(n => (
                  <button key={n} onClick={() => setClipCount(n)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${clipCount === n ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                    {n}개
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-slate-500">최소 클립 길이</p>
              <div className="flex gap-1.5">
                {([{ label: "30초", val: 30 }, { label: "1분", val: 60 }, { label: "2분", val: 120 }, { label: "3분", val: 180 }] as const).map(({ label, val }) => (
                  <button key={val} onClick={() => setMinClipDuration(val)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${minClipDuration === val ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-slate-500">출력 포맷</p>
              <div className="flex gap-1.5">
                {([
                  { label: "가로 (원본)", val: "original" },
                  { label: "1:1 정사각형", val: "square" },
                  { label: "세로 9:16", val: "vertical" },
                ] as const).map(({ label, val }) => (
                  <button key={val} onClick={() => setOutputFormat(val)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${outputFormat === val ? "btn-active" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── 분석 버튼 ── */}
        <div className="flex gap-2">
          <button onClick={() => handleAnalyze()} disabled={loading || !videoFile}
            className="flex-1 py-3.5 rounded-xl text-sm font-bold text-white btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
            {loading
              ? <span className="flex items-center justify-center gap-2"><Spinner />{isReanalyzeRef.current ? "다른 장면 찾는 중..." : "분석 중 (영상에 따라 수분 소요)..."}</span>
              : `AI 분석 시작${selectedTypes.length > 0 ? ` (${selectedTypes.join("·")} 위주)` : ""}`}
          </button>
          {result && !loading && (
            <button onClick={() => handleAnalyze(times.filter(t => isValidTime(t.start) && isValidTime(t.end)))} disabled={!videoFile}
              className="px-4 py-3.5 rounded-xl text-sm font-semibold border border-slate-300 text-slate-600 hover:border-slate-400 hover:text-slate-800 hover:bg-slate-50 transition-all disabled:opacity-40"
              title="현재 결과와 다른 장면을 새로 분석합니다">
              🔄 재분석
            </button>
          )}
        </div>

        {/* ── 진행 상황 ── */}
        {loading && (
          <div className="card p-5 space-y-3">
            <div className="flex items-center gap-3">
              <Spinner /><span className="text-sm text-slate-700">{progressLabel || "준비 중..."}</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">{Math.round(progress)}%</p>
              <button onClick={() => { abortRef.current?.abort(); if (progressTimer.current) clearInterval(progressTimer.current); isReanalyzeRef.current = false; setLoading(false); setProgress(0); }}
                className="text-xs px-3 py-1 border border-slate-200 rounded-lg text-slate-500 hover:text-red-500 hover:border-red-200 transition-colors">
                취소
              </button>
            </div>
          </div>
        )}

        {/* ── 오류 ── */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>
        )}

        {/* ── 결과 ── */}
        {result && !loading && (
          <div ref={resultRef} className="space-y-4">
            {/* 요약 */}
            <div className="bg-gradient-to-r from-blue-50 to-violet-50 border border-blue-200 rounded-xl p-4">
              <p className="text-xs text-blue-600 font-semibold mb-1">영상 요약</p>
              <p className="text-sm text-slate-800 leading-relaxed">{result.summary}</p>
            </div>

            {/* 클립 선택 툴바 */}
            <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                  <input type="checkbox"
                    checked={selected.size > 0 && selected.size === (result.moments?.length ?? 0)}
                    onChange={e => setSelected(e.target.checked ? new Set(result.moments?.map((_, i) => i) ?? []) : new Set())}
                    className="rounded" />
                  전체 선택
                </label>
                {selected.size > 0 && <span className="text-xs text-blue-600 font-medium">{selected.size}개 선택됨</span>}
              </div>
              <div className="flex items-center gap-2">
              <button onClick={exportMetadata}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300 transition-colors">
                📥 내보내기
              </button>
              <button
                onClick={() => {
                  const clips = [...selected].sort((a, b) => a - b).map(i => {
                    const m = result.moments[i]; const t = times[i];
                    return { start: t?.start ?? m.start, end: t?.end ?? m.end, title: clipTitles[i] ?? m.title, hook: m.hook, highlight: m.highlight, hashtags: m.hashtags, subtitleGuide: subtitleGuides[i] };
                  });
                  handleExtract(clips);
                }}
                disabled={selected.size === 0 || extracting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {extracting ? <><Spinner />추출 중...</> : `✂ ${selected.size}개 클립 추출 (.zip)`}
              </button>
              </div>
            </div>

            {/* 장면 카드 */}
            <div className="space-y-4">
              {result.moments?.map((m, i) => (
                <div key={i} className={`card p-5 transition-all ${selected.has(i) ? "border-blue-300 ring-1 ring-blue-200" : ""}`}>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <input type="checkbox" checked={selected.has(i)}
                      onChange={e => setSelected(prev => { const n = new Set(prev); e.target.checked ? n.add(i) : n.delete(i); return n; })}
                      className="rounded cursor-pointer" />
                    <span className="text-xs font-bold text-white bg-slate-800 px-2 py-0.5 rounded-lg">#{i + 1}</span>
                    {/* 타임스탬프 편집 */}
                    {times[i] && (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-slate-400">⏱</span>
                        <input value={times[i].start}
                          onChange={e => setTimes(prev => prev.map((t, j) => j === i ? { ...t, start: e.target.value } : t))}
                          className={`w-16 text-center text-xs font-mono rounded px-1 py-0.5 focus:outline-none transition-colors ${isValidTime(times[i].start) ? "text-blue-600 bg-blue-50 border border-blue-200 focus:border-blue-400" : "text-red-600 bg-red-50 border border-red-400"}`} />
                        <span className="text-xs text-slate-400">→</span>
                        <input value={times[i].end}
                          onChange={e => setTimes(prev => prev.map((t, j) => j === i ? { ...t, end: e.target.value } : t))}
                          className={`w-16 text-center text-xs font-mono rounded px-1 py-0.5 focus:outline-none transition-colors ${isValidTime(times[i].end) ? "text-blue-600 bg-blue-50 border border-blue-200 focus:border-blue-400" : "text-red-600 bg-red-50 border border-red-400"}`} />
                      </div>
                    )}
                    <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full border ${typeColor(m.type)}`}>{m.type}</span>
                    {m.score != null && (
                      <span className="text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                        ⭐ {m.score}/10
                      </span>
                    )}
                  </div>

                  {/* 파일명 편집 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-slate-400 shrink-0">파일명</span>
                    <input
                      value={clipTitles[i] ?? m.title}
                      onChange={e => setClipTitles(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                      className="flex-1 text-sm font-semibold text-slate-800 bg-transparent border-b border-dashed border-slate-300 focus:outline-none focus:border-blue-400 pb-0.5"
                      placeholder="클립 파일명"
                    />
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed mb-3 bg-slate-50 rounded-lg px-3 py-2">{m.highlight}</p>

                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                      <p className="text-xs text-yellow-700 font-semibold mb-1">첫 3초 훅</p>
                      <p className="text-xs text-slate-700 leading-relaxed">{m.hook}</p>
                    </div>
                    <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                      <p className="text-xs text-green-700 font-semibold mb-1">쇼츠로 좋은 이유</p>
                      <p className="text-xs text-slate-700 leading-relaxed">{m.reason}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {m.hashtags?.map((tag, j) => (
                      <span key={j} className="text-xs bg-slate-100 border border-slate-200 text-blue-600 px-2 py-0.5 rounded-lg">{tag}</span>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => { navigator.clipboard.writeText(`제목: ${m.title}\n훅: ${m.hook}\n핵심: ${m.highlight}\n${m.hashtags?.join(" ")}`); }}
                      className="text-xs px-2.5 py-1 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 transition-all">
                      복사
                    </button>

                    <button onClick={async () => {
                      if (!videoFile) {
                        setSubtitleErrors(prev => ({ ...prev, [i]: "영상 파일을 먼저 선택해 주세요." }));
                        return;
                      }
                      setSubtitleLoading(prev => ({ ...prev, [i]: true }));
                      setSubtitleErrors(prev => ({ ...prev, [i]: "" }));
                      try {
                        const fd = new FormData();
                        fd.append("file", videoFile);
                        fd.append("start", times[i]?.start ?? m.start);
                        fd.append("end", times[i]?.end ?? m.end);
                        fd.append("title", clipTitles[i] ?? m.title);
                        const res = await fetch("/api/subtitle-guide", { method: "POST", body: fd });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error);
                        if (!data.subtitles?.length) throw new Error("자막 제안을 찾지 못했습니다. 다시 시도해 주세요.");
                        setSubtitleGuides(prev => ({ ...prev, [i]: data.subtitles }));
                      } catch (e) {
                        setSubtitleErrors(prev => ({ ...prev, [i]: e instanceof Error ? e.message : "오류가 발생했습니다." }));
                      }
                      finally { setSubtitleLoading(prev => ({ ...prev, [i]: false })); }
                    }} disabled={subtitleLoading[i]}
                      className="text-xs px-2.5 py-1 rounded-lg bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 transition-all disabled:opacity-40">
                      {subtitleLoading[i] ? "분석 중..." : "✍ 포인트 자막"}
                    </button>
                    <button onClick={() => handleExtract([{
                      start: times[i]?.start ?? m.start,
                      end: times[i]?.end ?? m.end,
                      title: clipTitles[i] ?? m.title,
                      hook: m.hook, highlight: m.highlight, hashtags: m.hashtags,
                      subtitleGuide: subtitleGuides[i],
                    }])}
                      disabled={extracting}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition-all disabled:opacity-40 ${subtitleGuides[i] ? "bg-slate-800 hover:bg-slate-700 text-white border-slate-700" : "bg-slate-100 hover:bg-slate-200 text-slate-500 border-slate-300"}`}>
                      {subtitleGuides[i] ? "✂ 추출 (자막포함)" : "✂ 이 클립만 추출"}
                    </button>
                  </div>

                  {/* 포인트 자막 에러 */}
                  {subtitleErrors[i] && (
                    <p className="mt-2 text-xs text-red-500">{subtitleErrors[i]}</p>
                  )}

                  {/* 포인트 자막 결과 */}
                  {subtitleGuides[i] && (
                    <div className="mt-3 bg-violet-50 border border-violet-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-violet-700 mb-2">캡컷 포인트 자막 가이드</p>
                      <div className="space-y-1.5">
                        {subtitleGuides[i].map((s, j) => (
                          <div key={j} className="flex items-start gap-2 text-xs">
                            <span className="font-mono text-violet-500 shrink-0 w-10">{s.time}</span>
                            <span className="font-bold text-slate-900 shrink-0">{s.text}</span>
                            <span className="text-slate-400">— {s.desc}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => {
                          const txt = subtitleGuides[i].map(s => `${s.time}  ${s.text}  (${s.desc})`).join("\n");
                          navigator.clipboard.writeText(txt);
                        }} className="text-xs px-2.5 py-1 rounded-lg bg-white border border-violet-200 text-violet-600 hover:bg-violet-50 transition-colors">
                          복사
                        </button>
                        <button onClick={() => {
                          const title = clipTitles[i] ?? m.title;
                          const txt = [
                            `[${title}] 포인트 자막 가이드`,
                            "",
                            "캡컷 타임라인에서 해당 시간대에 텍스트 레이어를 추가하세요.",
                            "권장: 0.5~1초, 임팩트 있게 배치",
                            "",
                            ...subtitleGuides[i].map(s => `${s.time}  |  ${s.text}  |  ${s.desc}`),
                          ].join("\n");
                          const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${title.replace(/[\\/:*?"<>|]/g, "").slice(0, 40)}_포인트자막.txt`;
                          document.body.appendChild(a); a.click(); document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(url), 5000);
                        }} className="text-xs px-2.5 py-1 rounded-lg bg-white border border-violet-200 text-violet-600 hover:bg-violet-50 transition-colors">
                          📥 TXT 저장
                        </button>
                        <button onClick={() => {
                          const title = clipTitles[i] ?? m.title;
                          const srt = makeSrt(subtitleGuides[i]);
                          const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${title.replace(/[\\/:*?"<>|]/g, "").slice(0, 40)}.srt`;
                          document.body.appendChild(a); a.click(); document.body.removeChild(a);
                          setTimeout(() => URL.revokeObjectURL(url), 5000);
                        }} className="text-xs px-2.5 py-1 rounded-lg bg-white border border-violet-200 text-violet-600 hover:bg-violet-50 transition-colors">
                          📥 SRT 저장
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 수동 클립 추가 */}
            <div className="card p-4 space-y-3">
              <p className="text-sm font-semibold text-slate-800">✂ AI가 놓친 장면 직접 추가</p>
              {manualClips.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <input value={c.start} onChange={e => setManualClips(prev => prev.map((x, j) => j === i ? { ...x, start: e.target.value } : x))}
                    className={`w-16 text-center font-mono rounded px-1 py-1 focus:outline-none border ${isValidTime(c.start) ? "border-slate-200 focus:border-blue-400" : "border-red-400 bg-red-50 text-red-600"}`} placeholder="00:00" />
                  <span className="text-slate-400">→</span>
                  <input value={c.end} onChange={e => setManualClips(prev => prev.map((x, j) => j === i ? { ...x, end: e.target.value } : x))}
                    className={`w-16 text-center font-mono rounded px-1 py-1 focus:outline-none border ${isValidTime(c.end) ? "border-slate-200 focus:border-blue-400" : "border-red-400 bg-red-50 text-red-600"}`} placeholder="02:00" />
                  <input value={c.title} onChange={e => setManualClips(prev => prev.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
                    className="flex-1 border border-slate-200 rounded px-2 py-1 focus:outline-none focus:border-blue-400" placeholder="클립 제목" />
                  <button onClick={() => setManualClips(prev => prev.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-red-500 transition-colors px-1">✕</button>
                </div>
              ))}
              <div className="flex gap-2">
                <button onClick={() => setManualClips(prev => [...prev, { start: "00:00", end: "02:00", title: `직접추가 ${prev.length + 1}` }])}
                  className="text-xs px-3 py-1.5 border border-dashed border-slate-300 rounded-lg text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
                  + 장면 추가
                </button>
                {manualClips.length > 0 && (
                  <button onClick={async () => { const ok = await handleExtract(manualClips); if (ok) setManualClips([]); }} disabled={extracting || !videoFile}
                    className="text-xs px-3 py-1.5 bg-slate-800 text-white rounded-lg hover:bg-slate-700 disabled:opacity-40 transition-colors">
                    {extracting ? "추출 중..." : `✂ ${manualClips.length}개 직접 추출`}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 도움말 모달 */}
      {showHelp && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={() => setShowHelp(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <h2 className="text-base font-bold text-slate-900">사용 방법</h2>
              <button onClick={() => setShowHelp(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-5 py-5 space-y-5 text-sm">

              {/* 기본 흐름 */}
              <div className="bg-slate-50 rounded-xl p-4 text-xs text-slate-700 space-y-1.5">
                <p className="font-semibold text-slate-800 mb-2">📌 권장 사용 순서</p>
                <p>① AI 역할 설정 → ② 타겟 시청자 → ③ 영상 파일 선택</p>
                <p>→ ④ (선택) 장면 묘사·유형 지정 → ⑤ 추출 설정 (개수·길이·포맷)</p>
                <p>→ ⑥ AI 분석 시작 → 결과 확인 (마음에 안 들면 🔄 재분석)</p>
                <p>→ ⑦ 타임스탬프 수정 → ⑧ ✍ 포인트 자막 생성</p>
                <p>→ ⑨ ✂ 추출 (자막포함) → ZIP 다운로드</p>
                <p className="text-slate-400 pt-1">※ 포인트 자막은 추출 전에 생성해야 ZIP에 자동 포함됩니다.</p>
              </div>

              {[
                {
                  n: "1", title: "AI 역할 설정",
                  items: [
                    "AI에게 역할을 주면 그 전문가 시각으로 장면을 분석합니다",
                    "예능 PD → 웃음·케미·반전 위주  /  드라마 편집자 → 감동·눈물·명대사 위주",
                    "MZ 쇼츠 전문가 → 바이럴·댓글 유발  /  스포츠 하이라이터 → 클라이맥스·역전",
                    "직접 입력 → 텍스트로 자유롭게 지정 (예: '10년 경력 여행 PD야. 감탄사 나오는 순간...')",
                    "역할이 구체적일수록 분석 품질이 높아집니다",
                  ]
                },
                {
                  n: "2", title: "타겟 시청자",
                  items: [
                    "이 시청자의 시각으로 '어떤 장면에서 반응할까?'를 기준으로 분석합니다",
                    "같은 영상도 10대 학생 / 40~50대 직장인이 선택하는 장면이 다릅니다",
                    "직접 입력란에 '30대 육아 맘', '운동을 좋아하는 20대' 등 구체적으로 적을수록 좋습니다",
                  ]
                },
                {
                  n: "3", title: "영상 파일",
                  items: [
                    "MP4, MOV, AVI, MKV, TS, WebM 등 대부분의 포맷 지원, 용량 제한 없음",
                    "2시간 예능도 분석 가능 — 오디오만 추출해 AI에 전달합니다 (영상 화질 무관)",
                    "30분 영상 → 약 1~2분  /  2시간 영상 → 약 3~5분 소요",
                    "새 영상 선택 시 이전 분석 결과가 초기화됩니다",
                  ]
                },
                {
                  n: "4", title: "찾고 싶은 장면 묘사 (선택)",
                  items: [
                    "AI에게 특정 장면을 우선 찾도록 힌트를 줍니다",
                    "예) '두 출연자가 처음 만나는 장면'  /  '음식 먹는 리액션이 터지는 순간'",
                    "비워두면 AI가 전체 영상에서 자체 판단으로 선정합니다",
                  ]
                },
                {
                  n: "5", title: "추출할 장면 유형 (선택)",
                  items: [
                    "미선택 시 전체 유형에서 자동 분석 · 복수 선택 가능",
                    "🥺 감동 · 😂 웃음 · 😱 반전 · 💬 명대사 · 🔥 하이라이트 · ✨ 케미 · ⚡ 열정 · 📚 정보",
                  ]
                },
                {
                  n: "6", title: "추출 설정",
                  items: [
                    "클립 개수: 3 / 5 / 7 / 10개 선택 (분석 전 설정 · 기본값 5개)",
                    "최소 클립 길이: 30초 / 1분 / 2분 / 3분 — AI 프롬프트 가이드 + 추출 시 최소 시간 모두 반영",
                    "출력 포맷: 가로(원본 비율) 또는 세로 9:16 (Shorts/Reels용 · 블러 배경 자동 적용)",
                    "썸네일: 추출 시 각 클립 시작 지점 JPG가 ZIP에 자동 포함",
                    "🔄 재분석: 결과가 마음에 안 들면 클릭 → 이전 장면을 제외한 새 장면 탐색",
                  ]
                },
              ].map(({ n, title, items }) => (
                <div key={n}>
                  <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-slate-800 text-white text-xs font-bold flex items-center justify-center shrink-0">{n}</span>
                    {title}
                  </h3>
                  <ul className="space-y-1 text-xs text-slate-600 pl-8">
                    {items.map((item, i) => <li key={i}>• {item}</li>)}
                  </ul>
                </div>
              ))}

              {/* 분석 결과 */}
              <div>
                <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-slate-800 text-white text-xs font-bold flex items-center justify-center shrink-0">7</span>
                  분석 결과 활용
                </h3>
                <ul className="space-y-2 text-xs text-slate-600 pl-8">
                  <li><span className="font-medium text-slate-700">파일명 편집</span> — 카드 상단 텍스트 입력란에서 추출될 파일명 수정 가능</li>
                  <li><span className="font-medium text-slate-700">⭐ score 배지</span> — 각 카드의 쇼츠 바이럴 가능성 점수 (1~10). AI가 자동 산정</li>
                  <li><span className="font-medium text-slate-700">⏱ 타임스탬프 수정</span> — AI가 잡은 시작·끝 시간 직접 조정 가능. 잘못된 형식이면 빨간색으로 표시</li>
                  <li><span className="font-medium text-slate-700">📥 내보내기</span> — 전체 장면 정보(시간·훅·해시태그)를 TXT 파일로 저장</li>
                  <li><span className="font-medium text-slate-700">✂ 전체/개별 추출</span> — 체크박스 선택 후 상단 [N개 클립 추출] 또는 카드 내 [이 클립만 추출] 클릭</li>
                  <li><span className="font-medium text-slate-700">✂ AI가 놓친 장면 직접 추가</span> — 결과 하단에서 시작·끝 시간 직접 입력 후 추출</li>
                </ul>
              </div>

              {/* 포인트 자막 */}
              <div>
                <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-slate-800 text-white text-xs font-bold flex items-center justify-center shrink-0">8</span>
                  ✍ 포인트 자막 가이드
                </h3>
                <ul className="space-y-1.5 text-xs text-slate-600 pl-8">
                  <li>• 장면 카드 하단 [✍ 포인트 자막] 클릭 → AI가 해당 구간 재분석</li>
                  <li>• 결과 예시: <span className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">00:23 | 헐 | 예상 밖 발언에 당황</span></li>
                  <li>• [복사] → 클립보드에 복사  /  [📥 TXT 저장] → 가이드 파일  /  [📥 SRT 저장] → 캡컷 import용</li>
                  <li>• 포인트 자막 생성 후 추출하면 ZIP 안에 TXT·SRT가 자동 포함됩니다</li>
                  <li className="text-slate-500 pt-0.5 border-t border-slate-100 mt-1">캡컷: 타임라인에서 해당 시간대 이동 → 텍스트 추가 → 텍스트 입력 → 0.5~1초 배치</li>
                </ul>
              </div>

              {/* 기록·기타 */}
              <div>
                <h3 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-slate-800 text-white text-xs font-bold flex items-center justify-center shrink-0">9</span>
                  기타 기능
                </h3>
                <ul className="space-y-1.5 text-xs text-slate-600 pl-8">
                  <li><span className="font-medium text-slate-700">기록</span> — 분석 완료 시 자동 저장(최대 20개). 헤더 [기록] 버튼으로 이전 결과 불러오기</li>
                  <li><span className="font-medium text-slate-700">초기화</span> — 헤더 [초기화] 버튼으로 전체 상태 리셋. 새 영상 분석 시작할 때 사용</li>
                  <li><span className="font-medium text-slate-700">↑ 맨위로</span> — 스크롤 내렸을 때 우하단에 버튼 표시</li>
                  <li className="text-slate-400">※ 기록은 이 PC 브라우저에 저장. 브라우저 캐시 삭제 시 사라질 수 있습니다.</li>
                  <li className="text-slate-400">※ 기록에서 불러온 결과로 클립 추출 시 영상 파일을 다시 선택해야 합니다.</li>
                </ul>
              </div>

              {/* 팁 */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-700 space-y-1.5">
                <p className="font-semibold text-blue-800 mb-1.5">💡 활용 팁</p>
                <p>• 같은 영상을 AI 역할만 바꿔 여러 번 분석하면 다른 장면을 잡아냅니다</p>
                <p>• 🔄 재분석을 누르면 이전 장면과 겹치지 않는 새 장면을 찾습니다</p>
                <p>• 포인트 자막은 추출 전에 생성해야 ZIP에 자동 포함됩니다</p>
                <p>• 분석 완료 시 브라우저 알림이 옵니다 (알림 허용 필요)</p>
                <p>• 분석 중 취소가 필요하면 진행률 표시 옆 [취소] 버튼을 누르세요</p>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* 기록 모달 */}
      {showHistory && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={() => setShowHistory(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">분석 기록</h2>
              <div className="flex items-center gap-2">
                {historyItems.length > 0 && (
                  <button onClick={() => { if (confirm("기록을 모두 삭제할까요?")) deleteHistory(); }}
                    className="text-xs text-red-400 hover:text-red-600 transition-colors">전체 삭제</button>
                )}
                <button onClick={() => setShowHistory(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
              </div>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {historyItems.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">저장된 기록이 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {historyItems.map(item => (
                    <div key={item.id} className="border border-slate-200 rounded-xl p-4">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{item.source}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{item.date} · 장면 {item.result.moments?.length}개</p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => deleteHistory(item.id)}
                            className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200 transition-all">삭제</button>
                          <button onClick={() => {
                            setResult(item.result);
                            setTimes(item.times);
                            setClipTitles(item.clipTitles ?? item.result.moments?.map(m => m.title) ?? []);
                            setSelected(new Set());
                            setSubtitleGuides({});
                            setShowHistory(false);
                            setHistoryLoadedToast(true);
                            if (historyToastTimer.current) clearTimeout(historyToastTimer.current);
                            historyToastTimer.current = setTimeout(() => setHistoryLoadedToast(false), 4000);
                            setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
                          }} className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 text-white hover:bg-slate-700 transition-all">불러오기</button>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-2">{item.result.summary}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-slate-100 py-6 text-center mt-8">
        <p className="text-xs text-slate-400">Clip Extractor — 로컬 전용 도구</p>
      </footer>

      {/* 추출 성공 알림 */}
      {extractDone && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-slate-800 text-white text-sm px-5 py-3 rounded-xl shadow-xl">
          ✅ ZIP 다운로드 시작됨
        </div>
      )}

      {/* 기록 불러오기 안내 */}
      {historyLoadedToast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-blue-700 text-white text-sm px-5 py-3 rounded-xl shadow-xl text-center">
          📂 불러오기 완료 — 클립 추출 시 영상 파일을 다시 선택해 주세요
        </div>
      )}

      {/* 맨위로 버튼 */}
      {showScrollTop && (
        <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-40 w-10 h-10 rounded-full bg-slate-800 hover:bg-slate-700 text-white shadow-lg flex items-center justify-center transition-all">
          ↑
        </button>
      )}

    </main>
  );
}
