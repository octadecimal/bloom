import { Button } from '@/components/ui/button';
import { counterHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function CounterPane() {
  const s = counterHooks.usePluginState();
  bumpRenderCount('CounterPane');
  return (
    <div data-testid="counter-pane" style={{ padding: 12 }}>
      <span data-testid="counter-value">{s.count.get()}</span>
      <Button
        data-testid="counter-inc"
        onClick={() => s.count.set((c) => c + 1)}
      >
        +
      </Button>
    </div>
  );
}
