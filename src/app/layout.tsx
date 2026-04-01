import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podcast2Markdown",
  description: "将播客音频转换为结构化文章",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
