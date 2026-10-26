// A share page for testing on this computer only: runs share-worker/worker.js on http://127.0.0.1:8787 with an
// in-memory bucket (forgotten when it stops). Nothing is deployed and no account is used.
//   node test-app/fake-share-worker.mjs      then in Flatform: Share, Turn on sharing,
//   address http://127.0.0.1:8787, password flatform-test-share-token
import http from 'node:http';
import worker from '../share-worker/worker.js';

export const TOKEN = 'flatform-test-share-token';
const store = new Map();
const BUCKET = {
  async put(k, body) { store.set(k, Buffer.from(await new Response(body).arrayBuffer())); },
  async get(k) { const b = store.get(k); return b ? { body: b, json: async () => JSON.parse(b) } : null; },
  async delete(k) { store.delete(k); },
};
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const r = await worker.fetch(new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers: req.headers, body }), { BUCKET, SHARE_TOKEN: TOKEN });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, '127.0.0.1', () => console.log(`Test share page on http://127.0.0.1:8787 (password ${TOKEN}). Ctrl+C stops it.`));
