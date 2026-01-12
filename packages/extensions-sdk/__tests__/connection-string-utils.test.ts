import { describe, it, expect } from 'vitest';
import {
  extractConnectionUrl,
  buildPostgresConnectionUrl,
  buildMysqlConnectionUrl,
  buildClickHouseConnectionUrl,
  cleanPostgresConnectionUrl,
} from '../src/connection-string-utils';

describe('connection-string-utils', () => {
  describe('extractConnectionUrl', () => {
    it('should extract connectionUrl for PostgreSQL', () => {
      const config = {
        connectionUrl: 'postgresql://user:pass@host:5432/db',
      };
      const result = extractConnectionUrl(config, 'postgresql');
      expect(result).toBe('postgresql://user:pass@host:5432/db?sslmode=prefer');
    });

    it('should build PostgreSQL connection URL from fields', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        username: 'user',
        password: 'pass',
        database: 'mydb',
      };
      const result = extractConnectionUrl(config, 'postgresql');
      expect(result).toContain('postgresql://user:pass@localhost:5432/mydb');
      expect(result).toContain('sslmode=prefer');
    });

    it('should extract connectionUrl for MySQL', () => {
      const config = {
        connectionUrl: 'mysql://user:pass@host:3306/db',
      };
      const result = extractConnectionUrl(config, 'mysql');
      expect(result).toBe('mysql://user:pass@host:3306/db');
    });

    it('should build MySQL connection string from fields', () => {
      const config = {
        host: 'localhost',
        port: 3306,
        username: 'user',
        password: 'pass',
        database: 'mydb',
      };
      const result = extractConnectionUrl(config, 'mysql');
      expect(result).toBe('mysql://user:pass@localhost:3306/mydb');
    });

    it('should extract connectionUrl for ClickHouse', () => {
      const config = {
        connectionUrl: 'http://localhost:8123',
      };
      const result = extractConnectionUrl(config, 'clickhouse-node');
      expect(result).toBe('http://localhost:8123');
    });

    it('should build ClickHouse connection URL from fields', () => {
      const config = {
        host: 'localhost',
        port: 8123,
        username: 'default',
        password: 'pass',
        database: 'mydb',
      };
      const result = extractConnectionUrl(config, 'clickhouse-node');
      expect(result).toContain('http://');
      expect(result).toContain('localhost:8123');
    });

    it('should extract path for SQLite/DuckDB', () => {
      const config = {
        path: '/tmp/database.db',
      };
      const result = extractConnectionUrl(config, 'sqlite');
      expect(result).toBe('/tmp/database.db');
    });

    it('should throw error for unsupported provider', () => {
      const config = {
        host: 'localhost',
      };
      expect(() => extractConnectionUrl(config, 'unsupported')).toThrow(
        'Unsupported provider for connection string extraction',
      );
    });

    it('should throw error if required fields are missing', () => {
      const config = {};
      expect(() => extractConnectionUrl(config, 'postgresql')).toThrow(
        'requires connectionUrl or host',
      );
    });
  });

  describe('buildPostgresConnectionUrl', () => {
    it('should build URL with all fields', () => {
      const result = buildPostgresConnectionUrl({
        host: 'localhost',
        port: 5432,
        username: 'user',
        password: 'pass',
        database: 'mydb',
        sslmode: 'require',
      });
      expect(result).toBe(
        'postgresql://user:pass@localhost:5432/mydb?sslmode=require',
      );
    });

    it('should use defaults for missing fields', () => {
      const result = buildPostgresConnectionUrl({
        host: 'localhost',
      });
      expect(result).toContain('postgresql://');
      expect(result).toContain('localhost:5432');
      expect(result).toContain('sslmode=prefer');
    });
  });

  describe('buildMysqlConnectionUrl', () => {
    it('should build mysql:// URL format', () => {
      const result = buildMysqlConnectionUrl({
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass',
        database: 'mydb',
      });
      expect(result).toBe('mysql://root:pass@localhost:3306/mydb');
    });
  });

  describe('buildClickHouseConnectionUrl', () => {
    it('should build HTTP URL with credentials', () => {
      const result = buildClickHouseConnectionUrl({
        host: 'localhost',
        port: 8123,
        username: 'default',
        password: 'pass',
        database: 'mydb',
      });
      expect(result).toContain('http://');
      expect(result).toContain('default:pass@localhost:8123');
    });
  });

  describe('cleanPostgresConnectionUrl', () => {
    it('should remove channel_binding parameter', () => {
      const url =
        'postgresql://user:pass@host:5432/db?channel_binding=require&sslmode=prefer';
      const result = cleanPostgresConnectionUrl(url);
      expect(result).not.toContain('channel_binding');
      expect(result).toContain('sslmode=prefer');
    });

    it('should change sslmode=disable to prefer', () => {
      const url = 'postgresql://user:pass@host:5432/db?sslmode=disable';
      const result = cleanPostgresConnectionUrl(url);
      expect(result).toContain('sslmode=prefer');
      expect(result).not.toContain('sslmode=disable');
    });

    it('should add sslmode=prefer if missing', () => {
      const url = 'postgresql://user:pass@host:5432/db';
      const result = cleanPostgresConnectionUrl(url);
      expect(result).toContain('sslmode=prefer');
    });
  });
});
