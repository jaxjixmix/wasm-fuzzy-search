//! Raw wasm boundary for the fuzzy index.
//!
//! Same design as `wasm-image-lab`: plain `cdylib`, exported memory, C-ABI
//! `(ptr, len)` functions, and typed-array views straight over linear memory.
//!
//! ## Index lifetime
//!
//! Unlike the image kernels, the corpus is a *persistent* structure — you build
//! it once and query it thousands of times (once per keystroke). So it lives in
//! a global slot and is addressed by handle:
//!
//! ```text
//! build_index(ptr, len, count) -> handle
//! query_index(handle, needle_ptr, needle_len, limit, out_ptr, out_cap) -> n
//! free_index(handle)
//! ```
//!
//! `query_index` writes `n` results as `(score: i32, index: u32)` pairs into
//! `out_ptr` and returns `n`. The caller sizes `out_ptr` from `limit`.

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const ALIGN: usize = 4;

/// One entry per built index. `HashMap` rather than `Vec` so a freed handle is
/// never silently reused by a stale caller.
fn registry() -> &'static Mutex<HashMap<u32, fuzzy::Index>> {
    static REG: OnceLock<Mutex<HashMap<u32, fuzzy::Index>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_handle() -> u32 {
    static NEXT: OnceLock<Mutex<u32>> = OnceLock::new();
    let m = NEXT.get_or_init(|| Mutex::new(1));
    let mut g = m.lock().unwrap();
    let h = *g;
    *g = g.wrapping_add(1);
    h
}

/// Allocate `len` bytes in linear memory. Returns null on failure.
///
/// # Safety
/// Caller owns the block and must pass the same `len` to `dealloc`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    match Layout::from_size_align(len, ALIGN) {
        Ok(l) => unsafe { raw_alloc(l) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Free a block from `alloc`.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Ok(l) = Layout::from_size_align(len, ALIGN) {
        raw_dealloc(ptr, l);
    }
}

/// Build an index from a flat UTF-8 blob plus its offsets table.
///
/// The blob is `total_bytes` long and holds every candidate concatenated.
/// `offsets` is `count + 1` u32 values (absolute byte offsets into the blob),
/// so candidate `i` is `blob[offsets[i]..offsets[i+1]]`. This mirrors the Rust
/// `Index::from_parts` layout exactly and keeps the ABI dumb.
///
/// Returns a handle > 0, or 0 on failure.
///
/// # Safety
/// `blob_ptr` must be valid for `total_bytes`; `offsets_ptr` must be valid for
/// `(count + 1) * 4` bytes and hold the offsets described above.
#[no_mangle]
pub unsafe extern "C" fn build_index(
    blob_ptr: *const u8,
    total_bytes: usize,
    offsets_ptr: *const u32,
    count: usize,
) -> u32 {
    if count == 0 || total_bytes == 0 {
        return 0;
    }
    let blob = std::slice::from_raw_parts(blob_ptr, total_bytes).to_vec();
    let offsets = std::slice::from_raw_parts(offsets_ptr, count + 1).to_vec();

    // Validate the offsets table before trusting it. A malformed table would
    // otherwise cause a panic or an out-of-bounds slice inside `query`, and a
    // panic crossing the wasm boundary aborts the module.
    if offsets[0] != 0 || *offsets.last().unwrap() as usize != total_bytes {
        return 0;
    }
    if offsets.windows(2).any(|w| w[0] > w[1]) {
        return 0;
    }

    let handle = next_handle();
    registry()
        .lock()
        .unwrap()
        .insert(handle, fuzzy::Index::from_parts(blob, offsets));
    handle
}

/// Run a query against a built index.
///
/// Writes up to `limit` `(score, candidate_index)` pairs into `out_ptr` as
/// consecutive `i32`/`u32` values, and returns the number written. `out_cap`
/// must be at least `limit`. Returns 0 for an unknown handle or a null pointer.
///
/// # Safety
/// `needle_ptr` must be valid for `needle_len`; `out_ptr` must be valid for
/// `out_cap * 2` u32 values.
#[no_mangle]
pub unsafe extern "C" fn query_index(
    handle: u32,
    needle_ptr: *const u8,
    needle_len: usize,
    limit: usize,
    out_ptr: *mut u32,
    out_cap: usize,
) -> usize {
    if needle_ptr.is_null() || out_ptr.is_null() || limit == 0 {
        return 0;
    }
    let reg = registry().lock().unwrap();
    let Some(index) = reg.get(&handle) else {
        return 0;
    };

    let needle = std::slice::from_raw_parts(needle_ptr, needle_len);
    let hits = index.query(needle, limit);
    let n = hits.len().min(out_cap);

    let out = std::slice::from_raw_parts_mut(out_ptr, n * 2);
    for (k, (score, idx)) in hits.into_iter().take(n).enumerate() {
        out[k * 2] = score as u32;
        out[k * 2 + 1] = idx;
    }
    n
}

/// Score one needle against one candidate. Exposed so the harness can
/// differential-test the scoring function directly, without the ranking layer.
///
/// Returns `i32::MIN` when there is no match — a sentinel rather than a
/// separate out-param, because JS gets one number back and can compare it.
///
/// # Safety
/// Both pointers must be valid for their stated lengths.
#[no_mangle]
pub unsafe extern "C" fn score_one(
    needle_ptr: *const u8,
    needle_len: usize,
    hay_ptr: *const u8,
    hay_len: usize,
) -> i32 {
    let needle = std::slice::from_raw_parts(needle_ptr, needle_len);
    let hay = std::slice::from_raw_parts(hay_ptr, hay_len);
    fuzzy::score(needle, hay).unwrap_or(i32::MIN)
}

/// Free a built index. Returns 1 if it existed, 0 otherwise.
#[no_mangle]
pub extern "C" fn free_index(handle: u32) -> u32 {
    match registry().lock().unwrap().remove(&handle) {
        Some(_) => 1,
        None => 0,
    }
}

/// Number of live indexes. Lets the harness assert it has no leaks.
#[no_mangle]
pub extern "C" fn live_indexes() -> usize {
    registry().lock().unwrap().len()
}
