import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Awschett — مولّد الوسائط MCP",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        {/* خط عربي جيد (Cairo) مع بدائل نظام آمنة عند غياب الشبكة */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans text-slate-100 antialiased">{children}</body>
    </html>
  );
}
