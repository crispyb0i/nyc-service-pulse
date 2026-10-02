import { createGetHandler } from "@/lib/http";
import { parseRequestsQuery, readRequests } from "@/lib/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createGetHandler((params) => readRequests(parseRequestsQuery(params)));
