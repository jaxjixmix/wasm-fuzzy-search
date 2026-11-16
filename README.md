# wasm-fuzzy-search

fzf-style fuzzy search, implemented twice: pure Rust compiled to wasm32, and an
idiomatic JS reference. Differential-tested to exactness, then benchmarked.

The question: **would you actually rewrite your command palette in Rust?**

I predicted 5–10x. I measured **2.4–3.3x**. That gap is the interesting part, and
it's documented below rather than buried.

## Results (Apple M-series, Node v24 / V8, Rust 1.100, `--release`, lto=true)

### Correctness — exact, not "close enough"

| Corpus | Checks | Result |
|---|---|---|
| 500 paths | 5,000 score comparisons + 10 ranked queries | identical |
| 5,000 paths | 50,000 score comparisons + 10 ranked queries | identical |
| 50,000 paths | **500,000 score comparisons** + 10 ranked queries | identical |

Score parity is checked exhaustively — every corpus item against every query,
including the no-match sentinel. Query parity checks the full `(score, index)`
sequence *in order*, so a tie-breaking disagreement fails the build.

### Latency (10 queries, median of 12 runs)

| Corpus | JS total | WASM total | Speedup | JS/query | WASM/query |
|---|---|---|---|---|---|
| 500 | 0.56 ms | 0.17 ms | **3.31x** | 0.06 ms | 0.02 ms |
| 5,000 | 5.87 ms | 2.32 ms | **2.53x** | 0.59 ms | 0.23 ms |
| 50,000 | 62.24 ms | 25.73 ms | **2.42x** | 6.22 ms | 2.57 ms |

## The important negative result

I said in conversation this would land around 5–10x. It didn't. It's ~2.5x, and
the reasons are worth understanding because they generalise to any "rewrite JS
in Rust" decision:

1. **The JS baseline already has the good data layout.** Both sides search a flat
   `Uint8Array` blob with an offsets table, not `String[]`. Pointer-chasing was
   never the bottleneck, because I removed it from the JS side too. If you
   benchmarked Rust-blob against JS-`String[]`, you'd get a fake 10x that says
   nothing about languages.

2. **V8 is genuinely good at this.** Fuzzy matching is a byte-at-a-time branch
   loop with an early exit. That's the shape V8's optimiser handles well, unlike
   the wide typed-array stores that made `threshold` 12x in
   [wasm-image-lab](https://github.com/jaxjixmix/wasm-image-lab).

3. **The work is memory-bound, not compute-bound.** Both implementations stream
   the same bytes. Rust's advantage is instruction efficiency, and instruction
   efficiency stops mattering when you're waiting on cache.

4. **Per-keystroke reality check:** at 50k paths, 2.57 ms per query is *already
   under the 16 ms frame budget* for the JS version at 6.22 ms. So for a typical
   command palette neither implementation drops frames — the win is headroom for
   bigger corpora (500k paths) or slower machines, not a felt improvement at 5k.

That last point is the honest bottom line: **at normal corpus sizes, this rewrite
buys headroom, not a visible speedup.** Shipping it would be justified by
allocation behaviour and predictability, not by the millisecond number.

## Why the comparison is fair

Things that could have made this dishonest, and what I did instead:

- **Sabotaging the JS side** — it uses the same flat blob layout, same two-phase
  filter/rank structure, same greedy algorithm. Only the language differs.
- **Skipping the hard part of the API** — the benchmark times `query_index`
  including the wasm boundary call and the result write-back, because that's what
  a keystroke actually costs.
- **Not checking correctness** — 550k comparisons run in CI on every push.
- **Comparing different algorithms** — both are greedy leftmost. fzf's v2 uses DP;
  neither side here does, so DP is not silently in one implementation only.

## Design notes

1. **Two-phase by necessity.** Phase 1 is a greedy subsequence scan that rejects
   almost every candidate in a few bytes. Phase 2 scores only survivors. On 50k
   paths, phase 1 dominates wall time — so optimising the scorer would have been
   wasted effort. Measure first.

2. **Flat blob + offsets, not `Vec<String>`.** One contiguous allocation, no
   per-candidate pointer chasing. This is a data-layout win available to *both*
   languages, which is precisely why the JS side does it too.

3. **Greedy scoring, documented as a limitation.** fzf's v2 finds marginally
   better alignments with a DP matrix at O(n·m). Greedy is O(n). Most editors
   ship greedy. Stated as a tradeoff, not hidden.

4. **ASCII-only, case-insensitive.** Keeps the scoring arithmetic bit-identical
   between Rust and JS, which is what makes exact differential testing possible
   at all. Non-ASCII compares as raw bytes.

5. **Deterministic total ordering.** Score desc, then candidate length asc, then
   index asc. Every field is compared, so there are no "equal but arbitrarily
   ordered" results that would make the two implementations disagree by accident.

6. **Handle-based index lifetime.** Unlike image kernels, the corpus is built once
   and queried thousands of times. A `HashMap<u32, Index>` behind a `Mutex` keeps
   handles from being silently reused after free. `live_indexes()` exists so the
   verifier can assert zero leaks — and it does.

## Bugs the differential test caught (in my own harness)

Both were in `scripts/verify.mjs`, not the Rust — worth recording because they're
the sort of thing that makes a benchmark lie:

- `new Uint32Array(buf, ptr, len * 4)` — the third argument is an **element**
  count, not a byte count. Silently over-allocated the view.
- Viewing `n` u32s when `query_index` writes `n * 2` (score+index pairs).
  Overshooting a TypedArray returns `undefined`, so the first 10 pairs matched
  and it diverged at pair 11 — the logged diff looked *identical*, which is how
  I knew to go looking at the harness rather than the kernels.

A benchmark you haven't validated is a random number generator with extra steps.

## Structure

```
crates/fuzzy/       pure Rust: index, scoring, ranking. 9 unit tests + criterion
crates/wasm/        C-ABI surface, no wasm-bindgen
web/js/reference.js JS reference, same layout and algorithm
web/js/corpus.js    deterministic corpus generator (shared by both harnesses)
web/index.html      results table + live side-by-side query box
scripts/verify.mjs  headless differential verification (CI-able)
```

## Run it

```bash
cargo test -p fuzzy                         # 9 native unit tests
cargo bench -p fuzzy                        # criterion, native baseline
cargo build -p wasm --release --target wasm32-unknown-unknown
node scripts/verify.mjs                     # 550k comparisons + speed
npx http-server web -p 8081 -c-1            # then open localhost:8081
```

CI runs the differential verification, `rustfmt --check`, and
`clippy -D warnings` on every push.

## Follow-ups (where the real win might be)

1. **500k paths** — does the 2.4x widen as cache pressure grows? Predicted yes.
2. **Workers** — the JS baseline could parallelise across cores. That's the actual
   competitor, not single-threaded JS.
3. **Incremental filtering** — real palettes filter the *previous* result set as
   you type, not the full corpus. That changes the complexity profile completely
   and is what production implementations actually do.
4. **DP scoring** — does fzf v2's alignment beat greedy enough to justify O(n·m)?
5. **Allocation profile** — the honest case for Rust here may be GC behaviour, not
   throughput. Worth measuring directly.
