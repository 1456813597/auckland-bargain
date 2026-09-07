export type CatalogueCategory = {
  id: string;
  slug: string;
  children: CatalogueCategory[];
};

// MyFoodLink publishes a flat, store-specific department tree for its normal
// category navigation. Validate the entire tree before treating it as coverage.
export function parseCatalogueTree(value: unknown): CatalogueCategory {
  const rows = (value as { departments?: unknown } | null)?.departments;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5000) {
    throw new Error('Catalogue navigation has no valid department list.');
  }
  const nodes = new Map<string, CatalogueCategory>();
  const parents = new Map<string, string>();
  const slugs = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.slug !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) ||
      typeof row.parent_id !== 'string' ||
      nodes.has(row.id) ||
      slugs.has(row.slug)
    ) {
      throw new Error(
        'Catalogue navigation contains an invalid or duplicate department.',
      );
    }
    nodes.set(row.id, { id: row.id, slug: row.slug, children: [] });
    parents.set(row.id, row.parent_id);
    slugs.add(row.slug);
  }
  const roots: CatalogueCategory[] = [];
  for (const [id, node] of nodes) {
    const parentId = parents.get(id)!;
    if (!parentId) roots.push(node);
    else {
      const parent = nodes.get(parentId);
      if (!parent)
        throw new Error('Catalogue navigation has an orphan department.');
      parent.children.push(node);
    }
  }
  if (roots.length !== 1 || roots[0].slug !== 'all') {
    throw new Error(
      'Catalogue navigation must identify one all-departments root.',
    );
  }
  const visited = new Set<string>();
  const visit = (node: CatalogueCategory, depth: number) => {
    if (visited.has(node.id) || depth > 20) {
      throw new Error('Catalogue navigation is cyclic or too deeply nested.');
    }
    visited.add(node.id);
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(roots[0], 0);
  if (visited.size !== nodes.size) {
    throw new Error('Catalogue navigation contains disconnected departments.');
  }
  return roots[0];
}
