/**
 * dedup.ts — canonical dedup hashing (design §2.6).
 *
 * The dedup hash is the cross-lane key: an application in ANY lane (custom / aiapply /
 * jobright) blocks a re-apply in the others. The hash must therefore be stable across
 * sources, so we canonicalize aggressively before hashing.
 */

import { createHash } from "node:crypto";

/** Lowercase, strip punctuation/whitespace runs, drop common company suffixes. */
export function canonicalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|corp|corporation|co|co\.|gmbh|ag|sa|plc)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Lowercase, drop seniority/role noise that varies by source, collapse whitespace. */
export function canonicalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[(),/|–—-]+/g, " ")
    .replace(/\b(remote|hybrid|onsite|on-site|us|usa|united states)\b/g, " ")
    .replace(/[^a-z0-9+ ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Reduce location to a coarse token; remote postings collapse to "remote". */
export function canonicalizeLocation(location: string, remote: boolean | null): string {
  if (remote === true) return "remote";
  const loc = location.toLowerCase();
  if (/\bremote\b/.test(loc)) return "remote";
  // Keep only the first locality token (city) to absorb "City, ST, USA" variance.
  const first = loc.split(/[,/|]/)[0] ?? loc;
  return first.replace(/[^a-z0-9 ]+/g, " ").trim().replace(/\s+/g, " ");
}

/** sha256 of canonical company|title|location — the stored `dedup_hash`. */
export function computeDedupHash(
  company: string,
  title: string,
  location: string,
  remote: boolean | null = null,
): string {
  const key = [
    canonicalizeCompany(company),
    canonicalizeTitle(title),
    canonicalizeLocation(location, remote),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}
