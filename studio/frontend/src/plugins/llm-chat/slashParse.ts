export interface ISlashDraft {
  skillName: string;
  hasSpace: boolean;
  prose: string;
}

/** Parse the composer draft into its slash-skill parts, or null if not a slash draft. */
export function splitSlashDraft(draft: string): ISlashDraft | null {
  if (!draft.startsWith('/')) return null;
  const body = draft.slice(1);
  const spaceIdx = body.indexOf(' ');
  if (spaceIdx === -1) return { skillName: body, hasSpace: false, prose: '' };
  return { skillName: body.slice(0, spaceIdx), hasSpace: true, prose: body.slice(spaceIdx + 1).trim() };
}

/** Move the highlight index by delta, wrapping at both ends. 0 for an empty list. */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

/** Clamp the highlight index into [0, count-1]; 0 for an empty list. */
export function clampHighlight(current: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(current, 0), count - 1);
}

export type EnterDecision =
  | { kind: 'accept'; name: string }
  | { kind: 'run'; name: string; prose: string }
  | { kind: 'form'; name: string }
  | { kind: 'send' };

/** Decide what Enter does given the current draft, visible matches, and highlight. */
export function decideEnter(draft: string, matches: { name: string }[], highlight: number): EnterDecision {
  const slash = splitSlashDraft(draft);
  if (slash === null) return { kind: 'send' };
  // Popup open: still choosing a skill (no space) and there are matches → accept the highlight.
  if (!slash.hasSpace) {
    if (matches.length > 0) {
      const idx = clampHighlight(highlight, matches.length);
      return { kind: 'accept', name: matches[idx].name };
    }
    return { kind: 'send' };
  }
  // Name completed (has space): prose → run; empty → open the form.
  return slash.prose ? { kind: 'run', name: slash.skillName, prose: slash.prose } : { kind: 'form', name: slash.skillName };
}
