import { toast } from 'sonner';

// Thin seam over the toast library so plugins depend on `notify`, never `sonner`
// directly. Swappable and trivially mockable in tests.
export const notify = {
  error(message: string): void {
    toast.error(message);
  },
  info(message: string): void {
    toast.info(message);
  },
};
