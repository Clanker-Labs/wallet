CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`target_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`target_date` text,
	`account_ids` text DEFAULT '[]' NOT NULL,
	`monthly_cents` integer,
	`archived_at` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goals_user` ON `goals` (`user_id`);