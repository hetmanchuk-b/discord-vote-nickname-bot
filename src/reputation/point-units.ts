// Storage and arithmetic use integer quarter-points. Public values are exact
// multiples of 0.25 (also exactly representable as JavaScript numbers).
export const POINT_UNITS = 4;
export const MIN_POINT_UNITS = -500 * POINT_UNITS;
export const MAX_POINT_UNITS = 5000 * POINT_UNITS;
export function toPointUnits(points: number): number {
  if (typeof points !== 'number') throw new Error('Invalid quarter-point amount.');
  const units = points * POINT_UNITS;
  if (!Number.isSafeInteger(units)) throw new Error('Invalid quarter-point amount.');
  return units;
}
export function fromPointUnits(units: number): number {
  if (!Number.isSafeInteger(units)) throw new Error('Invalid stored point units.');
  return units / POINT_UNITS;
}
export function formatPoints(points: number): string {
  toPointUnits(points);
  return points.toLocaleString('uk-UA', { maximumFractionDigits: 2 });
}
