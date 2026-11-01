import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  base: './',
  server: { port: 5180, host: true },
  build: { target: 'es2022' },
});
