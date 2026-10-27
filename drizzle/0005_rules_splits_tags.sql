CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`category_id` integer,
	`amount_cents` integer NOT NULL,
	`note` text,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_tx` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
DROP INDEX `category_rules_user_pattern`;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `match_type` text DEFAULT 'contains' NOT NULL;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `account_id` integer REFERENCES accounts(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `direction` text;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `min_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `max_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `rename_to` text;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `add_tag` text;--> statement-breakpoint
CREATE INDEX `category_rules_user` ON `category_rules` (`user_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `payee` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `tags` text;