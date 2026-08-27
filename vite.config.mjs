import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* The React app is built into dist/next and served from /next while the
   original single-file dashboard keeps serving / untouched. Nothing that
   works today changes until the two reach parity and / is switched over. */
export default defineConfig({
  root: 'src',
  base: '/next/',
  build: {
    outDir: '../dist/next',
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' }
  }
});
