import { z } from 'zod';

import { registerExtension } from '@qwery/extensions-sdk/registry';
import { ExtensionScope } from '@qwery/extensions-sdk/types';

import { PostgresDatasourceDriver } from './driver';

const schema = z.object({
  connectionUrl: z
    .string()
    .url()
    .describe('PostgreSQL connection string (postgresql://user:pass@host:port/db)'),
});

let registered = false;

export function registerPostgresqlExtension(): void {
  if (registered) {
    return;
  }

  registerExtension({
    id: 'postgresql',
    name: 'PostgreSQL',
    description: 'Connect to PostgreSQL databases using the pg driver',
    logo: '/images/datasources/postgresql.png',
    scope: ExtensionScope.DATASOURCE,
    schema,
    getDriver: async (name, config) => {
      return new PostgresDatasourceDriver(name, config);
    },
  });

  registered = true;
}

export { PostgresDatasourceDriver };




