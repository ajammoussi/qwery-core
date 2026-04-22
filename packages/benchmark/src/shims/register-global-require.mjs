import { createRequire } from 'node:module';

if (typeof globalThis.require !== 'function') {
  globalThis.require = createRequire(import.meta.url);
}
