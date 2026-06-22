import { useEffect, useState } from 'react';
import { getHealth } from '../host/health';
import { StatusPill } from '@/components/ui/StatusPill';

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
    <StatusPill
      data-testid="mode-badge"
      data-mode={mode}
      tone={isReplay ? 'warning' : 'success'}
      title={isReplay ? 'Recorded-real fixtures — not live providers' : 'Live providers'}
      className="uppercase tracking-wide"
    >
      {mode === 'unknown' ? '…' : mode}
    </StatusPill>
  );
}
