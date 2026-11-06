"""Builds test/fixtures/template/filled.pdf: the bundled drawing template filled in on a tablet. FRONT has the
character drawn into the page (vector), BACK has it as ink annotations (pen strokes), the cover legend and the color
map are colored in. Pages 4-6 stay blank. The page scans are cut to 150 dpi so the file stays small.

    python test-app/make-template-pdf-fixture.py test/fixtures/template

Needs PyMuPDF (dev only, the app never runs Python).
"""
import os
import sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.join(HERE, '..', 'assets', 'template', 'Flatform-Drawing-Template.pdf')
out = sys.argv[1] if len(sys.argv) > 1 else '.'
PT = 72 / 25.4  # points per mm
INK = (30 / 255, 30 / 255, 34 / 255)
rgb = lambda h: tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
P = lambda x, y: pymupdf.Point(x * PT, y * PT)


def figure(page, ox, oy, s, colors=('#d9b35c', '#3d4f7a', '#5b6ea0', '#2c2c34')):
    """Arms out, legs apart, in a 150 x 200 mm box at (ox, oy) scaled by s (as make-template-fixtures.py)."""
    head, body, arm, leg = map(rgb, colors)
    p = lambda x, y: P(ox + x * s, oy + (y - 45) * s)
    sh = page.new_shape()
    for a, b, w, c in [((64, 92), (28, 132), 8, arm), ((86, 92), (122, 132), 8, arm), ((68, 140), (60, 222), 10, leg), ((82, 140), (90, 222), 10, leg)]:
        sh.draw_line(p(*a), p(*b)); sh.finish(color=INK, width=(w + 1.2) * s * PT, lineCap=1)
        sh.draw_line(p(*a), p(*b)); sh.finish(color=c, width=w * s * PT, lineCap=1)
    sh.draw_rect(pymupdf.Rect(p(63, 86), p(87, 142))); sh.finish(color=INK, fill=body, width=1.2 * s * PT)
    sh.draw_oval(pymupdf.Rect(p(65, 64), p(85, 86))); sh.finish(color=INK, fill=head, width=1.2 * s * PT)
    sh.commit()


doc = pymupdf.open(PDF)
# 1 cover: four legend swatches filled, Glow and Energy left empty.
sh = doc[0].new_shape()
for i, c in enumerate(['#3d4f7a', '#d9b35c', '#2c2c34', '#c0392b']):
    y = 94 + 17 * i
    sh.draw_rect(pymupdf.Rect(P(62, y + 2), P(84, y + 11))); sh.finish(fill=rgb(c), color=None)
sh.commit()
# 2 front: drawn into the page.
figure(doc[1], 33, 46, 1)
# 3 back: pen strokes as ink annotations, the way a tablet PDF app saves them.
p = lambda x, y: P(33 + x, 46 + y - 45)
for a, b, w in [((64, 92), (28, 132), 8), ((86, 92), (122, 132), 8), ((68, 140), (60, 222), 10), ((82, 140), (90, 222), 10), ((75, 86), (75, 142), 24), ((75, 66), (75, 84), 18)]:
    an = doc[2].add_ink_annot([[tuple(p(*a)), tuple(p(*b))]])
    an.set_colors(stroke=rgb('#3d4f7a'))
    an.set_border(width=w * PT)
    an.update()
# 7 color map: the figure in key colors, front and back.
figure(doc[6], 10, 46, 94 / 150, ('#FFFF00', '#FF0000', '#0000FF', '#00FF00'))
figure(doc[6], 111.9, 46, 94 / 150, ('#FFFF00', '#FF00FF', '#0000FF', '#00FF00'))
# The template's pages are 300 dpi scans; 150 dpi JPEG keeps the fixture small and still reads.
for page in doc:
    xref = page.get_images()[0][0]
    pix = pymupdf.Pixmap(doc, xref)
    pix.shrink(1)  # half size: 1275 x 1650
    page.replace_image(xref, stream=pix.tobytes('jpg', jpg_quality=80))
os.makedirs(out, exist_ok=True)
doc.save(os.path.join(out, 'filled.pdf'), garbage=4, deflate=True)
print('wrote filled.pdf')
