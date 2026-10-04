"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Send } from "lucide-react";
import { createTelegramCodeAction, unlinkTelegramAction } from "@/app/settings/actions";
import { Button } from "./ui";
import { ConfirmButton, CopyButton, Flash, useFlash } from "./settings-kit";

interface Code {
  code: string;
  expiresAt: string;
  /** Chat linked when the code was created, to notice when it changes. */
  before: number | null;
}

/**
 * Link / unlink this user's Telegram chat. While a code is on screen the page
 * refreshes every few seconds, so it flips to "Linked" as soon as the bot
 * redeems it.
 */
export function TelegramLink({ linked, chatId, bot }: { linked: boolean; chatId: number | null; bot: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState<Code | null>(null);
  const [pending, start] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  const [now, setNow] = useState(() => Date.now());

  const expired = code ? new Date(code.expiresAt).getTime() <= now : false;
  // A new chat was linked while the code was shown: the code was used.
  const justLinked = !!code && linked && chatId !== code.before;

  useEffect(() => {
    if (!code || expired || justLinked) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [code, expired, justLinked, router]);

  useEffect(() => {
    if (!justLinked) return;
    setCode(null);
    showFlash("good", "Linked! Your bot will now answer in that chat.");
  }, [justLinked, showFlash]);

  const generate = () =>
    start(async () => {
      try {
        const res = await createTelegramCodeAction();
        setNow(Date.now());
        setCode({ code: res.code, expiresAt: res.expiresAt, before: chatId });
      } catch {
        showFlash("critical", "Couldn't create a code — try again.");
      }
    });

  const unlink = () =>
    start(async () => {
      const res = await unlinkTelegramAction();
      if (res.ok) showFlash("good", res.message ?? "Unlinked");
      else showFlash("critical", res.error);
    });

  const message = code ? `/start ${code.code}` : "";
  const until = code
    ? new Date(code.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={linked ? "secondary" : "primary"} onClick={generate} disabled={pending}>
          {pending && !code ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Link2 size={14} aria-hidden />}
          {code ? "New code" : linked ? "Link a different chat" : "Generate link code"}
        </Button>
        {linked && <ConfirmButton onConfirm={unlink} label="Unlink" confirmLabel="Click again to unlink" disabled={pending} />}
        <Flash flash={flash} />
      </div>

      {code && (
        <div className="rounded-xl border border-border bg-surface-2 p-4">
          {expired ? (
            <p className="text-sm text-ink-2">
              This code expired. <span className="text-ink">Generate a new one</span> and send it within 30 minutes.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs text-muted">Your code</span>
                <span className="font-mono text-xl font-semibold tracking-[0.2em] text-ink">{code.code}</span>
                <span className="text-xs text-muted">expires in 30 minutes ({until})</span>
              </div>
              {bot && (
                <a
                  href={`https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(code.code)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
                >
                  <Send size={14} aria-hidden /> Open @{bot} in Telegram
                </a>
              )}
              <div>
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                  <Send size={12} aria-hidden /> {bot ? "Or send" : "Send"} this message to your bot in Telegram:
                </p>
                <div className="flex items-center gap-1 rounded-lg border border-border bg-surface py-1 pr-1 pl-3">
                  <code className="min-w-0 flex-1 font-mono text-sm text-ink [overflow-wrap:anywhere]">{message}</code>
                  <CopyButton text={message} />
                </div>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 size={12} className="animate-spin" aria-hidden /> Waiting for the bot… this page updates once it’s linked.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
