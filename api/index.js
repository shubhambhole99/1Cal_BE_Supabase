// App lives at BE root (same level as api/). No "src" - direct path so Vercel finds it.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const appPath = join(__dirname, "..", "app.js");
const { default: app } = await import(appPath);
export default app;
