import { defineConfig } from 'vite';

// The headers enable multithreaded WASM for computers without WebGPU.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { headers },
  preview: { headers },
});
