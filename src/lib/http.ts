import { FilterError } from "./filters";

/** Keeps database details out of responses and makes error behavior testable. */
export function createGetHandler<T>(load: (params: URLSearchParams) => Promise<T>) {
  return async (request: Request): Promise<Response> => {
    try {
      const startedAt = performance.now();
      const result = await load(new URL(request.url).searchParams);
      const duration = (performance.now() - startedAt).toFixed(2);
      return Response.json(result, { headers: {
        "Cache-Control": "no-store",
        "Server-Timing": `data;dur=${duration};desc="App loader (filters, pool, SQL)"`,
      } });
    } catch (error) {
      const invalid = error instanceof FilterError;
      if (!invalid) console.error("[api] Unable to read the local service request database.");
      return Response.json({
        error: {
          code: invalid ? "INVALID_FILTERS" : "DATA_UNAVAILABLE",
          message: invalid ? error.message : "The local database is unavailable. Check that PostgreSQL is running and the schema is installed, then try again.",
        },
      }, { status: invalid ? 400 : 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}
