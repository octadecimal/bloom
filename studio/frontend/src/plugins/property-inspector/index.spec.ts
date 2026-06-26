import { describe, it, expect } from 'vitest';
import { propertyInspector } from './index';

describe('propertyInspector plugin', () => {
  it('declares the expected id, pane, and command', () => {
    expect(propertyInspector.id).toBe('property-inspector');
    expect(propertyInspector.panes.map((p) => p.id)).toContain('property-inspector/panel');
    expect(propertyInspector.commands?.map((c) => c.id)).toContain('property-inspector/open');
  });

  it('seeds a non-persistent initial state', () => {
    expect(propertyInspector.persist).toBe(false);
    expect(propertyInspector.initialState).toEqual({ collapsed: {} });
  });
});
