import * as qwery from '@qwery/extensions-sdk';

import { makeClickHouseDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'clickhouse.web',
      (ctx: qwery.DriverContext) => makeClickHouseDriver(ctx),
      'browser',
    ),
  );
}

