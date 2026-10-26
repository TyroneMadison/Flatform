"""Flatform local engine: Microsoft TRELLIS (MIT) image-to-3D on a CUDA GPU, as a tiny HTTP service on 127.0.0.1.

Started and stopped by Flatform (local.mjs). Needs Python 3.10+, PyTorch with CUDA and the TRELLIS repo installed
(see README.md next to this file). Weights come from the folder Flatform downloaded them to (--weights).
Routes: GET /health, POST /generate {images: {front: data-uri, ...}, options}, GET /status/<id>, GET /result/<id>,
POST /shutdown. One job runs at a time; others wait in order.
"""
import argparse, base64, io, json, os, queue, sys, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # detail_boost.py sits next to this file
args = argparse.ArgumentParser()
args.add_argument('--port', type=int, default=41730)
args.add_argument('--weights', required=True)
opts = args.parse_args()

state = {'ok': False, 'error': None}
jobs, work, pipe = {}, queue.Queue(), None


def load():
    global pipe
    try:
        import torch
        if not torch.cuda.is_available():
            state['error'] = 'No CUDA graphics card found.'
            return
        os.environ.setdefault('SPCONV_ALGO', 'native')
        from trellis.pipelines import TrellisImageTo3DPipeline
        pipe = TrellisImageTo3DPipeline.from_pretrained(opts.weights)
        pipe.cuda()
        state['ok'] = True
    except Exception as e:  # shown to the user by Flatform
        state['error'] = f'Could not load TRELLIS: {e}'


def run():
    from PIL import Image
    from trellis.utils import postprocessing_utils
    while True:
        jid = work.get()
        job = jobs[jid]
        job['status'] = 'running'
        try:
            o = job['options']
            imgs = [Image.open(io.BytesIO(base64.b64decode(u.split(',', 1)[1]))) for u in job['images'].values()]
            steps = int(o.get('steps', 25))
            kw = dict(seed=int(o.get('seed') or 1), sparse_structure_sampler_params={'steps': steps, 'cfg_strength': 7.5},
                      slat_sampler_params={'steps': steps, 'cfg_strength': 3})
            out = pipe.run_multi_image(imgs, **kw) if len(imgs) > 1 else pipe.run(imgs[0], **kw)
            job['progress'] = 80
            glb = postprocessing_utils.to_glb(out['gaussian'][0], out['mesh'][0], simplify=float(o.get('simplify', 0.95)),
                                              texture_size=int(o.get('texture_size', 1024)))
            path = os.path.join(tempfile.gettempdir(), f'flatform-{jid}.glb')
            glb.export(path)
            if o.get('detail_boost'):  # local finishing pass, see detail_boost.py
                job['progress'] = 90
                from detail_boost import boost_glb
                boosted = path.replace('.glb', '-boost.glb')
                job['boost'] = boost_glb(path, boosted, weights=job.get('upscaler'), target=int(o.get('texture_size', 4096)))
                path = boosted
            job.update(status='success', progress=100, file=path)
        except Exception as e:
            job.update(status='failed', error=str(e)[:300])


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, code, body, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', kind); self.send_header('Content-Length', str(len(data))); self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200 if state['ok'] else 503, state)
        kind, _, jid = self.path.strip('/').partition('/')
        job = jobs.get(jid)
        if not job: return self.reply(404, {'error': 'no such job'})
        if kind == 'status': return self.reply(200, {k: job.get(k) for k in ('status', 'progress', 'error', 'boost')})
        if kind == 'result' and job['status'] == 'success':
            with open(job['file'], 'rb') as f: return self.reply(200, f.read(), 'model/gltf-binary')
        self.reply(404, {'error': 'not ready'})

    def do_POST(self):
        if self.path == '/shutdown':
            self.reply(200, {'ok': True}); threading.Thread(target=server.shutdown).start(); return
        if self.path != '/generate' or not state['ok']: return self.reply(503, {'error': state['error'] or 'not ready'})
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        jid = uuid.uuid4().hex
        jobs[jid] = {'status': 'queued', 'progress': 0, 'images': body['images'], 'options': body.get('options', {}),
                     'upscaler': body.get('upscaler')}
        work.put(jid)
        self.reply(200, {'task_id': jid})


server = ThreadingHTTPServer(('127.0.0.1', opts.port), H)
threading.Thread(target=load, daemon=True).start()
threading.Thread(target=run, daemon=True).start()
server.serve_forever()
