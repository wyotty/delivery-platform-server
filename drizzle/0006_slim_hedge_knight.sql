PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_order_item_modifiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`order_item_id` integer NOT NULL,
	`position` integer NOT NULL,
	`group_id` text,
	`group_name` text,
	`platform_modifier_id` text,
	`name` text NOT NULL,
	`price_minor` integer,
	`price_display` text,
	`quantity` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_order_item_modifiers`("id", "order_id", "order_item_id", "position", "group_id", "group_name", "platform_modifier_id", "name", "price_minor", "price_display", "quantity", "created_at") SELECT "id", "order_id", "order_item_id", "position", "group_id", "group_name", "platform_modifier_id", "name", "price_minor", "price_display", "quantity", "created_at" FROM `order_item_modifiers`;--> statement-breakpoint
DROP TABLE `order_item_modifiers`;--> statement-breakpoint
ALTER TABLE `__new_order_item_modifiers` RENAME TO `order_item_modifiers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_order_item_modifiers_item` ON `order_item_modifiers` (`order_item_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_order_item_modifiers_order` ON `order_item_modifiers` (`order_id`);