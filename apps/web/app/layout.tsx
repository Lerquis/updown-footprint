import type { ReactNode } from "react";
import "./globals.css";
import { JetBrains_Mono, Manrope } from "next/font/google";
import { cn } from "@/lib/utils";
import { THEME_SCRIPT } from "@/lib/theme";

const sans = Manrope({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = { title: "Updown Footprint" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // la clase `dark` la pone THEME_SCRIPT antes de pintar (tema guardado o el del sistema): sin parpadeo
    <html lang="es" className={cn("font-sans", sans.variable, mono.variable)} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
