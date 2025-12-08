import * as qwery from '@qwery/extensions-sdk';

import { makeMysqlDriver } from './driver';

export function activate(context: qwery.ExtensionContext) {
  context.subscriptions.push(
    qwery.datasources.registerDriver(
      'mysql.default',
      (ctx) => makeMysqlDriver(ctx),
      'node',
    ),
  );
}

