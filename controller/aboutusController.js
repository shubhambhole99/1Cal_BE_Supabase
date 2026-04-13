import { eq, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { aboutUs } from "../schema/aboutUs.js";
import { newObjectId } from "../utils/objectId.js";
import { normalizeTimestampFields } from "../utils/date.js";
// hello
export async function createAboutUs(req, res) {
  try {
    const { name, brief, description, level } = req.body;
    const [saved] = await db
      .insert(aboutUs)
      .values({ id: newObjectId(), name, brief, description, level })
      .returning();
    if (!saved) return res.status(500).json({ message: "Error creating About Us entry" });
    res.status(201).json(saved);
  } catch (error) {
    res.status(500).json({ message: "Error creating About Us entry", error: error.message });
  }
}

export async function getAllAboutUs(req, res) {
  try {
    const entries = await db.select().from(aboutUs).orderBy(asc(aboutUs.level));
    res.status(200).json(entries);
  } catch (error) {
    res.status(500).json({ message: "Error fetching About Us entries", error: error.message });
  }
}

export async function getAboutUsById(req, res) {
  try {
    const [entry] = await db.select().from(aboutUs).where(eq(aboutUs.id, req.params.id)).limit(1);
    if (!entry) return res.status(404).json({ message: "Entry not found" });
    res.status(200).json(entry);
  } catch (error) {
    res.status(500).json({ message: "Error fetching entry", error: error.message });
  }
}

export async function updateAboutUs(req, res) {
  try {
    const data = { ...req.body };
    normalizeTimestampFields(data, ["createdAt"]);
    const [updated] = await db
      .update(aboutUs)
      .set(data)
      .where(eq(aboutUs.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Entry not found" });
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: "Error updating entry", error: error.message });
  }
}

export async function deleteAboutUs(req, res) {
  try {
    const [entry1] = await db.select().from(aboutUs).where(eq(aboutUs.id, req.params.id)).limit(1);
    if (!entry1) return res.status(404).json({ message: "Entry not found" });
    await db.update(aboutUs).set({ isDisabled: !entry1.isDisabled }).where(eq(aboutUs.id, req.params.id));
    res.status(200).json({ message: "Entry disabled status updated successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error updating entry", error: error.message });
  }
}

export async function updateProfilePhoto(req, res) {
  try {
    const [updated] = await db
      .update(aboutUs)
      .set({ photoUrl: req.body.url })
      .where(eq(aboutUs.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Entry not found" });
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: "Error updating entry", error: error.message });
  }
}
