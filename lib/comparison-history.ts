type ObservedOffer = {
  offerPrice: number;
  previousPrice: number | null;
};

// Compare the same set of offers on both sides. A newly covered, cheaper
// supermarket is useful coverage, but is not evidence of a price reduction.
// The previous observations may be older than last week after missed crawls.
export function comparePriceObservations(offers: readonly ObservedOffer[]) {
  const comparable = offers.filter((offer) => offer.previousPrice !== null);
  if (!comparable.length) return null;
  const previousLowestPrice = Math.min(
    ...comparable.map((offer) => offer.previousPrice!),
  );
  const currentLowestPrice = Math.min(
    ...comparable.map((offer) => offer.offerPrice),
  );
  return {
    previousLowestPrice,
    currentLowestPrice,
    change: Math.round((currentLowestPrice - previousLowestPrice) * 100) / 100,
    offerCount: comparable.length,
  };
}
