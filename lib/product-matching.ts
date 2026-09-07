export const AUTO_MATCH_THRESHOLD = 0.86;
export const REVIEW_MATCH_THRESHOLD = 0.72;

export type ProductIdentity = Readonly<{
  id: string;
  sourceName: string;
  brand?: string | null;
  size?: string | null;
  category?: string | null;
  gtin?: string | null;
  retailerSlug?: string | null;
}>;

export type MatchDecision = 'auto' | 'review' | 'reject';

export type ProductMatch = {
  decision: MatchDecision;
  score: number;
  method: 'gtin' | 'attributes';
  reasons: string[];
  breakdown: {
    brand: number;
    title: number;
    size: number;
    category: number;
  };
};

type Measure = {
  dimension: 'mass' | 'volume' | 'count';
  total: number;
  packCount: number;
};

const TITLE_STOP_WORDS = new Set([
  'and',
  'the',
  'with',
  'for',
  'each',
  'ea',
  'pack',
  'packs',
  'pk',
  'packet',
  'bottle',
  'bottles',
  'can',
  'cans',
  'box',
  'bag',
  'grocery',
  'product',
  'new',
]);

const VARIANT_GROUPS = [
  ['salted', 'unsalted'],
  ['decaf', 'caffeinated'],
  ['skim', 'trim', 'standard', 'whole'],
  ['liquid', 'powder'],
  ['original', 'vanilla', 'chocolate', 'strawberry', 'caramel'],
  ['regular', 'diet', 'zero'],
] as const;

const BLOCKING_STOP_WORDS = new Set([
  'and',
  'for',
  'fresh',
  'frozen',
  'grocery',
  'new',
  'original',
  'pack',
  'product',
  'special',
  'supermarket',
  'the',
  'with',
]);

export function normalizeProductText(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .toLocaleLowerCase('en-NZ')
    .replace(/(\d)\.(\d)/g, '$1_decimal_$2')
    .replace(/[^a-z0-9_]+/g, ' ')
    .replaceAll('_decimal_', '.')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizedBrand(value: string | null | undefined) {
  return normalizeProductText(value);
}

function unitValue(value: number, unit: string) {
  const normalizedUnit = unit.toLocaleLowerCase('en-NZ');
  if (normalizedUnit === 'kg')
    return { dimension: 'mass' as const, value: value * 1_000 };
  if (normalizedUnit === 'g') return { dimension: 'mass' as const, value };
  if (normalizedUnit === 'l')
    return { dimension: 'volume' as const, value: value * 1_000 };
  return { dimension: 'volume' as const, value };
}

function parseMeasure(raw: string): Measure | null {
  if (
    /\b\d+(?:\.\d+)?\s*(?:kg|g|l|ml)?\s*(?:[-–—]|to)\s*\d+(?:\.\d+)?\s*(?:kg|g|l|ml)\b/i.test(
      raw,
    )
  ) {
    return null;
  }
  const text = normalizeProductText(raw);
  const multi = text.match(/\b(\d{1,3})\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
  if (multi) {
    const packCount = Number(multi[1]);
    const unit = unitValue(Number(multi[2]), multi[3]);
    return {
      dimension: unit.dimension,
      total: unit.value * packCount,
      packCount,
    };
  }

  const standard = text.match(/\b(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
  if (standard) {
    const unit = unitValue(Number(standard[1]), standard[2]);
    return { dimension: unit.dimension, total: unit.value, packCount: 1 };
  }

  const count = text.match(/\b(\d{1,4})\s*(?:pack|pk|count|ct|each|ea)\b/);
  if (count) {
    return {
      dimension: 'count',
      total: Number(count[1]),
      packCount: Number(count[1]),
    };
  }
  return null;
}

export function parseProductMeasure(
  size: string | null | undefined,
  sourceName = '',
): Measure | null {
  // A nappy's 10–15kg wearer range is not its 36-pack quantity. Prefer the
  // retailer's dedicated pack-size field, and never concatenate the two.
  if (size && /\d\s*(?:kg|g|l|ml)?\s*(?:[-–—]|to)\s*\d/i.test(size))
    return null;
  return parseMeasure(size ?? '') ?? parseMeasure(sourceName);
}

export function productMeasureKey(product: ProductIdentity) {
  const measure = parseProductMeasure(product.size, product.sourceName);
  return measure
    ? `${measure.dimension}:${String(measure.total)}:${String(measure.packCount)}`
    : null;
}

export function productBlockingTokens(product: ProductIdentity) {
  return [
    ...new Set(
      normalizeProductText(product.sourceName)
        .split(' ')
        .filter(
          (token) =>
            token.length >= 3 &&
            !BLOCKING_STOP_WORDS.has(token) &&
            !/^\d+(?:\.\d+)?$/.test(token),
        ),
    ),
  ]
    .sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )
    .slice(0, 3);
}

function singularToken(token: string) {
  if (token.length > 4 && token.endsWith('ies'))
    return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:ches|shes)$/.test(token))
    return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !/(?:ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

function tokens(value: string) {
  return new Set(
    normalizeProductText(value)
      .split(' ')
      .map(singularToken)
      .filter(
        (token) =>
          token.length > 1 &&
          !TITLE_STOP_WORDS.has(token) &&
          !/^\d+(?:\.\d+)?$/.test(token) &&
          !/^\d+(?:\.\d+)?(?:kg|g|l|ml|ct)$/.test(token) &&
          !/^(?:kg|g|l|ml|ct)$/.test(token),
      ),
  );
}

function titleTokens(product: ProductIdentity) {
  const result = tokens(product.sourceName);
  for (const token of tokens(product.brand ?? '')) result.delete(token);
  return result;
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection || 1);
}

function bigrams(value: string) {
  const compact = normalizeProductText(value).replaceAll(' ', '');
  if (compact.length < 2) return new Set(compact ? [compact] : []);
  return new Set(
    Array.from({ length: compact.length - 1 }, (_, index) =>
      compact.slice(index, index + 2),
    ),
  );
}

function dice(left: Set<string>, right: Set<string>) {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return (2 * intersection) / (left.size + right.size || 1);
}

function brandSimilarity(left: PreparedIdentity, right: PreparedIdentity) {
  const leftBrand = left.brand;
  const rightBrand = right.brand;
  if (!leftBrand && !rightBrand) return 0.65;
  if (!leftBrand || !rightBrand) return 0.5;
  if (leftBrand === rightBrand) return 1;
  return dice(left.brandBigrams, right.brandBigrams);
}

function titleSimilarity(left: PreparedIdentity, right: PreparedIdentity) {
  const tokenScore = jaccard(left.titleTokens, right.titleTokens);
  const characterScore = dice(left.titleBigrams, right.titleBigrams);
  return tokenScore * 0.7 + characterScore * 0.3;
}

function sizeSimilarity(left: PreparedIdentity, right: PreparedIdentity) {
  const leftMeasure = left.measure;
  const rightMeasure = right.measure;
  if (!leftMeasure && !rightMeasure) return 0.65;
  if (!leftMeasure || !rightMeasure) return 0.55;
  if (leftMeasure.dimension !== rightMeasure.dimension) return 0;
  if (leftMeasure.packCount !== rightMeasure.packCount) return 0;
  return leftMeasure.total > 0 &&
    rightMeasure.total > 0 &&
    Math.abs(leftMeasure.total - rightMeasure.total) < 0.000001
    ? 1
    : 0;
}

function categorySimilarity(left: PreparedIdentity, right: PreparedIdentity) {
  const leftCategory = left.categoryTokens;
  const rightCategory = right.categoryTokens;
  if (leftCategory.size === 0 || rightCategory.size === 0) return 0.6;
  return Math.max(0.2, jaccard(leftCategory, rightCategory));
}

function variantConflict(left: PreparedIdentity, right: PreparedIdentity) {
  const leftName = left.nameTokens;
  const rightName = right.nameTokens;
  for (const group of VARIANT_GROUPS) {
    const leftVariant = group.find((variant) => leftName.has(variant));
    const rightVariant = group.find((variant) => rightName.has(variant));
    if (leftVariant && rightVariant && leftVariant !== rightVariant) {
      return `${leftVariant} conflicts with ${rightVariant}`;
    }
  }
  return null;
}

function identityNumbers(sourceName: string) {
  // Strip selling quantities, not identity numbers: egg grade 7, hair shade
  // 8.1, SPF 50 and infant-formula stage 2 must survive title normalization.
  const withoutQuantities = normalizeProductText(sourceName)
    .replace(/\b\d+\s*x\s*\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b/g, ' ')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l|packs?|pk|count|ct|each|ea)\b/g,
      ' ',
    );
  return new Set(withoutQuantities.match(/\d+(?:\.\d+)?/g) ?? []);
}

type PreparedIdentity = {
  gtin: string;
  brand: string;
  brandBigrams: Set<string>;
  titleTokens: Set<string>;
  titleBigrams: Set<string>;
  nameTokens: Set<string>;
  categoryTokens: Set<string>;
  numbers: Set<string>;
  measure: Measure | null;
};

const preparedIdentities = new WeakMap<ProductIdentity, PreparedIdentity>();

function prepareIdentity(identity: ProductIdentity): PreparedIdentity {
  const cached = preparedIdentities.get(identity);
  if (cached) return cached;
  const brand = normalizedBrand(identity.brand);
  const title = titleTokens(identity);
  const prepared = {
    gtin: normalizeProductText(identity.gtin),
    brand,
    brandBigrams: bigrams(brand),
    titleTokens: title,
    titleBigrams: bigrams([...title].sort().join(' ')),
    nameTokens: tokens(identity.sourceName),
    categoryTokens: tokens(identity.category ?? ''),
    numbers: identityNumbers(identity.sourceName),
    measure: parseProductMeasure(identity.size, identity.sourceName),
  };
  preparedIdentities.set(identity, prepared);
  return prepared;
}

function rounded(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

export function scoreProductMatch(
  leftIdentity: ProductIdentity,
  rightIdentity: ProductIdentity,
): ProductMatch {
  const left = prepareIdentity(leftIdentity);
  const right = prepareIdentity(rightIdentity);
  const leftGtin = left.gtin;
  const rightGtin = right.gtin;
  if (leftGtin && rightGtin) {
    if (leftGtin === rightGtin) {
      return {
        decision: 'auto',
        score: 1,
        method: 'gtin',
        reasons: ['Exact GTIN match'],
        breakdown: { brand: 1, title: 1, size: 1, category: 1 },
      };
    }
    return {
      decision: 'reject',
      score: 0,
      method: 'attributes',
      reasons: ['GTIN values conflict'],
      breakdown: { brand: 0, title: 0, size: 0, category: 0 },
    };
  }

  const brand = brandSimilarity(left, right);
  const title = titleSimilarity(left, right);
  const size = sizeSimilarity(left, right);
  const category = categorySimilarity(left, right);
  const conflict = variantConflict(left, right);
  const bothBrandsPresent = Boolean(left.brand && right.brand);
  const numbersDisagree = jaccard(left.numbers, right.numbers) !== 1;
  const numericConflict =
    numbersDisagree && left.numbers.size > 0 && right.numbers.size > 0;
  const reasons: string[] = [];

  if (conflict) reasons.push(`Variant conflict: ${conflict}`);
  if (numbersDisagree)
    reasons.push('Numeric product identity differs or is missing');
  if (brand >= 0.98) reasons.push('Brand agrees');
  if (title >= 0.75) reasons.push('Product wording strongly overlaps');
  if (size >= 0.99) reasons.push('Pack size agrees');
  if (category >= 0.8) reasons.push('Category agrees');

  const hasHardMismatch =
    Boolean(conflict) ||
    numericConflict ||
    (bothBrandsPresent && brand < 0.72) ||
    size === 0;
  const score = rounded(
    brand * 0.28 + title * 0.42 + size * 0.22 + category * 0.08,
  );
  const decision = hasHardMismatch
    ? 'reject'
    : score >= AUTO_MATCH_THRESHOLD &&
        !numbersDisagree &&
        Boolean(left.measure && right.measure)
      ? 'auto'
      : score >= REVIEW_MATCH_THRESHOLD
        ? 'review'
        : 'reject';

  if (hasHardMismatch) reasons.push('A protected identity attribute disagrees');
  if (reasons.length === 0)
    reasons.push('Insufficient shared identity evidence');

  return {
    decision,
    score: hasHardMismatch
      ? Math.min(score, REVIEW_MATCH_THRESHOLD - 0.001)
      : score,
    method: 'attributes',
    reasons,
    breakdown: {
      brand: rounded(brand),
      title: rounded(title),
      size: rounded(size),
      category: rounded(category),
    },
  };
}

export function canonicalProductSlug(product: ProductIdentity) {
  const name = normalizeProductText(product.sourceName);
  const brand = normalizedBrand(product.brand);
  const size = normalizeProductText(product.size);
  const normalized = [
    brand && !name.startsWith(brand) ? brand : '',
    name,
    size && !name.includes(size) ? size : '',
  ]
    .filter(Boolean)
    .join(' ')
    .replaceAll(' ', '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return normalized || `product-${product.id}`;
}
