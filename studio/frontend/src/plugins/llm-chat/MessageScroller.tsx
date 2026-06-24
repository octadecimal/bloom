import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { isAtBottom } from './scroll';

/**
 * Owns the scrollable message viewport. Keeps the feed pinned to the bottom
 * while the user is already at the bottom (so streaming replies follow), but
 * leaves them alone once they scroll up — surfacing a "jump to latest" button
 * instead. Bubbles are passed as `children`, so this component's own `showJump`
 * state never re-renders them (render-count discipline preserved).
 */
export function MessageScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Follow content growth — new entries AND streaming token text. A
  // MutationObserver catches characterData mutations that never re-render this
  // shell; it is natively available in jsdom, so unit tests need no polyfill.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const pinned = isAtBottom({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
    pinnedRef.current = pinned;
    // Only flip state when the boolean actually changes — no per-event churn.
    setShowJump((prev) => (prev === !pinned ? prev : !pinned));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ul ref={ref} data-testid="chat-messages" onScroll={onScroll} className="m-0 flex h-full list-none flex-col gap-1.5 overflow-auto p-0">
        {children}
      </ul>
      {showJump && (
        <button
          type="button"
          data-testid="chat-jump-latest"
          aria-label="Jump to latest"
          onClick={() => {
            scrollToBottom();
            pinnedRef.current = true;
            setShowJump(false);
          }}
          className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-raised text-muted-foreground shadow-md hover:bg-raised-hover hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
