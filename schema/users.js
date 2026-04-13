import { text, varchar, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { finalSchema } from "./finalSchema.js";

export const users = finalSchema.table("users", {
  id: text("id").primaryKey(),
  actualCreatedAt: timestamp("actual_created_at", { withTimezone: true }).defaultNow(),
  name: text("name"),
  username: text("username"),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  role: text("role"),
  paths: jsonb("paths"),
  status: varchar("status", { length: 64 }).default("active"),
  isDisabled: boolean("is_disabled").default(false),
  phoneCountryCode: varchar("phone_country_code", { length: 16 }),
  phoneNumber: varchar("phone_number", { length: 32 }),
  firstName: text("first_name"),
  lastName: text("last_name"),
});
