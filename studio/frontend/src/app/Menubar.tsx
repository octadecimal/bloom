import { useEffect, useState } from 'react';
import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator } from '@/components/ui/menubar';
import { getHost } from '../state/hostRef';
import { getLayoutPresets } from '../state/layoutPresetsRef';
import { setSaveLayoutOpener } from '../state/saveLayoutDialogRef';
import { SaveLayoutDialog } from './SaveLayoutDialog';

export function AppMenubar() {
  const host = getHost();
  const presets = getLayoutPresets();
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    setSaveLayoutOpener(() => setSaveOpen(true));
  }, []);

  const all = presets.list();
  const userPresets = all.filter((p) => p.kind === 'user');

  return (
    <>
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-layout">Layout</MenubarTrigger>
          <MenubarContent>
            <MenubarItem data-testid="layout-save" onClick={() => setSaveOpen(true)}>
              Save arrangement…
            </MenubarItem>
            <MenubarSeparator />
            {all.map((p) => (
              <MenubarItem key={`apply-${p.name}`} data-testid={`layout-apply-${p.name}`} onClick={() => presets.apply(p.name)}>
                {p.name}
                {p.kind === 'builtin' ? '  (built-in)' : ''}
              </MenubarItem>
            ))}
            {userPresets.length > 0 && <MenubarSeparator />}
            {userPresets.map((p) => (
              <MenubarItem key={`delete-${p.name}`} data-testid={`layout-delete-${p.name}`} onClick={() => presets.delete(p.name)}>
                Delete: {p.name}
              </MenubarItem>
            ))}
            <MenubarSeparator />
            <MenubarItem data-testid="menu-reset-layout" onClick={() => host.resetLayout()}>
              Reset layout
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-view">View</MenubarTrigger>
          <MenubarContent>
            {host.listPanes().map((p) => (
              <MenubarItem key={p.id} data-testid={`view-open-${p.id}`} onClick={() => host.openPane(p.id)}>
                {p.title}
              </MenubarItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <SaveLayoutDialog open={saveOpen} onOpenChange={setSaveOpen} />
    </>
  );
}
