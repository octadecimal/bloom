import { useState } from 'react';
import { Dialog, DialogContent } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import type { ISectionLocks } from './state';
import { applyTemplateToGame } from './actions';

// ponytail: static mirror of GET /slot-model/templates — the set is 3 frozen
// templates; fetch the list only if templates ever become dynamic.
export const TEMPLATE_OPTIONS = [
  { name: 'classic-3x3', label: 'Classic 3×3' },
  { name: 'video-5x3', label: 'Video 5×3' },
  { name: 'high-vol-5x4', label: 'High Volatility 5×4' },
] as const;

const LOCKABLE = ['reels', 'paytable', 'bonus'] as const;

/** Which sections the template will overwrite vs keep, given current locks.
 * Symbols and paylines are never lockable (the GA cannot touch them). */
export function templateSummary(locks: ISectionLocks): { overwritten: string[]; kept: string[] } {
  const kept = LOCKABLE.filter((k) => locks[k]) as string[];
  const overwritten = ['symbols', 'paylines', ...LOCKABLE.filter((k) => !locks[k])];
  return { overwritten, kept };
}

export interface ITemplateDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  locks: ISectionLocks;
}

export function TemplateDialog({ open, onOpenChange, locks }: ITemplateDialogProps) {
  const [name, setName] = useState<string>('video-5x3');
  const { overwritten, kept } = templateSummary(locks);

  const confirm = async () => {
    await applyTemplateToGame(name);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Apply template</h2>
        <select
          data-testid="gc-template-select"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 rounded border border-border bg-canvas px-1 text-xs text-text-1"
        >
          {TEMPLATE_OPTIONS.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
        </select>
        <div data-testid="gc-template-summary" className="text-xs text-text-2">
          <div>Overwrites: {overwritten.join(', ')}.</div>
          {kept.length > 0 && (
            <div data-testid="gc-template-protected" className="text-warning">
              Lock-protected (kept): {kept.join(', ')}.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button data-testid="gc-template-cancel" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="gc-template-confirm" onClick={() => void confirm()}>
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
