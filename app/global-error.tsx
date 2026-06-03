"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#64748b", marginBottom: "12px" }}>오류가 발생했습니다.</p>
          <button onClick={reset} style={{ padding: "8px 16px", background: "#1e293b", color: "white", border: "none", borderRadius: "8px", cursor: "pointer" }}>
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
