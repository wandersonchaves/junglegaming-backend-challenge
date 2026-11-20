/**
 * Raw SQL through the EntityManager may hand timestamps back as strings.
 * Every row mapper goes through these two helpers, so domain objects always get real Dates.
 */
export function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function asOptionalDate(value: Date | string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : asDate(value);
}
