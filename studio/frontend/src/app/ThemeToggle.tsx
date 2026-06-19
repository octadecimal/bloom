import { useHookstate } from '@hookstate/core';
import { Button } from '@/components/ui/button';
import { rootStore } from '../state/rootStore';

export function ThemeToggle() {
  const theme = useHookstate(rootStore.workspace.theme);
  return (
    <Button
      data-testid="theme-toggle"
      variant="outline"
      size="icon"
      onClick={() => theme.set((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      {theme.get() === 'dark' ? '🌙' : '☀️'}
    </Button>
  );
}
