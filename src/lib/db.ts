import { Pool, type PoolClient } from "pg";

const processGlobal = globalThis as typeof globalThis & { pulsePool?: Pool };

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!processGlobal.pulsePool) {
    processGlobal.pulsePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      // Connection-scoped: keeps the August median sort in memory without changing PostgreSQL globally.
      options: "-c work_mem=16MB",
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 15_000,
      application_name: "nyc-service-pulse-api",
    });
    processGlobal.pulsePool.on("error", () => {
      console.error("[database] An idle connection was lost.");
    });
  }
  return processGlobal.pulsePool;
}

/** A refresh cannot split the totals, daily chart, and table across snapshots. */
export async function withReadSnapshot<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  // pg-pool removes its idle error listener during checkout. Socket loss can emit
  // an error between awaited queries as well as rejecting an active query.
  let connectionError: Error | undefined;
  const onConnectionError = (error: Error) => { connectionError = error; };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await read(client);
    if (connectionError) throw connectionError;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (!connectionError) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    // Release first so the pool reinstalls its listener without an unhandled gap.
    client.release(connectionError);
    client.off("error", onConnectionError);
  }
}
