import { text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const fileTemplates = finalSchema.table("file_templates", {
  id: varchar("id", { length: 24 }).primaryKey(),
  name: varchar("name", { length: 256 }),
  type: varchar("type", { length: 64 }),
  html: text("html"),
  inputValues: jsonb("input_values"),
  date: timestamp("date", { withTimezone: true }).defaultNow(),
});
