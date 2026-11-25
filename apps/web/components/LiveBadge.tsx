import type { UpstreamState } from "@updown/protocol";
import { Badge } from "@/components/ui/badge";
import type { LinkState } from "@/lib/useWsChannel";

/** Estado de un canal: en vivo, o el detalle del enlace con nuestro servidor y de este con Binance. */
export function LiveBadge({ label, link, upstream }: { label: string; link: LinkState; upstream: UpstreamState }) {
  const live = link === "open" && upstream === "connected";
  return (
    <Badge
      variant="outline"
      className={live ? "border-buy/40 text-buy" : "border-yellow-500/40 text-yellow-500"}
      title={`servidor: ${link} · binance: ${upstream}`}
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-buy" : "bg-yellow-500"}`} />
      {label} {live ? "en vivo" : `${link}/${upstream}`}
    </Badge>
  );
}
