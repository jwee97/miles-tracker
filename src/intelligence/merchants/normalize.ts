import { normalizeKey, similarity } from '../../merchants/normalize';

/**
 * What a bank printed, taken apart into the pieces that mean different things.
 *
 * `normalizeKey` already produces a comparison key, and that is the right tool
 * for matching. But a key throws away facts worth keeping: which processor
 * routed the payment, which country the terminal was in, whether a reference
 * number was stripped. Those are evidence in their own right — "SQ *" tells
 * you a small merchant on Square, which predicts a different MCC distribution
 * from the same name arriving through an airline's own gateway.
 *
 * The raw descriptor is never destroyed. Everything here is additive: if the
 * parse is wrong, the original is still there to re-read.
 */

export interface NormalizedDescriptor {
  /** Exactly what the bank sent, untouched. */
  raw: string;
  /** Human-readable merchant text with routing noise removed. */
  normalized: string;
  /** The comparison key, from the existing normaliser. */
  key: string;
  /** Who routed the payment, when the descriptor says. */
  processor: string | null;
  /** Two-letter country, when the descriptor carries one. */
  country_hint: string | null;
  /** A reference or terminal number that was removed, kept for auditing. */
  reference: string | null;
}

/**
 * Processors that print themselves into the descriptor.
 *
 * Keyed by the marker as it appears; the value is the canonical name. Only
 * markers whose meaning is unambiguous are listed — a prefix that might be
 * part of a merchant's actual name is left alone, because merging two
 * merchants is much harder to notice afterwards than failing to merge them.
 */
export const PROCESSORS: { pattern: RegExp; name: string }[] = [
  { pattern: /^sq\s*\*/i, name: 'SQUARE' },
  { pattern: /^sqc?\s*\*/i, name: 'SQUARE' },
  { pattern: /^stripe\s*\*/i, name: 'STRIPE' },
  { pattern: /^paypal\s*\*/i, name: 'PAYPAL' },
  { pattern: /^pp\s*\*/i, name: 'PAYPAL' },
  { pattern: /^grab\s*\*/i, name: 'GRAB' },
  { pattern: /^amaze\s*\*/i, name: 'AMAZE' },
  { pattern: /^shopback\s*\*/i, name: 'SHOPBACK' },
  { pattern: /^fave\s*\*/i, name: 'FAVE' },
  { pattern: /^adyen\s*\*/i, name: 'ADYEN' },
  { pattern: /^2c2p\s*\*/i, name: '2C2P' },
  { pattern: /^nets\s+/i, name: 'NETS' },
  { pattern: /^wl\s*\*/i, name: 'WORLDLINE' },
];

/** Country marks a Singapore statement actually prints. */
const COUNTRIES: { pattern: RegExp; code: string }[] = [
  { pattern: /\b(singapore|sgp|\bsg)\b\s*$/i, code: 'SG' },
  { pattern: /\b(malaysia|mys|\bmy)\b\s*$/i, code: 'MY' },
  { pattern: /\b(hong\s*kong|hkg|\bhk)\b\s*$/i, code: 'HK' },
  { pattern: /\b(united\s*states|usa|\bus)\b\s*$/i, code: 'US' },
  { pattern: /\b(australia|aus|\bau)\b\s*$/i, code: 'AU' },
  { pattern: /\b(japan|jpn|\bjp)\b\s*$/i, code: 'JP' },
  { pattern: /\b(united\s*kingdom|\bgb|\buk)\b\s*$/i, code: 'GB' },
];

/** A trailing reference or terminal id: long digit runs that carry no meaning. */
const REFERENCE = /\s+([0-9]{4,})\s*$/;

export function parseDescriptor(raw: string | null | undefined): NormalizedDescriptor {
  const original = (raw ?? '').toString();
  let work = original.trim().replace(/\s+/g, ' ');

  let processor: string | null = null;
  for (const p of PROCESSORS) {
    if (p.pattern.test(work)) {
      processor = p.name;
      work = work.replace(p.pattern, '').trim();
      break;
    }
  }

  // A web address is a channel signal, not part of the name.
  work = work.replace(/^www\./i, '').replace(/^https?:\/\//i, '');

  // Country and reference are stripped in a loop rather than once each,
  // because a statement prints them together and in either order:
  // `… 8829 SINGAPORE SG` needs the country twice and the reference in
  // between. Stopping after one pass leaves half the noise behind, which
  // looks like it worked until you read the output.
  let country: string | null = null;
  let reference: string | null = null;

  for (let pass = 0; pass < 4; pass++) {
    const before = work;

    for (const c of COUNTRIES) {
      if (c.pattern.test(work)) {
        country = country ?? c.code;
        work = work.replace(c.pattern, '').trim();
        break;
      }
    }

    const ref = work.match(REFERENCE);
    if (ref) {
      reference = reference ?? ref[1];
      work = work.slice(0, ref.index).trim();
    }

    if (work === before) break;
  }

  work = work.replace(/[*\-_.]+$/g, '').replace(/\s+/g, ' ').trim();

  return {
    raw: original,
    normalized: work || original.trim(),
    key: normalizeKey(original),
    processor,
    country_hint: country,
    reference,
  };
}

/**
 * Whether two descriptors are plausibly the same merchant seen twice.
 *
 * Used only to group observations, never to assert an identity. The caller
 * decides what to do with a maybe.
 */
export function sameMerchantLikely(a: string, b: string): boolean {
  const pa = parseDescriptor(a);
  const pb = parseDescriptor(b);
  if (!pa.key || !pb.key) return false;
  if (pa.key === pb.key) return true;

  // A high bar on top of key equality, for the case keys cannot handle: the
  // same words printed in a different order. Deliberately above the 0.8 that
  // a prefix match scores, so `NTUC FAIRPRICE 123` and `NTUC FAIRPRICE` stay
  // apart — those are two outlets, and merging them would silently pool two
  // merchants' MCC evidence.
  return similarity(pa.key, pb.key) >= 0.85;
}
