import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pdfDownloadLogs } from "../schema/pdfDownloadLogs.js";
import { users } from "../schema/users.js";
import { newObjectId } from "../utils/objectId.js";

export async function logPdfDownload(req, res) {
  try {
    const { user, fetchId, downloadedAt } = req.body;
    if (!user || !fetchId) {
      return res.status(400).json({ message: "Missing required fields: user or fetchId" });
    }
    let downloadedAtVal = new Date();
    if (downloadedAt != null && downloadedAt !== "") {
      const d = new Date(downloadedAt);
      if (!Number.isNaN(d.getTime())) downloadedAtVal = d;
    }
    await db.insert(pdfDownloadLogs).values({
      id: newObjectId(),
      user,
      fetchId,
      downloadedAt: downloadedAtVal,
    });
    res.status(201).json({ message: "PDF download logged successfully" });
  } catch (err) {
    console.error("Error logging download:", err);
    res.status(500).json({ message: "Server error while logging PDF download" });
  }
}

export async function getAllPdfDownloadLogs(req, res) {
  try {
    const logs = await db
      .select({
        id: pdfDownloadLogs.id,
        user: pdfDownloadLogs.user,
        fetchId: pdfDownloadLogs.fetchId,
        downloadedAt: pdfDownloadLogs.downloadedAt,
        firstName: users.firstName,
        lastName: users.lastName,
        phoneNumber: users.phoneNumber,
      })
      .from(pdfDownloadLogs)
      .leftJoin(users, eq(pdfDownloadLogs.user, users.id));

    const result = logs.map((row) => ({
      _id: row.id,
      user: row.user
        ? {
            _id: row.user,
            first_name: row.firstName,
            last_name: row.lastName,
            phone_number: row.phoneNumber,
          }
        : null,
      fetchId: row.fetchId,
      downloadedAt: row.downloadedAt,
    }));
    res.status(200).json(result);
  } catch (err) {
    console.error("Error retrieving download logs:", err);
    res.status(500).json({ message: "Server error while retrieving PDF download logs" });
  }
}
