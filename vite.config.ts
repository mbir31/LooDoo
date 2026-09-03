import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Firebase is roughly two thirds of the bundle and only changes when the
      // dependency is bumped; splitting it out keeps the app chunk small and
      // lets the browser cache the heavy vendor code across deploys.
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@firebase') || id.includes('firebase') || id.includes('@google-cloud')) {
              return 'firebase';
            }
            if (id.includes('lucide-react')) return 'icons';
            if (id.includes('/motion/') || id.includes('framer-motion')) return 'motion';
            if (id.includes('/react-dom/') || id.includes('/react/')) return 'react';
            return 'vendor';
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      host: true,
      // Sandbox / tunnel previews are served from a generated hostname.
      allowedHosts: true,
    },
    preview: {
      host: true,
      allowedHosts: true,
    },
  };
});
