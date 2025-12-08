import * as qwery from '@qwery/extensions-sdk';

import { makeGSheetDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'gsheet-csv.duckdb',
      (ctx: qwery.DriverContext) => makeGSheetDriver(ctx),
      'node',
    ),
  );
}

