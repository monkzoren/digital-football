import { defineConfig } from 'vite';

// One id per production build. It is baked into the bundle (__BUILD_ID__)
// AND emitted as /version.json, so a page loaded before a deploy can detect
// that a newer build is live (see src/update-check.ts).
const buildId = new Date().toISOString();

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    {
      name: 'emit-version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId }),
        });
      },
    },
  ],
  server: {
    host: true, // listen on all interfaces so LAN devices can connect
    port: Number(process.env.PORT) || 5173, // PORT lets tooling pick a free port
  },
});
