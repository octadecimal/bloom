export function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-5 w-5 place-items-center rounded-[6px] bg-primary text-[13px] font-bold leading-none text-primary-foreground"
      >
        b
      </span>
      <h1 className="m-0 text-[13px] font-semibold tracking-tight text-foreground">Bloom Studio</h1>
    </div>
  );
}
