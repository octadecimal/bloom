export interface IMirrorModel {
  symbols: { id: number; role: string }[];
  paytable: { entries: { symbol: number; count: number; payout: number }[] };
  bonuses: unknown[];
}

export function MirrorSection({ aspect, model, names }: { aspect: 'paytable' | 'bonus-features'; model: IMirrorModel | null; names: Map<number, string> }) {
  if (!model) return null;
  const name = (id: number) => names.get(id) ?? `#${id}`;
  return (
    <div data-testid={`gdd-mirror-${aspect}`} className="mt-4 border-t border-hairline pt-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-text-3">Realized — from the game model</div>
      {aspect === 'paytable' ? (
        <table className="w-full text-sm text-text-2">
          <thead>
            <tr className="text-left text-text-3">
              <th>Symbol</th>
              <th>Count</th>
              <th>Pays (x bet)</th>
            </tr>
          </thead>
          <tbody>
            {model.paytable.entries.map((e, i) => (
              <tr key={i}>
                <td>{name(e.symbol)}</td>
                <td>{e.count}</td>
                <td>{e.payout}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="text-sm text-text-2">
          {model.bonuses.map((b, i) => {
            const fs = (b as Record<string, { config?: { spins_awarded?: number } }>)['FreeSpins'];
            return <li key={i}>Free spins{fs?.config?.spins_awarded ? ` — ${fs.config.spins_awarded} awarded` : ''}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
