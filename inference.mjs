// Car material inference, server side: labels the photo's colour clusters with a vision-language model when an
// Anthropic key is set (keys.mjs, provider 'anthropic'), and falls back to the rule-based labels in
// public/lib/infer.js when there is no key, no network or a bad answer. Same raw-fetch pattern as providers.mjs.
import { REGION_IDS, REGIONS, labelClusters } from './public/lib/infer.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const VISION_MODEL = 'claude-opus-5-5';

const PROMPT = (stats) => `This is a photo of a car. Its pixels were grouped into ${stats.length} colour clusters. For each cluster, say which part of the car it mostly covers.
Clusters (index, mean sRGB colour, mean position in the frame as fractions from the top-left, share of the car's pixels):
${stats.map((c, i) => `${i}: rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}), x=${c.x.toFixed(2)}, y=${c.y.toFixed(2)}, share=${(c.share * 100).toFixed(1)}%`).join('\n')}
Labels: ${REGION_IDS.map((id) => `${id} (${REGIONS[id].label})`).join(', ')}.
Reply with only a JSON array, one object per cluster: [{"index": 0, "label": "paint", "confidence": 0.9}, ...]. Confidence is 0 to 1.`;

/**
 * stats: public/lib/infer.js clusterStats(). image: a data: URL of the photo (PNG or JPEG) or null.
 * key: the Anthropic API key or undefined. fetch: swapped in tests. Returns { labels, source: 'vision'|'heuristic', note? }.
 */
export async function inferRegions({ stats, image, key, fetch: doFetch = globalThis.fetch, base = ANTHROPIC_BASE }) {
  const fallback = (note) => ({ labels: labelClusters(stats), source: 'heuristic', ...(note && { note }) });
  if (!key || !image) return fallback(key ? 'No photo to look at' : 'No Anthropic key: used the built-in rules');
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(image);
  if (!m) return fallback('The photo must be a PNG or JPEG');
  try {
    const res = await doFetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL, max_tokens: 2048,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: PROMPT(stats) }] }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return fallback(`Vision model: ${out.error?.message || `HTTP ${res.status}`}`);
    if (out.stop_reason === 'refusal') return fallback('Vision model declined to look at this photo');
    const text = (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    const byIndex = [];
    for (const row of json) if (Number.isInteger(row?.index) && REGION_IDS.includes(row.label)) byIndex[row.index] = { label: row.label, confidence: Number(row.confidence) };
    if (!byIndex.some(Boolean)) return fallback('Vision model gave no usable labels');
    return { labels: labelClusters(stats, byIndex), source: 'vision' };
  } catch (e) {
    return fallback(`Vision model unreachable: ${e.message}`);
  }
}

// A key is accepted once the API lists its models with it (a free call).
export async function checkAnthropicKey(key, { fetch: doFetch = globalThis.fetch, base = ANTHROPIC_BASE } = {}) {
  const res = await doFetch(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'Anthropic rejected that key' : `Anthropic: HTTP ${res.status}`), { status: res.status === 401 ? 401 : 502 });
  return true;
}
