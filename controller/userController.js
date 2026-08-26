import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import https from "https";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../schema/users.js";
import { newObjectId } from "../utils/objectId.js";
import { normalizeTimestampFields } from "../utils/date.js";

const JWT_SECRET = process.env.JWT_SECRET || "your_secret_key";
// Mirrors the prod.user_role Postgres enum — a value missing here is rejected
// before it ever reaches the column, and a value missing from the enum fails at
// insert. Keep the two in step.
const validRoles = ["user", "admin", "client", "staff"];

function fetchPhoneData(userJsonUrl) {
  return new Promise((resolve, reject) => {
    https
      .get(userJsonUrl, (resp) => {
        let data = "";
        resp.on("data", (chunk) => (data += chunk));
        resp.on("end", () => {
          try {
            const jsonData = JSON.parse(data);
            const { user_country_code, user_phone_number, user_first_name, user_last_name } = jsonData;
            if (!user_country_code || !user_phone_number) {
              return reject(new Error("Phone verification data is incomplete."));
            }
            resolve({ user_country_code, user_phone_number, user_first_name, user_last_name });
          } catch (e) {
            reject(new Error("Failed to parse response from user_json_url."));
          }
        });
      })
      .on("error", reject);
  });
}

function toUserResponse(row) {
  if (!row) return null;
  return {
    ...row,
    _id: row.id,
    first_name: row.firstName ?? row.first_name ?? null,
    last_name: row.lastName ?? row.last_name ?? null,
    phone_number: row.phoneNumber ?? row.phone_number ?? null,
  };
}

export async function createUser(req, res) {
  const { username, email, password, role, user_json_url } = req.body;
  const username1 = String(Math.floor(Math.random() * 100000000000));
  const email1 = `${Math.floor(Math.random() * 100000000000)}@gmail.com`;
  const password1 = "123";

  if (username !== "" && username != null) {
    const [existingByUsername] = await db.select().from(users).where(eq(users.username, username1)).limit(1);
    if (existingByUsername) return res.status(400).json({ error: "Username already exists" });
  }

  const [existingByEmail] = await db.select().from(users).where(eq(users.email, email1)).limit(1);
  if (existingByEmail) return res.status(400).json({ error: "Email already exists. Please SignIn" });

  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Valid roles are ${validRoles.join(", ")}.` });
  }
  if (!user_json_url) return res.status(400).json({ error: "Missing user_json_url" });

  try {
    const phoneData = await fetchPhoneData(user_json_url);
    const [existingByPhone] = await db.select().from(users).where(eq(users.phoneNumber, phoneData.user_phone_number)).limit(1);

    if (existingByPhone) {
      // Single active session (last login wins) — same rule as /user/login.
      const sid = newObjectId();
      await db.update(users).set({ activeSessionId: sid }).where(eq(users.id, existingByPhone.id));
      const token = jwt.sign(
        { userId: existingByPhone.id, username: existingByPhone.username, role: existingByPhone.role, sid },
        JWT_SECRET,
        { expiresIn: "20d" }
      );
      return res.status(200).json({
        message: "Logged in successfully",
        user: toUserResponse(existingByPhone),
        token,
        phoneData,
      });
    }

    const hashedPassword = await bcrypt.hash(password1, 10);
    const sid = newObjectId();
    const [created] = await db
      .insert(users)
      .values({
        id: newObjectId(),
        username: username1,
        email: email1,
        password: hashedPassword,
        role: role || "user",
        phoneCountryCode: phoneData.user_country_code,
        phoneNumber: phoneData.user_phone_number,
        firstName: phoneData.user_first_name,
        lastName: phoneData.user_last_name,
        activeSessionId: sid,
      })
      .returning();

    const token = jwt.sign(
      { userId: created.id, username: created.username, role: created.role, sid },
      JWT_SECRET,
      { expiresIn: "20d" }
    );
    return res.json({
      message: "User created successfully",
      user: toUserResponse(created),
      token,
      phoneData,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

export async function verifyUserPhoneData(req, res) {
  const { user_json_url } = req.body;
  if (!user_json_url) return res.status(400).json({ error: "Missing user_json_url" });
  try {
    const phoneData = await fetchPhoneData(user_json_url);
    const [existing] = await db.select().from(users).where(eq(users.phoneNumber, phoneData.user_phone_number)).limit(1);
    if (!existing) return res.status(400).json({ error: "User with this phone number already exists." });
    return res.json({ message: "Phone number verified.", phoneData });
  } catch (error) {
    console.error("Verification error:", error.message);
    res.status(500).json({ error: error.message });
  }
}

export async function login(req, res) {
  const { userdetail, password } = req.body;
  try {
    const [finaluser] = await db
      .select()
      .from(users)
      .where(or(eq(users.username, userdetail), eq(users.email, userdetail), eq(users.phoneNumber, userdetail)))
      .limit(1);

    if (!finaluser) return res.status(404).json({ error: "User not found" });

    const passwordMatch = await bcrypt.compare(password, finaluser.password);
    if (!passwordMatch) return res.status(401).json({ error: "Invalid password" });

    // Single active session — "last login wins". Mint a fresh session id, make it
    // the user's ONLY valid session, and stamp it into the JWT. Any token holding
    // a different sid (an older device/browser) now fails the /user/check
    // heartbeat and is logged out.
    const sid = newObjectId();
    await db.update(users).set({ activeSessionId: sid }).where(eq(users.id, finaluser.id));

    const token = jwt.sign(
      { userId: finaluser.id, username: finaluser.username, role: finaluser.role, sid },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
    res.json({ message: "Login successful", token, finaluser: toUserResponse(finaluser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

export async function getAllUsers(req, res) {
  try {
    const hasListParams = [
      "page", "limit", "query", "sortBy", "sortDir", "role", "status", "v2",
    ].some((k) => Object.prototype.hasOwnProperty.call(req.query, k));

    // Backwards compatibility: when called without list params, return the original array payload.
    if (!hasListParams) {
      const rows = await db.select().from(users).orderBy(asc(users.username));
      return res.json(rows.map(toUserResponse));
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = String(req.query.limit ?? "50").trim();
    const query = String(req.query.query ?? "").trim();

    const normalizedLimit = limitRaw.toLowerCase() === "all" ? "all" : String(parseInt(limitRaw, 10) || 50);
    const limit =
      normalizedLimit === "all"
        ? null
        : [50, 100, 150].includes(Number(normalizedLimit))
          ? Number(normalizedLimit)
          : 50;

    const sortBy = String(req.query.sortBy ?? "createdAt").trim();
    const sortDir = String(req.query.sortDir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

    // Facet filters. These have to run in SQL rather than on the client, or a
    // filtered count would only ever describe the current page.
    const roleFilter = String(req.query.role ?? "").trim().toLowerCase();
    const statusFilter = String(req.query.status ?? "").trim().toLowerCase();
    const v2Filter = String(req.query.v2 ?? "").trim().toLowerCase();

    const conditions = [];

    if (query) {
      const pattern = `%${query}%`;
      const fullNameCond = sql`(coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')) ILIKE ${pattern}`;
      conditions.push(
        or(
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
          fullNameCond,
          ilike(users.email, pattern),
          ilike(users.phoneNumber, pattern),
          // role is a pg enum (prod.user_role) and ILIKE has no operator for
          // enum types — without this cast the whole OR errors out and EVERY
          // search returns "operator does not exist: prod.user_role ~~* unknown".
          sql`${users.role}::text ILIKE ${pattern}`,
          ilike(users.username, pattern)
        )
      );
    }

    if (roleFilter && roleFilter !== "all") {
      // role is a pg enum (prod.user_role), so cast to text before coalescing —
      // coalescing to '' against the enum type itself is a cast error.
      conditions.push(sql`lower(coalesce(${users.role}::text, '')) = ${roleFilter}`);
    }

    // status is nullable but defaults to active, so treat null as active.
    if (statusFilter && statusFilter !== "all") {
      conditions.push(sql`lower(coalesce(${users.status}::text, 'active')) = ${statusFilter}`);
    }

    if (v2Filter === "yes") conditions.push(eq(users.canCreateV2, true));
    if (v2Filter === "no") {
      conditions.push(sql`coalesce(${users.canCreateV2}, false) = false`);
    }

    const filter = conditions.length ? and(...conditions) : undefined;

    const orderExpr =
      sortBy === "createdAt"
        ? sortDir === "asc"
          ? asc(users.actualCreatedAt)
          : desc(users.actualCreatedAt)
        : asc(users.username);

    const baseQuery = db.select().from(users);
    const dataQuery = filter ? baseQuery.where(filter) : baseQuery;

    const listQuery = limit
      ? dataQuery.orderBy(orderExpr, asc(users.username)).limit(limit).offset((page - 1) * limit)
      : dataQuery.orderBy(orderExpr, asc(users.username));

    const rows = await listQuery;

    const countQuery = filter
      ? db.select({ count: sql`count(*)::int` }).from(users).where(filter)
      : db.select({ count: sql`count(*)::int` }).from(users);

    const [{ count }] = await countQuery;
    const totalItems = Number(count ?? 0);
    const totalPages = limit ? Math.ceil(totalItems / limit) : 1;

    return res.json({
      data: rows.map(toUserResponse),
      currentPage: limit ? page : 1,
      totalPages: Math.max(totalPages, 1),
      totalItems,
    });
  } catch (error) {
    console.error("[GET /api/user] Error:", error);
    res.status(500).json({ error: error.message });
  }
}

export async function resetPassword(req, res) {
  const { phone_number, newPassword } = req.body;
  if (!phone_number || !newPassword) {
    return res.status(400).json({ error: "Phone number and new password are required." });
  }
  try {
    const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone_number)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found." });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ password: hashed }).where(eq(users.id, user.id));
    res.json({ message: "Password reset successfully." });
  } catch (error) {
    console.error("[PUT /api/user/editpass] Error:", error);
    res.status(500).json({ error: error.message });
  }
}

export async function getUserById(req, res) {
  const id = req.params.id;
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (user) res.json(toUserResponse(user));
    else res.status(404).json({ error: "User not found" });
  } catch (error) {
    console.error("[GET /api/user/:id] Error:", error);
    res.status(500).json({ error: error.message });
  }
}

export async function updateUser(req, res) {
  const id = req.params.id;
  const newData = { ...req.body };
  if (newData.password) newData.password = await bcrypt.hash(newData.password, 10);
  normalizeTimestampFields(newData, ["actualCreatedAt"]);
  try {
    const [updated] = await db.update(users).set(newData).where(eq(users.id, id)).returning();
    if (updated) res.json({ message: "User updated successfully", user: toUserResponse(updated) });
    else res.status(404).json({ error: "User not found" });
  } catch (error) {
    console.error("[PUT /api/user/:id] Error:", error);
    res.status(500).json({ error: error.message });
  }
}

export async function deleteUser(req, res) {
  const id = req.params.id;
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    await db.update(users).set({ isDisabled: !user.isDisabled }).where(eq(users.id, id));
    const [updated] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    res.json({ message: "User status updated successfully", user: toUserResponse(updated) });
  } catch (error) {
    console.error("[DELETE /api/user/:id] Error:", error);
    res.status(500).json({ error: error.message });
  }
}

// Single-active-session heartbeat. The FE polls this; a 401 here means "this
// device's session was superseded (or is a legacy/no-sid token) → log out".
// `req.user` is the JWT payload set by isAuthenticated.
export async function checkloginvalidity(req, res) {
  try {
    const userId = req.user?.userId ?? req.user?.id;
    const sid = req.user?.sid;

    // No sid on the token → it was issued before single-session existed (or was
    // minted without one). Every such token is invalid, which is exactly what
    // forces all pre-existing sessions to re-login on rollout.
    if (!userId || !sid) {
      return res.status(401).json({ data: false, reason: "session_superseded" });
    }

    const [u] = await db
      .select({ activeSessionId: users.activeSessionId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!u) return res.status(401).json({ data: false, reason: "user_not_found" });

    // The user's ONLY valid session is the most recent login. A mismatch means a
    // newer login (another device/browser) took over — this device must log out.
    if (u.activeSessionId !== sid) {
      return res.status(401).json({ data: false, reason: "session_superseded" });
    }

    res.json({ data: true });
  } catch (err) {
    console.error("[PUT /api/user/check] Error:", err);
    res.status(500).json({ data: false, error: err.message });
  }
}
