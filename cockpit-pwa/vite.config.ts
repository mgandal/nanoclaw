import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Route the syntax highlighter into its own chunk so it loads
          // only on /vault/:slug visits, keeping the main bundle under budget.
          if (id.includes('highlight.js')) return 'hljs';
          if (id.includes('markdown-it')) return 'markdown';
        },
      },
    },
  },
});
