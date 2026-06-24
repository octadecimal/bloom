export function parseParentOrigin(search: string): string | null {
  const value = new URLSearchParams(search).get('parentOrigin');
  return value && value.length > 0 ? value : null;
}

export function originAllowed(expected: string | null, actual: string): boolean {
  return expected === null || actual === expected;
}
