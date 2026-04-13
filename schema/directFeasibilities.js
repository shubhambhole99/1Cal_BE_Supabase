import { text, varchar, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const directFeasibilities = finalSchema.table("direct_feasibilities", {
  id: varchar("id", { length: 24 }).primaryKey(),
  templateId: varchar("template_id", { length: 24 }).notNull(),
  pages: jsonb("pages").$type("object[]").default([]),
  masterinput: jsonb("masterinput").$type("object[]").default([]),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastModifiedAt: timestamp("last_modified_at", { withTimezone: true }),
  inputsections: jsonb("inputsections").$type("object[]").default([]),
  newPages: jsonb("new_pages").default({}),
  newMasterinput: jsonb("new_masterinput").default({}),
  newInputsections: jsonb("new_inputsections").default({}),
  userid: varchar("userid", { length: 24 }),
  collaborators: jsonb("collaborators").$type("string[]").default([]),
  isDisabled: boolean("is_disabled").default(false),
  fixedparameterset: boolean("fixedparameterset").default(false),
  showFilesAndStories: boolean("show_files_and_stories").default(false),
  showSlides: boolean("show_slides").default(false),
  chatBar1Enabled: boolean("chat_bar_1_enabled").default(false),
  chatBar2Enabled: boolean("chat_bar_2_enabled").default(false),
});
