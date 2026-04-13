import { varchar, timestamp } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const pdfDownloadLogs = finalSchema.table("pdf_download_logs", {
  id: varchar("id", { length: 24 }).primaryKey(),
  user: varchar("user", { length: 24 }).notNull(),
  fetchId: varchar("fetch_id", { length: 256 }).notNull(),
  downloadedAt: timestamp("downloaded_at", { withTimezone: true }).defaultNow().notNull(),
});
