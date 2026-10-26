// How a version reads to people: "1.1.0" → "1.1", "1.1.2" → "1.1.2", "v2.0.0" → "2.0". Releases step by 0.1
// (VERSIONING.md), so the .0 patch is noise. Anything that isn't X.Y.Z comes back as given.
export function displayVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(v ?? '').trim());
  if (!m) return String(v ?? '');
  return m[3] === '0' && !m[4] ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}${m[4]}`;
}
