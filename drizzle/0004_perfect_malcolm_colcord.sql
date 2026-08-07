ALTER TABLE `order_items` ADD `raw_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `detail_raw_json` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_total_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_subtotal_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_passenger_total_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_tax_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_delivery_fee_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_commission_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_merchant_charge_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_small_order_fee_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_promotion_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_total_discount_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_reduced_price_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_adjustment_by_driver_minor` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_merchant_charge_display` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_promotion_display` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_total_discount_display` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `fare_adjustment_by_driver_display` text;