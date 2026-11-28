import { CompareView } from "@/components/CompareView";

export const metadata = { title: "Comparativa spot vs futures" };

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ asset?: string }> }) {
  const { asset } = await searchParams;
  return <CompareView initialAsset={asset === "eth" ? "eth" : "btc"} />;
}
