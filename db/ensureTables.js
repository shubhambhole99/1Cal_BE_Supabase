import { config } from "dotenv";
config({ override: true });
import postgres from "postgres";

const SCHEMA = process.env.DB_SCHEMA ?? "final";
const ref = (table) => SCHEMA === "public" ? table : `"${SCHEMA}".${table}`;

/**
 * On startup, ensure all tables exist and add any missing columns.
 * Safe to run repeatedly — uses IF NOT EXISTS / information_schema checks.
 */
export async function ensureTables() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

  try {
    // Create schema if not public
    if (SCHEMA !== "public") {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    }

    // Helper: get existing columns for a table
    const getColumns = async (table) => {
      const rows = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = ${table}
      `;
      return new Set(rows.map((r) => r.column_name));
    };

    // Helper: add missing columns
    const ensure = async (table, columns) => {
      const existing = await getColumns(table);
      let added = 0;
      for (const [col, def] of Object.entries(columns)) {
        if (!existing.has(col)) {
          await sql.unsafe(`ALTER TABLE ${ref(table)} ADD COLUMN IF NOT EXISTS "${col}" ${def}`);
          added++;
          console.log(`  [ensureTables] Added ${table}.${col}`);
        }
      }
      return added;
    };

    let totalAdded = 0;

    // ── users ──
    // Fix: if users.id is uuid but app uses 24-char hex IDs, convert to text
    const userIdType = await sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = ${SCHEMA} AND table_name = 'users' AND column_name = 'id'
    `;
    if (userIdType.length > 0 && userIdType[0].data_type === 'uuid') {
      console.log("  [ensureTables] Converting users.id from uuid to text...");
      // Find and temporarily drop FK constraints referencing users.id
      const fks = await sql`
        SELECT tc.constraint_name, tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_schema = ${SCHEMA} AND ccu.table_name = 'users' AND ccu.column_name = 'id'
      `;
      for (const fk of fks) {
        console.log(`  [ensureTables] Temporarily dropping FK ${fk.constraint_name} on ${fk.table_name}`);
        await sql.unsafe(`ALTER TABLE ${ref(fk.table_name)} DROP CONSTRAINT IF EXISTS "${fk.constraint_name}"`);
      }
      // Convert column type
      await sql.unsafe(`ALTER TABLE ${ref("users")} ALTER COLUMN id TYPE text USING id::text`);
      console.log("  [ensureTables] users.id converted to text");
    }

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("users")} (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password text NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("users", {
      actual_created_at: "timestamptz DEFAULT now()",
      name: "text",
      username: "text",
      role: "text",
      paths: "jsonb",
      status: "varchar(64) DEFAULT 'active'",
      is_disabled: "boolean DEFAULT false",
      phone_country_code: "varchar(16)",
      phone_number: "varchar(32)",
      first_name: "text",
      last_name: "text",
      full_name: "text",
      password_hash: "text DEFAULT ''",
      created_at: "timestamptz DEFAULT now()",
      updated_at: "timestamptz DEFAULT now()",
    });

    // ── templates ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("templates")} (
        id varchar(24) PRIMARY KEY
      )
    `).catch(() => {});
    totalAdded += await ensure("templates", {
      pages: "jsonb DEFAULT '[]'",
      masterinput: "jsonb DEFAULT '[]'",
      masterinputfromother: "jsonb DEFAULT '[]'",
      imported_input_sections: "jsonb DEFAULT '[]'",
      pagesfromother: "jsonb DEFAULT '[]'",
      inputsections: "jsonb DEFAULT '[]'",
      dashboards: "jsonb DEFAULT '[]'",
      name: "text",
      subject: "varchar(512) DEFAULT 'No Subject'",
      scheme: "text",
      rulebook: "text",
      description: "text",
      template_id: "varchar(24)",
      userid: "varchar(24)",
      date: "timestamptz DEFAULT now()",
      tags: "jsonb DEFAULT '[]'",
      favourites: "jsonb DEFAULT '[]'",
      likedby: "jsonb DEFAULT '[]'",
      adminusers: "jsonb DEFAULT '[]'",
      created_at: "timestamptz DEFAULT now()",
      quotes: "jsonb DEFAULT '[]'",
      currentversion: "varchar(24)",
      publishid: "varchar(24)",
      to_publish: "boolean DEFAULT false",
      blogdetails: "jsonb",
      blocks: "jsonb",
      linktohtml: "text",
      is_disabled: "boolean DEFAULT false",
      "order": "integer DEFAULT 0",
    });

    // ── versions ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("versions")} (
        id varchar(24) PRIMARY KEY
      )
    `).catch(() => {});
    totalAdded += await ensure("versions", {
      pages: "jsonb DEFAULT '[]'",
      masterinput: "jsonb DEFAULT '[]'",
      masterinputfromother: "jsonb DEFAULT '[]'",
      imported_input_sections: "jsonb DEFAULT '[]'",
      pagesfromother: "jsonb DEFAULT '[]'",
      inputsections: "jsonb DEFAULT '[]'",
      dashboards: "jsonb DEFAULT '[]'",
      name: "text",
      subject: "varchar(512) DEFAULT 'No Subject'",
      scheme: "text",
      rulebook: "text",
      description: "text",
      template_id: "varchar(24)",
      date: "timestamptz DEFAULT now()",
      created_at: "timestamptz DEFAULT now()",
      versionof: "varchar(24)",
    });

    // ── direct_feasibilities ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("direct_feasibilities")} (
        id varchar(24) PRIMARY KEY,
        template_id varchar(24) NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("direct_feasibilities", {
      pages: "jsonb DEFAULT '[]'",
      masterinput: "jsonb DEFAULT '[]'",
      name: "text",
      created_at: "timestamptz DEFAULT now()",
      last_modified_at: "timestamptz",
      inputsections: "jsonb DEFAULT '[]'",
      new_pages: "jsonb DEFAULT '{}'",
      new_masterinput: "jsonb DEFAULT '{}'",
      new_inputsections: "jsonb DEFAULT '{}'",
      userid: "varchar(24)",
      collaborators: "jsonb DEFAULT '[]'",
      is_disabled: "boolean DEFAULT false",
      fixedparameterset: "boolean DEFAULT false",
      show_files_and_stories: "boolean DEFAULT false",
      show_slides: "boolean DEFAULT false",
      chat_bar_1_enabled: "boolean DEFAULT false",
      chat_bar_2_enabled: "boolean DEFAULT false",
    });

    // ── stories ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("stories")} (
        id varchar(36) PRIMARY KEY,
        direct_feasibility_id varchar(24) NOT NULL,
        story_text text NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("stories", {
      title: "text",
      date: "timestamptz",
      "order": "integer",
      is_disabled: "boolean DEFAULT false",
      is_hidden: "boolean DEFAULT false",
      type: "varchar(64)",
      linked_task_id: "varchar(24)",
      created_by_user_id: "varchar(24)",
      last_edited_at: "timestamptz",
      last_edited_by_user_id: "varchar(24)",
      linked_files: "text[] DEFAULT '{}'",
      versions: "jsonb DEFAULT '[]'",
    });

    // ── files ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("files")} (
        id varchar(36) PRIMARY KEY,
        direct_feasibility_id varchar(24) NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("files", {
      "order": "integer",
      uploaddate: "timestamptz",
      filename: "text",
      current: "text",
      prevlinks: "jsonb DEFAULT '[]'",
      is_disabled: "boolean DEFAULT false",
    });

    // ── slides ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("slides")} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        direct_feasibility_id varchar(24) NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("slides", {
      title: "text",
      layout: "varchar(32) DEFAULT 'image-text'",
      background_color: "text",
      text_background_color: "text",
      file_id: "varchar(36)",
      content: "jsonb",
      slide_order: "integer NOT NULL DEFAULT 0",
      created_at: "timestamptz DEFAULT now()",
      updated_at: "timestamptz DEFAULT now()",
    });

    // ── contacts ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("contacts")} (
        id varchar(24) PRIMARY KEY
      )
    `).catch(() => {});
    totalAdded += await ensure("contacts", {
      created_at: "timestamptz DEFAULT now()",
      name: "text",
      phone: "varchar(64)",
      is_disabled: "boolean DEFAULT false",
      email: "varchar(256)",
      type: "varchar(64)",
      description: "text",
      "user": "varchar(24)",
      files: "jsonb",
      gst: "varchar(64)",
      pan: "varchar(64)",
    });

    // ── about_us ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("about_us")} (
        id varchar(24) PRIMARY KEY,
        name varchar(256) NOT NULL,
        brief text NOT NULL,
        description text NOT NULL,
        level integer NOT NULL
      )
    `).catch(() => {});
    totalAdded += await ensure("about_us", {
      photo_url: "text",
      created_at: "timestamptz DEFAULT now()",
      is_disabled: "boolean DEFAULT false",
    });

    // ── bills ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("bills")} (
        id varchar(24) PRIMARY KEY
      )
    `).catch(() => {});
    totalAdded += await ensure("bills", {
      created_at: "timestamptz DEFAULT now()",
      form: "jsonb",
      "user": "varchar(24)",
      name: "varchar(256)",
      client: "varchar(24)",
    });

    // ── pdf_download_logs ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("pdf_download_logs")} (
        id varchar(24) PRIMARY KEY,
        "user" varchar(24) NOT NULL,
        fetch_id varchar(256) NOT NULL,
        downloaded_at timestamptz NOT NULL DEFAULT now()
      )
    `).catch(() => {});

    // ── file_templates ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("file_templates")} (
        id varchar(24) PRIMARY KEY
      )
    `).catch(() => {});
    totalAdded += await ensure("file_templates", {
      name: "varchar(256)",
      type: "varchar(64)",
      html: "text",
      input_values: "jsonb",
      date: "timestamptz DEFAULT now()",
    });

    // ── comment_threads ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("comment_threads")} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        target_type varchar(32) NOT NULL,
        target_id varchar(24) NOT NULL,
        created_at timestamptz DEFAULT now(),
        UNIQUE (target_type, target_id)
      )
    `).catch(() => {});

    // ── comments ──
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${ref("comments")} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id uuid NOT NULL,
        user_id varchar(24) NOT NULL,
        body text NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `).catch(() => {});
    totalAdded += await ensure("comments", {
      parent_id: "uuid",
    });

    if (totalAdded > 0) {
      console.log(`[ensureTables] Added ${totalAdded} missing column(s)`);
    } else {
      console.log("[ensureTables] All tables and columns up to date");
    }
  } catch (err) {
    console.error("[ensureTables] Error:", err.message);
    // Don't crash the server — just log the error
  } finally {
    await sql.end();
  }
}
