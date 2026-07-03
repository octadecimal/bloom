import { toBlob, toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';

// The export seam (Task 17). Report tab renders the actual DOM (charts +
// tiles + tables), so the export path rasterizes that DOM rather than
// re-deriving a document from data — `html-to-image` for the raster and
// `jsPDF` to assemble a single-page PDF sized to the capture, two mature,
// self-contained client-side libraries kept behind this one function so
// tests target the seam instead of driving real rasterization in jsdom (no
// canvas 2D context there — see [[prefer-proven-libraries]]).

export type IExportFormat = 'pdf' | 'png';

const PIXEL_RATIO = 2; // crisp export on standard + hi-DPI displays alike.

/** Renders `el` to a PDF or PNG `Blob`. PNG returns html-to-image's own Blob
 * directly; PDF rasterizes the same way, then hands that raster to jsPDF as a
 * single full-bleed page sized to the captured element (own-size, not a
 * fixed letter/A4 crop — the report is a variable-length stacked document). */
export async function exportReport(el: HTMLElement, format: IExportFormat): Promise<Blob> {
  if (format === 'png') {
    const blob = await toBlob(el, { pixelRatio: PIXEL_RATIO });
    if (!blob) throw new Error('exportReport: html-to-image produced no PNG blob');
    return blob;
  }

  const dataUrl = await toPng(el, { pixelRatio: PIXEL_RATIO });
  const width = el.scrollWidth || 1;
  const height = el.scrollHeight || 1;
  const pdf = new jsPDF({
    orientation: width >= height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [width, height],
  });
  pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
  return pdf.output('blob');
}
