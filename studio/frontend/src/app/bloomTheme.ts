import { themeAbyssSpaced, type DockviewTheme } from 'dockview-react';

// Floating-card model (mockup C): derived from the official "Spaced" theme so the
// gap/border/radius layout is a proven base; we override only the palette via the
// .dockview-theme-bloom CSS in styles.css. `gap` is a LAYOUT value (it changes the
// grid math) so it must travel on the theme object, not just CSS.
export const bloomTheme: DockviewTheme = {
  ...themeAbyssSpaced,
  name: 'bloom',
  className: 'dockview-theme-bloom',
  colorScheme: 'dark',
  gap: 8,
  tabGroupIndicator: 'wrap',
};
