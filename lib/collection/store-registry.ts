import { createHash } from 'node:crypto';

import type { CollectionScope, CollectorStore } from '../collectors/types';
import type { LocalRetailerSnapshot } from '../local-deals';
import { nzWeekStart } from '../weekly-history';

export const retailerDefinitions = {
  woolworths: { name: 'Woolworths', catalogue: false },
  paknsave: { name: "PAK'nSAVE", catalogue: false },
  newworld: { name: 'New World', catalogue: false },
  foursquare: { name: 'Four Square', catalogue: false },
  freshchoice: { name: 'FreshChoice', catalogue: true },
  supervalue: { name: 'SuperValue', catalogue: true },
} as const;

export type RegisteredRetailer = keyof typeof retailerDefinitions;
export type RegisteredStore = CollectorStore & {
  id: string;
  retailer: RegisteredRetailer;
  enabled: boolean;
  scope: CollectionScope;
  storeOrigin?: string;
  cookieEnv?: string;
  access: {
    status: 'pending' | 'approved' | 'denied';
    reference?: string;
    expiresAt?: string;
  };
};
export type StoreRegistry = { schemaVersion: 1; stores: RegisteredStore[] };

function record(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function knownKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(
      `${label} contains unsupported fields. Do not store credentials in the registry.`,
    );
}

function text(value: unknown, label: string, max = 250) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new Error(
      `${label} must be non-empty text without control characters.`,
    );
  return value.trim();
}

function isoDate(value: unknown, label: string) {
  const date = text(value, label, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(date) ||
    !Number.isFinite(Date.parse(date))
  )
    throw new Error(`${label} must be an ISO UTC timestamp.`);
  const normalized = new Date(date).toISOString();
  if (normalized.slice(0, 19) !== date.slice(0, 19))
    throw new Error(`${label} must be a real calendar date.`);
  return normalized;
}

export function registryStoreKey(
  store: Pick<RegisteredStore, 'retailer' | 'sourceStoreId'>,
) {
  return JSON.stringify([
    store.retailer,
    store.retailer === 'foursquare'
      ? store.sourceStoreId.toLowerCase()
      : store.sourceStoreId,
  ]);
}

export function parseStoreRegistry(value: unknown): StoreRegistry {
  const root = record(value, 'Store registry');
  knownKeys(root, ['schemaVersion', 'stores'], 'Store registry');
  if (
    root.schemaVersion !== 1 ||
    !Array.isArray(root.stores) ||
    root.stores.length > 10_000
  )
    throw new Error(
      'Store registry requires schemaVersion 1 and at most 10000 stores.',
    );
  const ids = new Set<string>();
  const sourceKeys = new Set<string>();
  const origins = new Set<string>();
  const stores = root.stores.map((value): RegisteredStore => {
    const row = record(value, 'Store');
    knownKeys(
      row,
      [
        'id',
        'retailer',
        'sourceStoreId',
        'name',
        'city',
        'address',
        'enabled',
        'scope',
        'storeOrigin',
        'cookieEnv',
        'access',
      ],
      'Store',
    );
    const id = text(row.id, 'Store id', 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id))
      throw new Error('Store ids must be unique lowercase slugs.');
    ids.add(id);
    if (
      typeof row.retailer !== 'string' ||
      !Object.hasOwn(retailerDefinitions, row.retailer)
    )
      throw new Error(`Unsupported retailer for ${id}.`);
    const retailer = row.retailer as RegisteredRetailer;
    if (
      typeof row.enabled !== 'boolean' ||
      typeof row.scope !== 'string' ||
      !['catalogue', 'specials'].includes(row.scope)
    )
      throw new Error(
        `Store ${id} needs an explicit enabled flag and collection scope.`,
      );
    const access = record(row.access, `Access for ${id}`);
    knownKeys(access, ['status', 'reference', 'expiresAt'], 'Access');
    if (
      typeof access.status !== 'string' ||
      !['pending', 'approved', 'denied'].includes(access.status)
    )
      throw new Error(`Invalid access status for ${id}.`);
    const reference =
      access.reference === undefined
        ? undefined
        : text(access.reference, 'Access reference', 1000);
    if (access.status === 'approved' && !reference)
      throw new Error(
        `Approved access for ${id} requires an operator-reviewed permission reference.`,
      );
    const store: RegisteredStore = {
      id,
      retailer,
      sourceStoreId: text(row.sourceStoreId, 'Source store id', 200),
      name: text(row.name, 'Store name'),
      city: text(row.city, 'Store city'),
      address:
        row.address == null ? null : text(row.address, 'Store address', 500),
      enabled: row.enabled,
      scope: row.scope as CollectionScope,
      access: {
        status: access.status as RegisteredStore['access']['status'],
        ...(reference ? { reference } : {}),
        ...(access.expiresAt === undefined
          ? {}
          : { expiresAt: isoDate(access.expiresAt, 'Access expiry') }),
      },
    };
    if (retailer === 'foursquare')
      store.sourceStoreId = store.sourceStoreId.toUpperCase();
    const key = registryStoreKey(store);
    if (sourceKeys.has(key))
      throw new Error(`Duplicate source store for ${id}.`);
    sourceKeys.add(key);
    if (retailer === 'freshchoice' || retailer === 'supervalue') {
      const origin = new URL(text(row.storeOrigin, 'Store origin'));
      const hostPattern = new RegExp(
        `^[a-z0-9]+(?:-[a-z0-9]+)*\\.store\\.${retailer}\\.co\\.nz$`,
      );
      if (
        origin.protocol !== 'https:' ||
        !hostPattern.test(origin.hostname) ||
        origin.port ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        throw new Error(
          `Store ${id} requires its official HTTPS storefront origin, without a path or credentials.`,
        );
      if (origins.has(origin.origin))
        throw new Error(`Duplicate storefront origin for ${id}.`);
      origins.add(origin.origin);
      store.storeOrigin = origin.origin;
    } else if (row.storeOrigin !== undefined) {
      throw new Error(`Store origin is not supported for ${retailer}.`);
    }
    if (retailer === 'woolworths') {
      const cookieEnv = text(
        row.cookieEnv,
        'Woolworths cookie environment variable',
        100,
      );
      if (!/^WOOLWORTHS_COOKIE(?:_[A-Z0-9]+)*$/.test(cookieEnv))
        throw new Error(
          'Use a WOOLWORTHS_COOKIE-prefixed environment variable name, never a cookie value.',
        );
      store.cookieEnv = cookieEnv;
    } else if (row.cookieEnv !== undefined) {
      throw new Error(`Cookie configuration is not supported for ${retailer}.`);
    }
    return store;
  });
  return { schemaVersion: 1, stores };
}

export type StorePlanReason =
  | 'access-pending'
  | 'access-denied'
  | 'access-expired'
  | 'catalogue-unsupported'
  | 'credential-missing'
  | 'scope-downgrade'
  | 'invalid-snapshot-date'
  | 'future-snapshot';
export type StorePlan = {
  id: string;
  retailer: RegisteredRetailer;
  sourceStoreId: string;
  scope: CollectionScope;
  weekStart: string;
  jobKey: string;
  status: 'due' | 'current' | 'disabled' | 'blocked';
  reasons: StorePlanReason[];
  lastCollectedAt: string | null;
};

export function storeAccessProblems(
  store: RegisteredStore,
  now: Date,
  environment: Record<string, string | undefined>,
): StorePlanReason[] {
  const reasons: StorePlanReason[] = [];
  if (store.access.status !== 'approved')
    reasons.push(
      store.access.status === 'denied' ? 'access-denied' : 'access-pending',
    );
  if (
    store.access.expiresAt &&
    Date.parse(store.access.expiresAt) <= now.getTime()
  )
    reasons.push('access-expired');
  if (
    store.scope === 'catalogue' &&
    !retailerDefinitions[store.retailer].catalogue
  )
    reasons.push('catalogue-unsupported');
  if (store.cookieEnv && !environment[store.cookieEnv]?.trim())
    reasons.push('credential-missing');
  return reasons;
}

export function planStoreCollections(
  registry: StoreRegistry,
  snapshots: LocalRetailerSnapshot[],
  now = new Date(),
  environment: Record<string, string | undefined> = {},
): StorePlan[] {
  if (!Number.isFinite(now.getTime()))
    throw new Error('Collection plan requires a valid date.');
  const weekStart = nzWeekStart(now);
  return registry.stores
    .map((store): StorePlan => {
      const previous = snapshots.filter(
        (snapshot) =>
          registryStoreKey({
            retailer: snapshot.slug as RegisteredRetailer,
            sourceStoreId: snapshot.store.sourceStoreId,
          }) === registryStoreKey(store),
      );
      const last = previous.toSorted(
        (a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt),
      )[0];
      const reasons = storeAccessProblems(store, now, environment);
      if (
        previous.some(
          (snapshot) => !Number.isFinite(Date.parse(snapshot.collectedAt)),
        )
      )
        reasons.push('invalid-snapshot-date');
      if (
        previous.some(
          (snapshot) => Date.parse(snapshot.collectedAt) > now.getTime(),
        )
      )
        reasons.push('future-snapshot');
      if (last?.scope === 'catalogue' && store.scope === 'specials')
        reasons.push('scope-downgrade');
      const current =
        last &&
        Number.isFinite(Date.parse(last.collectedAt)) &&
        nzWeekStart(last.collectedAt) === weekStart &&
        (last.scope ?? 'specials') === store.scope;
      return {
        id: store.id,
        retailer: store.retailer,
        sourceStoreId: store.sourceStoreId,
        scope: store.scope,
        weekStart,
        jobKey: createHash('sha256')
          .update(
            JSON.stringify([registryStoreKey(store), store.scope, weekStart]),
          )
          .digest('hex'),
        status: !store.enabled
          ? 'disabled'
          : reasons.length
            ? 'blocked'
            : current
              ? 'current'
              : 'due',
        reasons,
        lastCollectedAt: last?.collectedAt ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
