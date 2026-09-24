import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  manifest: {
    name: 'Live AI Transcript',
    description: 'Live transcript of calls on monitored Asterisk extensions',
    permissions: ['storage', 'sidePanel'],
    action: { default_title: 'Open live transcript' },
  },
  vite: () => ({
    plugins: [react(), tailwindcss()],
  }),
});
