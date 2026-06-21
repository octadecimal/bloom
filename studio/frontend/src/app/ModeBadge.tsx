import { useEffect, useState } from 'react';
import { getHealth } from '../host/health';

export function ModeBadge() {
  const [mode, setMode] = useState<'live' | 'replay' | 'unknown'>('unknown');

  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => alive && setMode(h.providerMode))
      .catch(() => alive && setMode('unknown'));
    return () => {
      alive = false;
    };
  }, []);

  const isReplay = mode === 'replay';
  return (
    <span
      data-testid="mode-badge"
      data-mode={mode}
      title={isReplay ? 'Recorded-real fixtures — not live providers' : 'Live providers'}
      style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        padding: '2px 6px',
        borderRadius: 4,
        textTransform: 'uppercase',
        background: isReplay ? '#a3551b' : '#1b5e20',
        color: 'white',
      }}
    >
      {mode === 'unknown' ? '…' : mode}
    </span>
  );
}
