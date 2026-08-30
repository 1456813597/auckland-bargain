CREATE TABLE `collection_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_slug` text NOT NULL,
	`store_source_id` text NOT NULL,
	`status` text NOT NULL,
	`offers_seen` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `idx_collection_runs_store_started` ON `collection_runs` (`store_source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `current_offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_product_id` integer NOT NULL,
	`store_id` integer NOT NULL,
	`regular_price_cents` integer,
	`promo_price_cents` integer,
	`member_price_cents` integer,
	`promotion_type` text,
	`promotion_text` text,
	`valid_until` integer,
	`collected_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`retailer_product_id`) REFERENCES `retailer_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_current_offers_product_store` ON `current_offers` (`retailer_product_id`,`store_id`);--> statement-breakpoint
CREATE INDEX `idx_current_offers_store_collected` ON `current_offers` (`store_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `offer_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_product_id` integer NOT NULL,
	`store_id` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`promotion_type` text,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`retailer_product_id`) REFERENCES `retailer_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_offer_history_product_store_date` ON `offer_history` (`retailer_product_id`,`store_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`brand` text,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`size_value` real,
	`size_unit` text,
	`gtin` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_products_gtin` ON `products` (`gtin`);--> statement-breakpoint
CREATE TABLE `retailer_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer,
	`retailer_id` integer NOT NULL,
	`source_product_id` text NOT NULL,
	`source_name` text NOT NULL,
	`source_url` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_retailer_products_source` ON `retailer_products` (`retailer_id`,`source_product_id`);--> statement-breakpoint
CREATE INDEX `idx_retailer_products_product` ON `retailer_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `retailers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`website` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_retailers_slug` ON `retailers` (`slug`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`retailer_id` integer NOT NULL,
	`source_store_id` text NOT NULL,
	`name` text NOT NULL,
	`city` text NOT NULL,
	`address` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stores_retailer_source` ON `stores` (`retailer_id`,`source_store_id`);--> statement-breakpoint
CREATE INDEX `idx_stores_city_active` ON `stores` (`city`,`active`);
--> statement-breakpoint
PRAGMA optimize;
