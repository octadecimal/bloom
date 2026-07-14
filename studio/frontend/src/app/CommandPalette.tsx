import { useEffect } from 'react';
import { CommandDialog, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { getHost } from '../state/hostRef';

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const host = getHost();
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command…" data-testid="command-input" />
      <CommandList>
        <CommandEmpty>No commands.</CommandEmpty>
        {host.listPanes().map((p) => (
          <CommandItem
            key={p.id}
            value={`Open ${p.title}`}
            onSelect={() => {
              host.openPane(p.id);
              onOpenChange(false);
            }}
          >
            Open {p.title}
          </CommandItem>
        ))}
        {host.listCommands().map((c) => (
          <CommandItem
            key={c.id}
            value={c.title}
            onSelect={() => {
              host.runCommand(c.id);
              onOpenChange(false);
            }}
          >
            {c.title}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
