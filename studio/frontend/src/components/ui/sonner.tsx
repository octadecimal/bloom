import { Toaster as Sonner } from 'sonner';

// Single app-wide toaster. richColors gives error/info distinct styling without
// extra config; closeButton lets users dismiss. Theme follows the OS for now.
export function Toaster() {
  return <Sonner data-testid="toaster" richColors closeButton position="bottom-right" />;
}
