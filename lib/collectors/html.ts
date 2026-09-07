const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export function decodeHtml(value: string) {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, encoded: string) => {
      const hexadecimal = encoded[0]?.toLocaleLowerCase('en-NZ') === 'x';
      const point = Number.parseInt(
        hexadecimal ? encoded.slice(1) : encoded,
        hexadecimal ? 16 : 10,
      );
      return Number.isSafeInteger(point) ? String.fromCodePoint(point) : '';
    })
    .replace(
      /&([a-z]+);/gi,
      (entity, name: string) =>
        NAMED_ENTITIES[name.toLocaleLowerCase('en-NZ')] ?? entity,
    );
}

export function stripHtml(value: string) {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSizeLabel(value: string) {
  const patterns = [
    /\b\d+(?:\.\d+)?\s*(?:kg|g|l|ml)\s*(?:-|to)\s*\d+(?:\.\d+)?\s*(?:kg|g|l|ml)\b/i,
    /\b\d{1,3}\s*[x×]\s*\d+(?:\.\d+)?\s*(?:kg|g|l|ml)\b/i,
    /\b\d+(?:\.\d+)?\s*(?:kg|g|l|ml)\b/i,
    /\b\d{1,4}\s*(?:pack|pk|count|ct)\b/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[0];
    if (match) return match.replace(/\s+/g, ' ').replace('×', 'x').trim();
  }
  return null;
}
