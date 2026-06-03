"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-3">
        <p className="text-slate-600">오류가 발생했습니다.</p>
        <button onClick={reset} className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm">
          다시 시도
        </button>
      </div>
    </div>
  );
}
