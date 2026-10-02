import { createGetHandler } from "@/lib/http";
import { parseMapQuery, readMap } from "@/lib/map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createGetHandler((params) => readMap(parseMapQuery(params)));
