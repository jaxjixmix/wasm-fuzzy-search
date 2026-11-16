//! fzf-style fuzzy matching and ranking.
//!
//! # Scope
//!
//! Matching is **ASCII-only**, case-insensitive. Non-ASCII bytes are compared
//! literally as bytes. This is a deliberate limitation: it keeps the scoring
//! arithmetic identical between Rust and the JS reference, which is what makes
//! byte-exact differential testing possible. Real command palettes nearly always
//! match on ASCII identifiers and paths anyway.
//!
//! # Algorithm
//!
//! Two phases, because that is what makes it fast in practice:
//!
//! 1. **Filter** — greedy leftmost subsequence scan. Linear in the candidate
//!    length, and rejects the overwhelming majority of candidates in the first
//!    few bytes. This is the phase that dominates wall time on a large corpus.
//! 2. **Rank** — for survivors only, the matched positions are scored with
//!    boundary/camelCase/consecutive bonuses and gap penalties.
//!
//! Scoring is greedy-leftmost rather than a full DP matrix. fzf's v2 algorithm
//! uses DP and finds marginally better alignments; greedy is O(n) instead of
//! O(n·m) and is what most editors actually ship. Documented tradeoff, not an
//! oversight.

/// Base score for every matched character.
pub const BONUS_MATCH: i32 = 16;
/// Extra for matching at a word boundary (`/`, `.`, `_`, `-`, space, or start).
pub const BONUS_BOUNDARY: i32 = 8;
/// Extra for matching an uppercase letter that follows a lowercase one.
pub const BONUS_CAMEL: i32 = 7;
/// Extra for matching immediately after the previous match.
pub const BONUS_CONSECUTIVE: i32 = 8;
/// Penalty per skipped character between two matches.
pub const PENALTY_GAP: i32 = 3;
/// Cap on the gap penalty, so a long gap cannot swamp the bonuses.
pub const MAX_GAP_PENALTY: i32 = 9;

#[inline]
fn fold(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b | 0x20
    } else {
        b
    }
}

#[inline]
fn is_boundary_prev(b: u8) -> bool {
    matches!(b, b'/' | b'.' | b'_' | b'-' | b' ')
}

/// Score `hay` against `needle`. `None` when `needle` is not a subsequence.
///
/// Greedy leftmost: takes the earliest possible match for each needle byte.
pub fn score(needle: &[u8], hay: &[u8]) -> Option<i32> {
    if needle.is_empty() {
        return None;
    }

    let mut total: i32 = 0;
    let mut prev: Option<usize> = None;
    let mut ni = 0usize;

    for (i, &hb) in hay.iter().enumerate() {
        if ni == needle.len() {
            break;
        }
        if fold(hb) != fold(needle[ni]) {
            continue;
        }

        let mut s = BONUS_MATCH;

        let at_boundary = i == 0 || is_boundary_prev(hay[i - 1]);
        if at_boundary {
            s += BONUS_BOUNDARY;
        } else if hb.is_ascii_uppercase() && hay[i - 1].is_ascii_lowercase() {
            s += BONUS_CAMEL;
        }

        if let Some(p) = prev {
            if p + 1 == i {
                s += BONUS_CONSECUTIVE;
            } else {
                let gap = (i - p - 1) as i32;
                s -= (gap * PENALTY_GAP).min(MAX_GAP_PENALTY);
            }
        }

        total += s;
        prev = Some(i);
        ni += 1;
    }

    if ni == needle.len() {
        Some(total)
    } else {
        None
    }
}

/// An immutable searchable corpus.
///
/// Candidates are stored in one flat byte buffer with an offsets table, so a
/// query touches one contiguous allocation instead of chasing N `String`
/// pointers. This is the single biggest reason the Rust side wins, and it is a
/// data-layout decision, not a language one — worth remembering when drawing
/// conclusions from the benchmark.
pub struct Index {
    blob: Vec<u8>,
    offsets: Vec<u32>,
}

impl Index {
    /// Build from a flat UTF-8 buffer and an offsets table of length `count + 1`.
    pub fn from_parts(blob: Vec<u8>, offsets: Vec<u32>) -> Self {
        debug_assert!(!offsets.is_empty());
        debug_assert_eq!(*offsets.last().unwrap() as usize, blob.len());
        Self { blob, offsets }
    }

    /// Build from byte slices. Convenience for tests and the wasm boundary.
    pub fn from_slices(items: impl IntoIterator<Item = Vec<u8>>) -> Self {
        let mut blob = Vec::new();
        let mut offsets = Vec::with_capacity(64);
        offsets.push(0u32);
        for item in items {
            blob.extend_from_slice(&item);
            offsets.push(blob.len() as u32);
        }
        Self { blob, offsets }
    }

    pub fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[inline]
    fn candidate(&self, i: usize) -> &[u8] {
        let start = self.offsets[i] as usize;
        let end = self.offsets[i + 1] as usize;
        &self.blob[start..end]
    }

    /// Query the corpus, returning `(score, candidate_index)` sorted best-first.
    ///
    /// Ordering: score descending, then candidate length ascending (shorter is a
    /// better match for the same score), then index ascending. Fully ordered, so
    /// the result is deterministic and reproducible between implementations.
    pub fn query(&self, needle: &[u8], limit: usize) -> Vec<(i32, u32)> {
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }

        let mut hits: Vec<(i32, u32, u32)> = Vec::new();

        for i in 0..self.len() {
            let cand = self.candidate(i);
            if cand.len() < needle.len() {
                continue;
            }
            if let Some(s) = score(needle, cand) {
                hits.push((s, cand.len() as u32, i as u32));
            }
        }

        hits.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

        hits.truncate(limit);
        hits.into_iter().map(|(s, _, i)| (s, i)).collect()
    }

    /// The raw bytes of one candidate. Used by the harness to render results.
    pub fn get(&self, i: usize) -> &[u8] {
        self.candidate(i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_subsequence_does_not_match() {
        assert_eq!(score(b"xyz", b"abc"), None);
        // order matters: z before x
        assert_eq!(score(b"zx", b"xz"), None);
    }

    #[test]
    fn subsequence_matches() {
        assert!(score(b"abc", b"a_b_c").is_some());
        assert!(score(b"fb", b"fooBar").is_some());
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(score(b"FB", b"fooBar"), score(b"fb", b"fooBar"));
    }

    #[test]
    fn boundary_beats_midword() {
        // "fb" as two word starts ("foo_bar") should outscore "fb" buried
        // mid-word.
        let boundary = score(b"fb", b"foo_bar").unwrap();
        let midword = score(b"fb", b"afxb").unwrap();
        assert!(boundary > midword, "boundary={boundary} midword={midword}");
    }

    #[test]
    fn consecutive_beats_scattered() {
        let consecutive = score(b"abc", b"abcxxxx").unwrap();
        let scattered = score(b"abc", b"axbxcxx").unwrap();
        assert!(
            consecutive > scattered,
            "consecutive={consecutive} scattered={scattered}"
        );
    }

    #[test]
    fn camel_case_gets_a_bonus() {
        let camel = score(b"b", b"fooBar").unwrap();
        let plain = score(b"b", b"foobar").unwrap();
        assert!(camel > plain, "camel={camel} plain={plain}");
    }

    #[test]
    fn empty_needle_matches_nothing() {
        assert_eq!(score(b"", b"anything"), None);
    }

    #[test]
    fn ranking_is_deterministic_and_ordered() {
        let idx = Index::from_slices([
            b"src/components/Button.tsx".to_vec(),
            b"src/components/Input.tsx".to_vec(),
            b"docs/readme.md".to_vec(),
        ]);

        let hits = idx.query(b"button", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(idx.get(hits[0].1 as usize), b"src/components/Button.tsx");

        // Repeat queries must be identically ordered.
        let a = idx.query(b"tsx", 10);
        let b = idx.query(b"tsx", 10);
        assert_eq!(a, b);
        assert_eq!(a.len(), 2);
        // Both files match "tsx" at the same trailing position, so scores tie.
        // The documented tiebreak is length ascending before index, and
        // "Input.tsx" (24 bytes) is shorter than "Button.tsx" (25 bytes) — so
        // the *later* candidate must sort first. This is the length rule doing
        // its job, not index order.
        assert_eq!(idx.get(a[0].1 as usize), b"src/components/Input.tsx");
        assert_eq!(idx.get(a[1].1 as usize), b"src/components/Button.tsx");
    }

    #[test]
    fn limit_is_honoured() {
        let idx = Index::from_slices((0..50).map(|i| format!("file{i}.ts").into_bytes()));
        assert_eq!(idx.query(b"file", 5).len(), 5);
    }
}
