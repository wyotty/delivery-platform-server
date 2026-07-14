CREATE TABLE `fetch_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`status` text NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `platform_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fetch_runs_account_date` ON `fetch_runs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`platform_order_id` text NOT NULL,
	`account_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`status` text NOT NULL,
	`platform_status` text NOT NULL,
	`gross_amount_minor` integer,
	`net_amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`ordered_at` text NOT NULL,
	`platform_timezone` text NOT NULL,
	`updated_at` text NOT NULL,
	`raw_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `platform_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_orders_platform_order` ON `orders` (`platform`,`platform_order_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_merchant_date` ON `orders` (`merchant_id`,`ordered_at`);--> statement-breakpoint
CREATE INDEX `idx_orders_account` ON `orders` (`account_id`,`ordered_at`);--> statement-breakpoint
CREATE TABLE `platform_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`platform` text NOT NULL,
	`label` text NOT NULL,
	`credential_key` text NOT NULL,
	`config` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `platform_sessions` (
	`account_id` text PRIMARY KEY NOT NULL,
	`session_json` text NOT NULL,
	`state` text DEFAULT 'valid' NOT NULL,
	`fetched_at` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `platform_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
