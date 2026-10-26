// Finds a mesh's loose pieces off the main thread (pieces.js), so a 2 million triangle scan never freezes the page.
import { findPieces } from './pieces.js';

self.onmessage = ({ data: { id, pos, index } }) => {
  const r = findPieces(pos, index);
  self.postMessage({ id, ...r }, [r.vertexPiece.buffer, r.sizes.buffer]);
};
