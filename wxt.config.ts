import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AI Content Generator',
    version: '1.0.5',
    permissions: ['activeTab', 'tabs', 'storage', 'alarms', 'debugger', 'unlimitedStorage'],
    host_permissions: ['https://*.vibes.ai/*', 'https://*.fbcdn.net/*', 'https://labs.google/*'],
    browser_specific_settings: {
      gecko: {
        id: 'omniflowai@example.com',
        strict_min_version: '109.0',
      },
    },
  },
});
