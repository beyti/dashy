# Backlog: Personal Dashboards

Items deliberately deferred from the P0 implementation (see `dashy-personal-overrides-prd.md`).

## P1 (from PRD)

- **FR-08: Import My Local Links.** A one-time, explicit import of old browser-local Dashy config (`confSections` etc.) after login, with a preview/diff and validation. Nothing is uploaded automatically. Today those keys are simply ignored while the feature is on.

## Verification gaps (P0 criteria covered differently than the PRD describes)

- **Browser-level E2E tests (AC18).** Two accounts × two real browsers against a real IdP. Today this is covered at the HTTP level (`tests/server/personal-api*.test.js`, including real JWT verification against a local JWKS) and at the store level (`tests/unit/personal-store.test.js`, account switch and draft preservation). Add Playwright against staging SSO.
- **Docker volume test (AC15) in CI.** This passed when run by hand against the built image, but it isn't in CI yet. Add it to `tests/docker-smoke-test.sh`: named volume → PUT preferences → `docker rm -f` → new container → GET, plus backup/restore.
- **Load test.** The PRD targets p95 < 200 ms with 500 company links and 100 personal links. The merge alone takes under 20 ms per call in unit tests. A real load test on staging hardware (autocannon/k6) is still needed.
- **Staging SSO check.** Run against the real company IdP: token audience/issuer, group claims for `showForGroups`, and logout/account switch.

## Nice to have

- A retry banner when `/api/me/dashboard` fails with 5xx (currently: empty dashboard plus a logged error).
- An explicit maintenance command to prune stale references from stored documents. They're already ignored at read time and dropped on the next save.
- Translations of the new `personal-dashboard.*` strings (only `en` exists).
- Personal sections with layout options (`displayData`), and personal sub-items.
- Optional keyed digest (`HMAC(secret, iss‖sub)`) for identity keys, if storing raw `iss`/`sub` becomes a privacy concern.
- An optional "Copy to my section" shortcut for company links, instead of Copy-or-Move.
