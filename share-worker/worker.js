// Flatform share page. GET /<id> serves a small HTML page that plays the MP4 from R2; expired or unknown ids get 404.
// Upload is POST /<id> with the SHARE_TOKEN bearer header (Flatform does that once Tyrone has deployed this).
const page = (id, m, origin) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)}</title><meta property="og:title" content="${esc(m.title)}"><meta property="og:type" content="video.other">
<meta property="og:video" content="${origin}/${id}/video.mp4">${m.poster ? `<meta property="og:image" content="${origin}/${id}/poster.jpg">` : ''}
<style>body{margin:0;background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}video{max-width:100vw;max-height:90vh}</style></head>
<body><video controls autoplay muted loop playsinline ${m.poster ? `poster="/${id}/poster.jpg"` : ''} src="/${id}/video.mp4"></video></body></html>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ID = /^[0-9A-Za-z]{10,32}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const [id, file] = url.pathname.slice(1).split('/');
    if (!ID.test(id || '')) return new Response('Not found', { status: 404 });
    if (req.method === 'POST') {
      if (req.headers.get('authorization') !== `Bearer ${env.SHARE_TOKEN}`) return new Response('Forbidden', { status: 403 });
      const key = file === 'meta' ? `${id}/meta.json` : `${id}/${file === 'poster.jpg' ? 'poster.jpg' : 'video.mp4'}`;
      await env.BUCKET.put(key, req.body);
      return new Response('ok');
    }
    if (req.method === 'DELETE') {
      if (req.headers.get('authorization') !== `Bearer ${env.SHARE_TOKEN}`) return new Response('Forbidden', { status: 403 });
      await Promise.all(['meta.json', 'video.mp4', 'poster.jpg'].map((f) => env.BUCKET.delete(`${id}/${f}`)));
      return new Response('ok');
    }
    const metaObj = await env.BUCKET.get(`${id}/meta.json`);
    if (!metaObj) return new Response('Not found', { status: 404 });
    const m = await metaObj.json();
    if (m.expiresAt && Date.parse(m.expiresAt) <= Date.now()) return new Response('This link has expired', { status: 410 });
    if (file === 'video.mp4' || file === 'poster.jpg') {
      const o = await env.BUCKET.get(`${id}/${file}`);
      return o ? new Response(o.body, { headers: { 'content-type': file.endsWith('mp4') ? 'video/mp4' : 'image/jpeg' } }) : new Response('Not found', { status: 404 });
    }
    return new Response(page(id, m, url.origin), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
