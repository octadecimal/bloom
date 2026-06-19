import { useEffect, useState } from 'react';
import { CommandDialog, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { getHost } from '../state/hostRef';

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const host = getHost();
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command…" data-testid="command-input" />
      <CommandList>
        <CommandEmpty>No commands.</CommandEmpty>
        {host.listCommands().map((c) => (
          <CommandItem
            key={c.id}
            value={c.title}
            onSelect={() => {
              host.runCommand(c.id);
              setOpen(false);
            }}
          >
            {c.title}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
