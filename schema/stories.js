import { text, varchar, timestamp, jsonb, boolean, integer } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { directFeasibilities } from "./directFeasibilities.js";

export const stories = finalSchema.table(
  "stories",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    directFeasibilityId: varchar("direct_feasibility_id", { length: 24 })
      .notNull()
      .references(() => directFeasibilities.id, { onDelete: "cascade" }),
    title: text("title"),
    storyText: text("story_text").notNull(),
    date: timestamp("date", { withTimezone: true }),
    order: integer("order"),
    isDisabled: boolean("is_disabled").default(false),
    isHidden: boolean("is_hidden").default(false),
    type: varchar("type", { length: 64 }),
    linkedTaskId: varchar("linked_task_id", { length: 24 }),
    createdByUserId: varchar("created_by_user_id", { length: 24 }),
    lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
    lastEditedByUserId: varchar("last_edited_by_user_id", { length: 24 }),
    linkedFiles: text("linked_files").array().$default([]),
    versions: jsonb("versions").default([]),
  },
  (t) => [t.directFeasibilityId]
);
