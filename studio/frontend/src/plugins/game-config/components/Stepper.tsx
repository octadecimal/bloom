export interface IStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  testId: string;
}

export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, testId }: IStepperProps) {
  const dec = () => value > min && onChange(value - 1);
  const inc = () => value < max && onChange(value + 1);
  const btn = 'h-5 w-5 rounded border border-border text-xs text-text-2 hover:bg-raised-hover disabled:text-text-3';
  return (
    <span className="inline-flex items-center gap-1">
      <button data-testid={`${testId}-dec`} className={btn} onClick={dec} disabled={value <= min}>
        −
      </button>
      <span data-testid={testId} className="min-w-6 text-center font-mono text-xs text-text-1">
        {value}
      </span>
      <button data-testid={`${testId}-inc`} className={btn} onClick={inc} disabled={value >= max}>
        +
      </button>
    </span>
  );
}
