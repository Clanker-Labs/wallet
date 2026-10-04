---
title: Mobile
description: The whole app works on a phone. Add it to your home screen, sign in with Face ID, and keep Telegram for the quick updates.
blurb: Every page on your phone; installable, Face ID sign-in.
section: features
order: 13
video: mobile
---

wallet is one responsive web app, not a separate mobile client. Every page, from the dashboard to the import wizard and the simulators, works on a phone-sized screen.

## On a small screen

- Below tablet width, the sidebar becomes a compact **top bar** with the logo, the theme toggle and a **menu** that drops down the full navigation.
- Layouts collapse to a single column and charts resize to the screen; nothing scrolls sideways.
- Amount fields accept the shortcuts you'd type on a phone keyboard: `12.5k`, `1 234,56`.
- Light and dark themes follow the phone's setting, or the toggle.

## Install it

The app ships a web manifest and icons. In Safari, **Share → Add to Home Screen**; in Chrome on Android, **Install app**. It then opens full screen from its own icon, like a native app.

## Sign in with Face ID

When the server is on **HTTPS**, sign in on the phone itself: **Sign in with a passkey** uses the passkey from iCloud Keychain (or Google Password Manager) with Face ID or a fingerprint. If you created the passkey with the QR flow on a computer, it's already on your phone. See [Deployment](deployment.html) for putting the app behind HTTPS: passkeys don't work on a LAN IP over plain http.

## Statements from the phone

The assistant's 📎 button opens the phone's file picker or camera, so you can attach a PDF statement from the Files app or a screenshot of your bank app. Or skip the browser: **share the file to your Telegram bot** and the assistant imports it ([Reminders & Telegram](telegram.html)).

## Telegram for the quick stuff

For a monthly routine, Telegram is often faster than the web app: the reminder arrives on the 1st, you tap **Update balances now** and answer one number per account, then send last month's statement as a file. The web app is there when you want charts.
