let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {}

  const model = data?.model?.display_name ?? "Claude";
  const used = data?.context_window?.used_percentage;

  if (typeof used !== "number") {
    process.stdout.write(model);
    return;
  }

  const pct = Math.round(used);
  const width = 20;
  const filled = Math.round((pct * width) / 100);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);

  // green <50%, yellow 50-79%, red >=80%
  const color = pct >= 80 ? "\x1b[31m" : pct >= 50 ? "\x1b[33m" : "\x1b[32m";
  const reset = "\x1b[0m";

  process.stdout.write(`${model}  ${color}[${bar}]${reset} ${pct}%`);
});
