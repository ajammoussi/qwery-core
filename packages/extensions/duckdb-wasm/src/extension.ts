import * as qwery from '@qwery/extensions-sdk';

import { makeDuckDBWasmDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'duckdb-wasm.default',
      (ctx) => makeDuckDBWasmDriver(ctx),
      'browser',
    ),
  );
}

