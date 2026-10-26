// Car auto-identify: from the source photo's name and metadata, suggest make, model, year range, body style and
// colour, to fill the project name and folder. The local pass is a word match over a known-make table (free,
// offline). An optional API pass runs only when a vision key is in settings; it is injected (callApi) so tests mock it.
import { slugify } from './pipeline.js';

// ponytail: a flat word table; a local vision model can replace identifyLocal later without touching callers.
export const MAKES = {
  lamborghini: ['huracan', 'urus', 'aventador', 'revuelto', 'gallardo'],
  ferrari: ['296', 'sf90', 'roma', 'purosangue', '488', 'f8', '812'],
  mercedes: ['c300', 'c63', 'gle', 'gls', 'maybach', 'g63', 'g-wagon', 'amg', 'e63', 's580', 'sl63'],
  bmw: ['m3', 'm4', 'm5', 'x5', 'x7', 'i7', 'm8'],
  chevrolet: ['corvette', 'c8', 'z06', 'camaro', 'tahoe', 'silverado'],
  cadillac: ['escalade', 'ct5', 'lyriq'],
  tesla: ['cybertruck', 'cyberbeast', 'model s', 'model 3', 'model x', 'model y', 'plaid'],
  porsche: ['911', 'taycan', 'cayenne', 'macan', 'panamera', 'gt3'],
  audi: ['r8', 'rs6', 'rs7', 'q8', 'e-tron'],
  rollsroyce: ['cullinan', 'ghost', 'phantom', 'spectre', 'dawn'],
  bentley: ['bentayga', 'continental', 'flying spur'],
  mclaren: ['720s', '765lt', 'artura', 'gt'],
  dodge: ['challenger', 'charger', 'hellcat', 'durango'],
  ford: ['mustang', 'raptor', 'f-150', 'bronco'],
  toyota: ['supra', 'land cruiser', 'tundra'],
  nissan: ['gt-r', 'gtr', 'z'],
  range_rover: ['sport', 'velar', 'evoque', 'defender'],
  jeep: ['wrangler', 'trackhawk'],
};
const MAKE_NAMES = { mercedes: 'Mercedes-Benz', bmw: 'BMW', rollsroyce: 'Rolls-Royce', mclaren: 'McLaren', range_rover: 'Range Rover' };
export const BODY_STYLES = ['coupe', 'convertible', 'spyder', 'spider', 'roadster', 'sedan', 'suv', 'truck', 'wagon', 'hatchback', 'cabriolet'];
export const COLORS = ['black', 'white', 'silver', 'grey', 'gray', 'red', 'blue', 'green', 'yellow', 'orange', 'gold', 'purple', 'brown', 'bronze', 'matte', 'pearl'];
const ALIASES = { 'g-wagon': 'g63', gtr: 'gt-r', cyberbeast: 'cybertruck' };
const titleCase = (s) => String(s).replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Hyphenated names (g-wagon, gt-r, f-150) are searched both as written and split, so "car-12-front" still reads.
const words = (text) => { const w = String(text || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[_.]+/g, ' '); return `${w} ${w.replace(/-/g, ' ')}`; };

/** The local suggestion from file names and any text hints (EXIF description, folder name). Never null. */
export function identifyLocal({ names = [], hints = [] } = {}) {
  const text = ` ${[...names, ...hints].map(words).join(' ')} `;
  let make = null;
  let model = null;
  for (const [key, models] of Object.entries(MAKES)) {
    const makeHit = text.includes(` ${key.replace('_', ' ')} `) || text.includes(` ${key} `);
    const modelHit = models.find((m) => text.includes(` ${m} `) || text.includes(` ${m}`));
    if (makeHit || modelHit) {
      make = key;
      model = modelHit || null;
      break;
    }
  }
  const year = text.match(/\b(19[89]\d|20[0-4]\d)\b/);
  const body = BODY_STYLES.find((b) => text.includes(` ${b} `));
  const color = COLORS.find((c) => text.includes(` ${c} `));
  const yearRange = year ? [Number(year[1]), Number(year[1])] : null;
  const confidence = Math.min(1, (make ? 0.4 : 0) + (model ? 0.3 : 0) + (year ? 0.15 : 0) + (color ? 0.1 : 0) + (body ? 0.05 : 0));
  return {
    make: make ? MAKE_NAMES[make] || titleCase(make) : null,
    model: model ? titleCase(ALIASES[model] || model) : null,
    yearRange, bodyStyle: body ? titleCase(body) : null, color: color ? titleCase(color === 'gray' ? 'grey' : color) : null,
    confidence: Math.round(confidence * 100) / 100, source: 'local',
  };
}

/** "2024 Ferrari 296 GTB" style name from a suggestion, or the first file's name when nothing was recognised. */
export function suggestName(s, fallback = 'Untitled car') {
  const year = s.yearRange ? (s.yearRange[0] === s.yearRange[1] ? String(s.yearRange[0]) : `${s.yearRange[0]}–${s.yearRange[1]}`) : '';
  const name = [year, s.make, s.model, s.color && !s.make ? s.color : ''].filter(Boolean).join(' ').trim();
  return name || fallback;
}
export const suggestFolder = (s, fallback) => slugify(suggestName(s, fallback));

/**
 * Local first; the API pass only when a key is set and a caller is given. callApi({ key, image }) → a partial
 * suggestion ({ make, model, yearRange, bodyStyle, color, confidence }) or throws; the local answer stands then.
 */
export async function identifyCar({ names, hints, image, apiKey, callApi }) {
  const local = identifyLocal({ names, hints });
  if (!apiKey || !callApi) return local;
  try {
    const remote = await callApi({ key: apiKey, image });
    if (!remote || typeof remote !== 'object') return local;
    const merged = { ...local };
    for (const k of ['make', 'model', 'yearRange', 'bodyStyle', 'color']) if (remote[k] != null && (merged[k] == null || (remote.confidence ?? 0) >= local.confidence)) merged[k] = remote[k];
    return { ...merged, confidence: Math.max(local.confidence, Number(remote.confidence) || 0), source: 'api+local' };
  } catch {
    return local;
  }
}
