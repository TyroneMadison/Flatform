// Flatform Test: stand-ins for every paid service, on 127.0.0.1 only. Tripo and 3D AI Studio accept any key, charge
// nothing and return the sample models (a photo named like a person gets the humanoid, anything else the car).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const PERSON = /human|person|hero|frame|warframe|char|man|woman|girl|boy/i;
// The keys the test app starts with. Never real: the mocks take anything, the real services would refuse these.
export const MOCK_KEYS = { TRIPO_API_KEY: 'tsk_flatform_test_mock', THREE_D_AI_STUDIO_KEY: 'flatform-test-mock-3das' };

export function startMocks() {
  const tokens = new Map(); // file_token → uploaded file name
  const tasks = new Map(); // task id → { model, polls }
  let n = 0;
  let base = '';
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const tripo = (data) => json({ code: 0, data });
    const url = req.url;
    const newTask = (model) => { const id = `mock_${++n}`; tasks.set(id, { model, polls: 0 }); return id; };
    if (url.startsWith('/cdn/')) {
      const file = url.slice(5).split('?')[0];
      const bytes = file.endsWith('.png') ? readFileSync(path.join(SEED, 'photos', 'car.png')) : readFileSync(path.join(SEED, /humanoid/.test(file) ? 'humanoid.glb' : 'car.glb'));
      res.writeHead(200);
      return res.end(bytes);
    }
    // Tripo v3
    if (url === '/tripo/v3/account/balance') return tripo({ balance: 9999, frozen: 0 });
    if (url === '/tripo/v3/files') {
      const name = body.match(/filename="([^"]*)"/)?.[1] || '';
      const token = `mock_file_${tokens.size + 1}`;
      tokens.set(token, name);
      return tripo({ file_token: token });
    }
    if (url === '/tripo/v3/generation/image-to-model') {
      const input = (() => { try { return JSON.parse(body).input; } catch { return ''; } })();
      return tripo({ task_id: newTask(PERSON.test(tokens.get(input) || '') ? 'humanoid' : 'car') });
    }
    if (url === '/tripo/v3/models/convert' || url === '/tripo/v3/task') return tripo({ task_id: newTask('car') });
    const tripoTask = url.match(/^\/tripo\/v3\/tasks\/(.+)$/)?.[1];
    if (tripoTask) {
      const t = tasks.get(tripoTask);
      if (!t) return json({ code: 2001, message: 'Task not found' }, 404);
      if (t.polls++ < 1) return tripo({ task_id: tripoTask, status: 'running', progress: 50 });
      return tripo({ task_id: tripoTask, status: 'success', progress: 100, credits_consumed: 0,
        output: { model_url: `${base}/cdn/${t.model}.glb`, rendered_image_url: `${base}/cdn/preview.png` } });
    }
    // 3D AI Studio
    if (url === '/3das/account/user/wallet/') return json({ balance: 9999, rate_limit: 60 });
    const aiTask = url.match(/^\/3das\/v1\/generation-request\/([^/]+)\/status\/$/)?.[1];
    if (aiTask) {
      const t = tasks.get(aiTask);
      if (!t) return json({ detail: 'Not found' }, 404);
      if (t.polls++ < 1) return json({ status: 'IN_PROGRESS', progress: 50 });
      return json({ status: 'FINISHED', progress: 100, results: [{ asset_type: '3D_MODEL', asset: `${base}/cdn/${t.model}.glb` }, { asset_type: 'THUMBNAIL', asset: `${base}/cdn/preview.png` }] });
    }
    if (url.startsWith('/3das/v1/') && req.method === 'POST') return json({ task_id: newTask(PERSON.test(body.slice(0, 2000)) ? 'humanoid' : 'car'), created_at: new Date().toISOString() });
    json({ error: 'Not mocked' }, 404);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    ok({ server, tripoBase: `${base}/tripo/v3`, threeDAIBase: `${base}/3das`, close: () => server.close() });
  }));
}
