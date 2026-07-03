import type { IGenFrame } from '../state';

export interface IScrubberProps {
  frames: IGenFrame[];
  selectedGeneration: number | 'live';
  onScrub: (generation: number) => void;
}

/** Generation scrubber — replays the Evolution charts frame-by-frame and drives
 * their playhead. `'live'` tracks the newest frame as it streams in; dragging
 * the slider pins `selectedGeneration` to a specific generation (see
 * `reducers.ts#scrubTo`) until the user scrubs back to the live edge. */
export function Scrubber({ frames, selectedGeneration, onScrub }: IScrubberProps) {
  const minGen = frames[0]?.generation ?? 0;
  const maxGen = frames[frames.length - 1]?.generation ?? 0;
  const isLive = selectedGeneration === 'live';
  const currentGen = isLive ? maxGen : selectedGeneration;

  return (
    <div data-testid="scrubber" className="flex flex-none items-center gap-2 rounded-md border border-hairline bg-raised px-2.5 py-1.5">
      <span className="w-16 flex-none text-[10px] text-text-2">
        Gen {currentGen}/{maxGen}
      </span>
      <input
        type="range"
        role="slider"
        aria-label="Generation scrubber"
        min={minGen}
        max={maxGen}
        value={currentGen}
        disabled={frames.length === 0}
        onChange={(e) => onScrub(Number(e.target.value))}
        className="h-1 flex-1 accent-[var(--accent)] disabled:opacity-40"
      />
      <span className={`w-10 flex-none text-right text-[9px] font-semibold uppercase ${isLive ? 'text-accent-text' : 'text-text-3'}`}>
        {isLive ? 'Live' : 'Paused'}
      </span>
    </div>
  );
}
