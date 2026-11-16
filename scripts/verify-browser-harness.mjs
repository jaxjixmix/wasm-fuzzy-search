/**
 * Headless coverage for the fuzzy browser harness (`web/js/bench.js`).
 *
 * `bench.js` was extracted out of `index.html` precisely so this file could
 * exist. While the benchmark lived inline in the page, no test could reach it —
 * the same structural gap that let a wrong-arity call hide in the image lab.
 *
 * This runs the real `runBenchmark`, checks export arity by name, and fails on
 * any correctness mismatch, so the harness itself is tested.
 */

import { readFile } from 'node:fs/promises';
import { runBenchmark, checkExports } from '../web/js/bench.js';

const WASM_PATH = new URL('../target/wasm32-unknown-unknown/release/wasm.wasm', import.meta.url);

async function main() {
  const bytes = await readFile(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;

  // Guard the ABI boundary first: a name/arity drift fails here, loudly, instead
  // of producing plausible-looking numbers from a mis-called function.
  const arityErr = checkExports(ex);
  if (arityErr) {
    console.error(`❌ ${arityErr}`);
    process.exit(1);
  }
  console.log('✅ wasm exports present with expected arity');

  // Small frontier: this is a correctness gate, not the published benchmark.
  const { correctness, speed } = await runBenchmark(ex, { sizes: [200, 1000] });

  const bad = correctness.filter((c) => !c.ok);
  if (bad.length > 0) {
    console.error(`❌ ${bad.length}/${correctness.length} correctness failures:`);
    for (const b of bad) console.error(`   ${b.size} ${b.check}: ${b.detail}`);
    process.exit(1);
  }

  const totalChecks = correctness.reduce((s, c) => s + c.checks, 0);
  console.log(`✅ ${correctness.length} correctness checks passed (${totalChecks.toLocaleString()} comparisons)`);

  if (speed.length === 0) {
    console.error('❌ no timing rows produced');
    process.exit(1);
  }
  for (const s of speed) {
    if (!(s.wasmTotal > 0) || !Number.isFinite(s.wasmTotal)) {
      console.error(`❌ ${s.size}: invalid wasm timing ${s.wasmTotal}`);
      process.exit(1);
    }
  }
  console.log(`✅ ${speed.length} timing rows finite and positive`);

  console.log('\nFuzzy browser harness exercised end-to-end.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
