import { text, varchar, timestamp, jsonb, boolean, integer } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { directFeasibilities } from "./directFeasibilities.js";

export const files = finalSchema.table(
  "files",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    directFeasibilityId: varchar("direct_feasibility_id", { length: 24 })
      .notNull()
      .references(() => directFeasibilities.id, { onDelete: "cascade" }),
    order: integer("order"),
    uploaddate: timestamp("uploaddate", { withTimezone: true }),
    filename: text("filename"),
    current: text("current"),
    prevlinks: jsonb("prevlinks").$type("string[]").default([]),
    isDisabled: boolean("is_disabled").default(false),
  },
  (t) => [t.directFeasibilityId]
);
