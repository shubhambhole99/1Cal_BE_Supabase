import crypto from "crypto";

/** 24-char hex id (MongoDB ObjectId compatible) without the bson dependency. */
export function newObjectId() {
  return crypto.randomBytes(12).toString("hex");
}
