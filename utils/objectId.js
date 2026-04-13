import { ObjectId } from "bson";

/** Returns a new 24-char hex string (MongoDB ObjectId–compatible) for use as primary key. */
export function newObjectId() {
  return new ObjectId().toString();
}
