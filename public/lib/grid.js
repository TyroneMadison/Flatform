// Reference grid: meters or feet, scale silhouettes and the live W x H x L readout.
export const M_PER_FT = 0.3048;
export const toUnit = (m, unit) => (unit === 'ft' ? m / M_PER_FT : m);
export const fromUnit = (v, unit) => (unit === 'ft' ? v * M_PER_FT : v);
export function formatLength(m, unit = 'm') {
  if (unit === 'ft') {
    const inches = Math.round(m / 0.0254);
    return `${Math.floor(inches / 12)} ft ${inches % 12} in`;
  }
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;
}
// size: { x, y, z } in meters (three.js Box3 size). W is x, H is y, L is z.
export const dimensions = (size, unit = 'm') => ({ w: formatLength(size.x, unit), h: formatLength(size.y, unit), l: formatLength(size.z, unit), text: `W ${formatLength(size.x, unit)} x H ${formatLength(size.y, unit)} x L ${formatLength(size.z, unit)}` });
// Grid line spacing: 1 m cells, or 1 ft cells; size covers the model with room to spare.
export function gridSpec(size, unit = 'm') {
  const cell = unit === 'ft' ? M_PER_FT : 1;
  const span = Math.max(4, Math.max(size.x, size.z, size.y) * 2.5);
  const divisions = Math.max(4, Math.ceil(span / cell));
  return { cell, divisions, size: divisions * cell };
}
export const REFERENCES = { human: { label: 'Person 1.8 m', height: 1.8, width: 0.5, depth: 0.3 }, car: { label: 'Car 4.5 m', height: 1.45, width: 1.85, depth: 4.5 } };
