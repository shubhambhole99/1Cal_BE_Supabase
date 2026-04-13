# Supabase Model Backend

Express + Drizzle backend for Supabase (Postgres).

## Local development

```bash
npm install
npm run dev
```

Set `DATABASE_URL` in `.env` (Supabase connection string).

## Deploying to Vercel

1. Push the repo and import it in Vercel (New Project → set root to this folder).
2. **Environment variables**: In Vercel Project Settings → Environment Variables, set at least **`DATABASE_URL`** (your Supabase connection string). Add any other keys the app uses (e.g. JWT secret).
3. Deploy. All routes are served via the serverless function; rewrites send every request to `/api`.

### Vercel request body limit

Vercel serverless functions have a **4.5MB** request body limit. Requests larger than that return `413 FUNCTION_PAYLOAD_TOO_LARGE` before reaching the app. For larger payloads (e.g. big template uploads), use direct upload to Supabase Storage (or similar) and pass references via the API.
