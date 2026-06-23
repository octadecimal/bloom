export interface IFeedEntry {
  kind: 'message' | 'run';
  id: string;
  createdAt: string;
  index: number;
}

/**
 * Merge the two source collections into one chronologically-ordered feed.
 * `index` is each entry's position in its OWN source array, so renderers can
 * subscribe to the matching hookstate node (`s.messages[index]` / `s.runs[index]`).
 * Stable: equal timestamps keep message-before-run, then source order.
 */
export function buildFeed(
  messages: { id: string; createdAt: string }[],
  runs: { id: string; createdAt: string }[],
): IFeedEntry[] {
  const entries: IFeedEntry[] = [
    ...messages.map((m, index): IFeedEntry => ({ kind: 'message', id: m.id, createdAt: m.createdAt, index })),
    ...runs.map((r, index): IFeedEntry => ({ kind: 'run', id: r.id, createdAt: r.createdAt, index })),
  ];
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : a.i - b.i))
    .map(({ e }) => e);
}
