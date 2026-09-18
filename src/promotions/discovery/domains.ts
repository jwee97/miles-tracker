import { TIER } from './sources';

/**
 * Who a domain is, and therefore what a page from it is worth.
 *
 * This exists because of a subtlety that is easy to get wrong: a search engine
 * is not the source of a financial claim. Brave returning a MileLion article
 * does not make that article a tier-4 search result — it is still a specialist
 * publication, and the search engine was only the way it was found. Trust
 * belongs to the destination, never to the route.
 *
 * Getting this backwards would quietly wreck corroboration: two specialist
 * articles found through search would score as two search results, never reach
 * secondary verification, and every offer discovered that way would sit in the
 * review queue forever.
 */

/** Issuer domains, where a page is the bank speaking for itself. */
export const OFFICIAL_DOMAINS: Record<string, string> = {
  'dbs.com.sg': 'DBS',
  'posb.com.sg': 'POSB',
  'uob.com.sg': 'UOB',
  'citibank.com.sg': 'Citi',
  'ocbc.com': 'OCBC',
  'hsbc.com.sg': 'HSBC',
  'sc.com': 'Standard Chartered',
  'maybank2u.com.sg': 'Maybank',
  'americanexpress.com': 'American Express',
  'bankofchina.com': 'BOC',
  'cimb.com.sg': 'CIMB',
  'trustbank.sg': 'Trust Bank',
};

/** Publications whose whole subject is this, and comparison sites, which are not the same thing. */
export const DOMAIN_TRUST: Record<string, number> = {
  'milelion.com': TIER.specialist,
  'mainlymiles.com': TIER.specialist,
  'moneysmart.sg': TIER.comparison,
  'blog.moneysmart.sg': TIER.comparison,
  'singsaver.com.sg': TIER.comparison,
  'seedly.sg': TIER.comparison,
  'valuechampion.sg': TIER.comparison,
};

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Match a host against a registry, allowing subdomains.
 *
 * `promotions.dbs.com.sg` is DBS; `dbs.com.sg.phishing.test` is not, which is
 * why the boundary is a dot rather than a substring.
 */
function lookup<T>(host: string, registry: Record<string, T>): T | null {
  if (registry[host] !== undefined) return registry[host];
  for (const key of Object.keys(registry)) {
    if (host.endsWith(`.${key}`)) return registry[key];
  }
  return null;
}

/** The issuer a domain speaks for, or null when it speaks for nobody. */
export function issuerForUrl(url: string): string | null {
  const host = hostOf(url);
  return host ? lookup(host, OFFICIAL_DOMAINS) : null;
}

export const isOfficialUrl = (url: string, issuer?: string | null): boolean => {
  const owner = issuerForUrl(url);
  if (!owner) return false;
  return issuer ? owner.toLowerCase() === issuer.toLowerCase() : true;
};

/**
 * What a page from this URL is worth, whatever found it.
 *
 * Unknown is `TIER.unknown` rather than `TIER.search`: a domain nobody
 * recognises is not a search engine, it is a site the app has no opinion
 * about, and those score differently.
 */
export function trustTierForUrl(url: string): number {
  const host = hostOf(url);
  if (!host) return TIER.unknown;
  if (lookup(host, OFFICIAL_DOMAINS)) return TIER.official;
  const known = lookup(host, DOMAIN_TRUST);
  return known ?? TIER.unknown;
}

/** A readable name for a host, for the screens that show where something came from. */
export function sourceNameForUrl(url: string): string {
  const host = hostOf(url);
  if (!host) return 'an unknown source';
  const issuer = lookup(host, OFFICIAL_DOMAINS);
  if (issuer) return issuer;
  const NAMES: Record<string, string> = {
    'milelion.com': 'The MileLion',
    'mainlymiles.com': 'Mainly Miles',
    'moneysmart.sg': 'MoneySmart',
    'blog.moneysmart.sg': 'MoneySmart',
    'singsaver.com.sg': 'SingSaver',
  };
  return lookup(host, NAMES) ?? host;
}
