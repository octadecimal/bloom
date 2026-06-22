// studio/frontend/src/plugins/assets/ImageLightbox.tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';

export interface IImageLightboxProps {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

// A full-size, in-app viewer for a generated image. Built on the shared Dialog so
// it inherits Esc / backdrop-click / close-button dismissal for free.
export function ImageLightbox({ src, alt, open, onOpenChange }: IImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="image-lightbox" className="flex max-w-[90vw] items-center justify-center bg-background/95 p-2 sm:max-w-[90vw]">
        <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
        <img data-testid="image-lightbox-img" src={src} alt={alt} className="max-h-[85vh] max-w-full object-contain" />
      </DialogContent>
    </Dialog>
  );
}
