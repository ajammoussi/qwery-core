import { pathToFileURL } from 'node:url';
import { resolve as pathResolve } from 'node:path';

const shimUrl = pathToFileURL(pathResolve(process.cwd(), 'src/shims/domain-entities-shim.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@qwery/domain/entities') {
    return {
      url: shimUrl,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
