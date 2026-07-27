DROP INDEX `idx_orders_merchant_date`;--> statement-breakpoint
DROP INDEX `idx_orders_account`;--> statement-breakpoint
--> SQLite cannot add a NOT NULL column to a populated table without a default.
--> '' marks rows written before report_date existed; they carry no business day
--> and must be re-fetched. New rows always get a real value from the connector.
ALTER TABLE `orders` ADD `report_date` text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE INDEX `idx_orders_merchant_report_date` ON `orders` (`merchant_id`,`report_date`);--> statement-breakpoint
CREATE INDEX `idx_orders_account` ON `orders` (`account_id`,`report_date`);