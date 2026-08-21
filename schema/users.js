import { text, varchar, boolean, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
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
  // Per-user gate: when true, this user sees the "Create Report · V2" button
  // on calculation pages. Hidden for everyone by default; admins grant it per user.
  canCreateV2: boolean("can_create_v2").default(false),
  phoneCountryCode: varchar("phone_country_code", { length: 16 }),
  phoneNumber: varchar("phone_number", { length: 32 }),
  firstName: text("first_name"),
  lastName: text("last_name"),
  // Single active session: the id of the ONLY session currently allowed for this
  // user. Set on every login; the JWT carries a matching `sid`. A token whose sid
  // differs (an older device/browser) fails the /user/check heartbeat → logged out.
  activeSessionId: text("active_session_id"),
});
