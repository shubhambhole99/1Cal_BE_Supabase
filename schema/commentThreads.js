import { uuid, varchar, timestamp, unique } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const commentThreads = finalSchema.table("comment_threads", {
  id: uuid("id").primaryKey(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 24 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  commentThreadsTargetTypeTargetIdUnique: unique().on(table.targetType, table.targetId),
}));
