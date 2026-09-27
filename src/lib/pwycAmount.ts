import { toMajor } from "./currency";

export const INPUT_MAX_MULTIPLE = 400;

// The amount a picker value stands for, in MAJOR units: `value` is what the
// member chose ("" = the floor), clamped into [floor, input max] so a sub-floor
// entry snaps up. `isCustom` = strictly above the floor, which is when a
// caller sends an amount at all rather than the catalog price.
export function resolveAmount(
  value: string,
  floorMinor: number | null,
  factor: number,
): { floorMajor: number | null; effectiveMajor: number | null; isCustom: boolean } {
  const floorMajor = floorMinor !== null ? toMajor(floorMinor, factor) : null;
  if (floorMajor === null) return { floorMajor, effectiveMajor: null, isCustom: false };
  const inputMax = floorMajor * INPUT_MAX_MULTIPLE;
  const parsed = value.trim() === "" ? null : Number(value);
  const effectiveMajor =
    parsed !== null && Number.isFinite(parsed)
      ? Math.min(inputMax, Math.max(floorMajor, parsed))
      : floorMajor;
  return { floorMajor, effectiveMajor, isCustom: effectiveMajor > floorMajor };
}
