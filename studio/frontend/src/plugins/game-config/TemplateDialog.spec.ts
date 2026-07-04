import { describe, it, expect } from 'vitest';
import { templateSummary, TEMPLATE_OPTIONS } from './TemplateDialog';

describe('templateSummary', () => {
  it('everything unlocked: all five sections overwritten, none kept', () => {
    const s = templateSummary({ reels: false, paytable: false, bonus: false });
    expect(s.overwritten).toEqual(['symbols', 'paylines', 'reels', 'paytable', 'bonus']);
    expect(s.kept).toEqual([]);
  });

  it('locked sections move to kept; symbols/paylines are never protectable', () => {
    const s = templateSummary({ reels: true, paytable: true, bonus: false });
    expect(s.overwritten).toEqual(['symbols', 'paylines', 'bonus']);
    expect(s.kept).toEqual(['reels', 'paytable']);
  });

  it('offers exactly the three shipped templates', () => {
    expect(TEMPLATE_OPTIONS.map((t) => t.name)).toEqual(['classic-3x3', 'video-5x3', 'high-vol-5x4']);
  });
});
