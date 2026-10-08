# Implementation Plan — Personal Dashboard Overrides

Implements the P0 scope of `dashy-personal-overrides-prd.md`.

- **Pinned upstream commit:** `2bea3d753b5b8398720374553b487176f4b27d3d` (Dashy 4.7.20, 2026-10-08)
- **Branch:** `feature/personal-overrides`
- **Feature flag:** `ENABLE_USER_OVERRIDES=true` (server env). When it's off, every code path below is inert and stock Dashy behaviour is unchanged.

## 1. What exists today (verified in source)

| Concern | Location | Notes |
|---|---|---|
| Server entry | `server.js` → `services/app.js` | Express 5 app. All routes are registered in one chain in `app.js`. |
| Server auth | `services/app.js` `getAuthMiddleware()` | Picks one of: OIDC/Keycloak bearer verification (`services/utils/auth-oidc.js`, `jose` + JWKS, checks issuer/audience/exp), `express-basic-auth` (conf.yml users with `ENABLE_HTTP_AUTH`, or `BASIC_AUTH_*` env), or trusted-proxy header auth (`appConfig.auth.headerAuth`, `proxyWhitelist` IP check). Sets `req.auth`. `requireAuth` / `requireAdmin` gate routes. **When no server auth is configured, `requireAuth` is a no-op.** |
| Config served to browser | `app.js` `.get(/\.ya?ml$/i)` + `maybeBootstrapConfig()` | Unauthenticated users get a stripped "bootstrap" conf.yml with only `appConfig.auth`. Authenticated users get the full file, including every section, whatever `displayData` visibility says. |
| Disk writes | `POST /config-manager/save` (`services/endpoints/save-config.js`), and opt-in REST API `/api/config/*` (`services/endpoints/api/`, `ENABLE_API=true`) | Both gated by `requireAdmin`. Upstream gap: with header-auth or `BASIC_AUTH_*` and no `users[]`, `requireAdmin` falls through and lets **any** authenticated user write. |
| Frontend config load | `src/store.js` actions `INITIALIZE_ROOT_CONFIG` / `INITIALIZE_CONFIG`, invoked from `router.beforeEach` (`src/router.js`) | Fetches `/conf.yml`, then layers localStorage (`confSections`, `pageInfo`, `appConfig`, `confPages`, plus theme/layout/iconSize/language) on top via `readLocalOverrides()`. |
| Visibility rules | `src/utils/IsVisibleToUser.js`, `CheckSectionVisibility.js` | **Client-side only** (`showForUsers`, `hideForUsers`, `show/hideForGroups`, `show/hideForRoles`, `hideForGuests`, legacy keycloak keys). Not a security boundary. |
| Runtime item IDs | `src/utils/config/SectionHelpers.js` `applyItemId()` | Overwrites `item.id` with a positional hash on every load; `stripItemIds()` removes it before persisting. So `id` cannot be used as a stable identity. |
| Visual editor | `src/components/InteractiveEditor/*`, `LinkItems/Item.vue`, `Section.vue`, `ItemContextMenu.vue`, `SectionContextMenu.vue`; store mutations `INSERT_ITEM`, `UPDATE_ITEM`, `REMOVE_ITEM`, `INSERT_SECTION`, `UPDATE_SECTION`, `REMOVE_SECTION`, `SET_SECTIONS` | Mutates `state.config.sections`. Saving via `src/mixins/ConfigSaving.js` (`saveConfigLocally` → localStorage, `writeConfigToDisk` → `/config-manager/save`), surfaced in `EditModeSaveMenu.vue`. |
| Logout | `src/components/Settings/AuthButtons.vue`, `src/views/Login.vue` | OIDC/Keycloak redirect (full reload). Basic/conf-user logout uses `router.push('/login')` **without** a reload, so Vuex state survives into the next login. |
| Service worker | `vite.config.mjs` (workbox `runtimeCaching`) | Caches `*.yml` NetworkFirst. Off by default (`enableServiceWorker`). |
| Schema | `src/utils/config/ConfigSchema.json` | `additionalProperties: false` on sections and items, so any new YAML key must be added here. Used by the server validator and the editor. |
| Tests | `vitest` (`tests/server`, `tests/unit`, `tests/components`), `supertest` for HTTP | 592 tests, all passing on the pinned commit. |
| Runtime | Node `^22.22 \|\| ^24.15 \|\| >=26`, Docker `node:24-alpine`, UID 1000 | All supported versions ship `node:sqlite` (`DatabaseSync`), unflagged. |

## 2. Design decisions

1. **SQLite driver: built-in `node:sqlite`.** It adds no dependency and needs no native build on Alpine. It's synchronous, which is fine for a single writer and keeps transactions simple. On Node 22 it prints an ExperimentalWarning, which is harmless.
2. **Stable ID key: `stableId`** on sections and items. `id` is already taken by Dashy's runtime positional IDs, so it can't be reused. `stableId` is added to `ConfigSchema.json` as an optional string.
   - Global IDs: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, must **not** start with `usr-`.
   - Personal IDs: `usr-sec-<uuid>` / `usr-link-<uuid>`. There is also one reserved ID, `usr-sec-my-tools`, for the orphan bucket. The two namespaces can never collide.
   - Migration: `node services/personalization/assign-stable-ids.js [path]` writes deterministic slug IDs (`sec-<name>`, `link-<section>-<title>`, `-2` suffix on collisions) into conf.yml. It keeps comments (via the `yaml` Document API) and never changes existing IDs. Admins run it once and commit the result. At runtime, missing or duplicate IDs get a logged warning and a deterministic fallback ID (`auto-<hash>`), so the dashboard still renders. Those fallback IDs don't survive a rename, which is why the IDs should be committed.
3. **Server-side authorization filter.** `services/personalization/visibility.js` re-implements the `displayData` visibility rules using **server-verified** identity (username, plus groups/roles from verified token claims). Unauthorized sections/items are removed **before** merge, and their metadata never appears in `/api/me/*` responses.
4. **When the flag is on, `/conf.yml` no longer serves `sections`.** It serves `appConfig`/`pageInfo`/`pages` plus a `_personalization: { enabled: true }` marker. Sections come only from `/api/me/dashboard`. This closes the leak where any authenticated user could read every company link in the raw YAML.
5. **Identity.** `identityKey = issuer + "\u0000" + subject`.
   - OIDC/Keycloak: `iss` / `sub` from the verified JWT.
   - Trusted-proxy header auth: issuer `proxy-header:<header-name>`, subject = header value (only accepted from `proxyWhitelist` IPs, as in upstream).
   - HTTP basic auth: issuer `basic:conf-users` or `basic:env`, subject = lower-cased username. This is a documented weaker mode; OIDC is recommended.
   - Passwords and tokens are never stored. Display names are not stored at all.
   - No client-supplied identity is ever read. Requests with no `req.auth` get 401, **even when no auth is configured**: the feature refuses anonymous use.
6. **Preferences document** is validated with Ajv (already a dependency) plus semantic checks: unique IDs, length and array bounds, a URL scheme allowlist (default `https,http`, overridable with `USER_OVERRIDES_URL_SCHEMES`), icon format allowlist, target sections must be authorized or owned, and personal section names must not clash with visible section names. Unknown root keys are stripped; unknown nested keys are rejected. Hidden/order references to IDs outside the caller's authorized ∪ owned set are silently dropped on write. That way unauthorized and nonexistent IDs look the same to the caller (no existence oracle).
7. **Merge** (`services/personalization/merge.js`) is a pure function implementing PRD §9 exactly. It never mutates its input, ignores stale IDs, and moves orphaned personal links to **My Tools**. Ordering rule: saved order first, then new company items in YAML order, then unlisted personal items in creation order.
8. **Concurrency.** `PUT` and `DELETE` require `expectedRevision`. The compare-and-swap runs inside `BEGIN IMMEDIATE`. A stale revision returns 409 with the current revision. WAL mode, `busy_timeout=5000`, `foreign_keys=ON`.
9. **Editor adapter** (`src/utils/personalization/OverridesAdapter.js`) is a pure function. It turns the edited section list into an override document (it does not send the merged config to the server):
   - Company section/link missing after editing → hidden. Previously hidden IDs stay hidden until unhidden.
   - Positions → `sectionOrder` / `linkOrderBySection`.
   - Items/sections with no `stableId` or a `usr-` one → personal records, keeping only `title, url, description, icon`.
   - Edits to company link fields are ignored, because company data is centrally owned. A company link dragged into another section snaps back to its home section, since cross-section moves aren't in MVP scope.
   - Widgets in personal sections are dropped.
10. **UI changes stay small.** When personalization is active:
    - The edit-mode bottom bar shows **Save My Dashboard**, **Hidden Items** (an unhide manager), **Reset My Dashboard**, and **Cancel**, instead of Save Locally / Save to Disk / config-as-code / app-config / page-info / pages.
    - Company items show **Hide for me** instead of Edit/Move/Delete.
    - Company sections show **Hide for me** instead of Edit/Remove.
    - Edit mode shows a subtle "Company" or "Mine" badge. Normal browsing looks unchanged.
    - A 409 on save opens a dialog with **Overwrite with my changes** and **Discard & reload**, and the draft is kept until the user chooses.
    - Save failures show a retryable error toast and stay in edit mode.
11. **Disk-write hardening.** With the flag on, `/config-manager/save` and the write methods of `/api/config/*` return 403 unless `ALLOW_CONFIG_DISK_WRITES=true`. Admins change defaults through Git/deploy, as the PRD specifies. This is enforced on the backend, separately from the UI.
12. **Shared-browser safety.** The frontend never writes personalized data to localStorage. When the flag is on, it ignores the `confSections`/`confPages`/`pageInfo`/`appConfig` local keys; cosmetic theme/layout/iconSize/language keys still apply. `AUTH_CHANGED` (login/logout) wipes the in-memory root config and personalization state, so the next navigation re-fetches for the new identity. `/api/me/*` responses send `Cache-Control: private, no-store` and `Vary: Authorization, Cookie`, and are excluded from the service worker.
13. **CSRF.** Basic auth credentials are sent by the browser automatically, so they're as CSRF-prone as cookies. Writes require `Content-Type: application/json`, which forces a CORS preflight. They're also rejected if `Origin` (or `Sec-Fetch-Site: cross-site`) shows a cross-origin caller.
14. **Base config reload.** conf.yml is re-read when its mtime/size changes, checked at most once a second on request. A deployed YAML update shows up on each user's next fetch without a restart. `baseRevision` is a SHA-256 of the authorized, normalized base sections.

## 3. Files

**New (server)** — `services/personalization/`
- `index.js`: wiring and the feature flag.
- `db.js`: SQLite open, pragmas, versioned migrations, CRUD, `backup()`.
- `migrations.js`: the ordered migration list.
- `preferences.js`: schema, validation, normalization.
- `identity.js`: `req.auth` → identity key.
- `visibility.js`: server-side displayData rules.
- `base-config.js`: load conf.yml, cache by mtime, normalize stable IDs.
- `stable-ids.js`: ID rules and fallback generation.
- `merge.js`: pure merge.
- `routes.js`: the `/api/me` router.
- `assign-stable-ids.js`: migration CLI.
- `backup.js`: backup CLI (`VACUUM INTO`).

**Modified (server)**
- `services/app.js`: mount the router before the global JSON parser, add the disk-write gate, strip sections from `/conf.yml`, and add the DB readiness field to `/healthz`.

**New (frontend)**
- `src/utils/personalization/OverridesAdapter.js`: pure adapter.
- `src/utils/personalization/PersonalApi.js`: API client.
- `src/components/InteractiveEditor/PersonalSaveMenu.vue`: save/reset/hidden/conflict UI.

**Modified (frontend)**
- `src/store.js`: fetch the merged dashboard, add personalization state, ignore local structural keys, reset on `AUTH_CHANGED`.
- `src/utils/StoreMutations.js`
- `EditModeSaveMenu.vue`
- `ItemContextMenu.vue`, `Item.vue`
- `SectionContextMenu.vue`, `Section.vue`
- `EditItem.vue`, `EditSection.vue`: preserve `stableId`.
- `src/assets/locales/en.json`
- `ConfigSchema.json`: add `stableId`.
- `vite.config.mjs`: service worker deny-list.

**Ops**
- `Dockerfile`: `/app/data` owned by UID 1000, `VOLUME`, `DATABASE_PATH`.
- `docker-compose.personal.yml`: named volume, env.
- `docs/personal-overrides.md`: API, schema, setup, backup/restore, runbook.
- `BACKLOG.md`

**Tests (new)**
- `tests/unit/personal-merge.test.js`
- `tests/unit/personal-preferences.test.js`
- `tests/unit/personal-stable-ids.test.js`
- `tests/unit/personal-visibility.test.js`
- `tests/unit/personal-adapter.test.js`
- `tests/unit/personal-store.test.js`
- `tests/server/personal-db.test.js`: persistence, migrations, revision CAS, restart, backup/restore.
- `tests/server/personal-api.test.js`: two users, isolation, forged IDs, 401/400/403/409/413, CSRF, disk-write gate, conf.yml stripping.
- `tests/server/personal-api-oidc.test.js`: real JWT signature/issuer/audience validation against a local JWKS.

## 4. Phases (each can be tested on its own)

1. **Data core**: stable IDs, preferences schema, merge, visibility, DB and migrations. Unit and DB tests.
2. **API/security**: router, identity, revision handling, CSRF, disk-write gate, conf.yml stripping. Supertest suites covering basic, header, and OIDC auth.
3. **Frontend**: store load path, adapter, save/reset/hide/unhide/conflict UI, local-key isolation, auth-change reset. Adapter and store unit tests.
4. **Deployment/docs**: Dockerfile, compose, backup CLI, runbook, backlog.

## 5. Compatibility and security risks

- **Upstream merges.** Changes in `app.js`, `store.js`, and the editor components are small and guarded by the flag. Most logic lives in new files.
- **`stableId` in YAML** is optional in the schema. Stock Dashy ignores it at runtime, though upstream schema validation would warn about an unknown key if the YAML is used without this fork.
- **Sub-pages (`pages:`)** are not personalized. They keep upstream behaviour, including localStorage overrides for sub-pages. Documented as a limitation.
- **Client-side Dashy login** (conf.yml `users[]` without `ENABLE_HTTP_AUTH`) gives the server no identity, so personal endpoints return 401. Deployments must use OIDC/Keycloak, trusted-proxy headers, or `ENABLE_HTTP_AUTH`.
- **Header auth** is only as strong as the proxy configuration: the whitelist IP check, plus a proxy that strips inbound headers. Documented.
- **Basic-auth subject is the username.** Renaming a user orphans their preferences. Documented; OIDC is preferred.
- **`node:sqlite` on Node 22** is release-candidate stability, with a warning printed. The Docker image uses Node 24.
- **E2E browser tests** (two real browsers against a real IdP) are not automated here. Two-account/two-client behaviour is covered at the HTTP level and in the store unit tests. Listed in BACKLOG.

## 6. Acceptance status (PRD §14)

Results: `yarn test` passes all 725 tests (592 upstream + 133 new). `yarn lint`, `yarn typecheck` and `yarn build` are all clean.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Fresh account sees the full catalog and has no overrides | ✅ | `personal-api.test.js` › default catalog |
| 2 | A's personal link is invisible to B | ✅ | › isolation |
| 3 | A sees the same link and layout from a second client | ✅ HTTP-level | › isolation (fresh agent). Real two-browser E2E is in BACKLOG |
| 4 | Hide/unhide only affects A | ✅ | › isolation; `personal-adapter.test.js` |
| 5 | A new global link appears, unless its section is hidden | ✅ | › company default changes |
| 6 | A rename keeps A's hide | ✅ | › company default changes; `personal-merge.test.js` |
| 7 | A deleted link stops rendering and stale IDs are harmless | ✅ | same |
| 8 | A link in a deleted section moves to My Tools | ✅ | same; adapter round-trip |
| 9 | Order is stable and new defaults append deterministically | ✅ | same |
| 10 | Reset affects only A | ✅ | › reset |
| 11 | Account switch never reveals A's data | ✅ store-level | `personal-store.test.js` › account switch. Browser E2E is in BACKLOG |
| 12 | Forged `user_id` and unauthenticated requests are rejected | ✅ | › authentication, forged identities; OIDC and header suites |
| 13 | Two concurrent saves: the second gets 409 and the UI keeps the draft | ✅ | › concurrency; store + `personal-ui.test.js` |
| 14 | Malformed, `javascript:`, oversize, invalid-ID and unauthorized-target input is rejected | ✅ | › input validation; `personal-preferences.test.js` |
| 15 | DB survives restart; migrations and backup/restore work | ✅ | `personal-db.test.js`. Also checked in Docker (image `node:24-alpine`, UID 1000, named volume on `/app/data`): data survived `docker rm -f` and a fresh container on the same volume. Backup ran inside the container and restore worked. Conf.yml was mounted read-only, and save-to-disk returned 403 |
| 16 | Existing Dashy behaviour still works | ✅ | All 592 upstream tests pass; the feature flag is off by default |
| 17 | Ordinary users can't write conf.yml | ✅ | › global config protection |
| 18 | Unit, integration and E2E tests | ⚠️ partial | Unit and integration tests are done. Browser E2E isn't: see BACKLOG |
| Perf | p95 < 200 ms | ⚠️ not load-tested | Merge of 500 company + 100 personal links takes under 20 ms (unit test). Staging load test is in BACKLOG |
