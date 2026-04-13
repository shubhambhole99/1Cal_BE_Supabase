import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "path";
import postgres from "postgres";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dbSchema = process.env.DB_SCHEMA ?? "final";
const client = postgres(connectionString, { max: 1, prepare: false });
const db = drizzle(client);

await migrate(db, {
  migrationsFolder: path.join(__dirname, "drizzle"),
  migrationsSchema: dbSchema,
});

await client.end();
console.log("Migrations applied.");
