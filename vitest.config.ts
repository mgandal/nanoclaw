import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    exclude: ['src/mount-security.test.ts', 'src/image.test.ts'],
  },
});
