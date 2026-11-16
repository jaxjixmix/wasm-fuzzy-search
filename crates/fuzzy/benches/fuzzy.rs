//! Criterion benchmarks for the native Rust path.
//!
//! This is the baseline: what the index costs with no JS, no wasm boundary, and
//! no marshalling at all. The wasm numbers in `scripts/verify.mjs` are compared
//! against this to separate "Rust is faster" from "the boundary is cheap".

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use fuzzy::Index;

const DIRS: [&str; 10] = [
    "src",
    "lib",
    "app",
    "components",
    "utils",
    "hooks",
    "pages",
    "api",
    "docs",
    "test",
];
const WORDS: [&str; 16] = [
    "button", "input", "modal", "header", "footer", "sidebar", "table", "form", "avatar",
    "dropdown", "tooltip", "banner", "card", "list", "grid", "nav",
];
const EXTS: [&str; 5] = ["ts", "tsx", "js", "css", "json"];

/// Deterministic corpus, mirroring `web/js/corpus.js` closely enough to be a
/// representative workload (exact parity is not required for the native bench).
fn corpus(n: usize) -> Vec<Vec<u8>> {
    let mut s: u32 = 12345;
    let mut next = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        s
    };

    (0..n)
        .map(|_| {
            let depth = (next() % 4) as usize + 1;
            let mut path = String::new();
            for _ in 0..depth {
                path.push_str(DIRS[(next() as usize) % DIRS.len()]);
                path.push('/');
            }
            path.push_str(WORDS[(next() as usize) % WORDS.len()]);
            if next() % 2 == 0 {
                path.push('_');
                path.push_str(WORDS[(next() as usize) % WORDS.len()]);
            }
            path.push('.');
            path.push_str(EXTS[(next() as usize) % EXTS.len()]);
            path.into_bytes()
        })
        .collect()
}

fn benches(c: &mut Criterion) {
    let queries: [&[u8]; 5] = [b"btn", b"inp", b"modal", b"hdr", b"tl"];

    let mut group = c.benchmark_group("fuzzy_query");

    for &n in &[500usize, 5_000, 50_000] {
        let items = corpus(n);
        let index = Index::from_slices(items);

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(BenchmarkId::new("all_queries", n), &n, |b, _| {
            b.iter(|| {
                for q in queries {
                    black_box(index.query(black_box(q), 20));
                }
            });
        });

        group.bench_with_input(BenchmarkId::new("single_query", n), &n, |b, _| {
            b.iter(|| black_box(index.query(black_box(b"modal"), 20)));
        });
    }

    group.finish();

    // Index construction cost: paid once per corpus load, not per keystroke.
    let mut ctor = c.benchmark_group("index_build");
    for &n in &[500usize, 5_000] {
        let items = corpus(n);
        ctor.throughput(Throughput::Elements(n as u64));
        ctor.bench_with_input(BenchmarkId::from_parameter(n), &items, |b, items| {
            b.iter(|| black_box(Index::from_slices(items.clone())));
        });
    }
    ctor.finish();
}

criterion_group!(benches_group, benches);
criterion_main!(benches_group);
