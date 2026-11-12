import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [react()];
  // Dev only: `vite --mode table` serves the real API handler on an in-memory store.
  if (command === 'serve' && mode === 'table')
    plugins.push((await import('./dev/local-table.ts')).default());
  return {
    plugins,
    resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  };
});
