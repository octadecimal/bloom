import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageLightbox } from './ImageLightbox';

describe('ImageLightbox', () => {
  it('renders the full image when open', () => {
    render(<ImageLightbox src="/media/g1/a1/gen1.png" alt="Wild" open onOpenChange={vi.fn()} />);
    const img = screen.getByTestId('image-lightbox-img') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
    expect(img.alt).toBe('Wild');
  });

  it('renders nothing when closed', () => {
    render(<ImageLightbox src="/x.png" alt="x" open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('image-lightbox-img')).toBeNull();
  });

  it('calls onOpenChange(false) when Escape is pressed', () => {
    const onOpenChange = vi.fn();
    render(<ImageLightbox src="/x.png" alt="x" open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(screen.getByTestId('image-lightbox-img'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
