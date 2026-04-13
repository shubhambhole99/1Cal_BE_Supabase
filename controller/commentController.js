import { eq, and, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { commentThreads } from "../schema/commentThreads.js";
import { comments } from "../schema/comments.js";
import { users } from "../schema/users.js";
import { templates } from "../schema/templates.js";
import { directFeasibilities } from "../schema/directFeasibilities.js";
import { uuidv7 } from "uuidv7";
import { containsProfanity } from "../utils/profanityFilter.js";

const TARGET_TYPES = ["template", "direct_feasibility"];

function toThreadResponse(row) {
  if (!row) return null;
  return { id: row.id, target_type: row.targetType, target_id: row.targetId, created_at: row.createdAt, _id: row.id };
}

/** Display name: name, or firstName + lastName merged, or null. */
function authorDisplayName(c) {
  const fromName = c.author_name && String(c.author_name).trim();
  if (fromName) return fromName;
  const parts = [c.author_first_name, c.author_last_name].filter(Boolean).map((s) => String(s).trim());
  const merged = parts.join(" ").trim();
  return merged || null;
}

/** Get or create a thread for target_type + target_id; return thread + comments. */
export async function getOrCreateThread(req, res) {
  try {
    const targetType = (req.query.target_type || "").trim();
    const targetId = (req.query.target_id || "").trim();

    if (!targetType || !targetId) {
      return res.status(400).json({ message: "target_type and target_id are required" });
    }
    if (!TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ message: "target_type must be template or direct_feasibility" });
    }

    if (targetType === "template") {
      const [t] = await db.select().from(templates).where(eq(templates.id, targetId)).limit(1);
      if (!t) return res.status(404).json({ message: "Template not found" });
    } else {
      const [d] = await db.select().from(directFeasibilities).where(eq(directFeasibilities.id, targetId)).limit(1);
      if (!d) return res.status(404).json({ message: "Direct feasibility not found" });
    }

    let [thread] = await db
      .select()
      .from(commentThreads)
      .where(and(eq(commentThreads.targetType, targetType), eq(commentThreads.targetId, targetId)))
      .limit(1);

    if (!thread) {
      const newId = uuidv7();
      [thread] = await db
        .insert(commentThreads)
        .values({ id: newId, targetType, targetId })
        .returning();
      if (!thread) return res.status(500).json({ message: "Failed to create thread" });
    }

    const commentsList = await db
      .select({
        id: comments.id,
        thread_id: comments.threadId,
        user_id: comments.userId,
        parent_id: comments.parentId,
        body: comments.body,
        created_at: comments.createdAt,
        updated_at: comments.updatedAt,
        author_name: users.name,
        author_first_name: users.firstName,
        author_last_name: users.lastName,
        author_phone: users.phoneNumber,
      })
      .from(comments)
      .leftJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.threadId, thread.id))
      .orderBy(asc(comments.createdAt));

    const commentResponses = commentsList.map((c) => ({
      id: c.id,
      _id: c.id,
      thread_id: c.thread_id,
      user_id: c.user_id,
      parent_id: c.parent_id,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      author: (authorDisplayName(c) || c.author_phone) ? { name: authorDisplayName(c), phone: c.author_phone } : null,
    }));

    return res.status(200).json({
      thread: toThreadResponse(thread),
      comments: commentResponses,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error getting thread", error: error.message });
  }
}

/** List comments for a thread. */
export async function getComments(req, res) {
  try {
    const { threadId } = req.params;

    const [thread] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1);
    if (!thread) return res.status(404).json({ message: "Thread not found" });

    const commentsList = await db
      .select({
        id: comments.id,
        thread_id: comments.threadId,
        user_id: comments.userId,
        parent_id: comments.parentId,
        body: comments.body,
        created_at: comments.createdAt,
        updated_at: comments.updatedAt,
        author_name: users.name,
        author_first_name: users.firstName,
        author_last_name: users.lastName,
        author_phone: users.phoneNumber,
      })
      .from(comments)
      .leftJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.threadId, threadId))
      .orderBy(asc(comments.createdAt));

    const commentResponses = commentsList.map((c) => ({
      id: c.id,
      _id: c.id,
      thread_id: c.thread_id,
      user_id: c.user_id,
      parent_id: c.parent_id,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      author: (authorDisplayName(c) || c.author_phone) ? { name: authorDisplayName(c), phone: c.author_phone } : null,
    }));

    return res.status(200).json({ comments: commentResponses });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error listing comments", error: error.message });
  }
}

/** Create a comment. */
export async function createComment(req, res) {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { threadId } = req.params;
    const { body: bodyRaw, parent_id: parentId } = req.body || {};
    const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
    if (!body) return res.status(400).json({ message: "body is required" });

    if (containsProfanity(body)) {
      return res.status(400).json({ message: "Comment contains language that isn't allowed. Please rephrase." });
    }

    const [thread] = await db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1);
    if (!thread) return res.status(404).json({ message: "Thread not found" });

    const commentId = uuidv7();
    const [created] = await db
      .insert(comments)
      .values({
        id: commentId,
        threadId,
        userId,
        parentId: parentId && String(parentId).trim() ? parentId : null,
        body,
      })
      .returning();

    if (!created) return res.status(500).json({ message: "Failed to create comment" });

    const [withUser] = await db
      .select({
        id: comments.id,
        thread_id: comments.threadId,
        user_id: comments.userId,
        parent_id: comments.parentId,
        body: comments.body,
        created_at: comments.createdAt,
        updated_at: comments.updatedAt,
        author_name: users.name,
        author_first_name: users.firstName,
        author_last_name: users.lastName,
        author_phone: users.phoneNumber,
      })
      .from(comments)
      .leftJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.id, commentId))
      .limit(1);

    const c = withUser;
    return res.status(201).json({
      comment: {
        id: c.id,
        _id: c.id,
        thread_id: c.thread_id,
        user_id: c.user_id,
        parent_id: c.parent_id,
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
        author: (authorDisplayName(c) || c.author_phone) ? { name: authorDisplayName(c), phone: c.author_phone } : null,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error creating comment", error: error.message });
  }
}

/** Update own comment (body only). Profanity filter applied. */
export async function updateComment(req, res) {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { commentId } = req.params;
    const { body: bodyRaw } = req.body || {};
    const body = typeof bodyRaw === "string" ? bodyRaw.trim() : "";
    if (!body) return res.status(400).json({ message: "body is required" });

    if (containsProfanity(body)) {
      return res.status(400).json({ message: "Comment contains language that isn't allowed. Please rephrase." });
    }

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!existing) return res.status(404).json({ message: "Comment not found" });
    if (existing.userId !== userId) return res.status(403).json({ message: "You can only edit your own comment" });

    const [updated] = await db
      .update(comments)
      .set({ body, updatedAt: new Date() })
      .where(eq(comments.id, commentId))
      .returning();

    if (!updated) return res.status(500).json({ message: "Failed to update comment" });
    return res.status(200).json({
      comment: {
        id: updated.id,
        _id: updated.id,
        thread_id: updated.threadId,
        user_id: updated.userId,
        parent_id: updated.parentId,
        body: updated.body,
        created_at: updated.createdAt,
        updated_at: updated.updatedAt,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error updating comment", error: error.message });
  }
}

/** Delete own comment or admin. */
export async function deleteComment(req, res) {
  try {
    const userId = req.user?.id || req.user?.userId;
    const role = req.user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { commentId } = req.params;
    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!existing) return res.status(404).json({ message: "Comment not found" });
    if (existing.userId !== userId && role !== "admin") {
      return res.status(403).json({ message: "You can only delete your own comment" });
    }

    await db.delete(comments).where(eq(comments.id, commentId));
    return res.status(200).json({ message: "Comment deleted" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error deleting comment", error: error.message });
  }
}
