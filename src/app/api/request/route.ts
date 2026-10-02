import { createGetHandler } from "@/lib/http";
import { parseRequestId, readRequest } from "@/lib/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createGetHandler((params) => readRequest(parseRequestId(params)));
