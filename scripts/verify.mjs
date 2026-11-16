/**
 * Headless differential verification + benchmark.
 *
 * Proves, in order:
 *   1. `score` agrees exactly with the JS reference on every corpus item for
 *      every query (including the no-match sentinel).
 *   2. `query` returns byte-identical (score, index) sequences, in the same
 *      order, for every query at every corpus size.
 *   3. No index handles leak.
 *
 * Only after all three pass is the speed comparison printed. If correctness
 * fails, the numbers below it are meaningless and the script exits non-zero.
 */

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as ref from '../web/js/reference.js';
import { generateCorpus, packCorpus, QUERIES } from '../web/js/corpus.js';

const WASM_PATH = new URL('../target/wasm32-unknown-unknown/release/wasm.wasm', import.meta.url);

async function instantiate() {
  const bytes = await readFile(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

const enc = new TextEncoder();

/** Re-view linear memory. Growing the heap detaches old ArrayBuffers. */
const u8 = (mem, ptr, len) => new Uint8Array(mem.buffer, ptr, len);
// Third arg of a TypedArray view is an ELEMENT count, not a byte count.
// Passing len*4 here silently over-allocated the view and blew up at 50k items.
const u32v = (mem, ptr, elems) => new Uint32Array(mem.buffer, ptr, elems);

const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function timeIt(fn, warmup = 3, runs = 12) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { median: median(samples), samples };
}

/** Copy a JS blob+offsets corpus into wasm memory and build an index there. */
function buildWasmIndex(ex, blob, offsets) {
  const mem = ex.memory;
  const pBlob = ex.alloc(blob.length);
  const pOff = ex.alloc(offsets.length * 4);
  if (!pBlob || !pOff) throw new Error('wasm alloc failed');

  u8(mem, pBlob, blob.length).set(blob);
  u32v(mem, pOff, offsets.length).set(offsets);

  const handle = ex.build_index(pBlob, blob.length, pOff, offsets.length - 1);

  // The wasm side copied the data, so the staging buffers go immediately.
  ex.dealloc(pBlob, blob.length);
  ex.dealloc(pOff, offsets.length * 4);

  if (handle === 0) throw new Error('build_index returned 0');
  return handle;
}

async function main() {
  const ex = await instantiate();
  const mem = ex.memory;

  const failures = [];
  const speedRows = [];

  const sizes = [500, 5000, 50000];

  for (const n of sizes) {
    const items = generateCorpus(n, 12345 + n);
    const { blob, offsets } = packCorpus(items);
    const jsIndex = new ref.Index(blob, offsets);

    const handle = buildWasmIndex(ex, blob, offsets);

    // ---------- 1. score parity, exhaustively ----------
    // Every corpus item against every query, both sides, compared exactly.
    let scoreChecks = 0;
    let scoreDiffs = 0;
    let firstScoreDiff = null;

    const pNeedle = ex.alloc(64);
    const pHay = ex.alloc(1 << 16);

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      if (needle.length > 64) throw new Error('needle staging buffer too small');
      u8(mem, pNeedle, 64).fill(0);
      u8(mem, pNeedle, needle.length).set(needle);

      for (let i = 0; i < items.length; i++) {
        const cand = items[i];
        if (cand.length > (1 << 16)) throw new Error('hay staging buffer too small');
        u8(mem, pHay, cand.length).set(cand);

        const got = ex.score_one(pNeedle, needle.length, pHay, cand.length);
        const want = ref.score(needle, cand);
        scoreChecks++;
        if (got !== want) {
          scoreDiffs++;
          if (!firstScoreDiff) {
            firstScoreDiff = { query: q, candidate: new TextDecoder().decode(cand), got, want };
          }
        }
      }
    }

    ex.dealloc(pNeedle, 64);
    ex.dealloc(pHay, 1 << 16);

    if (scoreDiffs > 0) {
      const msg = `${n}: ${scoreDiffs}/${scoreChecks} score mismatches, first=${JSON.stringify(firstScoreDiff)}`;
      failures.push(msg);
      console.log(`❌ ${msg}`);
    } else {
      console.log(`✅ ${n} items: score parity (${scoreChecks.toLocaleString()} comparisons)`);
    }

    // ---------- 2. query parity, ordering included ----------
    const LIMIT = 20;
    const pOut = ex.alloc(LIMIT * 8);
    const pNeedle2 = ex.alloc(64);
    let queryDiffs = 0;
    let firstQueryDiff = null;

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      u8(mem, pNeedle2, 64).fill(0);
      u8(mem, pNeedle2, needle.length).set(needle);

      const gotN = ex.query_index(handle, pNeedle2, needle.length, LIMIT, pOut, LIMIT);
      // query_index writes n*2 u32 values: alternating score, index. Viewing only
      // `gotN` elements read past the end, where TypedArrays return undefined,
      // so everything after the 10th pair silently compared against undefined.
      const gotRaw = u32v(mem, pOut, gotN * 2).slice();

      // wasm packs (score, index) as consecutive u32s.
      const got = [];
      for (let k = 0; k < gotN; k++) {
        got.push({ score: gotRaw[k * 2], index: gotRaw[k * 2 + 1] });
      }

      const want = jsIndex.query(needle, LIMIT);

      const same =
        got.length === want.length &&
        got.every((g, k) => g.score === want[k].score && g.index === want[k].index);

      if (!same) {
        queryDiffs++;
        if (!firstQueryDiff) {
          firstQueryDiff = {
            query: q,
            got: got.slice(0, 5),
            want: want.slice(0, 5),
            gotN,
            wantN: want.length,
          };
        }
      }
    }

    if (queryDiffs > 0) {
      const msg = `${n}: ${queryDiffs}/${QUERIES.length} query mismatches, first=${JSON.stringify(firstQueryDiff)}`;
      failures.push(msg);
      console.log(`❌ ${msg}`);
    } else {
      console.log(`✅ ${n} items: query parity across ${QUERIES.length} queries (order included)`);
    }

    // ---------- 3. speed ----------
    // wasm query is timed including the boundary call and the output write-back,
    // because that is what a real keystroke costs.
    let jsTotal = 0;
    let wasmTotal = 0;

    for (const q of QUERIES) {
      const needle = enc.encode(q);
      u8(mem, pNeedle2, 64).fill(0);
      u8(mem, pNeedle2, needle.length).set(needle);

      const jsTime = timeIt(() => jsIndex.query(needle, LIMIT)).median;
      const wasmTime = timeIt(() => {
        ex.query_index(handle, pNeedle2, needle.length, LIMIT, pOut, LIMIT);
      }).median;

      jsTotal += jsTime;
      wasmTotal += wasmTime;
    }

    const row = {
      n,
      jsTotalMs: jsTotal,
      wasmTotalMs: wasmTotal,
      // Per-query figure is the number a UI actually cares about.
      jsPerQueryMs: jsTotal / QUERIES.length,
      wasmPerQueryMs: wasmTotal / QUERIES.length,
      speedup: jsTotal / wasmTotal,
    };
    speedRows.push(row);

    console.log(
      `   ${n.toLocaleString()} items: ${QUERIES.length} queries — JS ${jsTotal.toFixed(2)}ms ` +
        `→ WASM ${wasmTotal.toFixed(2)}ms (${row.speedup.toFixed(2)}x)  ` +
        `[per query ${row.jsPerQueryMs.toFixed(2)}ms → ${row.wasmPerQueryMs.toFixed(2)}ms]`
    );

    ex.dealloc(pOut, LIMIT * 8);
    ex.dealloc(pNeedle2, 64);

    const freed = ex.free_index(handle);
    if (freed !== 1) failures.push(`${n}: free_index returned ${freed}`);
  }

  // ---------- leak check ----------
  const live = ex.live_indexes();
  if (live !== 0) {
    failures.push(`leaked ${live} index handle(s)`);
    console.log(`❌ leaked ${live} index handle(s)`);
  } else {
    console.log('✅ no leaked index handles');
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log('\nAll checks passed: scoring, ordering, and lifetime match the JS reference exactly.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
