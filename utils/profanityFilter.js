/**
 * Profanity filter for comment body: Hindi, English, Marathi.
 * Returns true if the text contains disallowed (harsh) language.
 */

import { english, hindiRoman, hindiDevanagari, marathiRoman, marathiDevanagari } from "./profanityWords.js";

const allWords = [
  ...english,
  ...hindiRoman,
  ...hindiDevanagari,
  ...marathiRoman,
  ...marathiDevanagari,
].filter(Boolean);

// Normalize: lowercase, collapse repeated chars (e.g. "daaaamn" -> "damn"), remove extra spaces
function normalize(text) {
  if (typeof text !== "string") return "";
  let t = text.toLowerCase().trim();
  t = t.replace(/\s+/g, " ");
  // Optional: collapse 2+ repeated letters to one for evasion (e.g. "daaaaamn" -> "damn")
  t = t.replace(/(.)\1{2,}/g, "$1$1");
  return t;
}

// Match whole words only (so "hell" does not match inside "hello")
function toWordBoundaryRegex(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

/**
 * @param {string} text - Comment body
 * @returns {boolean} - true if profanity detected
 */
export function containsProfanity(text) {
  const normalized = normalize(text);
  if (!normalized) return false;

  const normalizedWords = allWords.map((w) => w.toLowerCase().trim()).filter(Boolean);
  for (const bad of normalizedWords) {
    if (!bad) continue;
    // Whole-word match: avoids "hello" matching "hell", "classic" matching "ass", etc.
    if (toWordBoundaryRegex(bad).test(normalized)) return true;
  }
  return false;
}
