import { Pool, type PoolClient } from "pg";

const processGlobal = globalThis as typeof globalThis & { pulsePool?: Pool };

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!processGlobal.pulsePool) {
    processGlobal.pulsePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      // Allows a suspended Neon compute to wake; queries still have a separate budget.
      connectionTimeoutMillis: 10_000,
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
    // Transaction scope also works behind Neon's transaction pooler.
    await client.query("SET LOCAL work_mem='16MB'; SET LOCAL statement_timeout='15s'");
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
