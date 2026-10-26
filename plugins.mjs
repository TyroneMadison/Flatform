// Plugin sandbox. A user script runs in its own worker thread (memory cap, hard timeout, killed on overrun) inside a
// fresh vm context that has no require, process, fs or network: only `scene` (a deep copy) and `flatform`
// (log, and setResult to hand back a changed scene). A crash or infinite loop ends the worker, never the app.
// ponytail: vm inside a worker is isolation for mistakes, not a hostile-code boundary; plugins are Tyrone's own.
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
// No host object or function goes into the context (they would lead back to the worker's process); the API is built
// inside it and only JSON text comes out.
const sandbox = Object.create(null); sandbox.__scene = workerData.scene; // null prototype: nothing leads to host constructors
const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
vm.runInContext(\`
  const __out = { logs: [], result: undefined };
  const __fmt = (a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  const flatform = Object.freeze({ log: (...a) => { if (__out.logs.length < 500) __out.logs.push(__fmt(a).slice(0, 2000)); }, setResult: (s) => { __out.result = JSON.parse(JSON.stringify(s)); } });
  const console = { log: flatform.log, warn: flatform.log, error: flatform.log };
  const scene = JSON.parse(__scene); delete globalThis.__scene;
  globalThis.__report = () => JSON.stringify(__out);
\`, ctx);
const report = () => JSON.parse(vm.runInContext('__report()', ctx));
(async () => {
  try { await vm.runInContext('(async () => {' + workerData.code + '\\n})()', ctx, { timeout: workerData.timeoutMs }); parentPort.postMessage({ ok: true, ...report() }); }
  catch (e) { let r = { logs: [] }; try { r = report(); } catch {} parentPort.postMessage({ ok: false, logs: r.logs, error: String(e && e.message || e) }); }
})();
`;

export function runPlugin(code, scene = {}, { timeoutMs = 5000, memoryMb = 64 } = {}) {
  if (typeof code !== 'string' || !code.trim()) return Promise.resolve({ ok: false, logs: [], error: 'The script is empty' });
  if (code.length > 200_000) return Promise.resolve({ ok: false, logs: [], error: 'The script is too long' });
  return new Promise((resolve) => {
    const w = new Worker(WORKER, { eval: true, workerData: { code, scene: JSON.stringify(scene), timeoutMs }, resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 16 }, env: {}, stdout: true, stderr: true });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); w.terminate(); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, logs: [], error: `Stopped after ${timeoutMs / 1000}s` }), timeoutMs + 1000);
    w.on('message', finish);
    w.on('error', (e) => finish({ ok: false, logs: [], error: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `Used more than ${memoryMb} MB` : e.message }));
    w.on('exit', (c) => finish({ ok: false, logs: [], error: `The script stopped (code ${c})` }));
  });
}

const NAME = /^[\w -]{1,60}$/;
/** Installed plugins live in <library>/plugins/<name>.js. Only a script that just passed a test run can be installed. */
export function pluginStore(dir) {
  return {
    async list() { await mkdir(dir, { recursive: true }); return (await readdir(dir)).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)); },
    async install(name, code, lastRun) {
      if (!NAME.test(name || '')) throw new Error('Name the plugin with letters, numbers, spaces or dashes');
      if (!lastRun?.ok) throw new Error('Test the script first; only a passing script can be installed');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, `${name}.js`), code);
    },
    async read(name) { if (!NAME.test(name || '')) throw new Error('No such plugin'); return readFile(path.join(dir, `${name}.js`), 'utf8'); },
    async remove(name) { if (!NAME.test(name || '')) throw new Error('No such plugin'); await rm(path.join(dir, `${name}.js`), { force: true }); },
  };
}
