import { getPool } from "@/lib/db";
import { createGetHandler } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createGetHandler(async () => {
  await getPool().query("SELECT 1");
  return { status: "ok", database: "connected" };
});
