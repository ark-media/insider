// Pure math for the pay-what-you-choose amount slider. Extracted from the
// checkout modal so the curve/snap logic can be unit-tested in isolation.
//
// The slider works entirely in MAJOR currency units. Almost every gift lands
// near the floor, so a linear track would waste ~90% of its travel. We map the
// thumb's 0–1 position through a power curve: the low end gets most of the track
// (fine control where it matters) while the top stays reachable. Snapping keeps
// the chosen figure clean.
export const SLIDER_STEPS = 1000;
export const SLIDER_CURVE = 2.4;

// A "nice" increment (1/2/5 × 10ⁿ) near `x`, so snap steps read cleanly across
// magnitudes: ~$5 for a $130 floor, ~¥1,000 for a ¥21k floor, ~₪20 for ₪486.
export function niceNumber(x: number): number {
  if (x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const norm = x / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

// The snap step for a given floor: ~1/26 of the floor rounded to a nice
// increment (so $130 → $5), never below one whole currency unit.
export function snapStep(floorMajor: number): number {
  return Math.max(1, niceNumber(floorMajor / 26));
}

// Thumb position (0–SLIDER_STEPS) → major-unit amount, along the eased curve,
// snapped to a clean step. Endpoints stay exact (floor at 0, max at 1).
export function amountFromPos(
  pos: number,
  floor: number,
  max: number,
  step: number,
): number {
  const t = pos / SLIDER_STEPS;
  if (t <= 0) return floor;
  if (t >= 1) return max;
  const raw = floor + (max - floor) * Math.pow(t, SLIDER_CURVE);
  const snapped = Math.round(raw / step) * step;
  return Math.min(max, Math.max(floor, snapped));
}

// Major-unit amount → thumb position (inverse of the curve), for rendering the
// thumb + fill from the current amount.
export function posFromAmount(amount: number, floor: number, max: number): number {
  if (max <= floor) return 0;
  const clamped = Math.min(max, Math.max(floor, amount));
  const t = Math.pow((clamped - floor) / (max - floor), 1 / SLIDER_CURVE);
  return Math.round(t * SLIDER_STEPS);
}
