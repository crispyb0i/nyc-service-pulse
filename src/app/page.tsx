import PulseDashboard from "@/components/pulse-dashboard";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PulseDashboard initialQuery={await searchParams} />;
}
