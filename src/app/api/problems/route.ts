import { parseFilters } from "@/lib/filters";
import { createGetHandler } from "@/lib/http";
import { readProblems } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createGetHandler((params) => readProblems(parseFilters(params, false)));
