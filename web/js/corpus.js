/**
 * Deterministic corpus generator.
 *
 * Shared by the browser harness and the Node verifier so both sides see byte
 * identical input. Realistic-ish shapes: paths, camelCase identifiers,
 * dotted modules, kebab-case CSS. That mix matters because the scoring bonuses
 * (boundary, camelCase) only fire on realistic names.
 */

/** LCGB — deterministic, no dependency. */
function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

const DIRS = ['src', 'lib', 'app', 'components', 'utils', 'hooks', 'pages', 'api', 'docs', 'test'];
const WORDS = [
  'button', 'input', 'modal', 'header', 'footer', 'sidebar', 'table', 'form', 'avatar',
  'dropdown', 'tooltip', 'banner', 'card', 'list', 'grid', 'nav', 'menu', 'dialog',
  'search', 'filter', 'sort', 'pagination', 'toast', 'badge', 'chip', 'slider', 'tabs',
  'accordion', 'breadcrumb', 'carousel', 'gallery', 'timeline', 'skeleton', 'spinner',
  'datepicker', 'calendar', 'chart', 'editor', 'uploader', 'player', 'canvas', 'map',
];
const EXTS = ['ts', 'tsx', 'js', 'jsx', 'css', 'scss', 'json', 'md', 'rs', 'go'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function camel(rng) {
  const n = 1 + Math.floor(rng() * 2);
  let s = '';
  for (let i = 0; i < n; i++) {
    const w = pick(rng, WORDS);
    s += i === 0 ? w : w[0].toUpperCase() + w.slice(1);
  }
  return s;
}

function kebab(rng) {
  const n = 1 + Math.floor(rng() * 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(rng, WORDS));
  return parts.join('-');
}

const enc = new TextEncoder();

/**
 * Generate `n` candidates as Uint8Array[].
 * Deterministic for a given seed and n.
 */
export function generateCorpus(n, seed = 12345) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const depth = 1 + Math.floor(rng() * 4);
    const parts = [];
    for (let d = 0; d < depth; d++) parts.push(pick(rng, DIRS));

    // Mix the three name shapes so scoring bonuses actually fire.
    const roll = rng();
    let name;
    if (roll < 0.45) name = camel(rng);
    else if (roll < 0.8) name = kebab(rng);
    else name = pick(rng, WORDS) + '_' + pick(rng, WORDS);

    const ext = pick(rng, EXTS);
    const path = parts.join('/') + '/' + name + '.' + ext;
    out.push(enc.encode(path));
  }
  return out;
}

/** Build the flat blob + offsets pair used by both index implementations. */
export function packCorpus(items) {
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
  return { blob, offsets };
}

/** Queries used by the benchmark. Shapes a real palette sees: 2-8 chars. */
export const QUERIES = ['btn', 'inp', 'modal', 'hdr', 'drp', 'tl', 'card', 'srh', 'nav', 'badge'];
