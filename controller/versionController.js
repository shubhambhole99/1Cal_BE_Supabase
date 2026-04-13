import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { versions } from "../schema/versions.js";
import { newObjectId } from "../utils/objectId.js";

function toVersionResponse(row) {
  if (!row) return null;
  return { ...row, _id: row.id };
}

export async function createVersion(req, res) {
  try {
    const body = {
      id: newObjectId(),
      pages: req.body.pages,
      masterinput: req.body.masterinput,
      masterinputfromother: req.body.masterinputfromother || [],
      importedInputSections: req.body.imported_input_sections || [],
      pagesfromother: req.body.pagesfromother || [],
      inputsections: req.body.inputsections,
      dashboards: req.body.dashboards || [],
      name: req.body.versionname,
      versionof: req.body.id,
    };
    const [version] = await db.insert(versions).values(body).returning();
    if (!version) return res.status(400).json({ message: "Error creating version" });
    res.status(201).json({ version: toVersionResponse(version) });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "Error creating version", error: error.message });
  }
}

export async function getVersion(req, res) {
  try {
    const { id } = req.params;
    const { currentVersionId } = req.query;

    if (!id || typeof id !== "string" || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({
        message: "Invalid template ID format",
        id,
        error: "Template ID must be a valid UUID",
      });
    }
    if (currentVersionId && !/^[0-9a-fA-F]{24}$/.test(currentVersionId)) {
      return res.status(400).json({
        message: "Invalid current version ID format",
        currentVersionId,
        error: "Current version ID must be a valid UUID",
      });
    }

    if (currentVersionId) {
      const [currentVersion] = await db
        .select()
        .from(versions)
        .where(and(eq(versions.versionof, id), eq(versions.id, currentVersionId)))
        .limit(1);

      const otherVersions = await db
        .select({
          id: versions.id,
          name: versions.name,
          subject: versions.subject,
          scheme: versions.scheme,
          rulebook: versions.rulebook,
          description: versions.description,
          templateId: versions.templateId,
          date: versions.date,
          createdAt: versions.createdAt,
          versionof: versions.versionof,
        })
        .from(versions)
        .where(and(eq(versions.versionof, id), ne(versions.id, currentVersionId)));

      const optimizedVersions = currentVersion ? [currentVersion, ...otherVersions] : otherVersions;
      const mapped = optimizedVersions.map(toVersionResponse);
      return res.status(200).json({ version: mapped });
    }

    const allVersions = await db.select().from(versions).where(eq(versions.versionof, id));
    res.status(200).json({ version: allVersions.map(toVersionResponse) });
  } catch (error) {
    console.error("Error retrieving versions:", error);
    if (error.name === "MongoNetworkError" || error.name === "MongoServerSelectionError") {
      return res.status(503).json({ message: "Database connection error", error: "Unable to connect to database. Please try again later." });
    }
    res.status(500).json({
      message: "Error retrieving versions",
      error: process.env.NODE_ENV === "development" ? error.message : "Internal server error",
    });
  }
}

export async function getAllVersions(req, res) {
  try {
    const allVersions = await db.select().from(versions);
    res.status(200).json({ versions: allVersions.map(toVersionResponse) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error retrieving all versions", error: error.message });
  }
}

export async function updateVersion(req, res) {
  try {
    const { id } = req.params;
    const body = {
      pages: req.body.pages,
      masterinput: req.body.masterinput,
      masterinputfromother: req.body.masterinputfromother || [],
      importedInputSections: req.body.imported_input_sections || [],
      pagesfromother: req.body.pagesfromother || [],
      inputsections: req.body.inputsections,
      dashboards: req.body.dashboards || [],
      name: req.body.versionname,
    };
    if (req.body.date != null && req.body.date !== "") {
      const date = new Date(req.body.date);
      if (!Number.isNaN(date.getTime())) {
        body.date = date;
      }
    }
    const [version] = await db.update(versions).set(body).where(eq(versions.id, id)).returning();
    if (!version) return res.status(404).json({ message: "Version not found" });
    res.status(200).json({ version: toVersionResponse(version) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error updating version", error: error.message });
  }
}
