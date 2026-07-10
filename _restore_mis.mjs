// Fast MI-only restore into the 01-07-2026 version (all inputs are ungrouped).
import fs from "node:fs";
const BE = "http://127.0.0.1:5000";
const TID = "278ae332cfe0af1b00c6a598", VID = "25005c230cb09c90ccb065c6";
const mis = JSON.parse(fs.readFileSync("C:/Users/Shubham(Code)/Downloads/LAtest.json", "utf8")).masterInputs;
await fetch(`${BE}/v3/master-inputs/wipe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template_id: TID, version_id: VID }) });
const CHUNK = 2000;
for (let o = 0; o < mis.length; o += CHUNK) {
  const chunk = mis.slice(o, o + CHUNK).map((mi) => ({
    key: mi.key, display_name: mi.display_name, value: mi.value, ref: mi.ref,
    type: mi.type, options: Array.isArray(mi.options) ? mi.options : [],
    section: mi.section, kind: mi.kind, group_id: null, ord: mi.ord,
  }));
  const r = await fetch(`${BE}/v3/master-inputs/bulk`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template_id: TID, version_id: VID, masterInputs: chunk }) });
  if (!r.ok) { console.error("fail", r.status, await r.text()); process.exit(1); }
  console.log(`MIs ${Math.min(o + CHUNK, mis.length)}/${mis.length}`);
}
console.log("restored", mis.length, "MIs");
process.exit(0);
