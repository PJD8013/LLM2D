import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { editorServer } from './server.ts';

export default defineConfig({
  plugins: [svelte(), editorServer()],
  // The editor reads and writes project files: only this machine by default. `pnpm editor --host`
  // (LLM2D_EDITOR_HOST) opens it to the network.
  server: { port: Number(process.env.LLM2D_EDITOR_PORT ?? 5174), host: process.env.LLM2D_EDITOR_HOST ?? '127.0.0.1' },
  build: { target: 'es2022' },
});
