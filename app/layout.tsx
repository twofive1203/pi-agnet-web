import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "蜗牛派 / Snail Pi",
  description: "Snail Pi Web workspace for the pi coding agent",
  icons: {
    icon: "/snail-pi-logo.svg",
  },
};

const BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark");var l=localStorage.getItem("pi-locale");if(l!=="zh"&&l!=="en"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh":"en";}document.documentElement.lang=l==="zh"?"zh-CN":"en";document.documentElement.dataset.locale=l;}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={notoSansMono.variable} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: BOOT_SCRIPT,
          }}
        />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
