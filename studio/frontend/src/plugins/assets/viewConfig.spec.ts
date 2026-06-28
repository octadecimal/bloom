import { describe, it, expect } from 'vitest';
import { VIEW_CONFIG, VIEW_MODES, type AssetViewMode } from './viewConfig';

describe('viewConfig', () => {
  it('lists the four modes in size order', () => {
    expect(VIEW_MODES).toEqual(['small', 'medium', 'large', 'list']);
  });

  it('has a complete config entry for every mode', () => {
    for (const mode of VIEW_MODES) {
      const cfg = VIEW_CONFIG[mode];
      expect(typeof cfg.container).toBe('string');
      expect(cfg.container.length).toBeGreaterThan(0);
      expect(typeof cfg.card).toBe('string');
      expect(typeof cfg.image).toBe('string');
      expect(typeof cfg.showWorkflow).toBe('boolean');
      expect(typeof cfg.showCandidates).toBe('boolean');
      expect(typeof cfg.candidateSize).toBe('number');
      expect(['always', 'hover']).toContain(cfg.actions);
      expect(typeof cfg.row).toBe('boolean');
    }
  });

  it('only Large shows full chrome (workflow + always-on actions); all modes show candidates', () => {
    expect(VIEW_CONFIG.large).toMatchObject({ showWorkflow: true, showCandidates: true, actions: 'always', row: false });
    expect(VIEW_CONFIG.small).toMatchObject({ showWorkflow: false, showCandidates: true, actions: 'hover' });
    expect(VIEW_CONFIG.medium).toMatchObject({ showWorkflow: false, showCandidates: true, actions: 'hover' });
    expect(VIEW_CONFIG.list).toMatchObject({ showCandidates: true });
  });

  it('only List uses a row layout', () => {
    expect(VIEW_CONFIG.list.row).toBe(true);
    expect(VIEW_CONFIG.small.row).toBe(false);
    const modes: AssetViewMode[] = ['small', 'medium', 'large'];
    for (const m of modes) expect(VIEW_CONFIG[m].row).toBe(false);
  });
});
