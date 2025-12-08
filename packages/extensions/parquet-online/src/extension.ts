import * as qwery from '@qwery/extensions-sdk';

import { makeParquetDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'parquet-online.duckdb',
      (ctx: qwery.DriverContext) => makeParquetDriver(ctx),
      'node',
    ),
  );
}

