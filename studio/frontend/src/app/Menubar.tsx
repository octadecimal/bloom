import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem } from '@/components/ui/menubar';
import { getHost } from '../state/hostRef';

export function AppMenubar() {
  const host = getHost();
  return (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger data-testid="menu-file">File</MenubarTrigger>
        <MenubarContent>
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
  );
}
