import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    permissions: ['activeTab', 'tabs', 'storage', 'alarms'],
    // Image thumbnails are proxied through vibes.ai's own /_next/image, but
    // generated video src points directly at Facebook's CDN — needed to
    // fetch() the mp4 from the popup without a CORS/permission error.
    host_permissions: ['https://*.vibes.ai/*', 'https://*.fbcdn.net/*'],
  },
});
