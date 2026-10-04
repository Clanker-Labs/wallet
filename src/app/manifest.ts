import type { MetadataRoute } from "next";

/** Web app manifest: lets wallet be installed / added to the iPhone home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "wallet",
    short_name: "wallet",
    description: "Your net worth, budgets and investments — private, on your own machine.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6fa",
    theme_color: "#f5f6fa",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
