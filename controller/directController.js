import { Readable } from "stream";
import { eq, or, and, ne, ilike, desc, sql, gte, lte, asc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { directFeasibilities } from "../schema/directFeasibilities.js";
import { templates } from "../schema/templates.js";
import { stories as storiesTable } from "../schema/stories.js";
import { files as filesTable } from "../schema/files.js";
import { slides as slidesTable } from "../schema/slides.js";
import { users as usersTable } from "../schema/users.js";
import { uuidv7 } from "uuidv7";
import { newObjectId } from "../utils/objectId.js";

function userDisplayName(user) {
  if (!user) return undefined;
  const name = (user.name && user.name.trim()) || [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.phoneNumber || undefined;
}

function storyRowToApi(row, opts) {
  if (!row) return null;
  const createdByDisplay = opts && typeof opts === "object" ? opts.createdByDisplay : undefined;
  const lastEditedByDisplay = opts && typeof opts === "object" ? opts.lastEditedByDisplay : undefined;
  return {
    _id: row.id,
    title: row.title ?? undefined,
    storyText: row.storyText ?? "",
    date: row.date ? row.date.toISOString() : undefined,
    order: row.order,
    isDisabled: row.isDisabled ?? false,
    isHidden: row.isHidden ?? false,
    createdByUserId: row.createdByUserId ?? undefined,
    createdByDisplay: createdByDisplay ?? undefined,
    linkedFiles: row.linkedFiles ?? [],
    linkedTaskId: row.linkedTaskId ?? undefined,
    versions: row.versions ?? [],
    lastEditedAt: row.lastEditedAt ? row.lastEditedAt.toISOString() : undefined,
    lastEditedByUserId: row.lastEditedByUserId ?? undefined,
    lastEditedByDisplay: lastEditedByDisplay ?? undefined,
  };
}

function getUserIdFromReq(req) {
  return req.user?.userId || req.user?.id;
}

async function buildUserDisplayMapByIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const map = {};
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      phoneNumber: usersTable.phoneNumber,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  for (const u of rows) map[u.id] = userDisplayName(u);
  return map;
}

function fileRowToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    order: row.order,
    uploaddate: row.uploaddate ? row.uploaddate.toISOString() : undefined,
    filename: row.filename ?? undefined,
    current: row.current ?? undefined,
    prevlinks: row.prevlinks ?? [],
    isDisabled: row.isDisabled ?? false,
  };
}

function slideRowToApi(slideRow, fileRow) {
  if (!slideRow) return null;
  return {
    id: slideRow.id,
    _id: slideRow.id,
    directFeasibilityId: slideRow.directFeasibilityId,
    title: slideRow.title ?? "",
    layout: slideRow.layout ?? "image-text",
    backgroundColor: slideRow.backgroundColor ?? null,
    textBackgroundColor: slideRow.textBackgroundColor ?? null,
    fileId: slideRow.fileId ?? null,
    fileUrl: fileRow?.current ?? null,
    content: slideRow.content ?? null,
    slideOrder: slideRow.slideOrder ?? 0,
    createdAt: slideRow.createdAt ? slideRow.createdAt.toISOString() : undefined,
    updatedAt: slideRow.updatedAt ? slideRow.updatedAt.toISOString() : undefined,
  };
}

function toDirectResponse(row) {
  if (!row) return null;
  return {
    ...row,
    _id: row.id,
    CreatedAt: row.createdAt ?? null,
    LastModifiedAt: row.lastModifiedAt ?? null,
  };
}

/** Selected columns for direct + template join (used by getMyFeasibilities, getCollaborativeFeasibilities, getAllDirect). */
const directWithTemplateSelect = {
  id: directFeasibilities.id,
  templateId: directFeasibilities.templateId,
  name: directFeasibilities.name,
  pages: directFeasibilities.pages,
  masterinput: directFeasibilities.masterinput,
  createdAt: directFeasibilities.createdAt,
  lastModifiedAt: directFeasibilities.lastModifiedAt,
  inputsections: directFeasibilities.inputsections,
  newPages: directFeasibilities.newPages,
  newMasterinput: directFeasibilities.newMasterinput,
  newInputsections: directFeasibilities.newInputsections,
  userid: directFeasibilities.userid,
  collaborators: directFeasibilities.collaborators,
  isDisabled: directFeasibilities.isDisabled,
  fixedparameterset: directFeasibilities.fixedparameterset,
  showFilesAndStories: directFeasibilities.showFilesAndStories,
  showSlides: directFeasibilities.showSlides,
  chatBar1Enabled: directFeasibilities.chatBar1Enabled,
  chatBar2Enabled: directFeasibilities.chatBar2Enabled,
  templateName: templates.name,
  templateScheme: templates.scheme,
  templateRulebook: templates.rulebook,
  templateDescription: templates.description,
};

/**
 * Maps a joined row (direct + template) to the old API shape: _id, populated templateId,
 * CreatedAt, LastModifiedAt, and legacy new_pages, new_masterinput, new_inputsections.
 */
function toDirectResponseWithTemplate(row) {
  if (!row) return null;
  const {
    templateName,
    templateScheme,
    templateRulebook,
    templateDescription,
    ...direct
  } = row;
  const base = toDirectResponse(direct);
  base.templateId =
    row.templateId &&
    (templateName != null ||
      templateScheme != null ||
      templateRulebook != null ||
      templateDescription != null)
      ? {
          _id: row.templateId,
          name: templateName ?? null,
          scheme: templateScheme ?? null,
          rulebook: templateRulebook ?? null,
          description: templateDescription ?? null,
        }
      : row.templateId;
  base.templateName = templateName ?? null;
  base.TemplateName = templateName ?? null;
  base.CreatedAt = direct.createdAt ?? null;
  base.LastModifiedAt = direct.lastModifiedAt ?? null;
  base.new_pages = direct.newPages ?? {};
  base.new_masterinput = direct.newMasterinput ?? {};
  base.new_inputsections = direct.newInputsections ?? {};
  return base;
}

export async function cloneFullTemplate(req, res) {
  try {
    const { templateId, userid } = req.body;
    const [original] = await db.select().from(templates).where(eq(templates.id, templateId)).limit(1);
    if (!original) return res.status(404).json({ message: "Template not found" });

    const [clone] = await db
      .insert(directFeasibilities)
      .values({
        id: newObjectId(),
        templateId: original.id,
        masterinput: original.masterinput || [],
        name: original.name,
        userid: userid || null,
      })
      .returning();
    return res.status(201).json(toDirectResponse(clone));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function createCopy(req, res) {
  try {
    const { id } = req.params;
    const { userid } = req.body;
    const [original] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!original) return res.status(404).json({ message: "Formula template not found" });

    const [clone] = await db
      .insert(directFeasibilities)
      .values({
        id: newObjectId(),
        templateId: original.templateId,
        masterinput: original.masterinput || [],
        name: "Copy of " + (original.name || ""),
        userid: userid || null,
      })
      .returning();
    return res.status(201).json(toDirectResponse(clone));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function saveMasterInput(req, res) {
  try {
    const { masterinput, new_masterinput, new_pages, new_inputsections, userid, LastModifiedAt, fixedparameterset } = req.body;
    const { id } = req.params;

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) return res.status(404).json({ message: "Template not found." });

    const isOwner = existing.userid && String(existing.userid) === String(userid);
    const collaborators = (existing.collaborators || []);
    const isCollaborator = Array.isArray(collaborators) && collaborators.some((c) => String(c) === String(userid));

    if (!isOwner && !isCollaborator && existing.userid) {
      return res.status(403).json({ message: "You are not authorized to save." });
    }

    const updateData = {
      masterinput: masterinput ?? existing.masterinput,
      userid: existing.userid || userid,
      lastModifiedAt: LastModifiedAt ? new Date(LastModifiedAt) : new Date(),
    };
    if (new_pages !== undefined) updateData.newPages = new_pages;
    if (new_masterinput !== undefined) updateData.newMasterinput = new_masterinput;
    if (new_inputsections !== undefined) updateData.newInputsections = new_inputsections;
    if (fixedparameterset !== undefined) updateData.fixedparameterset = fixedparameterset;

    const [updated] = await db.update(directFeasibilities).set(updateData).where(eq(directFeasibilities.id, id)).returning();
    return res.status(200).json(toDirectResponse(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function getFormulaTemplateById(req, res) {
  try {
    const { id } = req.params;

    const [directTemplate] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!directTemplate) {
      console.error("[direct] GET /direct/:id – Formula template not found, id:", id);
      return res.status(404).json({ message: "Formula template not found" });
    }

    const [originalTemplate] = await db.select().from(templates).where(eq(templates.id, directTemplate.templateId)).limit(1);
    if (!originalTemplate) return res.status(404).json({ message: "Original template not found" });

    const templateCache = {};
    const origPages = originalTemplate.pages || [];
    const directPages = directTemplate.pages || [];

    const mergedPages = origPages.map((page, pageIndex) => {
      const originalPage = origPages[pageIndex] || {};
      const directPage = directPages[pageIndex] || page;
      const pageRows = directPage.rows || page.rows || [];
      const origPageRows = originalPage.rows || [];

      const mergedRows = pageRows.map((row, rowIndex) => {
        const originalRow = origPageRows[rowIndex] || {};
        const rowContent = row.content || [];
        const origContent = originalRow.content || [];

        const mergedContent = rowContent.map((cell, cellIndex) => {
          if (!Array.isArray(cell)) return [];
          const originalCell = origContent[cellIndex];
          const value = Array.isArray(originalCell) ? originalCell[0] : undefined;
          const formula = Array.isArray(originalCell) ? originalCell[1] : undefined;
          const style = Array.isArray(originalCell) ? originalCell[2] : undefined;
          const result = [];
          if (value !== undefined) result[0] = value;
          if (formula !== undefined) result[1] = formula;
          if (style !== undefined) result[2] = style;
          return result;
        });

        return { ...row, content: mergedContent };
      });

      return {
        ...page,
        name: originalPage.name || "default",
        order: page.order !== undefined ? page.order : 0,
        rows: mergedRows,
      };
    });

    const pagesfromother = (originalTemplate.pagesfromother || []).slice().sort((a, b) => {
      const orderA = typeof a?.importedPageOrder === "number" ? a.importedPageOrder : typeof a?.order === "number" ? a.order : Infinity;
      const orderB = typeof b?.importedPageOrder === "number" ? b.importedPageOrder : typeof b?.order === "number" ? b.order : Infinity;
      return orderA - orderB;
    });

    for (const importRef of pagesfromother) {
      if (!importRef?.isActive) continue;
      try {
        if (!templateCache[importRef.sourceTemplateId]) {
          const [st] = await db.select().from(templates).where(eq(templates.id, importRef.sourceTemplateId)).limit(1);
          if (!st) continue;
          templateCache[importRef.sourceTemplateId] = st;
        }
        const sourceTemplate = templateCache[importRef.sourceTemplateId];
        const sourcePages = sourceTemplate.pages || [];
        const sourcePage = sourcePages.find((p) => p.id === importRef.sourcePageId);
        if (!sourcePage) continue;

        const importedPageId = importRef.importedPageId || sourcePage.id;
        const importedPageOrder = importRef.importedPageOrder ?? sourcePage.order;
        const matchedPage = (directTemplate.pages || []).find((p) => p.id === importedPageId);
        const sourceRows = sourcePage.rows || [];

        const importedMergedRows = sourceRows.map((row, rowIndex) => {
          const matchedRow = matchedPage?.rows?.[rowIndex] || {};
          const rowContent = row.content || [];
          const mergedContent = rowContent.map((cell, cellIndex) => {
            if (!Array.isArray(cell)) return [];
            const matchedCell = (matchedRow.content || [])[cellIndex];
            const value = Array.isArray(matchedCell) ? matchedCell[0] : undefined;
            const formula = Array.isArray(matchedCell) ? matchedCell[1] : undefined;
            const style = Array.isArray(matchedCell) ? matchedCell[2] : undefined;
            const origCell = rowContent[cellIndex];
            const origValue = Array.isArray(origCell) ? origCell[0] : undefined;
            const origFormula = Array.isArray(origCell) ? origCell[1] : undefined;
            const origStyle = Array.isArray(origCell) ? origCell[2] : undefined;
            const result = [];
            result[0] = value !== undefined ? value : origValue;
            result[1] = formula !== undefined ? formula : origFormula;
            result[2] = style !== undefined ? style : origStyle;
            return result;
          });
          return { ...row, content: mergedContent };
        });

        mergedPages.push({
          ...sourcePage,
          id: importedPageId,
          order: importedPageOrder,
          name: matchedPage?.name || sourcePage.name || "default",
          rows: importedMergedRows,
        });
      } catch (e) {
        console.error("Error fetching imported page:", e);
      }
    }

    const directMasterinput = directTemplate.masterinput || [];
    const origMasterinput = originalTemplate.masterinput || [];
    const mergedMasterInput = origMasterinput.map((origRow) => {
      const matched = directMasterinput.find((r) => r.name === origRow.name);
      return {
        ...origRow,
        value: matched?.value != null && matched?.value !== "" ? matched.value : origRow.value,
        displayName: matched?.displayName ?? origRow.displayName,
        templateValue: origRow.value,
      };
    });

    const masterinputfromother = (originalTemplate.masterinputfromother || []).slice().sort((a, b) => {
      const orderA = typeof a?.order === "number" ? a.order : Infinity;
      const orderB = typeof b?.order === "number" ? b.order : Infinity;
      return orderA - orderB;
    });

    for (const importRef of masterinputfromother) {
      if (!importRef?.isActive) continue;
      try {
        if (!templateCache[importRef.sourceTemplateId]) {
          const [st] = await db.select().from(templates).where(eq(templates.id, importRef.sourceTemplateId)).limit(1);
          if (!st) continue;
          templateCache[importRef.sourceTemplateId] = st;
        }
        const sourceTemplate = templateCache[importRef.sourceTemplateId];
        const sourceInputs = sourceTemplate.masterinput || [];
        const individualInput = sourceInputs.find((mi) => mi.id === importRef.sourceMasterInputId);
        const importedInputs = individualInput ? [individualInput] : [];
        for (const importedRow of importedInputs) {
          const matched = directMasterinput.find((r) => r.name === importedRow.name);
          const val =
            matched?.value != null && matched?.value !== ""
              ? matched.value
              : importRef.importedMasterInputs?.[0]?.overrideValue!= null && importRef.importedMasterInputs[0].overrideValue !== ""
                ? importRef.importedMasterInputs[0].overrideValue
                : importedRow.value;
          const templateValue = importRef.importedMasterInputs?.[0]?.overrideValue!= null && importRef.importedMasterInputs[0].overrideValue !== ""
          ? importRef.importedMasterInputs[0].overrideValue
          : importedRow.value;
          const displayName = importRef.importedMasterInputs?.[0]?.overrideDisplayValue != null && importRef.importedMasterInputs[0].overrideDisplayValue !== ""
            ? importRef.importedMasterInputs[0].overrideDisplayValue
            : importedRow.displayName;
         
          mergedMasterInput.push({
            ...importedRow,
            value: val,
            displayName,
            hidden: importedRow.hidden || importRef.importedMasterInputs?.[0]?.hidden,
            templateValue: templateValue 
          });
        }
      } catch (e) {
        console.error("Error fetching imported masterinput:", e);
      }
    }

    const sortedMergedPages = mergedPages.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    const sortedMergedMasterInput = mergedMasterInput.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));

    const [storiesRows, filesRows, slidesRows] = await Promise.all([
      db
        .select()
        .from(storiesTable)
        .where(eq(storiesTable.directFeasibilityId, id))
        .orderBy(asc(storiesTable.order), desc(storiesTable.date)),
      db
        .select()
        .from(filesTable)
        .where(eq(filesTable.directFeasibilityId, id))
        .orderBy(asc(filesTable.order), desc(filesTable.uploaddate)),
      db
        .select()
        .from(slidesTable)
        .where(eq(slidesTable.directFeasibilityId, id))
        .orderBy(asc(slidesTable.slideOrder)),
    ]);

    const userDisplayMap = await buildUserDisplayMapByIds([
      ...storiesRows.map((r) => r.createdByUserId),
      ...storiesRows.map((r) => r.lastEditedByUserId),
    ]);

    const fileMapById = Object.fromEntries((filesRows || []).map((f) => [f.id, f]));

    const result = {
      ...directTemplate,
      id: directTemplate.id,
      _id: directTemplate.id,
      pages: sortedMergedPages,
      masterinput: sortedMergedMasterInput,
      pagesfromother: originalTemplate.pagesfromother || [],
      inputsections: originalTemplate.inputsections || [],
      CreatedAt: directTemplate.createdAt ?? null,
      LastModifiedAt: directTemplate.lastModifiedAt ?? null,
      stories: storiesRows.map((r) =>
        storyRowToApi(r, {
          createdByDisplay: userDisplayMap[r.createdByUserId],
          lastEditedByDisplay: userDisplayMap[r.lastEditedByUserId],
        })
      ),
      files: filesRows.map(fileRowToApi),
      slides: (slidesRows || []).map((s) => slideRowToApi(s, fileMapById[s.fileId] || null)),
    };

    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/** GET /direct/stories/:id - return stories (and files) for a direct feasibility. Must be registered before GET /:id. */
export async function getStoriesByDirectId(req, res) {
  try {
    const { id } = req.params;
    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      console.error("[direct] GET /direct/stories/:id – Direct feasibility not found, id:", id);
      return res.status(404).json({ message: "Direct feasibility not found" });
    }

    const [storiesRows, filesRows] = await Promise.all([
      db
        .select()
        .from(storiesTable)
        .where(eq(storiesTable.directFeasibilityId, id))
        .orderBy(asc(storiesTable.order), desc(storiesTable.date)),
      db
        .select()
        .from(filesTable)
        .where(eq(filesTable.directFeasibilityId, id))
        .orderBy(asc(filesTable.order), desc(filesTable.uploaddate)),
    ]);

    const userDisplayMap = await buildUserDisplayMapByIds([
      ...storiesRows.map((r) => r.createdByUserId),
      ...storiesRows.map((r) => r.lastEditedByUserId),
    ]);

    return res.status(200).json({
      stories: storiesRows.map((r) =>
        storyRowToApi(r, {
          createdByDisplay: userDisplayMap[r.createdByUserId],
          lastEditedByDisplay: userDisplayMap[r.lastEditedByUserId],
        })
      ),
      files: filesRows.map(fileRowToApi),
    });
  } catch (error) {
    console.error("getStoriesByDirectId error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

function buildDirectFilters(query, userId, startDateStr, endDateStr) {
  const conditions = [];
  if (userId && userId !== "all") {
    conditions.push(
      or(
        eq(directFeasibilities.userid, userId),
        sql`${directFeasibilities.collaborators} @> ${JSON.stringify([userId])}::jsonb`
      )
    );
  }
  if (query) {
    conditions.push(ilike(directFeasibilities.name, `%${query}%`));
  }
  if (startDateStr || endDateStr) {
    const startDate = startDateStr ? new Date(startDateStr) : null;
    const endDate = endDateStr ? new Date(endDateStr) : null;
    const validStart = startDate && !isNaN(startDate.getTime());
    const validEnd = endDate && !isNaN(endDate.getTime());
    if (validStart || validEnd) {
      const modRange = [];
      const createdRange = [];
      if (validStart) {
        modRange.push(gte(directFeasibilities.lastModifiedAt, startDate));
        createdRange.push(gte(directFeasibilities.createdAt, startDate));
      }
      if (validEnd) {
        modRange.push(lte(directFeasibilities.lastModifiedAt, endDate));
        createdRange.push(lte(directFeasibilities.createdAt, endDate));
      }
      conditions.push(or(and(...modRange), and(...createdRange)));
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function getAllDirect(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const userId = req.query.userid;
    const searchQuery = req.query.query || "";
    const startDateStr = req.query.startDate;
    const endDateStr = req.query.endDate;

    const filter = buildDirectFilters(searchQuery, userId, startDateStr, endDateStr);

    const baseQuery = db
      .select(directWithTemplateSelect)
      .from(directFeasibilities)
      .leftJoin(templates, eq(directFeasibilities.templateId, templates.id));
    const dataQuery = filter ? baseQuery.where(filter) : baseQuery;
    const list = await dataQuery
      .orderBy(desc(directFeasibilities.lastModifiedAt), desc(directFeasibilities.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const countQuery = filter
      ? db.select({ count: sql`count(*)::int` }).from(directFeasibilities).where(filter)
      : db.select({ count: sql`count(*)::int` }).from(directFeasibilities);
    const [{ count: totalTemplates }] = await countQuery;

    const data = list.map(toDirectResponseWithTemplate);
    return res.status(200).json({
      data,
      currentPage: page,
      totalPages: Math.ceil((totalTemplates || 0) / limit),
      totalItems: totalTemplates || 0,
    });
  } catch (error) {
    console.error("Error fetching templates:", error);
    return res.status(500).json({ message: "Error getting templates", error: error.message });
  }
}

export async function getAnalytics(req, res) {
  try {
    const userId = req.query.userid;
    const searchQuery = (req.query.query || "").trim();
    const startDateStr = req.query.startDate;
    const endDateStr = req.query.endDate;

    let filter = undefined;
    if (userId && userId !== "all") {
      filter = or(
        eq(directFeasibilities.userid, userId),
        sql`${directFeasibilities.collaborators} @> ${JSON.stringify([userId])}::jsonb`
      );
    }
    if (searchQuery) {
      const searchCond = or(
        ilike(directFeasibilities.name, `%${searchQuery}%`),
        sql`${directFeasibilities.name} ILIKE ${"%" + searchQuery + "%"}`
      );
      filter = filter ? and(filter, searchCond) : searchCond;
    }
    if (startDateStr || endDateStr) {
      const startDate = startDateStr ? new Date(startDateStr) : null;
      const endDate = endDateStr ? new Date(endDateStr) : null;
      const rangeCond = or(
        and(
          startDate && !isNaN(startDate.getTime()) ? gte(directFeasibilities.lastModifiedAt, startDate) : undefined,
          endDate && !isNaN(endDate.getTime()) ? lte(directFeasibilities.lastModifiedAt, endDate) : undefined
        ),
        and(
          startDate && !isNaN(startDate.getTime()) ? gte(directFeasibilities.createdAt, startDate) : undefined,
          endDate && !isNaN(endDate.getTime()) ? lte(directFeasibilities.createdAt, endDate) : undefined
        )
      );
      filter = filter ? and(filter, rangeCond) : rangeCond;
    }

    const allRows = filter ? await db.select().from(directFeasibilities).where(filter) : await db.select().from(directFeasibilities);
    const totalItems = allRows.length;
    const usersSet = new Set(allRows.map((r) => r.userid).filter(Boolean));
    const templatesSet = new Set(allRows.map((r) => r.templateId).filter(Boolean));
    const latestUpdate = allRows.reduce((acc, r) => {
      const d = r.lastModifiedAt || r.createdAt;
      return !acc || (d && d > acc) ? d : acc;
    }, null);

    const summary = {
      totalItems,
      uniqueUsers: usersSet.size,
      uniqueTemplates: templatesSet.size,
      latestUpdate,
    };

    const byUser = {};
    allRows.forEach((r) => {
      if (r.userid) byUser[r.userid] = (byUser[r.userid] || 0) + 1;
    });
    const topUsers = Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([userid, count]) => ({ userid, count }));

    const byTemplate = {};
    allRows.forEach((r) => {
      if (r.templateId) byTemplate[r.templateId] = (byTemplate[r.templateId] || 0) + 1;
    });
    const topTemplates = await Promise.all(
      Object.entries(byTemplate)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(async ([templateId, count]) => {
          const [t] = await db.select({ name: templates.name }).from(templates).where(eq(templates.id, templateId)).limit(1);
          return { templateId, templateName: t?.name ?? null, count };
        })
    );

    res.json({ summary, topUsers, topTemplates });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
}

export async function getMyFeasibilities(req, res) {
  try {
    const userId = req.query.userid;
    if (!userId) return res.status(400).json({ message: "Missing userId in query params" });

    const searchQuery = req.query.query || "";
    const page = parseInt(req.query.myPage) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const conditions = [eq(directFeasibilities.userid, userId)];
    if (searchQuery) conditions.push(ilike(directFeasibilities.name, `%${searchQuery}%`));
    const filter = and(...conditions);

    const [countResult] = await db.select({ count: sql`count(*)::int` }).from(directFeasibilities).where(filter);
    const totalTemplates = Number(countResult?.count ?? 0);

    const list = await db
      .select(directWithTemplateSelect)
      .from(directFeasibilities)
      .leftJoin(templates, eq(directFeasibilities.templateId, templates.id))
      .where(filter)
      .orderBy(desc(directFeasibilities.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return res.status(200).json({
      data: list.map(toDirectResponseWithTemplate),
      currentPage: page,
      totalPages: Math.ceil(totalTemplates / limit),
      totalItems: totalTemplates,
    });
  } catch (error) {
    console.error("Error fetching my feasibilities:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

export async function getCollaborativeFeasibilities(req, res) {
  try {
    const userId = req.query.userid;
    if (!userId) return res.status(400).json({ message: "Missing userId in query params" });

    const searchQuery = req.query.query || "";
    const page = parseInt(req.query.myPage) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const filter = and(
      sql`${directFeasibilities.collaborators} @> ${JSON.stringify([userId])}::jsonb`,
      ne(directFeasibilities.userid, userId)
    );
    const conditions = [filter];
    if (searchQuery) conditions.push(ilike(directFeasibilities.name, `%${searchQuery}%`));
    const fullFilter = and(...conditions);

    const [countResult] = await db.select({ count: sql`count(*)::int` }).from(directFeasibilities).where(fullFilter);
    const totalTemplates = Number(countResult?.count ?? 0);

    const list = await db
      .select(directWithTemplateSelect)
      .from(directFeasibilities)
      .leftJoin(templates, eq(directFeasibilities.templateId, templates.id))
      .where(fullFilter)
      .orderBy(desc(directFeasibilities.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return res.status(200).json({
      data: list.map(toDirectResponseWithTemplate),
      currentPage: page,
      totalPages: Math.ceil(totalTemplates / limit),
      totalItems: totalTemplates,
    });
  } catch (error) {
    console.error("Error fetching collaborative feasibilities:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

export async function addCollaborator(req, res) {
  try {
    const { id } = req.params;
    const { collab, userid } = req.body;

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) return res.status(404).json({ message: "Template not found." });

    const isOwner = existing.userid && String(existing.userid) === String(userid);
    const collaborators = existing.collaborators || [];
    const isCollaborator = Array.isArray(collaborators) && collaborators.some((c) => String(c) === String(userid));

    if (!isOwner && !isCollaborator && existing.userid) {
      return res.status(403).json({ message: "You are not authorized to add collaborators." });
    }

    await db.update(directFeasibilities).set({ collaborators: Array.isArray(collab) ? collab : [] }).where(eq(directFeasibilities.id, id));
    return res.status(200).json({ message: "Collaborators updated successfully." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Internal server error." });
  }
}

export async function updatename(req, res) {
  try {
    const { id } = req.params;
    const { name, userid } = req.body;

    if (!name || String(name).trim() === "") return res.status(400).json({ message: "Name cannot be empty" });

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) return res.status(404).json({ message: "Feasibility not found." });

    const isOwner = existing.userid && String(existing.userid) === String(userid);
    const collaborators = existing.collaborators || [];
    const isCollaborator = Array.isArray(collaborators) && collaborators.some((c) => String(c) === String(userid));

    if (!isOwner && !isCollaborator && existing.userid) {
      return res.status(403).json({ message: "You are not authorized to update this feasibility." });
    }

    const [updated] = await db
      .update(directFeasibilities)
      .set({ name: String(name).trim() })
      .where(eq(directFeasibilities.id, id))
      .returning();
    return res.status(200).json({ success: true, message: "Feasibility name updated successfully", data: toDirectResponse(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

/** PUT /direct/update-show-files-stories/:id - set showFilesAndStories. Admin only. */
export async function updateShowFilesAndStories(req, res) {
  try {
    const { id } = req.params;
    const showFilesAndStories = Boolean(req.body?.showFilesAndStories);

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Formula template not found" });
    }

    const [updated] = await db
      .update(directFeasibilities)
      .set({ showFilesAndStories })
      .where(eq(directFeasibilities.id, id))
      .returning();
    return res.status(200).json({ success: true, data: toDirectResponse(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

/** PUT /direct/update-show-slides/:id - set showSlides. Admin only. */
export async function updateShowSlides(req, res) {
  try {
    const { id } = req.params;
    const showSlides = Boolean(req.body?.showSlides);

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Formula template not found" });
    }

    const [updated] = await db
      .update(directFeasibilities)
      .set({ showSlides })
      .where(eq(directFeasibilities.id, id))
      .returning();
    return res.status(200).json({ success: true, data: toDirectResponse(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

/** PUT /direct/update-chat-bar-1/:id - set chatBar1Enabled. Admin only. */
export async function updateChatBar1(req, res) {
  try {
    const { id } = req.params;
    const chatBar1Enabled = Boolean(req.body?.chatBar1Enabled);

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Formula template not found" });
    }

    const [updated] = await db
      .update(directFeasibilities)
      .set({ chatBar1Enabled })
      .where(eq(directFeasibilities.id, id))
      .returning();
    return res.status(200).json({ success: true, data: toDirectResponse(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

/** PUT /direct/update-chat-bar-2/:id - set chatBar2Enabled. Admin only. */
export async function updateChatBar2(req, res) {
  try {
    const { id } = req.params;
    const chatBar2Enabled = Boolean(req.body?.chatBar2Enabled);

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Formula template not found" });
    }

    const [updated] = await db
      .update(directFeasibilities)
      .set({ chatBar2Enabled })
      .where(eq(directFeasibilities.id, id))
      .returning();
    return res.status(200).json({ success: true, data: toDirectResponse(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
}

export async function getDatewiseGrowthAnalytics(req, res) {
  try {
    const userId = req.query.userid;
    const range = (req.query.range || "30d").toLowerCase();
    const now = new Date();
    const start = new Date(now);
    if (range === "30d") start.setDate(start.getDate() - 30);
    else if (range === "2m") start.setMonth(start.getMonth() - 2);
    else if (range === "3m") start.setMonth(start.getMonth() - 3);
    else if (range === "6m") start.setMonth(start.getMonth() - 6);
    else if (range === "1y") start.setFullYear(start.getFullYear() - 1);
    else start.setDate(start.getDate() - 30);

    let filter = undefined;
    if (userId && userId !== "all") {
      filter = or(
        eq(directFeasibilities.userid, userId),
        sql`${directFeasibilities.collaborators} @> ${JSON.stringify([userId])}::jsonb`
      );
    }

    const allRows = filter ? await db.select().from(directFeasibilities).where(filter) : await db.select().from(directFeasibilities);

    const createdCounts = [];
    const modifiedCounts = [];
    const createdByDay = {};
    const modifiedByDay = {};

    allRows.forEach((r) => {
      const created = r.createdAt ? new Date(r.createdAt) : null;
      if (created && created >= start) {
        const key = created.toISOString().slice(0, 10);
        createdByDay[key] = (createdByDay[key] || 0) + 1;
      }
      const modified = r.lastModifiedAt ? new Date(r.lastModifiedAt) : null;
      if (modified && modified >= start) {
        const key = modified.toISOString().slice(0, 10);
        modifiedByDay[key] = (modifiedByDay[key] || 0) + 1;
      }
    });

    Object.entries(createdByDay)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([k, v]) => createdCounts.push({ _id: k, count: v }));
    Object.entries(modifiedByDay)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([k, v]) => modifiedCounts.push({ _id: k, count: v }));

    return res.status(200).json({
      range,
      startDate: start,
      endDate: now,
      createdCounts,
      modifiedCounts,
    });
  } catch (error) {
    console.error("Error computing datewise growth:", error);
    return res.status(500).json({ message: "Error computing datewise growth", error: error.message });
  }
}

export async function addStory(req, res) {
  try {
    const { id } = req.params;
    const { title, storyText, linkedFiles } = req.body;
    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      console.error("[direct] POST /direct/stories/:id – Direct feasibility not found, id:", id);
      return res.status(404).json({ message: "Direct feasibility not found" });
    }

    const currentUserId = getUserIdFromReq(req);

    const storyId = uuidv7();
    const now = new Date();
    const [inserted] = await db
      .insert(storiesTable)
      .values({
        id: storyId,
        directFeasibilityId: id,
        title: title ?? null,
        storyText: storyText ?? "",
        date: now,
        order: 0,
        isDisabled: false,
        isHidden: false,
        linkedFiles: Array.isArray(linkedFiles) ? linkedFiles : [],
        versions: [],
        createdByUserId: currentUserId ?? null,
        lastEditedAt: now,
        lastEditedByUserId: currentUserId ?? null,
      })
      .returning();

    const userDisplayMap = await buildUserDisplayMapByIds([inserted.createdByUserId, inserted.lastEditedByUserId]);
    return res.status(201).json({
      story: storyRowToApi(inserted, {
        createdByDisplay: userDisplayMap[inserted.createdByUserId],
        lastEditedByDisplay: userDisplayMap[inserted.lastEditedByUserId],
      }),
    });
  } catch (error) {
    console.error("addStory error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateStory(req, res) {
  try {
    const { id, storyId } = req.params;
    const body = req.body;

    const [existing] = await db
      .select()
      .from(storiesTable)
      .where(and(eq(storiesTable.id, storyId), eq(storiesTable.directFeasibilityId, id)))
      .limit(1);
    if (!existing) {
      console.error("[direct] PUT /direct/updatestories/:id/:storyId – Story not found, id:", id, "storyId:", storyId);
      return res.status(404).json({ message: "Story not found" });
    }

    const updateData = {};
    if (body.title !== undefined) updateData.title = body.title;
    if (body.storyText !== undefined) updateData.storyText = body.storyText;
    if (body.date !== undefined) updateData.date = body.date ? new Date(body.date) : null;
    if (body.order !== undefined) updateData.order = body.order;
    if (body.isDisabled !== undefined) updateData.isDisabled = !!body.isDisabled;
    if (body.isHidden !== undefined) updateData.isHidden = !!body.isHidden;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.linkedTaskId !== undefined) updateData.linkedTaskId = body.linkedTaskId;
    if (body.linkedFiles !== undefined) updateData.linkedFiles = Array.isArray(body.linkedFiles) ? body.linkedFiles : [];
    if (body.versions !== undefined) updateData.versions = Array.isArray(body.versions) ? body.versions : [];
    updateData.lastEditedAt = new Date();
    updateData.lastEditedByUserId = getUserIdFromReq(req) ?? null;

    const [updated] = await db
      .update(storiesTable)
      .set(updateData)
      .where(and(eq(storiesTable.id, storyId), eq(storiesTable.directFeasibilityId, id)))
      .returning();

    const userDisplayMap = await buildUserDisplayMapByIds([updated.createdByUserId, updated.lastEditedByUserId]);
    return res.status(200).json(
      storyRowToApi(updated, {
        createdByDisplay: userDisplayMap[updated.createdByUserId],
        lastEditedByDisplay: userDisplayMap[updated.lastEditedByUserId],
      })
    );
  } catch (error) {
    console.error("updateStory error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function addCustomLink(req, res) {
  try {
    const { id } = req.params;
    const { link, filename, date } = req.body;
    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Direct feasibility not found" });
    }
    const uploadDate = date ? new Date(date) : new Date();
    const [orderRow] = await db
      .select({ nextOrder: sql`coalesce(max(${filesTable.order}), -1) + 1` })
      .from(filesTable)
      .where(eq(filesTable.directFeasibilityId, id));
    const nextOrder = Number(orderRow?.nextOrder ?? 0);
    const fileId = uuidv7();
    const [row] = await db
      .insert(filesTable)
      .values({
        id: fileId,
        directFeasibilityId: id,
        order: nextOrder,
        uploaddate: uploadDate,
        filename: filename ?? null,
        current: link ?? null,
        prevlinks: [],
        isDisabled: false,
      })
      .returning();
    return res.status(201).json(fileRowToApi(row));
  } catch (error) {
    console.error("addCustomLink error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function addFiles(req, res) {
  try {
    const { id } = req.params;
    const { filesfrom, date } = req.body;
    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      console.error("[direct] PUT /direct/addfiles/:id – Direct feasibility not found, id:", id);
      return res.status(404).json({ message: "Direct feasibility not found" });
    }

    const list = Array.isArray(filesfrom) ? filesfrom : [];
    const uploadDate = date ? new Date(date) : new Date();
    const inserted = [];

    for (let i = 0; i < list.length; i++) {
      const [url, name] = Array.isArray(list[i]) ? list[i] : [list[i]?.current ?? list[i], list[i]?.filename ?? ""];
      const fileId = uuidv7();
      const [row] = await db
        .insert(filesTable)
        .values({
          id: fileId,
          directFeasibilityId: id,
          order: i,
          uploaddate: uploadDate,
          filename: name ?? null,
          current: url ?? null,
          prevlinks: [],
          isDisabled: false,
        })
        .returning();
      inserted.push(fileRowToApi(row));
    }

    return res.status(201).json(inserted);
  } catch (error) {
    console.error("addFiles error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateFile(req, res) {
  try {
    const { id, fileId } = req.params;
    const body = req.body;

    const [existing] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.id, fileId), eq(filesTable.directFeasibilityId, id)))
      .limit(1);
    if (!existing) {
      console.error("[direct] PUT /direct/updatefile/:id/:fileId – File not found, id:", id, "fileId:", fileId);
      return res.status(404).json({ message: "File not found" });
    }

    const updateData = {};
    if (body.order !== undefined) updateData.order = body.order;
    if (body.uploaddate !== undefined) updateData.uploaddate = body.uploaddate ? new Date(body.uploaddate) : null;
    if (body.filename !== undefined) updateData.filename = body.filename;
    if (body.prevlinks !== undefined) updateData.prevlinks = Array.isArray(body.prevlinks) ? body.prevlinks : [];
    if (body.isDisabled !== undefined) updateData.isDisabled = !!body.isDisabled;
    if (body.current !== undefined) {
      updateData.current = body.current;
      const prev = existing.prevlinks ?? [];
      if (existing.current) updateData.prevlinks = [...prev, existing.current];
    }

    const [updated] = await db
      .update(filesTable)
      .set(updateData)
      .where(and(eq(filesTable.id, fileId), eq(filesTable.directFeasibilityId, id)))
      .returning();

    return res.status(200).json(fileRowToApi(updated));
  } catch (error) {
    console.error("updateFile error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteFile(req, res) {
  try {
    const { id, fileId } = req.params;

    const [existing] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.id, fileId), eq(filesTable.directFeasibilityId, id)))
      .limit(1);
    if (!existing) {
      console.error("[direct] DELETE /direct/files/:id/:fileId – File not found, id:", id, "fileId:", fileId);
      return res.status(404).json({ message: "File not found" });
    }

    await db
      .update(filesTable)
      .set({ isDisabled: !existing.isDisabled })
      .where(and(eq(filesTable.id, fileId), eq(filesTable.directFeasibilityId, id)));

    return res.status(200).json({ message: "File toggled", isDisabled: !existing.isDisabled });
  } catch (error) {
    console.error("deleteFile error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/** GET /direct/files/:id/:fileId/serve – stream file content (for PDF export; avoids CORS). */
export async function serveFileContent(req, res) {
  try {
    const { id, fileId } = req.params;
    const [fileRow] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.id, fileId), eq(filesTable.directFeasibilityId, id)))
      .limit(1);
    if (!fileRow?.current) {
      return res.status(404).json({ message: "File not found" });
    }
    const fetchRes = await fetch(fileRow.current, { redirect: "follow" });
    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ message: "Failed to fetch file" });
    }
    const contentType = fetchRes.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    Readable.fromWeb(fetchRes.body).pipe(res);
  } catch (error) {
    console.error("serveFileContent error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

// --- Slides CRUD ---

export async function createSlide(req, res) {
  try {
    const { id } = req.params;
    const { title, layout, fileId, content, slideOrder, backgroundColor, textBackgroundColor } = req.body || {};

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Direct feasibility not found" });
    }

    const [maxOrder] = await db
      .select({ maxOrder: sql`COALESCE(MAX(${slidesTable.slideOrder}), -1)` })
      .from(slidesTable)
      .where(eq(slidesTable.directFeasibilityId, id));
    const nextOrder = typeof slideOrder === "number" ? slideOrder : Number(maxOrder?.maxOrder ?? -1) + 1;

    const slideId = uuidv7();
    const [inserted] = await db
      .insert(slidesTable)
      .values({
        id: slideId,
        directFeasibilityId: id,
        title: title ?? "",
        layout: layout ?? "image-text",
        backgroundColor: backgroundColor ?? null,
        textBackgroundColor: textBackgroundColor ?? null,
        fileId: fileId || null,
        content: content ?? null,
        slideOrder: nextOrder,
        updatedAt: new Date(),
      })
      .returning();

    const fileRow = fileId
      ? (await db.select().from(filesTable).where(eq(filesTable.id, fileId)).limit(1))[0]
      : null;
    return res.status(201).json(slideRowToApi(inserted, fileRow));
  } catch (error) {
    console.error("createSlide error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateSlide(req, res) {
  try {
    const { id, slideId } = req.params;
    const body = req.body || {};

    const [slide] = await db
      .select()
      .from(slidesTable)
      .where(and(eq(slidesTable.id, slideId), eq(slidesTable.directFeasibilityId, id)))
      .limit(1);
    if (!slide) {
      return res.status(404).json({ message: "Slide not found" });
    }

    const updateData = { updatedAt: new Date() };
    if (body.title !== undefined) updateData.title = body.title;
    if (body.layout !== undefined) updateData.layout = body.layout;
    if (body.backgroundColor !== undefined) updateData.backgroundColor = body.backgroundColor || null;
    if (body.textBackgroundColor !== undefined) updateData.textBackgroundColor = body.textBackgroundColor || null;
    if (body.fileId !== undefined) updateData.fileId = body.fileId || null;
    if (body.content !== undefined) updateData.content = body.content;
    if (typeof body.slideOrder === "number") updateData.slideOrder = body.slideOrder;

    const [updated] = await db
      .update(slidesTable)
      .set(updateData)
      .where(and(eq(slidesTable.id, slideId), eq(slidesTable.directFeasibilityId, id)))
      .returning();

    const fileRow = updated?.fileId
      ? (await db.select().from(filesTable).where(eq(filesTable.id, updated.fileId)).limit(1))[0]
      : null;
    return res.status(200).json(slideRowToApi(updated, fileRow));
  } catch (error) {
    console.error("updateSlide error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteSlide(req, res) {
  try {
    const { id, slideId } = req.params;

    const [slide] = await db
      .select()
      .from(slidesTable)
      .where(and(eq(slidesTable.id, slideId), eq(slidesTable.directFeasibilityId, id)))
      .limit(1);
    if (!slide) {
      return res.status(404).json({ message: "Slide not found" });
    }

    await db
      .delete(slidesTable)
      .where(and(eq(slidesTable.id, slideId), eq(slidesTable.directFeasibilityId, id)));

    return res.status(200).json({ message: "Slide deleted" });
  } catch (error) {
    console.error("deleteSlide error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function reorderSlides(req, res) {
  try {
    const { id } = req.params;
    const { slideIds } = req.body || {};

    if (!Array.isArray(slideIds) || slideIds.length === 0) {
      return res.status(400).json({ message: "slideIds array required" });
    }

    const [existing] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, id)).limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Direct feasibility not found" });
    }

    const slidesInDirect = await db
      .select({ id: slidesTable.id })
      .from(slidesTable)
      .where(eq(slidesTable.directFeasibilityId, id));
    const validIds = new Set(slidesInDirect.map((s) => s.id));
    for (let i = 0; i < slideIds.length; i++) {
      const sid = slideIds[i];
      if (validIds.has(sid)) {
        await db
          .update(slidesTable)
          .set({ slideOrder: i, updatedAt: new Date() })
          .where(and(eq(slidesTable.id, sid), eq(slidesTable.directFeasibilityId, id)));
      }
    }

    const slidesRows = await db
      .select()
      .from(slidesTable)
      .where(eq(slidesTable.directFeasibilityId, id))
      .orderBy(asc(slidesTable.slideOrder));
    const filesRows = await db
      .select()
      .from(filesTable)
      .where(eq(filesTable.directFeasibilityId, id));
    const fileMapById = Object.fromEntries((filesRows || []).map((f) => [f.id, f]));
    return res.status(200).json({
      slides: (slidesRows || []).map((s) => slideRowToApi(s, fileMapById[s.fileId] || null)),
    });
  } catch (error) {
    console.error("reorderSlides error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
