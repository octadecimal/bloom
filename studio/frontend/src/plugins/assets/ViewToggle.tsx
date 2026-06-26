// studio/frontend/src/plugins/assets/ViewToggle.tsx
import { Grid3x3, LayoutGrid, Square, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VIEW_MODES, type AssetViewMode } from './viewConfig';

const ICONS: Record<AssetViewMode, typeof Grid3x3> = {
  small: Grid3x3,
  medium: LayoutGrid,
  large: Square,
  list: List,
};

const LABELS: Record<AssetViewMode, string> = {
  small: 'Small thumbnails',
  medium: 'Medium thumbnails',
  large: 'Large thumbnails',
  list: 'List view',
};

export function ViewToggle({ mode, onChange }: { mode: AssetViewMode; onChange: (m: AssetViewMode) => void }) {
  return (
    <div role="group" aria-label="Asset view mode" className="flex items-center gap-0.5">
      {VIEW_MODES.map((m) => {
        const Icon = ICONS[m];
        const active = m === mode;
        return (
          <Button
            key={m}
            type="button"
            size="icon"
            variant={active ? 'accentOutline' : 'ghost'}
            aria-pressed={active}
            aria-label={LABELS[m]}
            title={LABELS[m]}
            data-testid={`view-mode-${m}`}
            onClick={() => onChange(m)}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        );
      })}
    </div>
  );
}
