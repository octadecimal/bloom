import type { IGddDoc } from './state';

export function upsertDoc(docs: IGddDoc[], doc: IGddDoc): IGddDoc[] {
  const next = docs.some((d) => d.aspect === doc.aspect)
    ? docs.map((d) => (d.aspect === doc.aspect ? doc : d))
    : [...docs, doc];
  return next.slice().sort((a, b) => a.order - b.order);
}
