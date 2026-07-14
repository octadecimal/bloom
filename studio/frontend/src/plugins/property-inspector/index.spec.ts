import { describe, it, expect } from 'vitest';
import { propertyInspector } from './index';

describe('propertyInspector plugin', () => {
  it('declares the expected id, pane, and command', () => {
    expect(propertyInspector.id).toBe('property-inspector');
    expect(propertyInspector.title).toBe('Inspector');
    expect(propertyInspector.panes.map((p) => p.id)).toContain('property-inspector/panel');
    expect(propertyInspector.panes.find((p) => p.id === 'property-inspector/panel')?.title).toBe('Inspector');
    expect(propertyInspector.commands).toBeUndefined();
  });

  it('seeds a non-persistent initial state', () => {
    expect(propertyInspector.persist).toBe(false);
    expect(propertyInspector.initialState).toEqual({ collapsed: {} });
  });
});
