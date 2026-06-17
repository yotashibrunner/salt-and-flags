// Postgres-backed persistence for the market. Implements the `Store` interface
// the Market core depends on: append a batch (intents + trades + ledger) in one
// transaction, and load the full intent log for replay on boot. Append-only — it
// never updates a row in place, so a crash mid-write can't corrupt prior state.
import type pg from "pg";
import type { Store, Batch, Intent } from "./market.mjs";

export class PgStore implements Store {
  constructor(private pool: pg.Pool) {}

  async persist(batch: Batch): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const it of batch.intents) {
        const { seq, kind, ...payload } = it as Intent & Record<string, unknown>;
        await client.query(
          "insert into market_intents (seq, kind, payload) values ($1, $2, $3)",
          [seq, kind, JSON.stringify(payload)],
        );
      }
      for (const t of batch.trades) {
        await client.query(
          "insert into trades (island_id, commodity_id, price, qty, buyer_id, seller_id) values ($1,$2,$3,$4,$5,$6)",
          [t.island, t.commodity, t.price, t.qty, t.buyer, t.seller],
        );
      }
      for (const l of batch.ledger) {
        await client.query(
          "insert into ledger (account_id, delta, reason) values ($1,$2,$3)",
          [l.account, l.delta, l.reason],
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async loadIntents(): Promise<Intent[]> {
    const { rows } = await this.pool.query(
      "select seq, kind, payload from market_intents order by seq asc, id asc",
    );
    return rows.map((r) => ({ seq: Number(r.seq), kind: r.kind, ...r.payload } as Intent));
  }
}
