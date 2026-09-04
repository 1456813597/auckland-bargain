const PAKNSAVE_SLUG = 'paknsave';
const MULTIBUY_PROMOTION = /^\s*(\d+)\s+for\s+\$(\d+(?:\.\d{1,2})?)\s*$/i;

export function multiBuyOffer(promotionText: string | null | undefined) {
  const match = promotionText?.match(MULTIBUY_PROMOTION);
  if (!match) return null;

  const quantity = Number(match[1]);
  const totalPriceCents = Math.round(Number(match[2]) * 100);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 2 ||
    !Number.isSafeInteger(totalPriceCents) ||
    totalPriceCents <= 0
  ) {
    return null;
  }

  return {
    quantity,
    totalPriceCents,
    unitPriceCents: Math.round(totalPriceCents / quantity),
  };
}

export function isMultiBuyPromotion(promotionText: string | null | undefined) {
  return Boolean(multiBuyOffer(promotionText));
}

export function shopperFacingPriceCents(input: {
  retailerSlug: string;
  promotionText: string | null;
  regularPriceCents: number | null;
  effectivePriceCents: number;
}) {
  if (
    input.retailerSlug === PAKNSAVE_SLUG &&
    isMultiBuyPromotion(input.promotionText) &&
    input.regularPriceCents !== null &&
    input.regularPriceCents > 0
  ) {
    return input.regularPriceCents;
  }

  return input.effectivePriceCents;
}
