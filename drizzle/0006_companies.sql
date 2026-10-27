CREATE TABLE `company_financials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`company_id` integer NOT NULL,
	`month` text NOT NULL,
	`revenue_cents` integer DEFAULT 0 NOT NULL,
	`expenses_cents` integer DEFAULT 0 NOT NULL,
	`note` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_financials_month` ON `company_financials` (`company_id`,`month`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `company_params` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `company_id` integer REFERENCES accounts(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `accounts` ADD `country` text;