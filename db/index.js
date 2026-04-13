import { config } from "dotenv";
config({ override: true });
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as model from "../schema/index.js";

let _db = null;

function getDb() {
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    console.log(connectionString)
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    const client = postgres(connectionString, { prepare: false });
    _db = drizzle(client, { schema: model });
  }
  return _db;
}

// Lazy init so we don't connect at cold start (avoids serverless crash)
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      return getDb()[prop];
    },
  }
);

export { model };
