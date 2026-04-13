import { uuid, text, varchar, timestamp } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";
import { commentThreads } from "./commentThreads.js";

export const comments = finalSchema.table("comments", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull().references(() => commentThreads.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 24 }).notNull(),
  parentId: uuid("parent_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
