CREATE TABLE `recurring` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`pattern` text NOT NULL,
	`account_id` integer,
	`category_id` integer,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`cadence` text NOT NULL,
	`next_date` text NOT NULL,
	`tolerance_pct` real DEFAULT 10 NOT NULL,
	`window_days` integer DEFAULT 5 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`last_matched_date` text,
	`last_amount_cents` integer,
	`last_change_pct` real,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recurring_user` ON `recurring` (`user_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurring_id` integer REFERENCES recurring(id) ON DELETE set null;