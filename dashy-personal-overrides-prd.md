# PRD: Dashy Enterprise Personalization

**Status:** Ready for implementation planning  
**Version:** 1.0 — 2026-10-09  
**Target:** Internal `tools.company.com` deployment, fork of [Lissy93/dashy](https://github.com/Lissy93/dashy)  
**Audience:** Engineering / coding agents (Codex, Claude Code)  
**Priority:** Reliable centrally maintained defaults plus persistent per-user customization

## 1. Executive summary

Fork Dashy to create an internal tool launcher. All authenticated employees see a company-managed base dashboard defined by Dashy's existing `user-data/conf.yml`. Each employee may add personal links, hide default links, organize sections, and reorder items without modifying the defaults or any other employee's dashboard. Personal overrides are stored server-side in a persistent SQLite database, keyed by a stable identity from validated SSO. Personal settings follow the user across devices and browsers. Company default changes propagate to everyone without wiping customizations.

**Core design principle:** `effectiveDashboard = merge(authorizedCompanyDefaults, validatedUserOverrides)`; never store a full copy of the company dashboard per user.

## 2. Context and problem

Dashy supports central YAML configuration, per-browser local edits, UI editing, and several authentication models. Per-browser local storage is not a durable per-account source of truth and can mask updates to `conf.yml`. We need per-authenticated-user persistent overrides with predictable merging and enterprise security.

**Primary users:** employees visiting `tools.company.com`. **Administrators:** engineering/platform owners who maintain the global config through Git and deployment (not through user endpoints).

## 3. Goals and non-goals

### MVP goals (P0)
1. Every authenticated user sees a centrally managed, authorized base link catalog.
2. Users can add/edit/delete personal links and personal sections, hide/unhide global links and sections, reorder sections/items, and reset their personalization.
3. Per-user changes persist across browsers, sessions, and app container restarts.
4. Global link additions, edits, and deletions propagate predictably without destroying personal changes.
5. User-specific operations are authenticated, authorized, isolated, validated, and test-covered.
6. Keep as much of upstream Dashy's UI, appearance, search, keyboard shortcuts, and existing functionality as possible.
7. Deploy using Docker with SQLite in a persistent volume; no external database dependency.

### Explicit non-goals (MVP)
- Cross-company sharing of personal layouts; collaboration or publishing personal links to others.
- Full RBAC editor for company defaults; admin defaults remain Git/YAML controlled.
- CRUD of global sections/items through the personal API.
- Multi-replica application instances or SQLite on shared network filesystems.
- Personalizing all arbitrary `appConfig` settings, custom widgets, pages, themes, or CSS. Preserve existing benign browser UI preferences where possible, but keep configuration/auth/security policy centrally controlled.
- User analytics, bookmark scraping/import, or automatic discovery.
- Replacing the identity provider or implementing custom password authentication.

## 4. Assumptions and decisions

- **Frontend:** Keep Dashy's existing Vue application, patch configuration loading, editing, and saving workflows.
- **Server:** Prefer extending the existing Node server and `services/` directory. Avoid reimplementing upstream proxy/status/widget functionality.
- **Base config:** `user-data/conf.yml` remains authoritative and is read-only for ordinary users. Admin editing may occur separately through Git/deploy. Disable or strictly gate conflicting 'Save to Disk' flows in this deployment.
- **Persistent data:** `/app/data/tools.sqlite` via Docker named volume/bind mount, NOT image layer.
- **Identity:** Stable OIDC issuer + subject (`iss`, `sub`) or an equivalently validated stable subject from trusted SSO middleware. Never identify a user by a client-provided `user_id`, display name, or localStorage value.
- **Login requirement:** Personal endpoints and user overrides require authentication. For MVP, no guest writes; anonymous use disabled in company deployment.
- **Scope:** Only sections and links are personalized. Global authorization/visibility filters are applied before merge. No personal override can reveal a centrally unauthorized item.
- **Stable IDs:** Introduce stable IDs for global sections and links, maintained in YAML, independent of titles, URLs, and ordering. Define a deterministic migration for existing records lacking IDs, then commit generated IDs to source config; do not dynamically regenerate on each launch.
- **Concurrency:** Single server container instance, SQLite WAL mode, parameterized SQL, transaction-backed updates.
- **Fork policy:** Minimize upstream changes; isolate custom behavior behind `ENABLE_USER_OVERRIDES` feature flag (default false outside custom deployment).

## 5. Personas and stories

**Employee**
- As an employee, I see the company's DevOps, Monitoring, Analytics, and other default links on first login.
- I can add a link to my own dashboard without affecting teammates.
- I can hide an irrelevant company link without deleting it globally.
- I can reorder my dashboard and see the same layout on another device.
- I can reset my personal changes and return to the latest company defaults.

**Administrator**
- As an administrator, I can edit the YAML defaults and roll out a new tool to all eligible employees, including those with custom layouts.
- I can rename/remove global links without leaving broken or duplicated personal copies.
- I can deploy/restart/restore without losing personal data.

## 6. Functional requirements

### FR-01 Default catalog (P0)
- Parse base Dashy YAML at startup and on supported reload mechanism; validate it and enforce stable global section/item IDs.
- Reuse the existing Dashy section/item format wherever possible, adding an optional stable identity property compatible with the chosen normalization layer. Avoid collisions with upstream fields; document mapping.
- Existing Dashy role-based display rules must be evaluated before personalized data is merged. Global URLs are **not secrets**; tool access is still enforced by destination apps.
- Global defaults cannot be changed via user preference endpoints.

### FR-02 Personal links/sections (P0)
- Allow user-owned sections and user-owned links; a personal link may be placed in a personal section or an eligible global section.
- Personal link fields: immutable UUID, title (required), HTTPS/HTTP URL (required; configurable company-safe scheme policy), description (optional), icon (optional), section ID, and order preference.
- Edit/delete only personal items. For global items, show **Hide**, not **Delete** or **Edit globally**. Global titles/URLs stay centrally owned.
- Ensure visible distinction between company and personal links in edit mode; normal browsing should remain visually clean.

### FR-03 Personal overrides (P0)
- Hide/unhide global section/link by stable ID; hiding a section hides it as a section, not delete its contents.
- Save item and section order using ordered ID arrays, NOT positional indexes or full duplicated objects.
- Personal links use UUIDs distinct from global IDs; IDs must not collide.
- Unsupported and unknown override references must not break rendering; ignore orphaned references at read time and optionally prune with explicit, safe maintenance.
- Newly introduced global links are visible by default unless their parent section is explicitly hidden. New sections appear in deterministic company order after already-ordered sections.
- Renaming or moving a global item with same stable ID preserves hide and order preference where possible; a moved global item follows the new section unless product policy explicitly supports cross-section user move (not MVP).
- Deleted global links disappear even if referenced by user preferences; user-owned links are unaffected.
- When a link is unauthorized for a given user, it must remain unavailable regardless of stored overrides; do not leak its metadata in personalized API responses.

### FR-04 Persistence (P0)
- SQLite database under `/app/data/` persistent mounted volume.
- User preferences keyed on normalized stable identity `(issuer, subject)` or opaque keyed hash thereof; email/username for display only, never ownership.
- Server stores a validated, versioned JSON preferences document with timestamps and optimistic revision (`version`).
- Database migrations are versioned and run on startup before serving traffic.
- Backups and restore documented. A single-machine SQLite database is sufficient for MVP.
- Browser localStorage is NOT authoritative for personalized links. Existing Dashy local config keys (`confSections`, `confPages`, `pageInfo`, `appConfig`) must not override the server-merged link catalog while this feature is enabled.

### FR-05 Authentication and authorization (P0)
- Verify authentication on the server for every `/api/me/*` call, using the selected Dashy-supported OIDC integration or trusted reverse-proxy auth with documented security boundary.
- If using OIDC, validate token signature against trusted keys, issuer, audience, expiration, and other required claims; do not trust an unverified decoded JWT.
- If using proxy headers, accept identity headers ONLY from the trusted proxy with direct backend access blocked and untrusted inbound headers stripped.
- Resolve identity from server-side verified claims; never accept `user_id`/`subject` from JSON, query strings or browser state.
- Prevent IDOR: a user can access/update only their own preferences. Admin role never implies access to arbitrary users' preferences unless a separately authorized, audited administrative operation is designed (not MVP).
- Apply CSRF defenses where cookie auth is used; protect API from cross-origin writes and configure secure cookie flags where applicable.
- Do not rely on Dashy's UI-only visibility rules as a security boundary for sensitive global metadata.

### FR-06 UX and editing (P0)
- Keep upstream Dashy rendering, navigation, search, and external-link launching unchanged.
- Reuse Dashy's visual editor where practical, but clearly separate a user-facing **Save My Dashboard** path from any existing shared **Save to Disk** path.
- On save success show confirmation; on error show a retryable error without discarding pending changes.
- Provide **Reset My Dashboard** with a confirmation dialog; clears all user overrides and shows latest authorized company defaults.
- On login, fetch merged dashboard and render only after personalization is resolved; no brief display of another user's previous local config.
- On logout or account switch, clear in-memory user data, cached responses, and personalized UI before rendering next account.
- Browser-local cosmetic preferences may remain if they are not identity-sensitive and do not interfere with server-owned link data.

### FR-07 Conflict behavior (P0)
- Each preferences update uses expected revision; stale revisions return HTTP 409 with current server revision.
- Frontend must offer reload/reapply or a deterministic conflict resolution path; must never silently overwrite concurrent changes from another device.
- Saving must be atomic with validation applied before transaction commit.

### FR-08 Migration (P1)
- Detect when old Dashy local configuration exists. Offer explicit one-time **Import My Local Links** flow after login, with preview/diff and validation. Do not automatically upload browser localStorage to server.
- Import personal additions and hides where safely distinguishable; ambiguous changes require user review.
- Clearing or abandoning import leaves company defaults and server-side preferences intact.

## 7. User experience and flows

**First login:** Authenticate -> server establishes user identity -> load authorized company base config -> load empty or existing user overrides -> merge -> show dashboard.

**Add personal link:** Click Add Link -> supply title/URL/section -> optimistic UI draft -> save -> API validates/persists -> refresh merged state -> other browser sees link after reload.

**Hide default link:** Open item menu -> Hide for Me -> save overrides -> link disappears only for this user -> provide discoverable management screen for hidden items and Unhide.

**Edit company default:** Deploy updated YAML -> server reload/restart -> new global link appears on each user's next fetch; hidden IDs remain hidden; removed global IDs no longer render.

**Reset:** Settings -> Reset My Dashboard -> confirm -> DELETE user preferences -> latest authorized defaults display.

**Switch account same browser:** Sign out A -> clear state -> sign in B -> load B from API -> never display A's data to B.

## 8. Data model

A versioned JSON document is appropriate for the small preference surface. Proposed SQL (exact syntax/migration framework may vary):

```sql
CREATE TABLE user_preferences (
  identity_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  preferences_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Suggested preference schema (illustrative; validate using Zod, JSON Schema, or equivalent):

```json
{
  "schemaVersion": 1,
  "personalSections": [
    { "id": "usr-sec-uuid", "title": "My Tools", "icon": "..." }
  ],
  "personalLinks": [
    { "id": "usr-link-uuid", "sectionId": "global-sec-devops", "title": "My Pipeline", "url": "https://ci.company.com/me", "description": "", "icon": "" }
  ],
  "hiddenGlobalSectionIds": [],
  "hiddenGlobalLinkIds": ["global-link-legacy-monitor"],
  "sectionOrder": ["global-sec-devops", "usr-sec-uuid"],
  "linkOrderBySection": {
    "global-sec-devops": ["global-link-ado", "usr-link-uuid"]
  }
}
```

**Schema rules:** all arrays bounded; uniqueness of IDs; limit title/description/URL lengths; whitelist allowed URL schemes (never `javascript:`, `data:`, `file:`); validate icons against supported safe formats; sanitize display rather than rendering arbitrary HTML; strip unknown root security-related fields; reject oversized payloads. Use JSON schema migrations for future versions. Personal records never contain passwords or OIDC tokens.

**Identity key:** canonical `issuer + '\\u0000' + subject` stored directly or an opaque keyed digest. Different issuers can have identical `sub`; a mutable username/email must not be used as the primary key.

## 9. Merge contract (deterministic)

1. Read validated base config and determine user-authorized sections and links.
2. Clone authorized config, never mutate base objects.
3. Remove global sections/items whose IDs are in the user's hidden sets, limited to authorized IDs.
4. Validate and append user-owned sections and links to valid authorized/owned target sections. If a target section was deleted, move an orphaned personal link to a synthetic/personal **My Tools** section rather than lose it; never relocate to an unauthorized global section.
5. Order sections and items according to saved ID order where present; append previously unlisted new company defaults in their YAML order, then unlisted personal items in saved creation order. Ignore stale IDs.
6. Return the fully merged, sanitized Dashy-compatible configuration, including a stable base revision/hash and preference revision.
7. Keep `appConfig` security, authentication and administrative values server-controlled; never allow preferences to overwrite these fields.

**Invariant:** any default addition that passes authorization is included for a user unless their parent section is hidden. Personal changes never modify the base config.

## 10. HTTP API contract

All endpoints below require validated authenticated identity. These are new endpoints, not a claim about stock Dashy APIs.

| Method | Route | Behavior |
|---|---|---|
| GET | `/api/me/dashboard` | Returns merged Dashy-compatible config, `baseRevision`, `preferenceRevision` |
| GET | `/api/me/preferences` | Returns validated override doc and revision; empty defaults if not created |
| PUT | `/api/me/preferences` | Replaces **only** caller's preference doc atomically; body includes `expectedRevision` |
| DELETE | `/api/me/preferences` | Clears caller's overrides, with revision check; returns current defaults on next GET |
| GET | `/api/healthz` or upstream health route | Existing health endpoint unchanged; database readiness check if feasible |

Example PUT:

```http
PUT /api/me/preferences
Content-Type: application/json

{
  "expectedRevision": 4,
  "preferences": { "schemaVersion": 1, "personalSections": [], "personalLinks": [], "hiddenGlobalSectionIds": [], "hiddenGlobalLinkIds": ["global-link-legacy-monitor"], "sectionOrder": [], "linkOrderBySection": {} }
}
```

**Expected responses:** `200` saved doc+new revision, `400` invalid input, `401` unauthenticated, `403` forbidden/unauthorized target, `409` stale revision, `413` oversized payload, `500` sanitized internal failure. Avoid exposing SQL, internal paths, secrets, tokens, or other users' records. Prefer `Cache-Control: private, no-store` on personalized responses.

## 11. Integration with upstream Dashy

Before coding, inspect the pinned Dashy fork commit and record relevant implementation locations in a brief `IMPLEMENTATION_PLAN.md`. Confirm current initialization, Vue store/state, localStorage handling, config save dialog, server auth middleware, server API structure, and relevant tests; do not guess file/function names.

Likely touchpoints based on public upstream documentation:
- `src/` frontend app, components, config/store logic and editor;
- `server.js` and `services/` Node routes/handlers;
- `user-data/conf.yml` authoritative base config;
- `Dockerfile`, `docker-compose.yml`, environment configuration.

When feature flag is enabled:
- Add an authenticated server request to load merged config.
- Replace personalized link persistence to `confSections`/local save with API persistence; ensure old cached `confSections` cannot override server result.
- Route visual editor edits through an adapter that maps user operations into override deltas. Do not simply send the whole edited merged Dashy config back as a personal document.
- Disable/hide upstream actions that could write global config for non-admins, and avoid confusion with local save. Harden backend routes independently from UI flags.
- Preserve all non-personalized upstream functionality and run upstream regression suite.

## 12. Deployment and operations

- Custom Docker image packages Dashy fork + API.
- Mount company YAML as `/app/user-data/conf.yml` (or existing equivalent) and DB directory `/app/data` as persistent named volume.
- Set `DATABASE_PATH=/app/data/tools.sqlite`, `ENABLE_USER_OVERRIDES=true`, and authenticated mode settings. These first two are custom-fork variables.
- Ensure app runs with least-privileged UID and writable DB directory; do not make base YAML writable by ordinary app endpoints if admin changes are managed via Git.
- SQLite: `PRAGMA journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` where applicable; one application writer instance; migrations at startup.
- Backup SQLite using SQLite online backup API or `VACUUM INTO`/safe snapshot mechanism, not unsafe live copying of an active WAL database; test restore. Protect backup access.
- Terminate HTTPS at trusted reverse proxy, block direct unauthenticated access, enforce same-origin API and acceptable content-security policy.
- Define a staging deployment and rollback procedure preserving DB/schema compatibility; make migration backups before upgrades.
- Log errors, migrations, and aggregate operational metrics; don't log preference payloads, auth tokens, or employees' private URLs unnecessarily.

## 13. Security and privacy checklist

- [ ] Stable server-verified identity from OIDC/proxy; no spoofable identity headers.
- [ ] Every personal route returns only authenticated caller's data.
- [ ] No user access to editing global config through new endpoints.
- [ ] Base access/visibility applied before merge and again on reads where necessary.
- [ ] URL schemes checked; XSS-safe rendering; icons constrained; JSON bounded.
- [ ] CSRF protection if cookies; secure/sameSite/httpOnly cookies when used.
- [ ] SQL parameters; no dynamic string-built queries using request data.
- [ ] Cross-account shared-browser cache cleared on logout and new login.
- [ ] No sensitive raw token in app logs or DB.
- [ ] Backups and database file protected by filesystem permissions.
- [ ] Review existing upstream HTTP routes for auth bypass; UI-only hiding is not security.

## 14. Acceptance criteria / test matrix

### Core tests (all P0)
1. Fresh account sees full authorized default catalog and zero overrides.
2. A adds a personal link; B does not see it.
3. A signs in on browser 2 and sees the same personal link/layout.
4. A hides global link X; B still sees X; A can unhide X.
5. Admin adds global link Y; A and B see Y after refresh, except when its parent section is hidden for a given user.
6. Admin renames global X with same ID; A's hide override still works.
7. Admin deletes X; X does not render; stale ID does not crash UI.
8. A's personal link in deleted global section survives and is placed in **My Tools**.
9. A's order is stable on refresh; new defaults are appended deterministically.
10. A resets preferences; A sees current default catalog, B unchanged.
11. Logging out A then logging in B in same browser never reveals A's preferences.
12. Forged `user_id` or unauthenticated request cannot read/write another account.
13. Two clients save with same old revision; first succeeds, second receives 409 and UI preserves draft.
14. Malformed JSON, `javascript:` URLs, enormous payloads, invalid IDs, and unauthorized target IDs are rejected safely.
15. DB survives container stop/recreate; migrations and backup/restore work.
16. Existing Dashy rendering, search, widgets, themes, navigation, and status behavior remain functional within supported scope.
17. Ordinary users cannot trigger upstream disk writes to `conf.yml`.
18. Unit tests cover merge edge cases; integration tests cover auth and persistence; end-to-end tests cover two accounts and two browsers.

**Performance guideline (initial target, not an upstream guarantee):** with up to 500 company links and 100 personal links/user, server merge plus DB access p95 < 200 ms under representative local/staging load, excluding SSO/network overhead. Use load tests to verify before declaring success.

## 15. Delivery plan and exit criteria

**Phase 0 — Repo reconnaissance:** Fork/pin upstream commit, inspect real modules and interfaces, document implementation plan and compatibility risks. Build unmodified Dashy. Identify auth strategy used for deployment and confirm server-side verification.

**Phase 1 — Data core:** Config stable IDs; SQLite store/migrations; validated preferences schema; pure merge function with unit tests.

**Phase 2 — APIs/security:** Authenticated `/api/me` routes, ownership isolation, optimistic concurrency, permission filtering, security tests.

**Phase 3 — Frontend integration:** Load merged config; add/hide/unhide/edit/reorder/reset; adapter from Dashy editor to preference overrides; no browser-local config conflict; error/409 UX.

**Phase 4 — Deployment/quality:** Docker volume config; CI tests; integration/E2E tests; backups; SSO staging; test company config update with existing overrides; README/runbook.

**MVP is complete when:** all P0 scenarios pass, two authenticated users in two browsers have isolated cross-device persistence, global catalog updates merge correctly, the DB survives redeployment, and global config cannot be modified via personal APIs.

## 16. Implementation guardrails for coding agents

1. Do not rewrite Dashy. Keep the original feature set and isolate changes.
2. Inspect the actual checked-out repository before committing to concrete file paths or dependencies.
3. Keep default configuration and user overrides as independent layers; never persist a full effective dashboard as the sole user record.
4. Never trust client-supplied identity or role; validate on server for every request.
5. Make merge deterministic, pure, unit-tested, and robust to stale references.
6. Prefer the smallest dependency footprint; use an SQLite driver compatible with the project's actual Node/Docker targets.
7. Use transactions and revisions to prevent silent overwrites.
8. Respect Dashy's MIT license and preserve required notices.
9. Put any intentionally deferred P1 items into `BACKLOG.md`; don't silently pretend they are implemented.
10. Before finishing, produce a change summary, schema/API documentation, setup instructions, test results, and identified limitations.

### Suggested first agent instruction

> Read `dashy-personal-overrides-prd.md`. Inspect the checked-out Dashy repository and pin the upstream commit. First create `IMPLEMENTATION_PLAN.md` mapping existing frontend config persistence, server auth middleware, and API hooks. Identify concrete compatibility and security risks. Then implement P0 in the listed phases with tests. Preserve existing Dashy behavior, keep company defaults in YAML, store only per-user override deltas in persistent SQLite, and never trust an identity supplied by the client. Do not claim completion until the acceptance tests pass.

## 17. External references (reviewed 2026-10-09)

- Dashy repository: https://github.com/Lissy93/dashy
- Development architecture: https://github.com/Lissy93/dashy/blob/master/docs/developing.md
- Configuration: https://dashy.to/docs/configuring/
- Privacy / local storage keys: https://dashy.to/docs/privacy/
- Authentication: https://dashy.to/docs/authentication/
- Built-in auth permissions/visibility caveats: https://dashy.to/docs/authentication/built-in/
- Management / standalone frontend limitations: https://github.com/Lissy93/dashy/wiki/management
- Troubleshooting / local config precedence: https://dashy.to/docs/troubleshooting/

**Note:** This document specifies new behavior for a fork; API paths, feature flags, SQLite structure, IDs, merge semantics, and user-facing actions are proposed requirements, not existing stock Dashy features. Verify source-level details against the exact fork commit before implementation.
