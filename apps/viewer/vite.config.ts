import { defineConfig } from 'vite';

export default defineConfig({
  // Serve the repo's samples folder at the site root: /bolt/bolt.l2d.json etc.
  publicDir: '../../samples',
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022' },
});
