import { text, uuid, varchar, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { directFeasibilities } from "./directFeasibilities.js";
import { files } from "./files.js";

export const slides = finalSchema.table(
  "slides",
  {
    id: uuid("id").primaryKey(),
    directFeasibilityId: varchar("direct_feasibility_id", { length: 24 })
      .notNull()
      .references(() => directFeasibilities.id, { onDelete: "cascade" }),
    title: text("title"),
    layout: varchar("layout", { length: 32 }).default("image-text"),
    backgroundColor: text("background_color"),
    textBackgroundColor: text("text_background_color"),
    fileId: varchar("file_id", { length: 36 }).references(() => files.id, {
      onDelete: "set null",
    }),
    content: jsonb("content").default(null),
    slideOrder: integer("slide_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [t.directFeasibilityId]
);
