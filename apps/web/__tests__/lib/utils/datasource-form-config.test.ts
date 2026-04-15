import { describe, expect, it } from 'vitest';

import { normalizeProviderConfig } from '~/lib/utils/datasource-form-config';

describe('normalizeProviderConfig', () => {
  it('coerces SQL port from string to number', () => {
    const out = normalizeProviderConfig(
      {
        host: 'localhost',
        port: '5432',
        database: 'tpch',
        username: 'postgres',
        password: 'postgres',
      },
      'postgresql',
    );

    expect(out.port).toBe(5432);
    expect(typeof out.port).toBe('number');
  });

  it('preserves connectionUrl-only SQL config', () => {
    const out = normalizeProviderConfig(
      {
        connectionUrl: 'postgresql://postgres:postgres@127.0.0.1:55432/tpch',
        port: '5432',
      },
      'postgresql',
    );

    expect(out).toEqual({
      connectionUrl: 'postgresql://postgres:postgres@127.0.0.1:55432/tpch',
    });
  });
});
