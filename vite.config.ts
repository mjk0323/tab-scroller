import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the build works under https://<user>.github.io/tab-scroller/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1000 }, // pdf.js is large by nature
});
