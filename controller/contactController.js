import { eq, or, ilike, and, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { contacts } from "../schema/contacts.js";
import { users } from "../schema/users.js";
import { newObjectId } from "../utils/objectId.js";
import { normalizeTimestampFields } from "../utils/date.js";

export async function listContacts(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const query = req.query.query || "";
    const showDisabledOnly = req.query.disabled === "true";

    const conditions = [eq(contacts.isDisabled, showDisabledOnly)];
    if (query) {
      conditions.push(
        or(
          ilike(contacts.name, `%${query}%`),
          ilike(contacts.email, `%${query}%`),
          ilike(contacts.phone, `%${query}%`)
        )
      );
    }

    const filter = conditions.length > 1 ? and(...conditions) : conditions[0];
    const [countResult] = await db
      .select({ count: sql`count(*)::int` })
      .from(contacts)
      .where(filter);
    const totalCount = Number(countResult?.count ?? 0);

    const data = await db
      .select()
      .from(contacts)
      .where(filter)
      .orderBy(desc(contacts.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return res.status(200).json({
      data,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page,
    });
  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ message: "Error getting contacts", error: error.message });
  }
}

export async function createContact(req, res) {
  try {
    const body = { id: newObjectId(), ...req.body };
    normalizeTimestampFields(body, ["createdAt"]);
    const [contact] = await db.insert(contacts).values(body).returning();
    if (!contact) return res.status(500).json({ message: "Error creating contact" });
    return res.status(201).json(contact);
  } catch (error) {
    return res.status(500).json({ message: "Error creating contact", error: error.message });
  }
}

export async function getContactById(req, res) {
  try {
    const [contact] = await db
      .select({
        contact: contacts,
        userName: users.name,
        userEmail: users.email,
      })
      .from(contacts)
      .leftJoin(users, eq(contacts.user, users.id))
      .where(eq(contacts.id, req.params.id))
      .limit(1);

    if (!contact) return res.status(404).json({ message: "Contact not found" });
    const out = {
      ...contact.contact,
      _id: contact.contact.id,
      user:
        contact.userName != null
          ? { _id: contact.contact.user, name: contact.userName, email: contact.userEmail }
          : contact.contact.user ?? null,
    };
    return res.status(200).json(out);
  } catch (error) {
    return res.status(500).json({ message: "Error getting contact", error: error.message });
  }
}

export async function updateContact(req, res) {
  try {
    const data = { ...req.body };
    normalizeTimestampFields(data, ["createdAt"]);
    const [updated] = await db
      .update(contacts)
      .set(data)
      .where(eq(contacts.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ message: "Contact not found" });
    return res.status(200).json(updated);
  } catch (error) {
    return res.status(500).json({ message: "Error updating contact", error: error.message });
  }
}

export async function deleteContact(req, res) {
  try {
    const [deleted] = await db.delete(contacts).where(eq(contacts.id, req.params.id)).returning();
    if (!deleted) return res.status(404).json({ message: "Contact not found" });
    return res.status(200).json(deleted);
  } catch (error) {
    return res.status(500).json({ message: "Error deleting contact", error: error.message });
  }
}
