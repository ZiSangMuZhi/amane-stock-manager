import { readFileSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  dependencies?: Record<string, string>;
};

const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];
const updateUrl = process.env.AMANE_UPDATE_URL ?? '';
const updateChannel = process.env.AMANE_UPDATE_CHANNEL ?? 'win';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __AMANE_UPDATE_URL__: JSON.stringify(updateUrl),
      __AMANE_UPDATE_CHANNEL__: JSON.stringify(updateChannel)
    },
    build: {
      rollupOptions: { external }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { external }
    }
  },
  renderer: {
    plugins: [react()]
  }
});
