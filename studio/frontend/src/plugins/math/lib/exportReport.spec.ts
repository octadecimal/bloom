import { describe, it, expect, vi, beforeEach } from 'vitest';

// Seam test — mock the underlying libraries so this never rasterizes real DOM
// (jsdom has no canvas 2D context). Asserts `exportReport` calls the mature,
// self-contained libraries and returns *their* Blob, not a hand-rolled one.
// See [[prefer-proven-libraries]].
const toBlob = vi.fn();
const toPng = vi.fn();
vi.mock('html-to-image', () => ({
  toBlob: (...args: unknown[]) => toBlob(...args),
  toPng: (...args: unknown[]) => toPng(...args),
}));

const addImage = vi.fn();
const output = vi.fn();
const jsPDFCtor = vi.fn();
vi.mock('jspdf', () => ({
  jsPDF: class {
    constructor(...args: unknown[]) {
      jsPDFCtor(...args);
    }
    addImage(...args: unknown[]) {
      return addImage(...args);
    }
    output(...args: unknown[]) {
      return output(...args);
    }
  },
}));

// Imported after the mocks so the module under test picks up the mocked deps.
const { exportReport } = await import('./exportReport');

function makeEl(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
  return el;
}

const PNG_BLOB = new Blob(['png-bytes'], { type: 'image/png' });
const PDF_BLOB = new Blob(['pdf-bytes'], { type: 'application/pdf' });

describe('exportReport', () => {
  beforeEach(() => {
    toBlob.mockReset();
    toPng.mockReset();
    addImage.mockReset();
    output.mockReset();
    jsPDFCtor.mockClear();
    toBlob.mockResolvedValue(PNG_BLOB);
    toPng.mockResolvedValue('data:image/png;base64,AAAA');
    output.mockReturnValue(PDF_BLOB);
  });

  it('renders to PNG via html-to-image and returns its Blob for format "png"', async () => {
    const el = makeEl();
    const blob = await exportReport(el, 'png');
    expect(toBlob).toHaveBeenCalledWith(el, expect.any(Object));
    expect(blob).toBe(PNG_BLOB);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('rasterizes via html-to-image then assembles a PDF via jsPDF and returns jsPDF\'s Blob for format "pdf"', async () => {
    const el = makeEl();
    const blob = await exportReport(el, 'pdf');
    expect(toPng).toHaveBeenCalledWith(el, expect.any(Object));
    expect(jsPDFCtor).toHaveBeenCalled();
    expect(addImage).toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith('blob');
    expect(blob).toBe(PDF_BLOB);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('throws instead of returning an empty result when html-to-image yields no PNG blob', async () => {
    toBlob.mockResolvedValue(null);
    await expect(exportReport(makeEl(), 'png')).rejects.toThrow();
  });
});
