import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { directFeasibilities } from "../schema/directFeasibilities.js";
import { templates } from "../schema/templates.js";

const router = express.Router();

router.get("/all", async (req, res) => {
  try {
    const list = await db
      .select({
        id: directFeasibilities.id,
        templateId: directFeasibilities.templateId,
        name: directFeasibilities.name,
        createdAt: directFeasibilities.createdAt,
        templateName: templates.name,
        templateScheme: templates.scheme,
        templateRulebook: templates.rulebook,
        templateDescription: templates.description,
      })
      .from(directFeasibilities)
      .leftJoin(templates, eq(directFeasibilities.templateId, templates.id));

    const result = list.map((row) => ({
      ...row,
      templateId: row.templateId ? { name: row.templateName, scheme: row.templateScheme, rulebook: row.templateRulebook, description: row.templateDescription } : null,
    }));
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ message: "Error getting templates", error: error.message });
  }
});

export default router;
