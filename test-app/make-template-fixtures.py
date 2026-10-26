"""Builds the drawing template test photos: pages of assets/template/Flatform-Drawing-Template.pdf with a simple
character drawn on them, then tilted and tinted like a phone photo.

    python test-app/make-template-fixtures.py test/fixtures/template

Needs PyMuPDF, Pillow and numpy (dev only, the app never runs Python). Writes cover.png, front.png, back.png,
left.png, right.png, detail.png and colormap.png. The back view's arms touch the body on purpose (a pre-check warning).
"""
import os
import sys

import fitz
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, '..', 'assets', 'template', 'Flatform-Drawing-Template.pdf')
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
DPI = 150
K = DPI / 25.4  # px per mm
INK = (30, 30, 34)


def page(i):
    pix = fitz.open(PDF)[i].get_pixmap(dpi=DPI)
    return Image.frombytes('RGB', (pix.width, pix.height), pix.samples)


def mm(*v):
    return [x * K for x in v]


def limb(d, a, b, w, fill):
    d.line(mm(*a, *b), fill=INK, width=int((w + 1.2) * K))
    d.line(mm(*a, *b), fill=fill, width=int(w * K))


def figure(d, ox, oy, s, arms='out', side=False, colors=None):
    """A character in a 150 x 200 mm box (head top and feet on the guide) at (ox, oy) scaled by s, colors: head, body, arms, legs."""
    head, body, arm, leg = colors or ('#d9b35c', '#3d4f7a', '#5b6ea0', '#2c2c34')
    p = lambda x, y: (ox + x * s, oy + (y - 45) * s)  # x: 75 is the middle, y: 64 is the head top
    if side:
        limb(d, p(75, 92), p(75, 138), 9, arm)
        limb(d, p(73, 140), p(71, 222), 11, leg)
        d.rounded_rectangle(mm(*p(64, 86), *p(86, 142)), radius=3 * K, fill=body, outline=INK, width=int(1.2 * K))
        d.ellipse(mm(*p(66, 64), *p(86, 86)), fill=head, outline=INK, width=int(1.2 * K))
        return
    if arms == 'out':
        limb(d, p(64, 92), p(28, 132), 8, arm)
        limb(d, p(86, 92), p(122, 132), 8, arm)
    else:  # down and touching the body
        limb(d, p(62, 92), p(60, 140), 8, arm)
        limb(d, p(88, 92), p(90, 140), 8, arm)
    limb(d, p(68, 140), p(60, 222), 10, leg)
    limb(d, p(82, 140), p(90, 222), 10, leg)
    d.rounded_rectangle(mm(*p(63, 86), *p(87, 142)), radius=3 * K, fill=body, outline=INK, width=int(1.2 * K))
    d.ellipse(mm(*p(65, 64), *p(85, 86)), fill=head, outline=INK, width=int(1.2 * K))


def photo(img, seed):
    """Tilts the page on a dark table, warms the light and darkens one side, like a phone photo."""
    rng = np.random.default_rng(seed)
    W, H = img.size
    pad = 90
    big = Image.new('RGB', (W + 2 * pad, H + 2 * pad), (58, 54, 50))
    big.paste(img, (pad, pad))
    w2, h2 = big.size
    j = lambda: rng.uniform(-40, 40)
    # Where the corners of the result come from in the padded page (a mild keystone and turn).
    src = [(j() + 20, j() + 20), (w2 - 20 + j(), j() + 20), (w2 - 20 + j(), h2 - 20 + j()), (j() + 20, h2 - 20 + j())]
    dst = [(0, 0), (w2, 0), (w2, h2), (0, h2)]
    A = []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    coef = np.linalg.solve(np.array(A, float), np.array([c for s in src for c in s], float))
    big = big.transform(big.size, Image.PERSPECTIVE, tuple(coef), Image.BICUBIC, fillcolor=(58, 54, 50))
    a = np.asarray(big).astype(np.float32)
    ramp = np.linspace(1.0, 0.86, a.shape[1])[None, :, None]
    a = a * ramp * np.array([1.0, 0.96, 0.88])
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


pages = {}
# 1 cover: four legend swatches filled, Glow and Energy left empty.
im = page(0); d = ImageDraw.Draw(im)
for i, c in enumerate(['#3d4f7a', '#d9b35c', '#2c2c34', '#c0392b']):
    y = 94 + 17 * i
    d.rounded_rectangle(mm(62, y + 2, 84, y + 11), radius=1.5 * K, fill=c)
pages['cover'] = im
# 2-5: front (arms out), back (arms touching), left and right (side on).
for idx, name, kw in [(1, 'front', {}), (2, 'back', {'arms': 'down'}), (3, 'left', {'side': True}), (4, 'right', {'side': True})]:
    im = page(idx); d = ImageDraw.Draw(im)
    figure(d, 33, 46, 1, **kw)
    pages[name] = im
# 6 detail: a helmet sketch in the first box.
im = page(5); d = ImageDraw.Draw(im)
d.ellipse(mm(30, 60, 84, 130), fill='#d9b35c', outline=INK, width=int(1.5 * K))
d.rectangle(mm(40, 85, 74, 95), fill='#18f0ff', outline=INK, width=int(K))
pages['detail'] = im
# 7 color map: the same figure in key colors, front and back (94 x 125.3 boxes, so scale 94 / 150).
im = page(6); d = ImageDraw.Draw(im)
keys = ('#FFFF00', '#FF0000', '#0000FF', '#00FF00')  # head Accent, body Primary, arms Tertiary, legs Secondary
s = 94 / 150
figure(d, 10, 46, s, colors=keys)
figure(d, 111.9, 46, s, colors=('#FFFF00', '#FF00FF', '#0000FF', '#00FF00'))  # the back's body is Energy
pages['colormap'] = im

for n, (name, im) in enumerate(pages.items()):
    photo(im, n + 1).save(os.path.join(out, f'{name}.png'), optimize=True)
    print('wrote', name)
