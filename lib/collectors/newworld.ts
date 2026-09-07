import {
  PaknsaveCollector,
  type PaknsaveCollectorOptions,
} from '@/lib/collectors/paknsave';

const DEFAULT_WEB_ORIGIN = 'https://www.newworld.co.nz';
const DEFAULT_API_ORIGIN = 'https://api-prod.newworld.co.nz';

export type NewWorldCollectorOptions = Omit<
  PaknsaveCollectorOptions,
  | 'webOrigin'
  | 'apiOrigin'
  | 'retailerSlug'
  | 'retailerName'
  | 'bannerCode'
  | 'productUrlSuffix'
> & {
  webOrigin?: string;
  apiOrigin?: string;
};

export class NewWorldCollector extends PaknsaveCollector {
  constructor(options: NewWorldCollectorOptions = {}) {
    super({
      ...options,
      webOrigin: options.webOrigin ?? DEFAULT_WEB_ORIGIN,
      apiOrigin: options.apiOrigin ?? DEFAULT_API_ORIGIN,
      retailerSlug: 'newworld',
      retailerName: 'New World',
      bannerCode: 'MNW',
      productUrlSuffix: 'nw',
      storeQuery: options.storeQuery ?? 'Metro Queen St',
    });
  }
}
