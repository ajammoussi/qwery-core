import * as qwery from '@qwery/extensions-sdk';

import { makeJsonDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'json-online.duckdb',
      (ctx: qwery.DriverContext) => makeJsonDriver(ctx),
      'node',
    ),
  );
}

