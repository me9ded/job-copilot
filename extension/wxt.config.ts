import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// E2E builds pre-grant the loopback origin so Playwright can exercise the
// content script against a local fixture server without a permission prompt.
const isE2E = process.env.E2E === '1';

// One id for the whole build. WXT runs a separate Vite build per entrypoint group (the
// injected filler is built apart from the side panel), so it must not be computed per build.
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  srcDir: 'src',
  outDir: isE2E ? 'dist-e2e' : 'dist',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  vite: () => ({
    plugins: [tailwindcss()],
    // Lets the extension tell a filler injected by this build from one left in a page by an earlier build.
    define: { __JC_BUILD__: JSON.stringify(BUILD_ID) },
    build: { chunkSizeWarningLimit: 1500 },
  }),
  manifest: {
    name: 'Job Copilot',
    description:
      'Autofill job applications from your own résumé. Parsed and stored locally in your browser.',
    minimum_chrome_version: '116',
    // See docs/PERMISSIONS.md for the justification of every entry.
    permissions: [
      'storage',
      'unlimitedStorage',
      'sidePanel',
      'activeTab',
      'scripting',
      'alarms',
      'contextMenus',
    ],
    optional_permissions: ['notifications'],
    host_permissions: isE2E ? ['http://127.0.0.1/*'] : [],
    optional_host_permissions: [
      // Public ATS job pages (content script, only after the user enables a site)
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://jobs.ashbyhq.com/*',
      'https://apply.workable.com/*',
      'https://jobs.smartrecruiters.com/*',
      'https://*.myworkdayjobs.com/*',
      // Documented public job-board APIs (discovery)
      'https://boards-api.greenhouse.io/*',
      'https://api.lever.co/*',
      'https://api.ashbyhq.com/*',
      // User-specified career sites and the user's own backend, requested per origin
      'https://*/*',
      // Local model servers (Ollama, LM Studio, llama.cpp) and a local backend
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    action: { default_title: 'Job Copilot' },
    commands: {
      'autofill-page': {
        suggested_key: { default: 'Alt+Shift+J' },
        description: 'Autofill the job application on the current page',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    },
  },
});
