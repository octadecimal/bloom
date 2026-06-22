import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getLayoutPresets } from '../state/layoutPresetsRef';

export interface ISaveLayoutDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function SaveLayoutDialog({ open, onOpenChange }: ISaveLayoutDialogProps) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = () => {
    if (getLayoutPresets().saveAs(name)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Save arrangement</h2>
        <input
          data-testid="save-layout-name"
          autoFocus
          value={name}
          placeholder="Arrangement name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="rounded-md border border-border bg-raised px-3 py-2 text-sm"
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button data-testid="save-layout-cancel" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="save-layout-confirm" onClick={submit}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
