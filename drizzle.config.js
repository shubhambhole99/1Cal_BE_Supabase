import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
const dbSchema = process.env.DB_SCHEMA ?? "final";
if (!connectionString) {
  throw new Error("DATABASE_URL is required for drizzle-kit. Set it in .env");
}

export default defineConfig({
  dialect: "postgresql",
  schemaFilter: [dbSchema],
  migrations: { schema: dbSchema },
  schema: [
    "./schema/users.js",
    "./schema/templates.js",
    "./schema/versions.js",
    "./schema/directFeasibilities.js",
    "./schema/stories.js",
    "./schema/files.js",
    "./schema/slides.js",
    "./schema/contacts.js",
    "./schema/aboutUs.js",
    "./schema/bills.js",
    "./schema/pdfDownloadLogs.js",
    "./schema/fileTemplates.js",
    "./schema/commentThreads.js",
    "./schema/comments.js",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: connectionString,
  },
});
