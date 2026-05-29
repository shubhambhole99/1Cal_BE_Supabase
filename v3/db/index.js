import { config } from "dotenv";
config({ override: true });
import postgres from "postgres";

let _sql = null;

/** Lazy-init postgres client. Use as: `await sql\`SELECT 1\`` */
export function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = postgres(url, { prepare: false });
  }
  return _sql;
}

export const sql = new Proxy(function () {}, {
  get(_t, prop) {
    return getSql()[prop];
  },
  apply(_t, _this, args) {
    return getSql()(...args);
  },
});
