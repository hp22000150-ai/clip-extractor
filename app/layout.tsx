import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clip Extractor — 영상 하이라이트 추출",
  description: "긴 영상에서 쇼츠 클립을 AI로 자동 추출",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
