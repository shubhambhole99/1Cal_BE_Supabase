import "dotenv/config";
import { pgSchema } from "drizzle-orm/pg-core";

/** PostgreSQL schema for all app tables. Set DB_SCHEMA in .env (default: "final"). */
const schemaName = process.env.DB_SCHEMA ?? "final";
export const finalSchema = pgSchema(schemaName);
