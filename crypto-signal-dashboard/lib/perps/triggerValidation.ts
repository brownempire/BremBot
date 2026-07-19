export type PerpsTriggerKind = "tp" | "sl";
export type PerpsPositionSide = "long" | "short";

export type PerpsTriggerPriceValidationError =
  | "invalid-price"
  | "tp-must-be-above-mark"
  | "tp-must-be-below-mark"
  | "sl-must-be-above-mark"
  | "sl-must-be-below-mark";

export function validatePerpsTriggerPriceAgainstMark(options: {
  kind: PerpsTriggerKind;
  markPrice: number | null;
  side: PerpsPositionSide;
  triggerPrice: number;
}): PerpsTriggerPriceValidationError | null {
  if (!Number.isFinite(options.triggerPrice) || options.triggerPrice <= 0) {
    return "invalid-price";
  }

  if (
    typeof options.markPrice !== "number"
    || !Number.isFinite(options.markPrice)
    || options.markPrice <= 0
  ) {
    // Jupiter performs the final validation when a current mark is unavailable.
    return null;
  }

  if (options.side === "long") {
    if (options.kind === "tp" && options.triggerPrice <= options.markPrice) {
      return "tp-must-be-above-mark";
    }
    if (options.kind === "sl" && options.triggerPrice >= options.markPrice) {
      return "sl-must-be-below-mark";
    }
    return null;
  }

  if (options.kind === "tp" && options.triggerPrice >= options.markPrice) {
    return "tp-must-be-below-mark";
  }
  if (options.kind === "sl" && options.triggerPrice <= options.markPrice) {
    return "sl-must-be-above-mark";
  }
  return null;
}
