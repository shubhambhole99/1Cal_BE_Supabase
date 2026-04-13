import { eq, asc, inArray, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { templates } from "../schema/templates.js";
import { users } from "../schema/users.js";
import { versions } from "../schema/versions.js";
import { newObjectId } from "../utils/objectId.js";
import { normalizeTimestampFields } from "../utils/date.js";

function toTemplateResponse(row) {
  if (!row) return null;
  return { ...row, _id: row.id };
}

const TEMPLATE_TIMESTAMP_FIELDS = ["date", "createdAt"];

export async function createTemplate(req, res) {
  try {
    const body = { id: newObjectId(), ...req.body };
    normalizeTimestampFields(body, TEMPLATE_TIMESTAMP_FIELDS);
    const [created] = await db.insert(templates).values(body).returning();
    if (!created) return res.status(400).json({ message: "Error creating template" });
    res.status(201).json({ template: toTemplateResponse(created) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "Error creating template", error: error.message });
  }
}

export async function copyTemplate(req, res) {
  try {
    const ids = req.params.ids;
    const [original] = await db.select().from(templates).where(eq(templates.id, ids)).limit(1);
    if (!original) return res.status(404).json({ message: "Template not found" });

    const { id: _omit, ...rest } = original;
    const body = { id: newObjectId(), ...rest };
    normalizeTimestampFields(body, TEMPLATE_TIMESTAMP_FIELDS);
    const [clone] = await db.insert(templates).values(body).returning();
    if (!clone) return res.status(500).json({ message: "Error copying template" });
    res.status(201).json({ clone: toTemplateResponse(clone) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error copying template", error: error.message });
  }
}

export async function getAllTemplates(req, res) {
  try {
    const rows = await db
      .select({
        id: templates.id,
        name: templates.name,
        scheme: templates.scheme,
        description: templates.description,
        date: templates.date,
        order: templates.order,
        toPublish: templates.toPublish,
        isDisabled: templates.isDisabled,
        userid: templates.userid,
        userName: users.name,
        userEmail: users.email,
      })
      .from(templates)
      .leftJoin(users, eq(templates.userid, users.id))
      .orderBy(asc(templates.order));

    const result = rows.map((r) => ({
      _id: r.id,
      name: r.name,
      scheme: r.scheme,
      description: r.description,
      date: r.date,
      order: r.order,
      toPublish: r.toPublish,
      isDisabled: r.isDisabled,
      userid: r.userid
        ? { _id: r.userid, name: r.userName, email: r.userEmail }
        : r.userid,
    }));
    res.status(200).json({ templates: result });
  } catch (error) {
    console.error("[PUT /api/template] Error:", error);
    res.status(500).json({ message: "Error getting templates", error: error.message });
  }
}

export async function updateTemplateOrder(req, res) {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ message: "Orders must be an array" });
    for (const { id, order } of orders) {
      await db.update(templates).set({ order }).where(eq(templates.id, id));
    }
    res.status(200).json({ message: "Template order updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error updating template order", error: error.message });
  }
}

export async function getTemplateById(req, res) {
  try {
    const [template] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    if (!template) return res.status(404).json({ message: "Template not found" });

    let currentversion = template.currentversion;
    let publishid = template.publishid;

    // When currentversion is null, derive from latest version for this template (old API compatibility)
    if (!currentversion) {
      const [latest] = await db
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.versionof, template.id))
        .orderBy(desc(versions.date))
        .limit(1);
      if (latest) {
        currentversion = latest.id;
        publishid = publishid ?? latest.id;
      }
    }

    const response = toTemplateResponse(template);
    if (currentversion) response.currentversion = currentversion;
    if (publishid != null) response.publishid = publishid;

    res.status(200).json({ template: response });
  } catch (error) {
    console.error("[GET /api/template/:id] Error:", error);
    res.status(500).json({ message: "Error getting template", error: error.message });
  }
}

export async function updateTemplate(req, res) {
  try {
    const [existingTemplate] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    if (!existingTemplate) return res.status(404).json({ message: "Template not found" });

    const updateData = { ...req.body };
    const publishVersionId =
      typeof req.body.publishid === "string" && req.body.publishid.trim() !== ""
        ? req.body.publishid.trim()
        : null;

    if (publishVersionId) {
      if (!/^[0-9a-fA-F]{24}$/.test(publishVersionId)) {
        return res.status(400).json({ message: "Invalid publish version ID format" });
      }

      const [publishVersion] = await db
        .select({
          id: versions.id,
          versionof: versions.versionof,
          dashboards: versions.dashboards,
        })
        .from(versions)
        .where(eq(versions.id, publishVersionId))
        .limit(1);

      if (!publishVersion || publishVersion.versionof !== req.params.id) {
        return res.status(400).json({ message: "Publish version does not belong to this template" });
      }

      updateData.publishid = publishVersion.id;
      updateData.dashboards = publishVersion.dashboards || [];
    } else {
      if (typeof updateData.publishid === "string" && updateData.publishid.trim() === "") {
        delete updateData.publishid;
      }
      const isVersionedTemplate = Boolean(existingTemplate.currentversion || existingTemplate.publishid);
      if (isVersionedTemplate && Object.prototype.hasOwnProperty.call(updateData, "dashboards")) {
        delete updateData.dashboards;
      }
    }

    normalizeTimestampFields(updateData, TEMPLATE_TIMESTAMP_FIELDS);
    const [updated] = await db
      .update(templates)
      .set(updateData)
      .where(eq(templates.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Template not found" });
    res.status(200).json(toTemplateResponse(updated));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error updating template", error: error.message });
  }
}

export async function updatePageBlocks(req, res) {
  try {
    const [updated] = await db
      .update(templates)
      .set({ blocks: req.body.blocks, blogdetails: req.body.blogdetails })
      .where(eq(templates.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Template not found" });
    res.status(200).json({ template: "updated" });
  } catch (error) {
    res.status(500).json({ message: "Error updating page blocks", error: error.message });
  }
}

export async function updatePageContent(req, res) {
  try {
    const [updated] = await db
      .update(templates)
      .set({ linktohtml: req.body.linktohtml, blogdetails: req.body.blogdetails })
      .where(eq(templates.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Template not found" });
    res.status(200).json({ template: "updated" });
  } catch (error) {
    res.status(500).json({ message: "Error updating page blocks", error: error.message });
  }
}

export async function updateCurrentVersion(req, res) {
  try {
    const [updated] = await db
      .update(templates)
      .set({ currentversion: req.body.currentversion })
      .where(eq(templates.id, req.params.id))
      .returning();
    res.status(200).json({ template: updated ? toTemplateResponse(updated) : null });
  } catch (error) {
    res.status(500).json({ message: "Error updating template", error: error.message });
  }
}

export async function deleteTemplate(req, res) {
  try {
    const [template] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    if (!template) return res.status(404).json({ message: "Template not found" });
    await db.update(templates).set({ isDisabled: !template.isDisabled }).where(eq(templates.id, req.params.id));
    const [updated] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    res.status(200).json({ message: "Template status updated successfully", template: toTemplateResponse(updated) });
  } catch (error) {
    res.status(500).json({ message: "Error deleting template", error: error.message });
  }
}

export async function toggleTemplateStatus(req, res) {
  try {
    const [template] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    if (!template) return res.status(404).json({ message: "Template not found" });
    await db.update(templates).set({ toPublish: !template.toPublish }).where(eq(templates.id, req.params.id));
    const [updated] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    res.status(200).json({
      message: `Template publish status updated to ${updated.toPublish}`,
      toPublish: updated.toPublish,
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
}

export async function getAdminAccess(req, res) {
  try {
    const [template] = await db.select().from(templates).where(eq(templates.id, req.params.id)).limit(1);
    if (!template) return res.status(404).json({ message: "Template not found" });
    const adminIds = (template.adminusers || [])?.filter(Boolean) ?? [];
    const adminRows =
      adminIds.length > 0
        ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, adminIds))
        : [];
    const adminusers = adminRows.map((u) => ({ _id: u.id, name: u.name, email: u.email }));
    res.status(200).json({ adminusers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error getting admin access", error: error.message });
  }
}

export async function updateAdminAccess(req, res) {
  try {
    const { adminusers } = req.body;
    const [updated] = await db
      .update(templates)
      .set({ adminusers: adminusers || [] })
      .where(eq(templates.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Template not found" });
    const adminIds = (updated.adminusers || [])?.filter(Boolean) ?? [];
    const adminRows =
      adminIds.length > 0
        ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, adminIds))
        : [];
    const populatedAdminusers = adminRows.map((u) => ({ _id: u.id, name: u.name, email: u.email }));
    res.status(200).json({ message: "Admin access updated successfully", adminusers: populatedAdminusers });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error updating admin access", error: error.message });
  }
}
