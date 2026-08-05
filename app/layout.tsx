import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import {
  THEME_MODE_BY_PREFERENCE,
  THEME_SKIN_PREFERENCES,
  THEME_STORAGE_KEY,
} from "@/lib/theme";
import { buildWorkbenchSkinBootFragment } from "@/lib/theme-skin";

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

const BOOT_SCRIPT = `(function(){try{var r=document.documentElement,m=${JSON.stringify(THEME_MODE_BY_PREFERENCE)},s=${JSON.stringify(THEME_SKIN_PREFERENCES)},t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(!Object.prototype.hasOwnProperty.call(m,t))t="system";var d=t==="system"?window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches:m[t]==="dark";r.dataset.themePreference=t;delete r.dataset.themeSkin;if(s.indexOf(t)>-1)r.dataset.themeSkin=t;r.classList.toggle("dark",!!d);r.style.colorScheme=d?"dark":"light";${buildWorkbenchSkinBootFragment()}var l=localStorage.getItem("pi-locale");if(l!=="zh"&&l!=="en"){var n=(navigator.language||"").toLowerCase();l=n.indexOf("zh")===0?"zh":"en";}r.lang=l==="zh"?"zh-CN":"en";r.dataset.locale=l;}catch(e){}})();`;

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
