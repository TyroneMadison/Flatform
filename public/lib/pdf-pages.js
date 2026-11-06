// PDF pages as pixels for the drawing kit: each page of the drawing template PDF (filled in on a tablet, or scanned
// pages saved as one PDF) is read like one photo by lib/drawing-kit.js. pdf.js and the canvas maker are passed in,
// so the node tests (@napi-rs/canvas) and the page (OffscreenCanvas) run the same code.

export const PDF_DPI = 200; // 1700 x 2200 px for a US Letter page, about 7.9 px per mm: the kit straightens at 8
export const MAX_PDF_PAGES = 20;
export const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');

/**
 * Yields { n, total, image } per page (image is { width, height, data: RGBA }), one at a time so a long PDF does not
 * hold every page in memory. data: the PDF bytes. canvas(w, h): a canvas with a 2d context.
 */
export async function* pdfPages(data, pdfjs, canvas, { dpi = PDF_DPI, max = MAX_PDF_PAGES } = {}) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const total = Math.min(doc.numPages, max);
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = canvas(Math.round(vp.width), Math.round(vp.height));
      const g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      // ENABLE: ink and other annotations (drawing done on a tablet) are painted onto the page too.
      await page.render({ canvas: c, canvasContext: g, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
      const { width, height, data: px } = g.getImageData(0, 0, c.width, c.height);
      page.cleanup();
      yield { n, total, image: { width, height, data: px } };
    }
  } finally {
    await task.destroy();
  }
}
