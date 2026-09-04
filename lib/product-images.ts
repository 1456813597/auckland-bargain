const PAKNSAVE_IMAGE_ORIGIN = 'https://a.fsimg.co.nz';

export function paknsaveProductImageUrl(sourceProductId: string) {
  const numericId = sourceProductId.trim().split('-')[0];
  return /^\d+$/.test(numericId)
    ? `${PAKNSAVE_IMAGE_ORIGIN}/prod/product/retail/fan/image/500x500/${numericId}.png`
    : null;
}
