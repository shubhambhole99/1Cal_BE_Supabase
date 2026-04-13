import { eq, ilike, desc, sql, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { bills } from "../schema/bills.js";
import { newObjectId } from "../utils/objectId.js";
import { normalizeTimestampFields } from "../utils/date.js";

export async function createBill(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const body = { id: newObjectId(), ...req.body, user: userId };
    normalizeTimestampFields(body, ["createdAt"]);
    const [bill] = await db.insert(bills).values(body).returning();
    if (!bill) return res.status(500).json({ message: "Error creating bill" });
    return res.status(201).json(bill);
  } catch (error) {
    return res.status(500).json({ message: "Error creating bill", error: error.message });
  }
}

export async function listBills(req, res) {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const query = req.query.query || "";

    const conditions = [eq(bills.user, userId)];
    if (query) conditions.push(ilike(bills.name, `%${query}%`));
    const filter = conditions.length > 1 ? and(...conditions) : conditions[0];

    const [countResult] = await db.select({ count: sql`count(*)::int` }).from(bills).where(filter);
    const total = Number(countResult?.count ?? 0);

    const data = await db
      .select()
      .from(bills)
      .where(filter)
      .orderBy(desc(bills.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return res.status(200).json({
      data,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error getting bills", error: error.message });
  }
}

export async function getBillById(req, res) {
  try {
    const [bill] = await db.select().from(bills).where(eq(bills.id, req.params.id)).limit(1);
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    return res.status(200).json(bill);
  } catch (error) {
    return res.status(500).json({ message: "Error getting bill", error: error.message });
  }
}

export async function updateBill(req, res) {
  try {
    const data = { ...req.body };
    normalizeTimestampFields(data, ["createdAt"]);
    const [updated] = await db
      .update(bills)
      .set(data)
      .where(eq(bills.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Bill not found" });
    return res.status(200).json(updated);
  } catch (error) {
    return res.status(500).json({ message: "Error updating bill", error: error.message });
  }
}

export async function deleteBill(req, res) {
  try {
    const [deleted] = await db.delete(bills).where(eq(bills.id, req.params.id)).returning();
    if (!deleted) return res.status(404).json({ message: "Bill not found" });
    return res.status(200).json(deleted);
  } catch (error) {
    return res.status(500).json({ message: "Error deleting bill", error: error.message });
  }
}
