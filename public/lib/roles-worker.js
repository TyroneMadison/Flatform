// Splits a mesh into parts for Part colors off the main thread (roles.js segmentFaces), so a big scan never freezes the page.
import { segmentFaces } from './roles.js';

self.onmessage = ({ data: { id, pos, index, opts } }) => {
  try {
    const r = segmentFaces(pos, index, opts);
    self.postMessage({ id, ...r }, [r.labels.buffer]);
  } catch (e) { self.postMessage({ id, error: e.message }); }
};
