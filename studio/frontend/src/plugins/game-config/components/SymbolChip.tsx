import { symbolColor, symbolLabel, SWATCH_DOT_CLASS, type IPresentation } from '../presentation';

export interface ISymbolChipProps {
  presentation: IPresentation;
  id: number;
  testId?: string;
}

/** StatusPill-style chip: swatch dot + label. Dot color comes from the token map —
 *  never a raw color (design-language guard). */
export function SymbolChip({ presentation, id, testId }: ISymbolChipProps) {
  const color = symbolColor(presentation, id);
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-text-1">
      <span className={`h-1.5 w-1.5 rounded-full ${SWATCH_DOT_CLASS[color] ?? 'bg-muted-foreground'}`} />
      {symbolLabel(presentation, id)}
    </span>
  );
}
