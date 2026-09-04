import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

const MAX_PREVIEWS = 16;
const previewCache = new Map<string, Promise<Blob>>();

/** Render the first page of a local PDF as a PNG suitable for an HTML image. */
export function renderPdfFigurePreview(pdf: Blob, cacheKey: string): Promise<Blob> {
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;
  const preview = renderFirstPage(pdf);
  previewCache.set(cacheKey, preview);
  while (previewCache.size > MAX_PREVIEWS) previewCache.delete(previewCache.keys().next().value!);
  void preview.catch(() => { if (previewCache.get(cacheKey) === preview) previewCache.delete(cacheKey); });
  return preview;
}

export function isPdfFigurePath(path: string): boolean {
  return /\.pdf$/i.test(path.trim());
}

/** Keeps scientific figures crisp without allowing an unbounded canvas. */
export function pdfPreviewScale(width: number, height: number): number {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  return Math.min(3, 1_800 / safeWidth, 2_400 / Math.max(safeWidth, safeHeight));
}

async function renderFirstPage(pdfBlob: Blob): Promise<Blob> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
  const loading = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, stopAtErrors: true });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pdfPreviewScale(base.width, base.height) });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas rendering is unavailable for this PDF figure.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
    page.cleanup();
    return await canvasToPng(canvas);
  } finally {
    await loading.destroy();
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('The PDF figure could not be converted to PNG.')),
    'image/png',
  ));
}
