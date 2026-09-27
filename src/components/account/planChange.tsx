import type { ChangePreview } from "../../lib/auth";
import { AmountPicker } from "../AmountPicker";

// The amount picker, for a member who chooses their own amount. Nothing for
// everyone else: their change is at the minimum.
export function ChangeAmountField({
  preview,
  value,
  onChange,
}: {
  preview: ChangePreview;
  value: string;
  onChange: (value: string) => void;
}) {
  if (!preview.pwyc) return null;
  return (
    <div className="mt-4 border-t border-rule pt-4">
      <span className="eyebrow text-fg-muted">Choose your amount</span>
      <AmountPicker
        plan={preview.plan}
        currency={preview.currency}
        factor={preview.minorFactor}
        floorMinor={preview.floorCents}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

export const GIFT_BLOCKED_LINE =
  "Your gifted membership time is still running, so this change can’t be made yet. Please contact us and we’ll help.";
