import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied so cookies are same-origin (SameSite=Lax just works).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_DEV_API ?? 'http://localhost:4000', changeOrigin: false } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
});
