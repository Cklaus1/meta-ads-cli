import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2020',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // keytar is a native optional dependency loaded lazily; the MCP SDK is
  // imported only by `meta-ads mcp`. Keep both out of the bundle.
  external: ['keytar', '@modelcontextprotocol/sdk'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
