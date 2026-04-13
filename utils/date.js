/**
 * Normalize timestamp fields in an object so Drizzle's PgTimestamp.mapToDriverValue
 * receives Date objects (it calls .toISOString() on the value).
 * Mutates obj: converts valid date-like values to Date, removes invalid ones.
 * @param {Record<string, unknown>} obj - Object that will be passed to Drizzle .set() or .values()
 * @param {string[]} fieldNames - Column names that are timestamp type (e.g. ['date', 'createdAt'])
 */
export function normalizeTimestampFields(obj, fieldNames) {
  if (!obj || !Array.isArray(fieldNames)) return obj;
  for (const key of fieldNames) {
    if (obj[key] == null || obj[key] === "") continue;
    const d = new Date(obj[key]);
    if (!Number.isNaN(d.getTime())) obj[key] = d;
    else delete obj[key];
  }
  return obj;
}
