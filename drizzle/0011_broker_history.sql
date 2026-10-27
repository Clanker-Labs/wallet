CREATE TABLE `broker_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`connection_id` integer,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`at` text NOT NULL,
	`date` text NOT NULL,
	`ticker` text,
	`symbol` text,
	`name` text,
	`quantity` real,
	`price` real,
	`price_currency` text,
	`cash_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`realized_cents` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `broker_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `broker_activity_external` ON `broker_activity` (`account_id`,`kind`,`external_id`);--> statement-breakpoint
CREATE INDEX `broker_activity_account_date` ON `broker_activity` (`account_id`,`date`);--> statement-breakpoint
ALTER TABLE `broker_connections` ADD `history_synced_at` integer;--> statement-breakpoint
ALTER TABLE `broker_connections` ADD `history_status` text;