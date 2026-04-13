import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { fileTemplates } from "../schema/fileTemplates.js";
import { newObjectId } from "../utils/objectId.js";

export async function createFileTemplate(req, res) {
  try {
    const existing = await db
      .select()
      .from(fileTemplates)
      .where(and(eq(fileTemplates.name, req.body.name), eq(fileTemplates.type, req.body.type)));
    if (existing.length > 0) {
      return res.status(400).json({ message: "File template already exists" });
    }
    const [fileTemplate] = await db
      .insert(fileTemplates)
      .values({
        id: newObjectId(),
        name: req.body.name,
        type: req.body.type,
        html: req.body.rawHtml,
        inputValues: req.body.inputValues,
      })
      .returning();
    res.status(201).json({ fileTemplate });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getAllFileTemplates(req, res) {
  try {
    const fileTemplatesList = await db.select().from(fileTemplates);
    res.status(200).json({ fileTemplates: fileTemplatesList });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
}

export async function getFileTemplateById(req, res) {
  try {
    const { id } = req.params;
    const [fileTemplate] = await db.select().from(fileTemplates).where(eq(fileTemplates.id, id)).limit(1);
    if (!fileTemplate) return res.status(404).json({ message: "File template not found" });
    res.status(200).json({ fileTemplate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateFileTemplate(req, res) {
  try {
    const { id } = req.params;
    const [updated] = await db
      .update(fileTemplates)
      .set({
        name: req.body.name,
        type: req.body.type,
        html: req.body.rawHtml,
        inputValues: req.body.inputValues,
      })
      .where(eq(fileTemplates.id, id))
      .returning();
    if (!updated) return res.status(404).json({ message: "File template not found" });
    res.status(200).json({ updatedFileTemplate: updated });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteFileTemplate(req, res) {
  try {
    const { id } = req.params;
    const [deleted] = await db.delete(fileTemplates).where(eq(fileTemplates.id, id)).returning();
    if (!deleted) return res.status(404).json({ message: "File template not found" });
    res.status(200).json({ message: "File template deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
