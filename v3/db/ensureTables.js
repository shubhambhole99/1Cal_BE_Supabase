import { config } from "dotenv";
config({ override: true });
import postgres from "postgres";
import { newObjectId } from "../utils/objectId.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const ref = (t) => (SCHEMA === "public" ? `"${t}"` : `"${SCHEMA}"."${t}"`);

/**
 * Create / migrate v3 schema. Idempotent. Run on boot.
 *
 * Version branching model:
 *   v3_templates.published_version_id  → pointer to the version users see "live"
 *   v3_versions                        → branches per template
 *   v3_pages.version_id                → page rows belong to a version
 *   v3_master_input.version_id            → master inputs belong to a version
 *
 * Editing a non-published version mutates rows tagged with that version_id; the
 * published view stays untouched until POST /v3/templates/:id/publish flips
 * `published_version_id`.
 */
export async function ensureTables() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try {
    if (SCHEMA !== "public") {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    }

    // ── 0. One-time rename from `v8_*` → `v3_*` ─────────────────────────
    // The product was rebranded v8 → v3. This block renames every existing
    // v8_* table to its v3_* equivalent. All guards use `IF EXISTS`, so on
    // a fresh install (no v8_ tables present) the block is a no-op.
    //
    // Conflict recovery: in some upgrade paths (e.g. the rename code was
    // deployed AFTER an `ensureTables` pass that already created an empty
    // v3_* via CREATE TABLE IF NOT EXISTS), the RENAME target may already
    // exist. To survive that, we DROP the empty v3_* first only when
    // BOTH names exist AND v3_* has 0 rows. If v3_* has data we leave it
    // alone (refuse to clobber).
    const tableRenames = [
      ["v8_templates",              "v3_templates"],
      ["v8_pages",                  "v3_pages"],
      ["v8_versions",               "v3_versions"],
      ["v8_version_diffs",          "v3_version_diffs"],
      ["v8_master_input",           "v3_master_input"],
      ["v8_master_input_group",     "v3_master_input_group"],
      ["v8_instances",              "v3_instances"],
      ["v8_instance_master_input",  "v3_instance_master_input"],
      ["v8_calculations",           "v3_calculations"],
    ];
    for (const [oldT, newT] of tableRenames) {
      await sql.unsafe(`DO $$
        DECLARE old_exists BOOLEAN; new_exists BOOLEAN; new_count BIGINT;
        BEGIN
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = '${SCHEMA}' AND table_name = '${oldT}'
          ) INTO old_exists;
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = '${SCHEMA}' AND table_name = '${newT}'
          ) INTO new_exists;
          IF old_exists AND new_exists THEN
            EXECUTE 'SELECT COUNT(*) FROM ${ref(newT)}' INTO new_count;
            IF new_count = 0 THEN
              EXECUTE 'DROP TABLE ${ref(newT)} CASCADE';
              EXECUTE 'ALTER TABLE ${ref(oldT)} RENAME TO ${newT}';
            END IF;
          ELSIF old_exists AND NOT new_exists THEN
            EXECUTE 'ALTER TABLE ${ref(oldT)} RENAME TO ${newT}';
          END IF;
        END $$`);
    }
    const indexRenames = [
      ["idx_v8_pages_tmpl_ord", "idx_v3_pages_tmpl_ord"],
      ["idx_v8_pages_version",  "idx_v3_pages_version"],
      ["idx_v8_vdiff_ver",      "idx_v3_vdiff_ver"],
    ];
    for (const [oldI, newI] of indexRenames) {
      await sql.unsafe(`ALTER INDEX IF EXISTS ${ref(oldI)} RENAME TO ${newI}`);
    }
    // Constraints — wrapped in DO $$ ... EXCEPTION so a missing constraint
    // on a fresh DB doesn't abort the migration.
    const constraintRenames = [
      ["v3_master_input",          "v8_master_input_group_fk",                  "v3_master_input_group_fk"],
      ["v3_master_input",          "v8_master_input_type_check",                "v3_master_input_type_check"],
      ["v3_master_input",          "v8_master_input_kind_check",                "v3_master_input_kind_check"],
      ["v3_master_input_group",    "v8_master_input_group_unique",              "v3_master_input_group_unique"],
      ["v3_instance_master_input", "v8_instance_master_input_fk",               "v3_instance_master_input_fk"],
      ["v3_instance_master_input", "v8_instance_master_input_template_mi_fk",   "v3_instance_master_input_template_mi_fk"],
      ["v3_pages",                 "v8_pages_template_ord_unique",              "v3_pages_template_ord_unique"],
      ["v3_pages",                 "v8_pages_tmpl_ver_ord_unique",              "v3_pages_tmpl_ver_ord_unique"],
      ["v3_instance_master_input", "v8_instance_master_input_inst_key_unique",  "v3_instance_master_input_inst_key_unique"],
    ];
    for (const [tbl, oldC, newC] of constraintRenames) {
      await sql.unsafe(`DO $$
        BEGIN
          ALTER TABLE ${ref(tbl)} RENAME CONSTRAINT ${oldC} TO ${newC};
        EXCEPTION
          WHEN undefined_object THEN NULL;
          WHEN undefined_table  THEN NULL;
          WHEN duplicate_object THEN NULL;
        END $$`);
    }

    // ── 1. Base tables (CREATE IF NOT EXISTS, fresh-DB friendly) ────────
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_templates")} (
      id                    VARCHAR(24) PRIMARY KEY,
      name                  TEXT,
      scheme                TEXT,
      description           TEXT,
      user_id               VARCHAR(24),
      published_version_id  VARCHAR(24),
      legacy_template_id    VARCHAR(24),
      input_sections        JSONB DEFAULT '[]'::jsonb,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )`);

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_pages")} (
      id              VARCHAR(24) PRIMARY KEY,
      template_id     VARCHAR(24) NOT NULL,
      version_id      VARCHAR(24),
      name            TEXT,
      ord             INTEGER DEFAULT 0,
      row_count       INTEGER DEFAULT 0,
      col_count       INTEGER DEFAULT 0,
      size            TEXT,
      orientation     TEXT,
      scale           NUMERIC,
      hidden          BOOLEAN DEFAULT FALSE,
      is_imported     BOOLEAN DEFAULT FALSE,
      columns_order   JSONB DEFAULT '[]'::jsonb,
      column_widths   JSONB DEFAULT '{}'::jsonb,
      row_heights     JSONB DEFAULT '{}'::jsonb,
      cells           JSONB DEFAULT '{}'::jsonb,
      styles          JSONB DEFAULT '{}'::jsonb,
      merges          JSONB DEFAULT '[]'::jsonb,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_versions")} (
      id              VARCHAR(24) PRIMARY KEY,
      template_id     VARCHAR(24) NOT NULL,
      label           TEXT,
      author_id       VARCHAR(24),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_version_diffs")} (
      version_id      VARCHAR(24) NOT NULL,
      page_id         VARCHAR(24) NOT NULL,
      snapshot        JSONB,
      PRIMARY KEY (version_id, page_id)
    )`);

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_master_input")} (
      id              VARCHAR(24) PRIMARY KEY,
      template_id     VARCHAR(24) NOT NULL,
      version_id      VARCHAR(24),
      key             TEXT,
      value           TEXT,
      ref             TEXT,
      type            TEXT,
      options         JSONB DEFAULT '[]'::jsonb,
      section         TEXT,
      ord             INTEGER DEFAULT 0,
      display_name    TEXT,
      kind            TEXT DEFAULT 'basic',
      group_name      TEXT,
      group_id        VARCHAR(24)
    )`);

    // Groups are first-class — they live in their own table and a master
    // input's group_id is a real FK. parent_group_id is reserved for nested
    // groups (no UI yet, schema-ready).
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_master_input_group")} (
      id               VARCHAR(24) PRIMARY KEY,
      template_id      VARCHAR(24) NOT NULL,
      version_id       VARCHAR(24),
      key              TEXT NOT NULL,
      display_name     TEXT,
      section          TEXT,
      ord              INTEGER DEFAULT 0,
      parent_group_id  VARCHAR(24)
    )`);

    // Instances — per-feasibility copies forked from a template. Lightweight:
    // they own master-input values, nothing else. Pages/formulas/groups stay
    // on the template (read-through via FK).
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_instances")} (
      id              VARCHAR(24) PRIMARY KEY,
      template_id     VARCHAR(24) NOT NULL,
      version_id      VARCHAR(24),
      name            TEXT,
      user_id         VARCHAR(24),
      collaborators   JSONB DEFAULT '[]'::jsonb,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Per-instance master inputs — REFERENCE + OVERRIDES model.
    //
    // Instance owns ONLY its values. Metadata (key, display_name, ref, type,
    // options, section, ord, kind, group_id) is read live from v3_master_input
    // at GET time via JOIN. This avoids the ~750-row INSERT fan-out on
    // instance creation and lets template edits (e.g. typo fixes in
    // display_name) propagate to existing instances within the same version.
    //
    // A row only exists in v3_instance_master_input when the user has
    // overridden the template's default value for that MI. UNIQUE constraint
    // on (instance_id, template_mi_id) supports UPSERT semantics.
    //
    // Drop the old fat shape (display_name, options, etc.) if present so we
    // recreate clean. Idempotent: once the new shape exists, this is a no-op.
    await sql.unsafe(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = '${SCHEMA}'
            AND table_name = 'v3_instance_master_input'
            AND column_name = 'display_name'
        ) THEN
          DROP TABLE ${ref("v3_instance_master_input")} CASCADE;
        END IF;
      END $$`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_instance_master_input")} (
      id              VARCHAR(24) PRIMARY KEY,
      instance_id     VARCHAR(24) NOT NULL,
      template_mi_id  VARCHAR(24) NOT NULL,
      value           TEXT,
      UNIQUE (instance_id, template_mi_id)
    )`);

    // Real Estate calculations — standalone entities surfaced by the
    // landing-L Real Estate section. Not tied to a template or a version;
    // they are just a flat list with name / description / sector / author.
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ref("v3_calculations")} (
      id           VARCHAR(24) PRIMARY KEY,
      name         TEXT NOT NULL,
      description  TEXT,
      sector       TEXT,
      author       TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Add `author` for tables created before this column existed.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS author TEXT`);
    // `ord` drives the admin DnD ordering. Default low number so newly-
    // POSTed rows sort to the top until reordered.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS ord INTEGER NOT NULL DEFAULT 0`);
    // `disabled` is the soft-delete replacement — landing-L hides disabled
    // rows; admin still sees them so they can be re-enabled.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE`);
    // `template_id` attaches a legacy (V2) template so the detail page can
    // surface a "Create Report by V2" action that hands the templateId to
    // the existing direct-use flow.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS template_id VARCHAR(24)`);
    // `instance_id` is a legacy column from an earlier draft of the V3
    // flow (picked instance directly). The current model is to pick a
    // re-template and create a FRESH instance per click via
    // `retemplate_id`. The instance_id column is retained for back-compat
    // but no longer surfaces in the admin UI.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS instance_id VARCHAR(24)`);
    // `retemplate_id` attaches a v3 re-template so the detail page can
    // surface a "Create Report by V3" action — clicking POSTs a brand-new
    // instance under this template and opens it in /retemplate2/.
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS retemplate_id VARCHAR(24)`);
    // `prefill_master_inputs` lets the admin set master-input overrides
    // ahead of time — when V3 "Create Report" fires, the new instance is
    // populated with these values right after creation. Shape:
    //   [ { id: <template_mi_id>, key: <stable key>, value: <string> }, ... ]
    await sql.unsafe(`ALTER TABLE ${ref("v3_calculations")} ADD COLUMN IF NOT EXISTS prefill_master_inputs JSONB DEFAULT '[]'::jsonb`);

    // `ord` + `disabled` on v3_templates power the admin Re-Template
    // listing's drag-to-reorder + disable-toggle UI (mirrors the
    // v3_calculations chrome).
    await sql.unsafe(`ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS ord INTEGER NOT NULL DEFAULT 0`);
    await sql.unsafe(`ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE`);

    // ── 2. Migrate existing schema if upgrading ─────────────────────────
    // 2a. Promote legacy table names to v3_master_input (preserves data).
    //   v3_template_master_input → master_input → v3_master_input
    await sql.unsafe(`DO $$
      BEGIN
        -- Step 1: rename legacy "v3_template_master_input" if present.
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = '${SCHEMA}' AND table_name = 'v3_template_master_input'
        ) THEN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = '${SCHEMA}' AND table_name = 'v3_master_input'
          ) THEN
            INSERT INTO ${ref("v3_master_input")}
              (id, template_id, key, value, ref, type, options, section, ord, display_name, kind, group_name)
            SELECT id, template_id, key, value, ref, type, options, section, ord,
                   display_name, kind, group_name
            FROM ${ref("v3_template_master_input")}
            ON CONFLICT (id) DO NOTHING;
            DROP TABLE ${ref("v3_template_master_input")};
          ELSE
            ALTER TABLE ${ref("v3_template_master_input")} RENAME TO v3_master_input;
          END IF;
        END IF;

        -- Step 2: rename intermediate "master_input" if present.
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = '${SCHEMA}' AND table_name = 'master_input'
        ) THEN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = '${SCHEMA}' AND table_name = 'v3_master_input'
          ) THEN
            INSERT INTO ${ref("v3_master_input")}
              (id, template_id, version_id, key, value, ref, type, options, section, ord, display_name, kind, group_name)
            SELECT id, template_id, version_id, key, value, ref, type, options, section, ord,
                   display_name, kind, group_name
            FROM ${ref("master_input")}
            ON CONFLICT (id) DO NOTHING;
            DROP TABLE ${ref("master_input")};
          ELSE
            ALTER TABLE ${ref("master_input")} RENAME TO v3_master_input;
          END IF;
        END IF;
      END $$`);

    // 2b. Rename v3_templates.current_version_id → published_version_id if needed.
    await sql.unsafe(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = '${SCHEMA}' AND table_name = 'v3_templates'
            AND column_name = 'current_version_id'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = '${SCHEMA}' AND table_name = 'v3_templates'
            AND column_name = 'published_version_id'
        ) THEN
          ALTER TABLE ${ref("v3_templates")} RENAME COLUMN current_version_id TO published_version_id;
        END IF;
      END $$`);

    // 2c. Add columns that may be missing on older databases (idempotent).
    const colAdds = [
      `ALTER TABLE ${ref("v3_pages")} ADD COLUMN IF NOT EXISTS version_id VARCHAR(24)`,
      `ALTER TABLE ${ref("v3_master_input")} ADD COLUMN IF NOT EXISTS version_id VARCHAR(24)`,
      `ALTER TABLE ${ref("v3_master_input")} ADD COLUMN IF NOT EXISTS display_name TEXT`,
      `ALTER TABLE ${ref("v3_master_input")} ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'basic'`,
      `ALTER TABLE ${ref("v3_master_input")} ADD COLUMN IF NOT EXISTS group_name TEXT`,
      `ALTER TABLE ${ref("v3_master_input")} ADD COLUMN IF NOT EXISTS group_id VARCHAR(24)`,
      `ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS input_sections JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS page_groups JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS published_version_id VARCHAR(24)`,
      `ALTER TABLE ${ref("v3_templates")} ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE ${ref("v3_instances")} ADD COLUMN IF NOT EXISTS collaborators JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE ${ref("v3_pages")} ADD COLUMN IF NOT EXISTS schemes JSONB DEFAULT '[]'::jsonb`,
      `ALTER TABLE ${ref("v3_pages")} ADD COLUMN IF NOT EXISTS row_heights JSONB DEFAULT '{}'::jsonb`,
      // Instance overrides keyed by the template MI's stable `key` (not by id),
      // so a delete-and-recreate of the template MI under the same key (e.g. on
      // JSON restore or xlsx import) preserves the instance's value.
      `ALTER TABLE ${ref("v3_instance_master_input")} ADD COLUMN IF NOT EXISTS template_mi_key TEXT`,
    ];
    for (const s of colAdds) await sql.unsafe(s);

    // 2c-bis. Promote master-input "group" rows to v3_master_input_group and
    // backfill group_id on inputs. Safe to re-run: subsequent passes find no
    // rows with type='group' / kind='group' so the body is a no-op.
    await sql.unsafe(`
      INSERT INTO ${ref("v3_master_input_group")}
        (id, template_id, version_id, key, display_name, section, ord)
      SELECT id, template_id, version_id, key, COALESCE(display_name, key), section, ord
      FROM ${ref("v3_master_input")}
      WHERE type = 'group' OR kind = 'group'
      ON CONFLICT (id) DO NOTHING
    `);
    await sql.unsafe(`
      UPDATE ${ref("v3_master_input")} mi
      SET group_id = g.id
      FROM ${ref("v3_master_input_group")} g
      WHERE mi.group_id IS NULL
        AND mi.group_name IS NOT NULL
        AND mi.template_id = g.template_id
        AND (mi.version_id IS NOT DISTINCT FROM g.version_id)
        AND (mi.section IS NOT DISTINCT FROM g.section)
        AND mi.group_name = g.key
    `);
    await sql.unsafe(`
      DELETE FROM ${ref("v3_master_input")}
      WHERE type = 'group' OR kind = 'group'
    `);
    await sql.unsafe(`
      UPDATE ${ref("v3_master_input")}
      SET kind = 'basic'
      WHERE kind IS NULL OR kind NOT IN ('basic','fixed','hidden')
    `);

    // 2c-ter. Constraints: FK on group_id, CHECKs on type/kind. Idempotent —
    // guarded by pg_constraint lookups.
    await sql.unsafe(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_master_input_group_fk'
        ) THEN
          ALTER TABLE ${ref("v3_master_input")}
            ADD CONSTRAINT v3_master_input_group_fk
            FOREIGN KEY (group_id)
            REFERENCES ${ref("v3_master_input_group")} (id)
            ON DELETE SET NULL;
        END IF;
        -- type check: drop+recreate so adding 'multiselect' over time works idempotently
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_master_input_type_check'
        ) THEN
          ALTER TABLE ${ref("v3_master_input")}
            DROP CONSTRAINT v3_master_input_type_check;
        END IF;
        ALTER TABLE ${ref("v3_master_input")}
          ADD CONSTRAINT v3_master_input_type_check
          CHECK (type IS NULL OR type IN ('text','textarea','number','select','boolean','multiselect'));
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_master_input_kind_check'
        ) THEN
          ALTER TABLE ${ref("v3_master_input")}
            ADD CONSTRAINT v3_master_input_kind_check
            CHECK (kind IS NULL OR kind IN ('basic','fixed','hidden'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_master_input_group_unique'
        ) THEN
          ALTER TABLE ${ref("v3_master_input_group")}
            ADD CONSTRAINT v3_master_input_group_unique
            UNIQUE (template_id, version_id, section, key);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_instance_master_input_fk'
        ) THEN
          ALTER TABLE ${ref("v3_instance_master_input")}
            ADD CONSTRAINT v3_instance_master_input_fk
            FOREIGN KEY (instance_id)
            REFERENCES ${ref("v3_instances")} (id)
            ON DELETE CASCADE;
        END IF;
        -- Override rows reference template MIs. If the template MI is
        -- deleted, drop its overrides too.
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_instance_master_input_template_mi_fk'
        ) THEN
          ALTER TABLE ${ref("v3_instance_master_input")}
            ADD CONSTRAINT v3_instance_master_input_template_mi_fk
            FOREIGN KEY (template_mi_id)
            REFERENCES ${ref("v3_master_input")} (id)
            ON DELETE CASCADE;
        END IF;
      END $$`);

    // 2d. Indexes
    const idx = [
      `CREATE INDEX IF NOT EXISTS idx_v3_pages_tmpl_ord  ON ${ref("v3_pages")} (template_id, ord)`,
      `CREATE INDEX IF NOT EXISTS idx_v3_pages_version   ON ${ref("v3_pages")} (version_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mi_tmpl            ON ${ref("v3_master_input")} (template_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mi_version         ON ${ref("v3_master_input")} (version_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mi_group           ON ${ref("v3_master_input")} (group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mig_tmpl           ON ${ref("v3_master_input_group")} (template_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mig_version        ON ${ref("v3_master_input_group")} (version_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inst_tmpl           ON ${ref("v3_instances")} (template_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inst_user           ON ${ref("v3_instances")} (user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inst_mi_inst        ON ${ref("v3_instance_master_input")} (instance_id)`,
      `CREATE INDEX IF NOT EXISTS idx_inst_mi_tmpl_mi     ON ${ref("v3_instance_master_input")} (template_mi_id)`,
      `CREATE INDEX IF NOT EXISTS idx_v3_vdiff_ver       ON ${ref("v3_version_diffs")} (version_id)`,
      // Resolution path is by (instance_id, template_mi_key) — index it.
      `CREATE INDEX IF NOT EXISTS idx_inst_mi_inst_key ON ${ref("v3_instance_master_input")} (instance_id, template_mi_key)`,
    ];
    for (const s of idx) await sql.unsafe(s);

    // 2d-bis. Backfill template_mi_key on any pre-existing override rows by
    // joining to v3_master_input through the legacy template_mi_id FK. Drop
    // the ON DELETE CASCADE so MI deletion no longer evicts overrides —
    // future re-creation of the MI under the same key keeps the value.
    await sql.unsafe(`
      UPDATE ${ref("v3_instance_master_input")} imi
         SET template_mi_key = tmi.key
        FROM ${ref("v3_master_input")} tmi
       WHERE imi.template_mi_id = tmi.id
         AND (imi.template_mi_key IS NULL OR imi.template_mi_key = '')
    `);
    await sql.unsafe(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'v3_instance_master_input_template_mi_fk'
        ) THEN
          ALTER TABLE ${ref("v3_instance_master_input")}
            DROP CONSTRAINT v3_instance_master_input_template_mi_fk;
        END IF;
      END $$`);
    // Add UNIQUE (instance_id, template_mi_key) so the upsert below can
    // ON CONFLICT cleanly. The old (instance_id, template_mi_id) UNIQUE
    // stays in place as a secondary guard.
    await sql.unsafe(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'v3_instance_master_input_inst_key_unique'
        ) THEN
          ALTER TABLE ${ref("v3_instance_master_input")}
            ADD CONSTRAINT v3_instance_master_input_inst_key_unique
            UNIQUE (instance_id, template_mi_key);
        END IF;
      END $$`);

    // 2e. Switch unique constraint from (template_id, ord) → (template_id, version_id, ord).
    await sql.unsafe(
      `ALTER TABLE ${ref("v3_pages")} DROP CONSTRAINT IF EXISTS v3_pages_template_ord_unique`,
    );
    await sql.unsafe(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'v3_pages_tmpl_ver_ord_unique'
        ) THEN
          ALTER TABLE ${ref("v3_pages")}
            ADD CONSTRAINT v3_pages_tmpl_ver_ord_unique UNIQUE (template_id, version_id, ord);
        END IF;
      END $$`);

    // ── 3. Seed a default "v1" version for every template that doesn't have one ──
    // Picks up: legacy-migrated rows, fresh templates without a version, anything
    // whose pages / master inputs still have NULL version_id.
    const orphans = await sql.unsafe(`
      SELECT id FROM ${ref("v3_templates")} WHERE published_version_id IS NULL
    `);
    let seeded = 0;
    for (const t of orphans) {
      const versionId = newObjectId();
      await sql.unsafe(
        `INSERT INTO ${ref("v3_versions")} (id, template_id, label) VALUES ($1, $2, $3)`,
        [versionId, t.id, "v1"],
      );
      await sql.unsafe(
        `UPDATE ${ref("v3_pages")} SET version_id = $1 WHERE template_id = $2 AND version_id IS NULL`,
        [versionId, t.id],
      );
      await sql.unsafe(
        `UPDATE ${ref("v3_master_input")} SET version_id = $1 WHERE template_id = $2 AND version_id IS NULL`,
        [versionId, t.id],
      );
      await sql.unsafe(
        `UPDATE ${ref("v3_master_input_group")} SET version_id = $1 WHERE template_id = $2 AND version_id IS NULL`,
        [versionId, t.id],
      );
      await sql.unsafe(
        `UPDATE ${ref("v3_templates")} SET published_version_id = $1 WHERE id = $2`,
        [versionId, t.id],
      );
      seeded++;
    }

    console.log(
      `[ensureTables] v3 schema ready in '${SCHEMA}'.` +
        (seeded ? ` Seeded v1 for ${seeded} template(s).` : ""),
    );
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
