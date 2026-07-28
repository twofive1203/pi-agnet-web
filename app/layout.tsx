import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { THEME_META, THEME_PREFERENCES } from "@/lib/theme";

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

const THEME_MODES = Object.fromEntries(
  THEME_PREFERENCES.map((preference) => [preference, THEME_META[preference].mode]),
);
const THEME_SKINS = THEME_PREFERENCES.filter(
  (preference) => preference !== "system" && preference !== "light" && preference !== "dark",
);
const BOOT_SCRIPT = `(function(){try{var r=document.documentElement,m=${JSON.stringify(THEME_MODES)},s=${JSON.stringify(THEME_SKINS)},t=localStorage.getItem("pi-theme");if(!Object.prototype.hasOwnProperty.call(m,t))t="system";var d=t==="system"?window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches:m[t]==="dark";r.dataset.themePreference=t;if(s.indexOf(t)>-1)r.dataset.themeSkin=t;r.classList.toggle("dark",!!d);r.style.colorScheme=d?"dark":"light";var l=localStorage.getItem("pi-locale");if(l!=="zh"&&l!=="en"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh":"en";}r.lang=l==="zh"?"zh-CN":"en";r.dataset.locale=l;}catch(e){}})();`;

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
