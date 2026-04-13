import { text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const bills = finalSchema.table("bills", {
  id: varchar("id", { length: 24 }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  form: jsonb("form"),
  user: varchar("user", { length: 24 }),
  name: varchar("name", { length: 256 }),
  client: varchar("client", { length: 24 }),
});
