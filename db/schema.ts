import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const retailers = sqliteTable("retailers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  website: text("website"),
}, (table) => [uniqueIndex("idx_retailers_slug").on(table.slug)]);

export const stores = sqliteTable("stores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  retailerId: integer("retailer_id").notNull().references(() => retailers.id),
  sourceStoreId: text("source_store_id").notNull(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  address: text("address"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  uniqueIndex("idx_stores_retailer_source").on(table.retailerId, table.sourceStoreId),
  index("idx_stores_city_active").on(table.city, table.active),
]);

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  brand: text("brand"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  sizeValue: real("size_value"),
  sizeUnit: text("size_unit"),
  gtin: text("gtin"),
}, (table) => [uniqueIndex("idx_products_gtin").on(table.gtin)]);

export const retailerProducts = sqliteTable("retailer_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").references(() => products.id),
  retailerId: integer("retailer_id").notNull().references(() => retailers.id),
  sourceProductId: text("source_product_id").notNull(),
  sourceName: text("source_name").notNull(),
  sourceUrl: text("source_url"),
}, (table) => [
  uniqueIndex("idx_retailer_products_source").on(table.retailerId, table.sourceProductId),
  index("idx_retailer_products_product").on(table.productId),
]);

export const currentOffers = sqliteTable("current_offers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  retailerProductId: integer("retailer_product_id").notNull().references(() => retailerProducts.id),
  storeId: integer("store_id").notNull().references(() => stores.id),
  regularPriceCents: integer("regular_price_cents"),
  promoPriceCents: integer("promo_price_cents"),
  memberPriceCents: integer("member_price_cents"),
  promotionType: text("promotion_type"),
  promotionText: text("promotion_text"),
  validUntil: integer("valid_until", { mode: "timestamp_ms" }),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  contentHash: text("content_hash").notNull(),
}, (table) => [
  uniqueIndex("idx_current_offers_product_store").on(table.retailerProductId, table.storeId),
  index("idx_current_offers_store_collected").on(table.storeId, table.collectedAt),
]);

export const offerHistory = sqliteTable("offer_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  retailerProductId: integer("retailer_product_id").notNull().references(() => retailerProducts.id),
  storeId: integer("store_id").notNull().references(() => stores.id),
  priceCents: integer("price_cents").notNull(),
  promotionType: text("promotion_type"),
  observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("idx_offer_history_product_store_date").on(table.retailerProductId, table.storeId, table.observedAt),
]);

export const collectionRuns = sqliteTable("collection_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  retailerSlug: text("retailer_slug").notNull(),
  storeSourceId: text("store_source_id").notNull(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed"] }).notNull(),
  offersSeen: integer("offers_seen").notNull().default(0),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  errorMessage: text("error_message"),
}, (table) => [
  index("idx_collection_runs_store_started").on(table.storeSourceId, table.startedAt),
]);
