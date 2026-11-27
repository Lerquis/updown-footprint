import { ReplaysView } from "@/components/ReplaysView";

export const metadata = { title: "Replays · motor A con retraso" };

/** Solo por URL (/replays): no hay enlace en la navegación. */
export default function ReplaysPage() {
  return <ReplaysView />;
}
