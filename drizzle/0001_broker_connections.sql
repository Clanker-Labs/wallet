CREATE TABLE `broker_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`environment` text NOT NULL,
	`account_id` integer NOT NULL,
	`external_account_id` text,
	`credentials` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_ok` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `broker_connections_user` ON `broker_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `broker_connections_account` ON `broker_connections` (`account_id`);--> statement-breakpoint
ALTER TABLE `holdings` ADD `connection_id` integer REFERENCES broker_connections(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `holdings` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_connection_external` ON `holdings` (`connection_id`,`external_id`);