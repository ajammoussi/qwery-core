import * as qwery from '@qwery/extensions-sdk';

import { makeDuckDBDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'duckdb.default',
      (ctx) => makeDuckDBDriver(ctx),
      'node',
    ),
  );
}

