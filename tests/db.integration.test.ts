import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client, type PoolClient } from "pg";
import { getPool, withReadSnapshot } from "../src/lib/db";
import { createGetHandler } from "../src/lib/http";

const connectionString = process.env.TEST_DATABASE_URL;
test("lost checked-out connections return 503 and are replaced without uncaught errors", { skip: !connectionString, timeout: 15_000 }, async () => {
  process.env.DATABASE_URL = connectionString;
  const controller = new Client({ connectionString, application_name: "pulse-recovery-controller" });
  await controller.connect();
  const pool = getPool();
  try {
    for (const state of ["between queries", "during query"] as const) {
      const marker = `pulse-recovery-${randomUUID()}`;
      let terminatedPid = 0;
      let checkedOut: PoolClient | undefined;
      const handler = createGetHandler(async () => withReadSnapshot(async (client) => {
        checkedOut = client;
        const own = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid, set_config('application_name',$1,true)", [marker]);
        terminatedPid = own.rows[0].pid;
        // Await 'end', not 'error': an error listener in the test would mask the bug.
        const ended = new Promise<void>((resolve) => client.once("end", resolve));
        const inFlight = state === "during query"
          ? assert.rejects(client.query("SELECT pg_sleep(10)"), /terminat|connection/i)
          : Promise.resolve();
        // Terminate only this fixture's PID plus unguessable marker in this database.
        const killed = await controller.query<{ killed: boolean }>(`
          SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
          WHERE pid=$1 AND application_name=$2 AND datname=current_database()
            AND pid<>pg_backend_pid() AND backend_type='client backend'`, [terminatedPid, marker]);
        assert.deepEqual(killed.rows, [{ killed: true }]);
        await inFlight;
        await ended;
        return { unexpected: "success" };
      }));
      const response = await handler(new Request("http://localhost/api/pulse"));
      assert.equal(response.status, 503, state);
      const body = await response.json();
      assert.equal(body.error.code, "DATA_UNAVAILABLE");
      assert.doesNotMatch(body.error.message, /pg_sleep|terminat|pulse-recovery/i);
      assert.equal(pool.totalCount, 0, "broken connection must be discarded");
      assert.equal(checkedOut?.listenerCount("error"), 1, "only the pool's released listener remains");
      const replacement = await withReadSnapshot(async (client) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      assert.notEqual(replacement, terminatedPid);
      assert.equal(pool.idleCount, 1, "subsequent reads recover on a healthy connection");
    }
  } finally {
    await controller.end();
    await pool.end();
  }
});
