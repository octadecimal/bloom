import * as React from 'react';
import * as MenubarPrimitive from '@radix-ui/react-menubar';
import { cn } from '@/lib/utils';

const MenubarMenu = MenubarPrimitive.Menu;
const MenubarGroup = MenubarPrimitive.Group;
const MenubarPortal = MenubarPrimitive.Portal;
const MenubarSub = MenubarPrimitive.Sub;
const MenubarRadioGroup = MenubarPrimitive.RadioGroup;

export interface IMenubarProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Root> {}

const Menubar = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Root>, IMenubarProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Root ref={ref} className={cn('flex items-center gap-1', className)} {...props} />
));
Menubar.displayName = MenubarPrimitive.Root.displayName;

export interface IMenubarTriggerProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Trigger> {}

const MenubarTrigger = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Trigger>, IMenubarTriggerProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-7 cursor-default select-none items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-raised-hover hover:text-foreground focus:bg-raised-hover focus:text-foreground data-[state=open]:bg-raised-hover data-[state=open]:text-foreground',
      className,
    )}
    {...props}
  />
));
MenubarTrigger.displayName = MenubarPrimitive.Trigger.displayName;

export interface IMenubarContentProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Content> {}

const MenubarContent = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Content>, IMenubarContentProps>(
  ({ className, align = 'start', alignOffset = -4, sideOffset = 8, ...props }, ref) => (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        ref={ref}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[12rem] overflow-hidden rounded-[9px] border border-border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  ),
);
MenubarContent.displayName = MenubarPrimitive.Content.displayName;

export interface IMenubarItemProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Item> {
  inset?: boolean;
}

const MenubarItem = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Item>, IMenubarItemProps>(({ className, inset, ...props }, ref) => (
  <MenubarPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none focus:bg-raised-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
));
MenubarItem.displayName = MenubarPrimitive.Item.displayName;

export interface IMenubarSeparatorProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Separator> {}

const MenubarSeparator = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Separator>, IMenubarSeparatorProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Separator ref={ref} className={cn('-mx-1 my-1 h-px bg-muted', className)} {...props} />
));
MenubarSeparator.displayName = MenubarPrimitive.Separator.displayName;

export interface IMenubarLabelProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Label> {}

const MenubarLabel = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Label>, IMenubarLabelProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Label
    ref={ref}
    className={cn('px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground', className)}
    {...props}
  />
));
MenubarLabel.displayName = MenubarPrimitive.Label.displayName;

export {
  Menubar,
  MenubarMenu,
  MenubarGroup,
  MenubarPortal,
  MenubarSub,
  MenubarRadioGroup,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarLabel,
};
