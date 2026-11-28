import type { UpstreamState } from "@updown/protocol";
import type { LinkState } from "@/lib/useWsChannel";
import { cn } from "@/lib/utils";

/** Estado de un canal: en vivo, o el detalle del enlace con nuestro servidor y de este con Binance. */
export function LiveBadge({ label, link, upstream }: { label: string; link: LinkState; upstream: UpstreamState }) {
  const live = link === "open" && upstream === "connected";
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 text-[11px] font-medium whitespace-nowrap"
      title={`servidor: ${link} · binance: ${upstream}`}
    >
      <span className="relative flex size-1.5">
        {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-buy opacity-60" />}
        <span className={cn("relative inline-flex size-1.5 rounded-full", live ? "bg-buy" : "bg-warn")} />
      </span>
      <span className="text-foreground">{label}</span>
      <span className={live ? "text-muted-foreground" : "text-warn"}>{live ? "en vivo" : `${link}/${upstream}`}</span>
    </span>
  );
}
