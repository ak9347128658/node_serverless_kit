/** Shared business logic, imported as `@lib/greeting` from any handler. */

export const MAX_NAME_LENGTH = 40;

export function greeting(name: string | undefined): string {
  const clean = (name ?? "").trim() || "world";
  return `Hello, ${clean.slice(0, MAX_NAME_LENGTH)}!`;
}
