/**
 * Discount codes. In a real service this would call a pricing API or a database,
 * which is exactly the kind of dependency tests replace with `vi.mock`.
 */

const CODES: Record<string, number> = { WELCOME10: 0.1, VIP25: 0.25 };

/** Discount rate (0..1) for a code, 0 when unknown. */
export async function discountRate(code: string): Promise<number> {
  return CODES[code.toUpperCase()] ?? 0;
}
