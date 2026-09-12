import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";
import { assertCloudBuildConfig, withCloudCsp } from "./src/build/cloud-csp";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_SUPABASE_');
  const accountUrl = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '';
  const accountKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
  const localTest = command === 'serve' || process.env.JOVE_LOCAL_CLOUD_TEST === '1';
  assertCloudBuildConfig(accountUrl, accountKey, process.env.JOVE_REQUIRE_CLOUD === '1', localTest);
  return {
  base: "/jove-english-os/",
  plugins: [
    vue(),
    { name: 'jove-account-csp', transformIndexHtml: (html) => withCloudCsp(html, accountUrl, localTest) },
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "audio/*.wav"],
      manifest: {
        name: "Jove Language OS",
        short_name: "Jove Language",
        description: "Your personal practice for real-world language use.",
        theme_color: "#476b63",
        background_color: "#f7f8f5",
        display: "standalone",
        start_url: "/jove-english-os/",
        scope: "/jove-english-os/",
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,wav,png}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  };
});
