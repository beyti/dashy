# Personal Dashboards (Company Fork Feature)

> Fork-specific feature. It is not part of upstream Dashy. It's off unless `ENABLE_USER_OVERRIDES=true`.

Every signed-in employee sees the company dashboard from `user-data/conf.yml`. On top of that, each person can:

- add their own links and sections,
- hide company links or sections they don't need,
- reorder everything.

Personal changes are stored server-side in SQLite, keyed by the person's verified identity, so they follow the user across browsers and devices. Company YAML updates still reach everyone.

```
effectiveDashboard = merge(authorizedCompanyDefaults, validatedUserOverrides)
```

The server stores only each user's *override deltas*, never a copy of the company dashboard.

## Contents

- [Setup](#setup)
- [Stable IDs in conf.yml](#stable-ids-in-confyml)
- [Authentication requirements](#authentication-requirements)
- [How users personalize](#how-users-personalize)
- [Merge rules](#merge-rules)
- [HTTP API](#http-api)
- [Preferences schema](#preferences-schema)
- [Database](#database)
- [Backup and restore](#backup-and-restore)
- [Operations runbook](#operations-runbook)
- [Security model](#security-model)
- [Limitations](#limitations)

## Setup

1. **Assign stable IDs** to every section and link (one-off), and commit the result:
   ```bash
   node services/personalization/assign-stable-ids.js user-data/conf.yml
   git add user-data/conf.yml && git commit -m "Add stable IDs"
   ```
   In CI, `node services/personalization/assign-stable-ids.js user-data/conf.yml --check` fails if any ID is missing or duplicated.
2. **Configure server-side authentication.** OIDC/Keycloak is recommended. See [Authentication requirements](#authentication-requirements).
3. **Provision a MongoDB database** (Atlas, or any MongoDB 5+ instance) reachable from where the app runs. This is required - the app refuses to start with `ENABLE_USER_OVERRIDES=true` and no `MONGODB_URI`. Unlike the SQLite file this feature used before, Mongo isn't pod-local state, so the app has no single-replica or storage-class constraints: it works the same on a single Docker host or a multi-replica k8s Deployment.
4. **Deploy**:
   ```bash
   docker compose -f docker-compose.personal.yml up -d --build
   ```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ENABLE_USER_OVERRIDES` | unset (off) | Turns the feature on. |
| `MONGODB_URI` | none (required when the feature is on) | Connection string for the preferences database. |
| `MONGODB_DB_NAME` | `dashy` | Database name on that connection. |
| `USER_OVERRIDES_URL_SCHEMES` | `https,http` | Allowed URL schemes for personal links. `javascript`, `data`, `file`, `vbscript` and `blob` are always refused. |
| `USER_OVERRIDES_MAX_BODY` | `64kb` | Max request body for `/api/me/*`. Larger bodies get 413. |
| `ALLOW_CONFIG_DISK_WRITES` | unset | While the feature is on, upstream "Save to Disk" and `ENABLE_API` writes return 403. Set to `true` only if you deliberately want UI/API edits of `conf.yml`. |

## Stable IDs in conf.yml

```yaml
sections:
  - name: DevOps
    stableId: sec-devops          # never change once published
    items:
      - title: Azure DevOps
        stableId: link-devops-ado # rename/move-safe identity
        url: https://dev.azure.com/company
```

- `stableId` is an optional field on sections and items, and it's declared in `ConfigSchema.json`.
- Allowed format: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. It must not start with `usr-`, which is reserved for personal IDs.
- It's separate from Dashy's runtime `id`, which Dashy regenerates on every load from position and title.
- If you rename a title or URL, keep the ID: users' hides and ordering stay intact.
- If you delete an entry, its ID simply disappears. Stale references are ignored.
- Never reuse an ID for a different tool.
- Missing or duplicate IDs are logged at startup and get a deterministic fallback (`auto-<hash>`) so the page still renders. Fallback IDs change when the title changes, which is why IDs must be committed.

### Mapping

| Concept | conf.yml | Runtime (browser) | Preferences |
|---|---|---|---|
| Company section | `sections[].stableId` | `section.stableId` | `hiddenGlobalSectionIds`, `sectionOrder` |
| Company link | `sections[].items[].stableId` | `item.stableId` (`item.id` stays positional) | `hiddenGlobalLinkIds`, `linkOrderBySection` |
| Personal section | n/a | `stableId: usr-sec-<uuid>` | `personalSections[].id` |
| Personal link | n/a | `stableId: usr-link-<uuid>` | `personalLinks[].id` |
| Orphan bucket | n/a | `usr-sec-my-tools` ("My Tools") | reserved ID |

## Authentication requirements

Personal endpoints **always** require an identity verified by the server. Anonymous and guest users get 401, even if no auth is configured; the server logs a warning at startup in that case.

| Mode | Configure | Identity key (`issuer` + `\u0000` + `subject`) | Notes |
|---|---|---|---|
| OIDC / Keycloak (**recommended**) | `appConfig.auth.enableOidc` / `enableKeycloak` | verified token `iss` + `sub` | The JWT signature is checked against the IdP's JWKS, plus issuer, audience (`clientId`) and expiry. Groups and roles for visibility rules come from verified claims. |
| Cloudflare Zero Trust Access (**recommended**) | `appConfig.auth.enableCloudflareAccess`, `cloudflareAccess.teamDomain`, `cloudflareAccess.aud` | verified token `iss` + `sub` | The `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie) is checked against the team's own JWKS (`https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`), plus issuer, audience (the Access application's AUD tag) and expiry — a forged header alone is never enough, unlike trusted proxy headers below. Still requires the origin to be otherwise unreachable (e.g. only via a Cloudflare Tunnel), since Access is what enforces *who* gets in, not network isolation. |
| Trusted proxy headers | `appConfig.auth.enableHeaderAuth`, `headerAuth.userHeader`, `headerAuth.proxyWhitelist` | `proxy-header:<header>` + header value | Accepted only from IPs in `proxyWhitelist`. The proxy **must** strip any inbound copy of the header, and the app port must not be reachable except through the proxy. Bind the port to localhost or a private network. |
| HTTP basic auth | `ENABLE_HTTP_AUTH=true` + `appConfig.auth.users`, or `BASIC_AUTH_USERNAME/PASSWORD` | `basic:conf-users` / `basic:env` + lower-cased username | Weaker. Renaming a user orphans their record. Passwords are never stored. |

The Dashy client-side login (conf.yml `users` without `ENABLE_HTTP_AUTH`) gives the server no identity, so it **cannot** be used with this feature.

Display names and emails are never stored. The identity key is the only ownership field.

## How users personalize

| Action | Where |
|---|---|
| Add a personal link | Edit mode → "Add new item" in any section. The link belongs to that user. |
| Add a personal section | Edit mode → "Add new section". |
| Edit/delete a personal link or section | Edit mode → item/section menu (Edit, Remove). |
| Hide a company link or section | Right-click → **Hide for me**. Outside edit mode this saves immediately; in edit mode it's saved with **Save My Dashboard**. |
| Unhide | Edit mode → **Hidden Items** → Restore → **Save My Dashboard**. |
| Reorder | Drag and drop in edit mode → **Save My Dashboard**. |
| Reset | Edit mode → **Reset My Dashboard** → confirm. This deletes all of the user's overrides. |

In edit mode, every tile shows a small **Company** or **Mine** badge. Normal browsing looks exactly like stock Dashy.

Company links can't be edited or moved to another section. If a user drags one into another section, it snaps back to its home section on save. Copying it with *Copy or Move → Copy* creates a personal copy instead. Widgets are company-managed: personal sections can't hold widgets.

**Save errors** keep the user in edit mode with their draft intact; clicking Save again retries.

**Conflicts (409):** if the dashboard was saved from another device in the meantime, the user chooses one of:

- **Overwrite with my changes**: an explicit, informed overwrite.
- **Discard my changes & reload**
- **Keep editing**

Nothing is ever overwritten silently.

## Merge rules

This is the deterministic algorithm implemented in `services/personalization/merge.js`.

1. Load conf.yml and normalize stable IDs.
2. **Authorize**: apply `displayData` visibility rules on the server, using verified identity. The rules are `showForUsers`/`hideForUsers`, `show/hideForGroups`, `show/hideForRoles`, and the legacy keycloak keys. Unauthorized entries are removed before anything else, and their metadata never appears in `/api/me` responses.
3. Remove hidden sections and links. Only authorized IDs count.
4. Add personal sections, then personal links:
   - A link goes into its target section if that section is an authorized company section or one of the user's own sections.
   - Otherwise it goes into **My Tools**. A link is never relocated into another company section.
   - Personal links in a hidden company section are hidden with that section, not deleted.
5. Order:
   - First, entries listed in the saved `sectionOrder` / `linkOrderBySection`.
   - Then unlisted company entries, in YAML order.
   - Then unlisted personal entries, in creation order.
   - Stale IDs are ignored.
6. Inputs are never mutated. The same inputs always produce the same output.

Consequences:

- A new company link shows up for everyone on their next fetch, unless its parent section is hidden for that user.
- A deleted company link disappears even if someone referenced it.
- A renamed link (same ID) keeps its hide and ordering preferences.

Changes to conf.yml on disk are picked up within about a second, without a restart. The server checks mtime and size.

## HTTP API

All routes require authentication and respond with `Cache-Control: private, no-store`. No route accepts a user ID; the caller can only ever reach their own record.

| Method | Route | Body | Success |
|---|---|---|---|
| GET | `/api/me/dashboard` | — | `{ config: { pageInfo, appConfig, pages, sections }, hidden: { sections, links }, catalog, preferences, baseRevision, preferenceRevision }` |
| GET | `/api/me/preferences` | — | `{ revision, preferences, updatedAt }` (revision `0` and empty defaults if never saved) |
| PUT | `/api/me/preferences` | `{ expectedRevision, preferences }` | `{ revision, preferences }`, the normalized document that was stored |
| DELETE | `/api/me/preferences` | `{ expectedRevision }` (or `?expectedRevision=`) | `{ revision: 0, preferences: <defaults> }` |
| GET | `/healthz` | — | adds `database: "ok"`; returns 503 if the DB is unavailable |

Error codes:

| Code | Meaning |
|---|---|
| 400 | Invalid document, malformed JSON, or bad `expectedRevision` |
| 401 | Not authenticated |
| 403 | Cross-origin write, or a personal link targets a section the user can't use |
| 409 | Stale `expectedRevision`. The body includes `currentRevision`. |
| 413 | Body too large |
| 415 | Non-JSON write |
| 500 | Generic message only |

When the feature is on, `/conf.yml` is served **without `sections`** (plus `_personalization: { enabled: true }`). Sections reach the browser only through the authorized, merged `/api/me/dashboard`.

## Preferences schema

```json
{
  "schemaVersion": 1,
  "personalSections": [{ "id": "usr-sec-<uuid>", "title": "My Tools", "icon": "fas fa-star" }],
  "personalLinks": [{ "id": "usr-link-<uuid>", "sectionId": "sec-devops", "title": "My Pipeline", "url": "https://ci.company.com/me", "description": "", "icon": "" }],
  "hiddenGlobalSectionIds": [],
  "hiddenGlobalLinkIds": ["link-legacy-monitor"],
  "sectionOrder": ["sec-devops", "usr-sec-<uuid>"],
  "linkOrderBySection": { "sec-devops": ["link-devops-ado", "usr-link-<uuid>"] }
}
```

Validation is in `services/personalization/preferences.js`:

- Unknown root keys are stripped. Unknown nested keys are rejected.
- Size limits:
  - at most 50 personal sections and 300 personal links;
  - ID lists of at most 2000 entries;
  - titles up to 120 characters, descriptions up to 500, URLs up to 2048, icons up to 256.
- IDs must be unique and match the `usr-` patterns.
- URLs must parse and use an allowed scheme. Whitespace and control characters are rejected.
- Icons must be a Dashy icon name or emoji, or an http(s) URL. No `javascript:`/`data:` URIs and no HTML characters.
- Personal section titles must not clash with each other or with company section names.
- Hide and order references to anything other than the caller's authorized or owned IDs are dropped silently, so the API reveals nothing about IDs the caller can't see.

## Database

A single MongoDB collection, `user_preferences`, in the database named by `MONGODB_DB_NAME`:

```js
{
  identityKey: String,       // issuer '\u0000' subject - unique index
  schemaVersion: Number,
  revision: Number,          // optimistic concurrency
  preferencesJson: String,   // opaque JSON; see "Preferences schema" above
  createdAt: Date,
  updatedAt: Date,
}
```

`preferences` is stored as a JSON string rather than a native subdocument: `linkOrderBySection`'s
keys are stableIds, and stableIds allow `.` - unsafe as a literal BSON field name. The app never
queries inside preferences server-side, so nothing is lost by keeping it opaque.

**Writes:** no transactions - every write only ever touches the one document for the caller's
own identity. Revision checks are atomic compare-and-set (`updateOne` matching the expected
`revision`, or `insertOne` relying on the unique index to reject a concurrent first write).

**Index:** `{ identityKey: 1 }`, unique, created on startup (idempotent - safe to run on every
boot, including across multiple replicas starting concurrently).

**Schema version:** unlike the old single-writer SQLite file, this collection can be read by
multiple app versions at once during a rolling deploy, so there's no startup-time version ratchet.
A per-document `schemaVersion` newer than this app understands just degrades that one document to
empty preferences (logged, not fatal) rather than refusing to boot.

**Deployment:** no replica or storage-class constraints - this is exactly why personalization
moved off pod-local SQLite. Any number of app replicas can point at the same MongoDB.

## Backup and restore

Backups are MongoDB's job, not the app's: use your provider's point-in-time/continuous backups
(e.g. Atlas), or `mongodump`/`mongorestore` against the `user_preferences` collection directly.
There's no app-level backup script for this store.

## Operations runbook

- **Rolling out a new company tool:**
  1. Add the item with a new `stableId`.
  2. Run `assign-stable-ids.js --check` in CI.
  3. Deploy.
  
  Users see the tool on their next page load.
- **Renaming or retiring a tool:** edit the title/URL and keep the ID, or delete the entry. Never reassign an ID to a different tool.
- **Upgrading the app:** deploy to staging with a copy of production data first, since the
  database is shared, external state rather than something recreated per container.
- **Logging:** errors are logged. Preference payloads, tokens and URLs are not.
- **Restarting or recreating the container:** no impact - the data lives in MongoDB, not in the
  container, so this is safe on any number of replicas and any Docker/k8s restart or reschedule.

## Security model

- Identity comes only from server-verified auth (`services/personalization/identity.js`). No `user_id` from the body, query, headers or localStorage is ever read.
- Every `/api/me` call authenticates independently, so there's no IDOR surface. An admin role grants no access to other users' records.
- **Authorization:** visibility filtering happens on the server, before the merge. It's applied again on every read; stored references to IDs a user has lost access to are ignored.
- **CSRF:** writes must be `application/json` (which forces a CORS preflight). Requests with a mismatched `Origin`, `Origin: null`, or `Sec-Fetch-Site: cross-site` are rejected.
- **Global config is read-only:** with the feature on, `/config-manager/save` and the write methods of `/api/config/*` return 403. Personal endpoints have no code path to conf.yml. Mount conf.yml read-only.
- **Stored data and shared browsers:**
  - Personal data is never written to localStorage.
  - The legacy `confSections`/`confPages`/`pageInfo`/`appConfig` local keys are ignored while the feature is on. Cosmetic theme, layout, size and language choices still apply.
  - Login and logout wipe the in-memory dashboard.
  - `/api/me` is excluded from the service worker cache.
- **Rendering:** links render through Dashy's existing templates. Titles are text-interpolated, and the HTML tooltips (title, description) are sanitized with DOMPurify. URLs and icons are allow-listed on the server.
- **Upstream gap:** with header auth or `BASIC_AUTH_*` and no `users[]`, upstream `requireAdmin` lets every authenticated user write conf.yml. The disk-write gate above closes this gap for this deployment.

## Limitations

- **Sub-pages** (`pages:`) aren't personalized; they keep upstream behaviour.
- Personalized `appConfig`, themes, widgets and CSS are out of scope. Cosmetic quick-picker choices stay browser-local.
- Personal links store only title, URL, description and icon.
- Users can't move company links between sections (snap-back rule).
- If loading the personal dashboard fails with a non-401 error, the dashboard renders empty and the error is logged to the console/error log. There's no retry banner yet.
- See [`BACKLOG.md`](../BACKLOG.md) for deferred items.
