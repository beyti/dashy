/**
 * Server-side twin of src/utils/IsVisibleToUser.js
 * Evaluates displayData visibility rules against a server-verified principal,
 * so hidden sections/items are removed before anything reaches the browser.
 * Principal: { username, groups: string[], roles: string[] }
 */

const lower = (s) => String(s).toLowerCase();
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const intersects = (a, b) => a.some((x) => b.includes(x));

/* New rule names take precedence over legacy show/hideForKeycloakUsers */
const pickRule = (list, legacyList) => (asList(list).length ? asList(list) : asList(legacyList));

function isVisibleToPrincipal(displayData, principal) {
  const dd = displayData && typeof displayData === 'object' ? displayData : {};
  const username = lower(principal?.username || '');
  const groups = asList(principal?.groups);
  const roles = asList(principal?.roles);

  if (asList(dd.hideForUsers).some((u) => lower(u) === username)) return false;
  const showForUsers = asList(dd.showForUsers);
  if (showForUsers.length && !showForUsers.some((u) => lower(u) === username)) return false;

  const legacyHide = dd.hideForKeycloakUsers || {};
  const hideForGroups = pickRule(dd.hideForGroups, legacyHide.groups);
  const hideForRoles = pickRule(dd.hideForRoles, legacyHide.roles);
  if (intersects(hideForGroups, groups) || intersects(hideForRoles, roles)) return false;

  const legacyShow = dd.showForKeycloakUsers;
  const showForGroups = pickRule(dd.showForGroups, legacyShow && legacyShow.groups);
  const showForRoles = pickRule(dd.showForRoles, legacyShow && legacyShow.roles);
  if (legacyShow || showForGroups.length || showForRoles.length) {
    if (!(intersects(showForGroups, groups) || intersects(showForRoles, roles))) return false;
  }
  // hideForGuests: personal endpoints never serve guests, so nothing to check
  return true;
}

/* Returns the sections + items this principal may see. Never mutates input */
function filterAuthorized(sections, principal) {
  return (sections || [])
    .filter((s) => isVisibleToPrincipal(s.displayData, principal))
    .map((s) => ({
      ...s,
      items: (s.items || []).filter((i) => isVisibleToPrincipal(i.displayData, principal)),
    }));
}

module.exports = { isVisibleToPrincipal, filterAuthorized };
