CREATE TABLE `order_item_modifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`order_item_id` integer NOT NULL,
	`position` integer NOT NULL,
	`group_id` text,
	`group_name` text,
	`platform_modifier_id` text,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`price_minor` integer,
	`price_display` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_order_item_modifiers_item` ON `order_item_modifiers` (`order_item_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_order_item_modifiers_order` ON `order_item_modifiers` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`position` integer NOT NULL,
	`line_key` text NOT NULL,
	`platform_item_id` text,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`base_total_minor` integer,
	`base_total_display` text,
	`discount_minor` integer,
	`discounts_json` text,
	`comment` text,
	`sku_id` text,
	`item_code` text,
	`barcode` text,
	`currency` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_order_items_order_line` ON `order_items` (`order_id`,`line_key`);--> statement-breakpoint
CREATE INDEX `idx_order_items_order_position` ON `order_items` (`order_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_order_items_platform_item` ON `order_items` (`platform_item_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `items_fetched_at` text;