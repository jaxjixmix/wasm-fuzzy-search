/**
 * Benchmark + differential harness for the fuzzy index.
 *
 * Extracted from `index.html` so it can be run headlessly and tested. The
 * browser page imports this same module, so what CI exercises is exactly what
 * the page runs — that equivalence is the whole point. Previously the benchmark
 * lived inline in the page, which meant no test could reach it, and a
 * caller/callee mismatch there would have stayed invisible forever.
 *
 * Returns plain data. All DOM rendering stays in `index.html`.
 */

import * as ref from './reference.js';
import { generateCorpus, packCorpus, QUERIES } from './corpus.js';

const enc = new TextEncoder();
export const LIMIT = 20;

/** Re-view linear memory. Heap growth detaches old ArrayBuffers. */
export const u8 = (mem, ptr, len) => new Uint8Array(mem.buffer, ptr, len);
// Third argument is an ELEMENT count, never a byte count.
export const u32v = (mem, ptr, elems) => new Uint32Array(mem.buffer, ptr, elems);

/**
 * Expected export names and arities.
 *
 * This table is the direct guard against the bug class that bit the image lab:
 * a caller passing the wrong number of arguments. Checking by name and arity
 * catches it by construction instead of hoping the output looks wrong.
 */
export const EXPECTED_EXPORTS = {
  alloc: 1,
  dealloc: 2,
  build_index: 4,
  query_index: 6,
  score_one: 4,
  free_index: 1,
  live_indexes: 0,
};

export function checkExports(ex) {
  for (const [name, arity] of Object.entries(EXPECTED_EXPORTS)) {
    const fn = ex[name];
    if (typeof fn !== 'function') return `missing wasm export: ${name}`;
    if (fn.length !== arity) return `${name} arity ${fn.length}, harness expects ${arity}`;
  }
  return null;
}

export const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function timeIt(fn, warmup = 3, runs = 12) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

/** Copy a packed corpus into wasm memory and build an index there. */
export function buildWasmIndex(ex, blob, offsets) {
  const mem = ex.memory;
  const pBlob = ex.alloc(blob.length);
  const pOff = ex.alloc(offsets.length * 4);
  if (!pBlob || !pOff) throw new Error('wasm alloc failed');

  u8(mem, pBlob, blob.length).set(blob);
  u32v(mem, pOff, offsets.length).set(offsets);

  const handle = ex.build_index(pBlob, blob.length, pOff, offsets.length - 1);

  ex.dealloc(pBlob, blob.length);
  ex.dealloc(pOff, offsets.length * 4);

  if (handle === 0) throw new Error('build_index returned 0');
  return handle;
}

/** Read n (score, index) pairs written by query_index. */
export function readHits(mem, pOut, n) {
  const raw = u32v(mem, pOut, n * 2).slice();
  const hits = [];
  for (let k = 0; k < n; k++) hits.push({ score: raw[k * 2], index: raw[k * 2 + 1] });
  return hits;
}

/**
 * Run the full harness over the given corpus sizes.
 *
 * `sizes` lets the frontier shrink it for a fast CI path while the page keeps
 * the full set.
 */
export async function runBenchmark(ex, { sizes = [500, 5000, 50000], log = () => {} } = {}) {
  const mem = ex.memory;
  const correctness = [];
  const speed = [];
  let leaked = 0;

  for (const n of sizes) {
    const items = generateCorpus(n, 12345 + n);
    const { blob, offsets } = packCorpus(items);
    const jsIndex = new ref.Index(blob, offsets);

    const handle = buildWasmIndex(ex, blob, offsets);

    // ---- score parity, exhaustive ----
    const pN = ex.alloc(64);
    const pH = ex.alloc(1 << 16);
    let scoreDiffs = 0;
    let scoreChecks = 0;
    let firstScoreDiff = null;

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      u8(mem, pN, 64).fill(0);
      u8(mem, pN, needle.length).set(needle);

      for (let i = 0; i < items.length; i++) {
        const cand = items[i];
        u8(mem, pH, cand.length).set(cand);
        const got = ex.score_one(pN, needle.length, pH, cand.length);
        const want = ref.score(needle, cand);
        scoreChecks++;
        if (got !== want) {
          scoreDiffs++;
          if (!firstScoreDiff) firstScoreDiff = { query: q, i, got, want };
        }
      }
    }

    ex.dealloc(pN, 64);
    ex.dealloc(pH, 1 << 16);

    correctness.push({
      size: n,
      check: 'score parity',
      ok: scoreDiffs === 0,
      checks: scoreChecks,
      detail: scoreDiffs ? `${scoreDiffs} mismatches, first=${JSON.stringify(firstScoreDiff)}` : null,
    });

    // ---- query parity, order included ----
    const pOut = ex.alloc(LIMIT * 8);
    const pN2 = ex.alloc(64);
    let queryDiffs = 0;
    let firstQueryDiff = null;

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      u8(mem, pN2, 64).fill(0);
      u8(mem, pN2, needle.length).set(needle);

      const gotN = ex.query_index(handle, pN2, needle.length, LIMIT, pOut, LIMIT);
      const got = readHits(mem, pOut, gotN);
      const want = jsIndex.query(needle, LIMIT);

      const same =
        got.length === want.length &&
        got.every((g, k) => g.score === want[k].score && g.index === want[k].index);

      if (!same) {
        queryDiffs++;
        if (!firstQueryDiff) firstQueryDiff = { query: q, got: got.slice(0, 5), want: want.slice(0, 5) };
      }
    }

    correctness.push({
      size: n,
      check: 'query parity (order)',
      ok: queryDiffs === 0,
      checks: QUERIES.length,
      detail: queryDiffs ? `${queryDiffs} mismatches, first=${JSON.stringify(firstQueryDiff)}` : null,
    });

    // ---- speed ----
    let jsTotal = 0;
    let wasmTotal = 0;

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      u8(mem, pN2, 64).fill(0);
      u8(mem, pN2, needle.length).set(needle);

      jsTotal += timeIt(() => jsIndex.query(needle, LIMIT));
      // Timed including the boundary call and result write-back: that is what a
      // keystroke actually costs.
      wasmTotal += timeIt(() => {
        ex.query_index(handle, pN2, needle.length, LIMIT, pOut, LIMIT);
      });
    }

    speed.push({
      size: n,
      jsTotal,
      wasmTotal,
      jsPerQuery: jsTotal / QUERIES.length,
      wasmPerQuery: wasmTotal / QUERIES.length,
      speedup: jsTotal / wasmTotal,
    });

    log(
      `${n.toLocaleString()} items: JS ${jsTotal.toFixed(2)}ms → WASM ${wasmTotal.toFixed(2)}ms ` +
        `(${(jsTotal / wasmTotal).toFixed(2)}x)`
    );

    ex.dealloc(pOut, LIMIT * 8);
    ex.dealloc(pN2, 64);

    if (ex.free_index(handle) !== 1) leaked++;
  }

  if (ex.live_indexes() !== 0) leaked += ex.live_indexes();

  correctness.push({
    size: 0,
    check: 'index lifetime',
    ok: leaked === 0,
    checks: 1,
    detail: leaked ? `${leaked} leaked handle(s)` : null,
  });

  return { correctness, speed };
}
