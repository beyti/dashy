/**
 * Maps a server-verified `req.auth` into a stable identity + authorization principal.
 * Never reads identity from the body, query, or any client-controlled header
 * (header-auth values are only present after the trusted-proxy IP check in app.js).
 *
 * identityKey = issuer + '\u0000' + subject
 */

const asStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/* Same claim shapes as deriveIsAdmin() in utils/auth-oidc.js */
function claimsToGroupsRoles(claims, oidcSettings) {
  const groups = [...asStrings(claims.groups), ...asStrings(claims.groups_direct)];
  const roles = [...asStrings(claims.roles), ...asStrings(claims.realm_access?.roles)];
  const clientId = oidcSettings?.clientId;
  if (clientId) roles.push(...asStrings(claims.resource_access?.[clientId]?.roles));
  return { groups: [...new Set(groups)], roles: [...new Set(roles)] };
}

/**
 * @param req Express request, after the auth middleware ran
 * @param ctx { mode: 'oidc'|'basic-conf'|'basic-env'|'header'|'none', oidcSettings, headerName }
 * @returns { key, username, groups, roles } or null when unauthenticated
 */
function resolveIdentity(req, ctx) {
  const auth = req.auth;
  if (!auth || typeof auth !== 'object') return null;

  if (ctx.mode === 'oidc') {
    const { claims } = auth;
    if (!claims || typeof claims.iss !== 'string' || typeof claims.sub !== 'string'
      || !claims.iss || !claims.sub) return null;
    return {
      key: `${claims.iss}\u0000${claims.sub}`,
      username: String(auth.user || claims.sub),
      ...claimsToGroupsRoles(claims, ctx.oidcSettings),
    };
  }

  const user = typeof auth.user === 'string' ? auth.user.trim() : '';
  if (!user) return null;

  if (ctx.mode === 'basic-conf' || ctx.mode === 'basic-env') {
    // Usernames are matched case-insensitively by the basic-auth authorizer
    return {
      key: `basic:${ctx.mode === 'basic-conf' ? 'conf-users' : 'env'}\u0000${user.toLowerCase()}`,
      username: user,
      groups: [],
      roles: [],
    };
  }

  if (ctx.mode === 'header') {
    return {
      key: `proxy-header:${String(ctx.headerName || 'remote-user').toLowerCase()}\u0000${user}`,
      username: user,
      groups: [],
      roles: [],
    };
  }

  return null; // No server-side auth configured: personal data is never served anonymously
}

module.exports = { resolveIdentity, claimsToGroupsRoles };
