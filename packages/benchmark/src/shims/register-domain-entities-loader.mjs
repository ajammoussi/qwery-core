import { register } from 'node:module';

register(new URL('./domain-entities-loader.mjs', import.meta.url));
