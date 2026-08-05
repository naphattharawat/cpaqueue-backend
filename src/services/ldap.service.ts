import { Client } from 'ldapts';
import { readFileSync } from 'fs';

export type AuthUser = {
  username: string;
  displayName: string;
  cid: string;
  roles: string[];
};

export async function authenticateLdap(usernameInput: string, password: string): Promise<AuthUser> {
  const username = normalizeUsername(usernameInput);
  if (!username || !password) throw new Error('Invalid username or password');

  const client = new Client({
    url: requiredEnv('LDAP_URL'),
    tlsOptions: ldapTlsOptions(),
  });
  let bound = false;
  try {
    await client.bind(bindName(username), password);
    bound = true;
    const user = await findUser(client, username);
    if (!user) {
      console.warn(`LDAP bind succeeded but user search returned no entries for ${username}`);
      return {
        username,
        displayName: username,
        cid: '',
        roles: ['user'],
      };
    }
    return mapUser(username, user);
  } catch (err) {
    console.warn(`LDAP ${bound ? 'search' : 'bind'} failed for ${username}:`, err instanceof Error ? err.message : err);
    throw err;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

function normalizeUsername(value: string) {
  return String(value || '').trim().replace(/@.*/, '');
}

function bindName(username: string) {
  const suffix = requiredEnv('LDAP_DOMAIN_SUFFIX');
  return username.includes('@') ? username : `${username}${suffix}`;
}

async function findUser(client: Client, username: string) {
  const baseDn = requiredEnv('LDAP_BASE_DN');
  const restrictOu = process.env.LDAP_RESTRICT_OU || '';
  const searchBases = restrictOu ? [`${restrictOu},${baseDn}`, baseDn] : [baseDn];
  const filter = `(|(sAMAccountName=${escapeFilter(username)})(userPrincipalName=${escapeFilter(bindName(username))}))`;
  const attributes = ['sAMAccountName', 'displayName', 'cn', 'memberOf', process.env.LDAP_CID_ATTRIBUTE || 'employeeID'];
  for (const searchBase of searchBases) {
    try {
      const { searchEntries } = await client.search(searchBase, {
        scope: 'sub',
        filter,
        attributes,
        sizeLimit: 1,
      });
      if (searchEntries[0]) return searchEntries[0] as any;
    } catch (err) {
      console.warn(`LDAP search failed at ${searchBase}:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

function mapUser(username: string, entry: any): AuthUser {
  const cidAttr = process.env.LDAP_CID_ATTRIBUTE || 'employeeID';
  const memberOf = Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf] : [];
  const adminGroup = requiredEnv('LDAP_ADMIN_GROUP');
  const isAdmin = memberOf.some((dn: string) => groupMatches(dn, adminGroup));
  return {
    username: String(entry.sAMAccountName || username),
    displayName: String(entry.displayName || entry.cn || username),
    cid: String(entry[cidAttr] || ''),
    roles: isAdmin ? ['admin', 'user'] : ['user'],
  };
}

function groupMatches(dn: string, group: string) {
  const lower = String(dn || '').toLowerCase();
  const target = String(group || '').toLowerCase();
  return lower === target || lower.includes(`cn=${target},`) || lower.includes(`=${target},`);
}

function escapeFilter(value: string) {
  return String(value).replace(/[\\*()\0]/g, char => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function ldapTlsOptions() {
  const caPath = process.env.LDAP_CA_CERT_PATH || process.env.NODE_EXTRA_CA_CERTS;
  if (caPath) {
    return {
      ca: [readFileSync(caPath)],
      servername: process.env.LDAP_TLS_SERVER_NAME || undefined,
    };
  }
  if (process.env.LDAP_TLS_REJECT_UNAUTHORIZED === 'false') {
    return {
      rejectUnauthorized: false,
      servername: process.env.LDAP_TLS_SERVER_NAME || undefined,
    };
  }
  return process.env.LDAP_TLS_SERVER_NAME ? { servername: process.env.LDAP_TLS_SERVER_NAME } : undefined;
}
