// png-squeeze: rewrite each 1280x720 screenshot as the smallest lossless PNG it can be.
//
// Approach, all with Node's built-ins only:
//  - decode the stored RGBA input, then pick the cheapest exact form for it:
//    palette (<=256 colours, transparent entries first), grey, grey+alpha, RGB,
//    RGBA, or a single transparent colour keyed through tRNS instead of an alpha
//    channel;
//  - choose each row's filter (none/sub/up/average/paeth, or the per-row
//    minimum-sum / fewest-pairs / brute-force-by-zlib winner) and compress the
//    winner again at zlib level 9, keeping the smallest of a few strategies.
//  - fully deterministic: no clock, no randomness, no environment input besides
//    the input/output directories the harness provides.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ---- CRC32 (PNG chunk checksums) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- PNG chunk assembly ----
function oneChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length);
  crcIn.set(out.subarray(4, 8), 0);
  crcIn.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcIn));
  return out;
}
function assemble(chunks) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
  let total = 8;
  for (const [type, data] of chunks) {
    const c = oneChunk(type, data);
    parts.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function ihdr(width, height, colourType) {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  b[8] = 8;
  b[9] = colourType;
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

// ---- Paeth predictor (shared by the filter and the unfilter) ----
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---- PNG decode: bit depth 8, non-interlaced, colour types 0, 2, 3, 4, 6 ----
const CHANS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    return { ok: false, why: 'not a PNG' };
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8);
    const len = view.getUint32(0);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(data.buffer, data.byteOffset, data.length);
      width = v.getUint32(0);
      height = v.getUint32(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || !(colourType in CHANS) || width === 0 || height === 0) {
    return { ok: false, why: 'unsupported IHDR' };
  }
  let total = 0;
  for (const d of idat) total += d.length;
  const z = new Uint8Array(total);
  let p = 0;
  for (const d of idat) {
    z.set(d, p);
    p += d.length;
  }
  const raw = inflateSync(z);
  const bpp = CHANS[colourType];
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) return { ok: false, why: 'bad IDAT length' };
  const samples = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (colourType === 0) {
      rgba[d] = samples[i];
      rgba[d + 1] = samples[i];
      rgba[d + 2] = samples[i];
      rgba[d + 3] = 255;
    } else if (colourType === 2) {
      rgba[d] = samples[i * 3];
      rgba[d + 1] = samples[i * 3 + 1];
      rgba[d + 2] = samples[i * 3 + 2];
      rgba[d + 3] = 255;
    } else if (colourType === 3) {
      const idx = samples[i];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colourType === 4) {
      rgba[d] = samples[i * 2];
      rgba[d + 1] = samples[i * 2];
      rgba[d + 2] = samples[i * 2];
      rgba[d + 3] = samples[i * 2 + 1];
    } else {
      rgba[d] = samples[i * 4];
      rgba[d + 1] = samples[i * 4 + 1];
      rgba[d + 2] = samples[i * 4 + 2];
      rgba[d + 3] = samples[i * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// ---- Image summary: opaque? grey? at most 256 distinct colours? ----
function summarize(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!many) {
      const key = (r * 16777216 + g * 65536 + b * 256 + a) >>> 0;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else counts.set(key, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [key, count] of counts) {
      colours.push({
        r: (key >>> 24) & 255,
        g: (key >>> 16) & 255,
        b: (key >>> 8) & 255,
        a: key & 255,
        count,
      });
    }
  }
  return { opaque, grey, colours };
}

// ---- The one fully-transparent value an image may key through tRNS ----
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---- Samples of an image in a channel colour type ----
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---- Palette form: entries ordered, transparent first, then by order ----
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.r - y.r || x.g - y.g || x.b - y.b;
    return y.count - x.count || x.r - y.r || x.g - y.g || x.b - y.b;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set((c.r * 16777216 + c.g * 65536 + c.b * 256 + c.a) >>> 0, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    indices[i] = index.get((rgba[d] * 16777216 + rgba[d + 1] * 65536 + rgba[d + 2] * 256 + rgba[d + 3]) >>> 0);
  }
  return { plte, trns, indices };
}

// ---- One filtered row ----
function filterRow(type, cur, prev, bpp, out) {
  for (let x = 0; x < cur.length; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let v = cur[x];
    if (type === 1) v -= a;
    else if (type === 2) v -= b;
    else if (type === 3) v -= (a + b) >> 1;
    else if (type === 4) v -= paeth(a, b, c);
    out[x] = v & 0xff;
  }
}

// ---- Cost of a filtered row as a sum of absolute signed bytes ----
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---- Filter a whole image by one choice: fixed 0-4, 'minsum', 'pairs', 'brute' ----
const BRUTE_CONTEXT = 32768;
function filterImage(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const out = raw ?? new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterRow(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = out.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (choice === 'pairs') {
        const row = trial[t].subarray(1);
        let n = 0;
        const mark = ++stamp;
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seen[pair] !== mark) {
            seen[pair] = mark;
            n++;
          }
        }
        cost = n;
      } else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    out.set(trial[type], at);
  }
  return out;
}

// ---- Candidate forms for one image ----
function formsOf(rgba) {
  const { opaque, grey, colours } = summarize(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum', 'brute']],
      ['luminance', [0, 'minsum', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const chunkOverhead = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---- Screen every form/filter at level 6, keep the smallest ----
function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkOverhead(form);
    for (const choice of form.filters) {
      const data = filterImage(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : undefined);
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else {
        spare = data;
      }
    }
  }
  return best;
}

// ---- Encode one image: screen, then re-compress the winner at level 9 ----
function encode(rgba, width, height) {
  const winner = screen(rgba, width, height);
  const form = winner.form;
  let zlib = null;
  for (const opt of [
    { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: constants.Z_FIXED },
  ]) {
    const z = deflateSync(winner.data, opt);
    if (zlib === null || z.length < zlib.length) zlib = z;
  }
  const chunks = [['IHDR', ihdr(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(zlib)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemble(chunks);
}

// ---- Main: /input/<id>/image.png -> /output/<id>/image.png ----
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encode(image.rgba, image.width, image.height));
}
