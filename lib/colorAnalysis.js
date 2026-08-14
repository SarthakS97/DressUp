/**
 * All pure color math for the "run color analysis" feature — no AI, no
 * network calls. Runs entirely in result.js against canvas pixel data.
 */

/* ---------------------- Fitzpatrick type -> swatch ---------------------- *
 * Fitzpatrick is a melanin/burn-tan classification (Type I-VI), not a
 * measured color — the API returns a category, not an RGB value. These are
 * standard reference swatches used to *visualize* each type; they're an
 * approximation for display, not the person's actual measured skin color.
 * ------------------------------------------------------------------- */
const FITZPATRICK_SWATCHES = {
  1: { label: 'Type I  \u2014 White',        hex: '#F4DCC9' },
  2: { label: 'Type II \u2014 Beige',        hex: '#E8C39E' },
  3: { label: 'Type III \u2014 Light Brown', hex: '#D4A276' },
  4: { label: 'Type IV \u2014 Medium Brown', hex: '#A97155' },
  5: { label: 'Type V  \u2014 Dark Brown',   hex: '#6B4331' },
  6: { label: 'Type VI \u2014 Very Dark Brown', hex: '#3B2419' },
};

/** Normalize whatever shape the Fitzpatrick API returns ('III', 3, 'Type III', ...) to 1-6. */
function normalizeFitzpatrickType(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  const romanMap = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
  // try a plain number first ("3", 3)
  const asNum = Number(s);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 6) return asNum;
  // try to find a roman numeral token anywhere in the string ("Type III" -> III)
  const tokens = s.replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (romanMap[t]) return romanMap[t];
  }
  return null;
}

function getFitzpatrickSwatch(rawType) {
  const idx = normalizeFitzpatrickType(rawType);
  if (!idx) return null;
  return { index: idx, ...FITZPATRICK_SWATCHES[idx] };
}

/* ------------------------------ color utils ------------------------------ */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/** WCAG relative luminance. */
function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio, 1 (no contrast) to 21 (max). */
function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const [L1, L2] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (L1 + 0.05) / (L2 + 0.05);
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

/** Shortest distance between two hues on the 0-360 wheel. */
function hueDistance(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Dominant color of a canvas region via simple RGB binning (quantize each
 * channel into 32 buckets, take the most frequent bucket). Fast, no
 * dependencies, good enough for "what color is this roughly."
 */
function dominantColor(ctx, x, y, w, h) {
  const { data } = ctx.getImageData(Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h));
  const buckets = new Map();
  const BUCKET = 32;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 200) continue; // skip transparent edge pixels
    const r = Math.floor(data[i] / BUCKET) * BUCKET;
    const g = Math.floor(data[i + 1] / BUCKET) * BUCKET;
    const b = Math.floor(data[i + 2] / BUCKET) * BUCKET;
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let best = null, bestCount = -1;
  for (const [key, count] of buckets) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  if (!best) return { r: 128, g: 128, b: 128 };
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b };
}

/** Euclidean RGB distance — used to filter out skin-colored pixels before binning. */
function rgbDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * Same as dominantColor(), but skips any pixel close to a known skin tone
 * first. Used for the lookbook flow: face detection finds the torso region,
 * this keeps exposed neck/chest skin from contaminating the garment sample.
 */
function dominantColorExcludingSkin(ctx, x, y, w, h, skinRgb, threshold = 45) {
  const { data } = ctx.getImageData(Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h));
  const buckets = new Map();
  const BUCKET = 32;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 200) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (skinRgb && rgbDistance({ r, g, b }, skinRgb) < threshold) continue; // skip skin-colored pixels
    const rb = Math.floor(r / BUCKET) * BUCKET;
    const gb = Math.floor(g / BUCKET) * BUCKET;
    const bb = Math.floor(b / BUCKET) * BUCKET;
    const key = `${rb},${gb},${bb}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let best = null, bestCount = -1;
  for (const [key, count] of buckets) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  if (!best) return null; // everything in the region looked like skin — nothing usable to report
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b };
}

/**
 * Compare a garment color against a skin swatch and produce a plain-language
 * verdict. Contrast uses the WCAG formula (solid ground). Hue comparison is
 * flagged as approximate — Fitzpatrick is a depth/melanin scale, not a
 * measured undertone, so the swatch's hue is only a rough proxy.
 */
function analyzeOutfitMatch(skinRgb, garmentRgb) {
  const contrast = contrastRatio(skinRgb, garmentRgb);
  const skinHsl = rgbToHsl(skinRgb);
  const garmentHsl = rgbToHsl(garmentRgb);
  const hueDist = hueDistance(skinHsl.h, garmentHsl.h);

  const lowContrast = contrast < 1.6; // both roughly similar brightness
  const closeHue = hueDist < 25 && garmentHsl.s > 0.15; // garment color leans same hue family as skin

  let verdict, note;
  if (lowContrast) {
    verdict = 'low contrast';
    note = 'this color sits close in brightness to your skin tone — it may read as flat in photos.';
  } else if (closeHue) {
    verdict = 'similar hue';
    note = 'this garment leans a similar hue to your skin tone — worth seeing in person before committing.';
  } else {
    verdict = 'good contrast';
    note = 'this color stands apart from your skin tone — should read clearly.';
  }

  return { contrast, hueDist, verdict, note, lowContrast, closeHue };
}
