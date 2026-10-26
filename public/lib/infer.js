// Car material inference: from the source photo, which parts of the car are paint, chrome, glass, rubber, carbon
// fibre, brake calipers, lights or grille plastic, and what PBR material each should get instead of the baked photo.
// Pure functions (no DOM, no three): the browser does the pixel work and the camera projection, the server asks a
// vision model when a key is set (inference.mjs), and the tests run the rules on small fixtures.

// Regions and the PBR preset each one maps to. Every value is a MeshPhysicalMaterial field (see tenno.js).
export const REGIONS = {
  paint: { label: 'Body paint', preset: { metalness: 0.3, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06, flake: { size: 0.4, density: 0.5 } }, sampleColor: true },
  chrome: { label: 'Chrome / trim', preset: { metalness: 1, roughness: 0.05, color: '#f2f2f2' } },
  glass: { label: 'Glass', preset: { metalness: 0, roughness: 0.03, transmission: 1, ior: 1.5, thickness: 0.02, color: '#14202a' } },
  rubber: { label: 'Tyres / rubber', preset: { metalness: 0, roughness: 0.9, color: '#141414' } },
  carbon: { label: 'Carbon fibre', preset: { metalness: 0.1, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08, color: '#1a1a1c', weave: true } },
  caliper: { label: 'Brake calipers', preset: { metalness: 0.4, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2 }, sampleColor: true },
  lights: { label: 'Lights', preset: { metalness: 0, roughness: 0.05, transmission: 0.9, ior: 1.5, thickness: 0.01, color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 0.6 } },
  grille: { label: 'Grille plastic', preset: { metalness: 0, roughness: 0.55, color: '#101010' } },
};
export const REGION_IDS = Object.keys(REGIONS);
export const LOW_CONFIDENCE = 0.55; // below this a piece is flagged for review

// The PBR material for a region. sampled: the base colour taken from the photo (paint, calipers).
export function presetFor(region, sampled = null) {
  if (!Object.hasOwn(REGIONS, region)) throw new Error(`Unknown region ${region}`);
  const r = REGIONS[region];
  const { flake, weave, ...values } = r.preset;
  return { ...values, ...(r.sampleColor && sampled && { color: sampled }), ...(flake && { flake }), ...(weave && { weave }), region };
}

// Base colour of a painted region with baked reflections, highlights and shadows stripped: the robust median of
// the mid-tone pixels. pixels: flat RGBA bytes (or RGB with stride 3), mask: optional 0/1 per pixel.
// Specular hotspots (very bright, low saturation) and deep shadows are dropped before the median, and the median is
// taken per channel over the middle half of the luminance range, so a few hotspots never move it.
export function stripHighlights(pixels, mask = null, stride = 4) {
  const n = pixels.length / stride;
  const lum = [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const p = i * stride;
    const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
    if (l > 235 && sat < 0.25) continue; // specular hotspot / baked reflection of the sky
    if (l < 12) continue; // deep shadow
    lum.push(l);
    idx.push(i);
  }
  if (!idx.length) return { color: '#808080', samples: 0 };
  const order = idx.map((_, k) => k).sort((a, b) => lum[a] - lum[b]);
  const lo = Math.floor(order.length * 0.25);
  const hi = Math.max(lo + 1, Math.ceil(order.length * 0.75)); // the middle half: no highlights, no shadow sides
  const chan = [[], [], []];
  for (let k = lo; k < hi; k++) {
    const p = idx[order[k]] * stride;
    for (let c = 0; c < 3; c++) chan[c].push(pixels[p + c]);
  }
  const med = chan.map((arr) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; });
  return { color: `#${med.map((v) => v.toString(16).padStart(2, '0')).join('')}`, samples: hi - lo };
}

// Votes per piece: samples = [{ piece, label, weight }] (one per projected face or vertex that landed on a labelled
// photo pixel). Returns { [piece]: { region, confidence, votes, flagged } }; confidence = share of the winning label.
export function voteRegions(samples, { minVotes = 3 } = {}) {
  const tally = {};
  for (const s of samples) {
    if (!s.label) continue;
    const t = tally[s.piece] ||= { total: 0, labels: {} };
    const w = s.weight ?? 1;
    t.total += w;
    t.labels[s.label] = (t.labels[s.label] || 0) + w;
  }
  const out = {};
  for (const [piece, t] of Object.entries(tally)) {
    const [region, votes] = Object.entries(t.labels).sort((a, b) => b[1] - a[1])[0];
    const confidence = t.total ? votes / t.total : 0;
    out[piece] = { region, confidence, votes: t.total, flagged: confidence < LOW_CONFIDENCE || t.total < minVotes };
  }
  return out;
}

// Groups the faces of an indexed geometry by label so each label becomes its own material group ("piece"). index:
// the triangle index array, faceLabels: a label per triangle (null = unlabelled, kept in a group of its own).
// Returns { index: reordered indices, groups: [{ start, count, label }] } for geometry.setIndex / addGroup.
export function groupFaces(index, faceLabels) {
  const faces = index.length / 3;
  const byLabel = new Map();
  for (let f = 0; f < faces; f++) {
    const label = faceLabels[f] ?? null;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(f);
  }
  const out = new (index.length > 65535 ? Uint32Array : Uint16Array)(index.length);
  const groups = [];
  let at = 0;
  for (const [label, list] of [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    groups.push({ start: at, count: list.length * 3, label });
    for (const f of list) { out[at++] = index[f * 3]; out[at++] = index[f * 3 + 1]; out[at++] = index[f * 3 + 2]; }
  }
  return { index: out, groups };
}

// Label a cluster of photo pixels without a vision model: colour, brightness and where it sits in the frame.
// c: { r, g, b, y (0 top … 1 bottom, mean), x (0 … 1), share (0 … 1 of the car's pixels), edge (0 … 1 share of
// pixels next to another cluster) }. The biggest colourful or glossy cluster is the paint.
export function labelClusterHeuristic(c, { largest = false } = {}) {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const sat = max ? (max - min) / max : 0;
  if (largest) return { label: 'paint', confidence: 0.7 };
  if (lum < 40 && c.y > 0.6 && sat < 0.2) return { label: 'rubber', confidence: 0.75 };
  if (lum > 200 && sat < 0.12) return { label: 'chrome', confidence: 0.5 };
  if (lum < 70 && sat < 0.3 && c.y < 0.55) return { label: 'glass', confidence: 0.6 };
  if (lum > 170 && sat > 0.1 && c.y > 0.3 && c.y < 0.75 && c.share < 0.06) return { label: 'lights', confidence: 0.5 };
  if (lum < 40 && c.y > 0.4 && c.y < 0.75 && c.share < 0.08) return { label: 'grille', confidence: 0.45 };
  if (sat > 0.6 && c.share < 0.03 && c.y > 0.55) return { label: 'caliper', confidence: 0.5 };
  return { label: 'paint', confidence: 0.4 };
}

// k-means on RGB (k clusters, a few iterations): returns a cluster index per pixel and the cluster centres.
// Pixels with mask 0 (not the car) get -1. ponytail: plain k-means stands in for SAM when no model is reachable.
export function kmeans(pixels, mask, k = 8, iterations = 8, stride = 4) {
  const n = pixels.length / stride;
  const centres = [];
  for (let i = 0, step = Math.max(1, Math.floor(n / k)); centres.length < k && i < n; i += step) if (!mask || mask[i]) centres.push([pixels[i * stride], pixels[i * stride + 1], pixels[i * stride + 2]]);
  while (centres.length < k) centres.push([Math.random() * 255, Math.random() * 255, Math.random() * 255]);
  const labels = new Int16Array(n).fill(-1);
  for (let it = 0; it < iterations; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      const p = i * stride;
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = (pixels[p] - centres[c][0]) ** 2 + (pixels[p + 1] - centres[c][1]) ** 2 + (pixels[p + 2] - centres[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      labels[i] = best;
      sum[best][0] += pixels[p]; sum[best][1] += pixels[p + 1]; sum[best][2] += pixels[p + 2]; sum[best][3]++;
    }
    for (let c = 0; c < centres.length; c++) if (sum[c][3]) centres[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
  }
  return { labels, centres };
}

// Cluster statistics for labelling: mean colour, position, share, from a k-means result.
export function clusterStats(labels, centres, width, height) {
  const stats = centres.map(([r, g, b]) => ({ r, g, b, n: 0, x: 0, y: 0 }));
  let total = 0;
  for (let i = 0; i < labels.length; i++) {
    const c = labels[i];
    if (c < 0) continue;
    stats[c].n++; total++;
    stats[c].x += (i % width) / width;
    stats[c].y += Math.floor(i / width) / height;
  }
  return stats.map((s) => ({ r: s.r, g: s.g, b: s.b, share: total ? s.n / total : 0, x: s.n ? s.x / s.n : 0, y: s.n ? s.y / s.n : 0, n: s.n }));
}
// Labels every cluster: the vision model's answer when it has one, the heuristic otherwise.
export function labelClusters(stats, visionLabels = null) {
  const largest = stats.reduce((a, b, i) => (stats[i].n > stats[a].n ? i : a), 0);
  return stats.map((c, i) => {
    const v = visionLabels?.[i];
    if (v && REGION_IDS.includes(v.label)) return { label: v.label, confidence: Math.min(1, Math.max(0, v.confidence ?? 0.8)), source: 'vision' };
    return { ...labelClusterHeuristic(c, { largest: i === largest }), source: 'heuristic' };
  });
}

// Inferred results merged with the user's overrides: a piece the user set keeps its region and preset across re-runs.
export function mergeInference(pieces, inferred) {
  const out = { ...pieces };
  for (const [key, r] of Object.entries(inferred)) {
    const prev = out[key] || {};
    if (prev.region?.user) continue; // the user decided; a re-run never overrides that
    out[key] = { ...prev, region: { label: r.region, confidence: r.confidence, flagged: r.flagged, user: false } };
  }
  return out;
}
export const overrideRegion = (pieces, key, label) => ({ ...pieces, [key]: { ...pieces[key], region: { label, confidence: 1, flagged: false, user: true } } });
