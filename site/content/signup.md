---
title: Sign-up
description: Create the owner account with a passkey in a few seconds, then optionally let family members create their own private wallets on the same server.
blurb: Passkey sign-up, from this device or an iPhone.
section: features
order: 12
video: signup
---

There's no password to choose and no email to confirm. A wallet account is a **name and a passkey**.

## The first account

On a fresh install, every page leads to **Set up your wallet**. Type your name, then:

- **Create my passkey**: on this device, with Touch ID, Face ID, Windows Hello or your password manager; or
- **Save it on my iPhone (QR code)**: scan the code with the iPhone camera, approve with Face ID, and the passkey lives in iCloud Keychain.

You're signed in right away (a 90-day session) and land on the dashboard's welcome card. This first account is the **owner**. New users start with 23 default categories and their own settings.

> [!IMPORTANT]
> Passkeys need **https** or **http://localhost**. Opening the app on a LAN IP over http (`http://192.168.1.10:3000`) won't let you create one: use localhost on the server itself, or put the app behind HTTPS ([Deployment](deployment.html)).

## More people

After the owner exists, sign-ups are **closed**: `/signup` says so, and the registration API refuses with 403. To let someone create their own wallet:

```bash
WALLET_ALLOW_SIGNUP=1    # in .env, then restart; also accepts true, yes, on
```

They open `/signup` (the page now reads **Create your account**) and go through the same passkey step. Each member has a completely separate wallet: accounts, transactions, budgets, reminders, assistant conversations, Telegram chat. The owner sees everyone under **Settings → Members**. Remove the variable again to close sign-ups; existing members keep their access.

## Signing in

**Welcome back**: **Sign in with a passkey** on this device, or **Use my iPhone (QR code)**. No username: the passkey knows which account it belongs to. Add passkeys for your other devices in **Settings → Security**.

## Lost access?

`npm run auth:link` on the server prints a one-time link (15 minutes) that signs you in and opens **Settings → Security**, where you can register a new passkey. `-- --list` shows users and `-- --user <id>` targets a member. It requires shell access to the server, which is the point.

How the ceremonies work: [Auth & security](security.html).
