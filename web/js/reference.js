/**
 * JS reference implementation of fzf-style fuzzy matching.
 *
 * Written the way a competent frontend dev would write it. Not sabotaged.
 *
 * Idiomatic things that ARE included:
 * - the corpus stored as a *flat* Uint8Array blob + offsets table, exactly like
 *   the Rust side. This is the important one: it means the benchmark compares
 *   language/runtime, not data layout. If JS lost only because of String[]
 *   pointer chasing, the result would be meaningless.
 * - the two-phase filter-then-rank structure
 * - comparisons on raw bytes, no per-candidate string allocation
 *
 * Excluded, and left as follow-up work:
 * - Web Workers
 * - precomputed per-candidate lookup tables
 */

export const BONUS_MATCH = 16;
export const BONUS_BOUNDARY = 8;
export const BONUS_CAMEL = 7;
export const BONUS_CONSECUTIVE = 8;
export const PENALTY_GAP = 3;
export const MAX_GAP_PENALTY = 9;

/** Sentinel for "no match", mirroring i32::MIN on the Rust side. */
export const NO_MATCH = -2147483648;

const SLASH = 47, DOT = 46, UNDER = 95, DASH = 45, SPACE = 32;

function isBoundaryPrev(b) {
  return b === SLASH || b === DOT || b === UNDER || b === DASH || b === SPACE;
}

/** ASCII lowercase fold. Matches the Rust `fold` exactly. */
function fold(b) {
  return b >= 65 && b <= 90 ? b | 0x20 : b;
}

/**
 * Score `hay` against `needle`. Returns NO_MATCH when not a subsequence.
 * Greedy leftmost.
 */
export function score(needle, hay) {
  if (needle.length === 0) return NO_MATCH;

  let total = 0;
  let prev = -1;
  let ni = 0;
  const nl = needle.length;
  const hl = hay.length;

  for (let i = 0; i < hl; i++) {
    if (ni === nl) break;
    const hb = hay[i];
    if (fold(hb) !== fold(needle[ni])) continue;

    let s = BONUS_MATCH;

    const atBoundary = i === 0 || isBoundaryPrev(hay[i - 1]);
    if (atBoundary) {
      s += BONUS_BOUNDARY;
    } else if (hb >= 65 && hb <= 90 && hay[i - 1] >= 97 && hay[i - 1] <= 122) {
      s += BONUS_CAMEL;
    }

    if (prev >= 0) {
      if (prev + 1 === i) {
        s += BONUS_CONSECUTIVE;
      } else {
        const gap = i - prev - 1;
        const pen = gap * PENALTY_GAP;
        s -= pen < MAX_GAP_PENALTY ? pen : MAX_GAP_PENALTY;
      }
    }

    total += s;
    prev = i;
    ni++;
  }

  return ni === nl ? total : NO_MATCH;
}

/** Immutable searchable corpus over a flat byte blob + offsets table. */
export class Index {
  /**
   * @param {Uint8Array} blob    all candidates concatenated
   * @param {Uint32Array} offsets  length count+1, absolute offsets into blob
   */
  constructor(blob, offsets) {
    this.blob = blob;
    this.offsets = offsets;
    this.count = offsets.length - 1;
  }

  /** Build from an array of Uint8Array candidates. */
  static fromSlices(items) {
    let total = 0;
    for (const it of items) total += it.length;
    const blob = new Uint8Array(total);
    const offsets = new Uint32Array(items.length + 1);
    let at = 0;
    for (let i = 0; i < items.length; i++) {
      blob.set(items[i], at);
      at += items[i].length;
      offsets[i + 1] = at;
    }
    return new Index(blob, offsets);
  }

  candidate(i) {
    return this.blob.subarray(this.offsets[i], this.offsets[i + 1]);
  }

  /**
   * Returns [{score, index}] sorted best-first, capped at `limit`.
   *
   * Ordering: score desc, then length asc, then index asc — identical to the
   * Rust implementation, so results are directly comparable.
   */
  query(needle, limit) {
    if (needle.length === 0 || limit === 0) return [];

    const hits = [];
    const n = this.count;

    for (let i = 0; i < n; i++) {
      const start = this.offsets[i];
      const end = this.offsets[i + 1];
      const len = end - start;
      if (len < needle.length) continue;

      const cand = this.blob.subarray(start, end);
      const s = score(needle, cand);
      if (s !== NO_MATCH) hits.push({ score: s, len, index: i });
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.len !== b.len) return a.len - b.len;
      return a.index - b.index;
    });

    const out = [];
    const m = Math.min(hits.length, limit);
    for (let k = 0; k < m; k++) out.push({ score: hits[k].score, index: hits[k].index });
    return out;
  }
}
