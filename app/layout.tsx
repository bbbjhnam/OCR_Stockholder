import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: "주주명부 렌즈 | 주주명부 OCR 분석",
  description: "여러 주주명부 PDF에서 총 발행주식수, 지정 회사의 보유주식수와 지분율을 추출합니다.",
  openGraph: {
    title: "주주명부 렌즈",
    description: "여러 주주명부 PDF에서 필요한 세 가지 숫자만 추출합니다.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
