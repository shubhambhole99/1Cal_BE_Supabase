import { text, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const versions = finalSchema.table("versions", {
  id: varchar("id", { length: 24 }).primaryKey(),
  pages: jsonb("pages").$type("object[]").default([]),
  masterinput: jsonb("masterinput").$type("object[]").default([]),
  masterinputfromother: jsonb("masterinputfromother").$type("object[]").default([]),
  importedInputSections: jsonb("imported_input_sections").$type("object[]").default([]),
  pagesfromother: jsonb("pagesfromother").$type("object[]").default([]),
  inputsections: jsonb("inputsections").$type("object[]").default([]),
  dashboards: jsonb("dashboards").$type("object[]").default([]),
  name: text("name"),
  subject: varchar("subject", { length: 512 }).default("No Subject"),
  scheme: text("scheme"),
  rulebook: text("rulebook"),
  description: text("description"),
  templateId: varchar("template_id", { length: 24 }),
  date: timestamp("date", { withTimezone: true }).defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  versionof: varchar("versionof", { length: 24 }),
});
