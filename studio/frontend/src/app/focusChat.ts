import { useEffect } from 'react';
import type { IPluginHost } from '../host/types';
import { getHost } from '../state/hostRef';

const CHAT_ROOM_PANE_ID = 'llm-chat/room';
const COMPOSER_SELECTOR = '[data-testid="chat-composer"]';

/** True for the Ctrl+L / Cmd+L chord that focuses the chat composer. */
export function isFocusChatChord(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'key'>): boolean {
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l';
}

interface IFocusOpts {
  doc?: Document;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Reveal the chat room pane (creating/activating it via the host) and focus its
 * composer input. The pane may need a frame or two to mount when it was hidden,
 * so we poll briefly for the composer before giving up.
 */
export function revealAndFocusChatComposer(host: IPluginHost, opts: IFocusOpts = {}): void {
  const doc = opts.doc ?? document;
  const attempts = opts.attempts ?? 20;
  const intervalMs = opts.intervalMs ?? 25;
  host.openPane(CHAT_ROOM_PANE_ID);

  let remaining = attempts;
  const tryFocus = () => {
    const el = doc.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (el) {
      el.focus();
      return;
    }
    if (--remaining > 0) setTimeout(tryFocus, intervalMs);
  };
  tryFocus();
}

/** Register the global Ctrl+L shortcut for the lifetime of the calling component. */
export function useFocusChatShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFocusChatChord(e)) return;
      e.preventDefault();
      revealAndFocusChatComposer(getHost());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
