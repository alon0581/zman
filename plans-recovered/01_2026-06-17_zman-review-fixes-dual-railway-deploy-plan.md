<!-- שוחזר מתמליל | שיחה: 534d1944-ba27-409d-8a6a-6e03b74b1889 | זמן: 2026-06-17 18:04 -->

# Zman — Review Fixes + Dual-Railway Deploy Plan

## Context

Two goals from the user:

1. **Review pass** — go over the codebase for bugs, security issues, and improvements, and apply **all** findings.
2. **Deploy Zman to a newly-purchased Railway** that lives **alongside "dad's site"** as a **separate Railway project**, without the two overriding each other.

On the deploy side, the good news: Railway **projects are fully isolated** — separate builds, env vars, domains, and volumes. So "without overriding each other" is already guaranteed by Railway's architecture *as long as* Zman doesn't accidentally reuse dad's project's GitHub auto-deploy hook, custom domain, or hardcoded URL. The current code hardcodes a single Railway URL in two spots and stores all user data on local files (which reset on every Railway deploy unless a Volume is mounted). The plan parameterizes the URLs and documents a clean second-project deploy.

On the review side, the exploration surfaced ~20 findings spanning a missing-import risk, timing-attack-prone comparisons, file-write race conditions, silent data-corruption handling, missing request timeouts, and input-validation gaps. All are folded in below, grouped by priority.

---

## Part A — Dual-Railway deployment (no override)

Because the two are **separate Railway projects**, the only things that could cause a clash are shared URLs / shared auto-deploy / shared domain. We fix the code so the URL is fully env-driven, then deploy as an independent project.

### A1. Parameterize the hardcoded Railway URL
- `capacitor.config.ts:9` — already falls back to `process.env.CAPACITOR_SERVER_URL`. Keep the env override but change the hardcoded default to a neutral placeholder comment so a copy of this repo doesn't silently point at the old/other project. The real URL is supplied via `CAPACITOR_SERVER_URL` at build time.
- `NEXT_PUBLIC_APP_URL` (used in OAuth redirects — `src/app/api/auth/oauth/**`, `src/lib/capacitor-push.ts`) must be set **per Railway project** to that project's own domain.

### A2. Document the second-project setup (no shared state)
Add/refresh `RAILWAY_ENV.txt` (or a short `DEPLOY.md`) describing, for the **new** project:
1. Railway → **New Project** → Deploy from the Zman GitHub repo (a *different* project from dad's; do **not** add the service into dad's existing project).
2. Variables to set on the new project only:
   - `AUTH_SECRET` (unique per project — never reuse dad's), `ENCRYPTION_KEY`, `OPENAI_API_KEY` (or `MINIMAX_API_KEY`), `VAPID_PRIVATE_KEY` + `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `NEXT_PUBLIC_APP_URL` = new project's URL, `CAPACITOR_SERVER_URL` = new project's URL.
3. **Volume** → mount path `/app/data` (each project gets its own volume — dad's data and Zman's data never mix).
4. If a custom domain is used, assign distinct domains per project.

### A3. Guard against shared auto-deploy
- Confirm `deploy.bat` pushes to the Zman repo only. If dad's site shares the same GitHub repo (it shouldn't), note that Railway's GitHub trigger is configured per-service, so each project watches its own repo/branch — call this out explicitly in the deploy doc so the user doesn't connect both projects to one repo.

**Files:** `capacitor.config.ts`, `RAILWAY_ENV.txt` (or new `DEPLOY.md`), review `deploy.bat`.

---

## Part B — Code fixes (all findings)

### Critical

1. **`crypto.randomUUID()` without explicit import** — `src/app/api/profile/route.ts:110`. Works on Node ≥20 via the global Web Crypto, but is fragile and inconsistent with the rest of the file. Add `import crypto from 'crypto'` to be safe and explicit. (Other routes that use `crypto.*` already import it.)

2. **Non-constant-time secret comparisons (timing attack)** — `src/lib/auth/index.ts:102` (`sig !== expected`) and `:141` (`hash !== user.passwordHash`). Replace with `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))`, guarding for equal length first (return invalid on length mismatch).

3. **Lost-update race in file storage** — `src/lib/demo/storage.ts` (all read-modify-write ops) and the inline memory writes in `src/app/api/chat/route.ts` + `src/app/api/profile/route.ts:103-120`. Two concurrent tool calls can clobber each other. Add a tiny per-`userId` async mutex utility (a `Map<string, Promise>` chain) in a shared `src/lib/util/fileLock.ts` and wrap each mutating op. Reuse it for events, tasks, memory, and profile writes.

4. **Silent data loss on corrupt JSON** — bare `catch { return [] }` in `storage.ts:28/49`, `auth/index.ts:73`, `profile/route.ts:30`. Change to `catch (err) { console.error('[storage] parse failed', file, err); return [] }`, and on parse failure of a non-empty file, back the file up to `<file>.corrupt-<ts>` before returning the default (timestamp passed in / `new Date().toISOString()` at call site) so the user's data isn't silently wiped on the next write.

### High

5. **No wall-clock timeout on the tool-call loop** — `src/app/api/chat/route.ts` (both the Anthropic and OpenAI `while (iterations < 10)` loops). Add a `MAX_DURATION_MS` (~25s) check at the top of each iteration; on exceed, break and return a graceful "took too long, try again" stream instead of hanging until the platform HTTP timeout.

6. **Tool-input validation is coerce-and-continue** — `src/app/api/chat/route.ts` `str()/num()/bool()` helpers + `executeTool`. Tighten so invalid/missing required fields (e.g. empty `title`, non-positive duration, unparseable dates) return a structured tool error that stops that tool's execution, rather than silently creating a degenerate event/task. Apply the same to `src/app/api/tasks/route.ts:43-56` (validate `title`/`estimated_hours`/`priority` types instead of trusting `body`).

7. **Shared userId path-safety helper** — `SAFE_ID_RE` only lives in `storage.ts:7`. The direct `path.join(process.cwd(),'data','users',userId,...)` constructions in `profile/route.ts:22,103` and the chat route bypass it. Export a single `assertSafeUserId(userId)` (from `src/lib/auth` or a util) and call it everywhere a userId becomes a path. Also fixes the latent bug that `demoStorage`'s `userId='demo'` default fails `SAFE_ID_RE` (`'demo'` isn't hex) — either drop the misleading default or special-case `'demo'`.

8. **Swallowed push errors in chat route** — the `.catch(() => {})` on `sendFcmPush(...)` / `sendPush(...)` in `src/app/api/chat/route.ts`. Change to `.catch(err => console.warn('[chat] push failed:', err?.message))`. (Note: `src/lib/push.ts` itself already logs internally and guards missing keys, so no change needed there beyond A/B9.)

9. **VAPID/Firebase config visibility** — `src/lib/push.ts:4-14`. Add a one-time module-load `console.warn` in production when `VAPID_PRIVATE_KEY`/`NEXT_PUBLIC_VAPID_PUBLIC_KEY` (or `FIREBASE_SERVICE_ACCOUNT`) are absent, so a misconfigured Railway project is obvious in logs rather than silently no-op.

### Medium

10. **Memory key/value size limits** — `src/app/api/chat/route.ts` `save_memory`. Reject keys >100 chars and values >~10 KB to prevent `memory.json` bloat from a runaway/jailbroken prompt.

11. **Unchecked Supabase upsert errors** — chat route `ai_memory` upsert loop (production/Supabase path). Capture `{ error }` and return/log it instead of ignoring.

12. **Duplicate-event check rigidity** — chat route create_event dedup (case-insensitive exact title + same day). Keep dedup but allow intentional repeats (e.g. numbered sessions) — relax to also compare start time, so "Study Math" at 10:00 and at 14:00 aren't treated as dupes.

### Low / cleanup

13. **Granular stream errors** — chat route stream `catch`: include a short `message` in the `{type:'error'}` SSE frame so the client can distinguish disconnect vs. AI/API failure.
14. **Time-field parsing hardening** — chat route `sleep_time`/`wake_time` `parseInt(...split(':')[0])`: clamp to 0–23, default safely on malformed values.
15. **Event list bound** — `src/app/api/events/route.ts`: add a `limit` param (capped) to the Supabase query for power users.
16. **`.env.local` hygiene** — confirm `.env.local` is git-ignored and that the real `OPENAI_API_KEY` currently sitting in it is not committed; rotate it if it ever was pushed. (Verification/advice step — no code change beyond `.gitignore` check.)
17. **Capacitor `webDir: 'out'` mismatch** — since `server.url` is set, native apps load the remote URL and `out/` is only needed to satisfy `cap sync`. Document this (no functional change needed) so nobody re-adds `output:'export'` to `next.config.ts` and breaks the server runtime.

---

## Suggested order of work

1. Part A (deploy wiring + doc) — unblocks the user's immediate goal.
2. Critical B1–B4 (security + data integrity).
3. High B5–B9.
4. Medium/Low B10–B17.

Shared helpers to add: `src/lib/util/fileLock.ts` (per-user async mutex) and an exported `assertSafeUserId()` — both reused across storage, auth, profile, and chat routes.

---

## Verification

- **Type check:** `npx tsc --noEmit` (no test framework in repo) and `npm run lint`.
- **Local smoke (demo mode):** `npm run dev` → exercise chat (create/move/delete event), tasks CRUD, profile save, memory save. Confirm concurrent rapid AI event creation no longer loses events (fire two create requests back-to-back and check count) — validates the file lock.
- **Auth:** register + login + bad-password login still behave correctly after the `timingSafeEqual` change; tampered session cookie still rejected.
- **Corrupt-data path:** hand-corrupt a `data/users/<id>/events.json`, hit the events API, confirm it logs + writes a `.corrupt-*` backup and returns empty instead of throwing.
- **Push:** with VAPID keys unset in dev, confirm the new startup warning logs and sends are no-ops (no crash).
- **Deploy (manual, user-driven):** create the **new** Railway project from the repo, set the env vars + `/app/data` volume, deploy, open the URL, register a user, reload — data persists (volume works) and dad's project is untouched (separate dashboard/project, own domain/volume).
