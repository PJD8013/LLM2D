import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { editorServer } from './server.ts';

export default defineConfig({
  plugins: [svelte(), editorServer()],
  server: { port: Number(process.env.LLM2D_EDITOR_PORT ?? 5174), host: true },
  build: { target: 'es2022' },
});
