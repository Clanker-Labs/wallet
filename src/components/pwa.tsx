"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/** Registers the service worker (production only) and says when you're offline. */
export function Pwa() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <div role="status" className="animate-rise fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm text-page shadow-pop">
      <WifiOff size={15} aria-hidden /> Offline — showing the last version of this page
    </div>
  );
}

/** Ask the service worker to forget cached pages (on sign-out). */
export function clearOfflineCopies() {
  try {
    navigator.serviceWorker?.controller?.postMessage("wallet:clear");
  } catch {
    /* no service worker */
  }
}
