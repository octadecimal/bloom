import { counterHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function MirrorPane() {
  const s = counterHooks.usePluginState();
  bumpRenderCount('MirrorPane');
  return (
    <div data-testid="mirror-pane" className="h-full bg-surface p-3">
      count is {s.count.get()}
    </div>
  );
}
