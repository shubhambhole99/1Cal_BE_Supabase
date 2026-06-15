import { config } from "dotenv";
config({ override: true });

/**
 * Choose the Postgres connection string based on DB_TARGET (set in .env):
 *   DB_TARGET=prod  (default) -> DATABASE_URL        (Supabase cloud)
 *   DB_TARGET=local           -> LOCAL_DATABASE_URL  (local downloaded copy)
 *
 * This lets the whole backend be flipped to a local copy of the prod DB from
 * .env alone — e.g. a presentation fallback when the cloud is unreachable.
 * Default is "prod", so existing/deployed behaviour is unchanged unless you opt in.
 */
export function resolveDbUrl() {
  const target = (process.env.DB_TARGET ?? "prod").toLowerCase();
  const url = target === "local" ? process.env.LOCAL_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    const key = target === "local" ? "LOCAL_DATABASE_URL" : "DATABASE_URL";
    throw new Error(`No DB URL for DB_TARGET="${target}". Set ${key} in .env`);
  }
  return url;
}
