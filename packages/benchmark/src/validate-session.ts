import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile } from 'fs/promises';
import type { BenchmarkSession } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function validateSession(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const content = await readFile(filePath, 'utf-8');
    const session = JSON.parse(content) as BenchmarkSession;

    if (
      !session.id ||
      !session.id.match(/^(tpch|saas)-(rci|irc|pta|dcs|sncj)-\d{3}$/)
    ) {
      errors.push(`Invalid session ID: ${session.id}`);
    }

    if (
      !session.metadata.database ||
      !['tpch', 'saas'].includes(session.metadata.database)
    ) {
      errors.push(`Invalid database: ${session.metadata.database}`);
    }

    if (
      !session.metadata.conversationType ||
      !['RCI', 'IRC', 'PTA', 'DCS', 'SNCJ'].includes(
        session.metadata.conversationType,
      )
    ) {
      errors.push(
        `Invalid conversation type: ${session.metadata.conversationType}`,
      );
    }

    if (!session.turns || session.turns.length === 0) {
      errors.push('Session has no turns');
    }

    for (const turn of session.turns) {
      if (turn.role !== 'user') {
        errors.push(`Turn ${turn.turnNumber} has invalid role: ${turn.role}`);
      }
      if (!turn.content || turn.content.trim().length === 0) {
        errors.push(`Turn ${turn.turnNumber} has empty content`);
      }
    }

    for (const correction of session.persistedCorrections || []) {
      if (!correction.correctionText) {
        errors.push(
          `Correction at turn ${correction.turnEstablished} has no correction text`,
        );
      }
    }

    for (const ref of session.anaphoricReferences || []) {
      if (ref.sourceTurn <= ref.targetTurn) {
        errors.push(
          `Anaphoric reference: sourceTurn (${ref.sourceTurn}) should be > targetTurn (${ref.targetTurn})`,
        );
      }
    }

    for (const callback of session.callbacks || []) {
      if (callback.sourceTurn <= callback.targetTurn) {
        errors.push(
          `Callback: sourceTurn (${callback.sourceTurn}) should be > targetTurn (${callback.targetTurn})`,
        );
      }
    }
  } catch (error) {
    errors.push(
      `Failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

async function validateAll() {
  const sessionsDir = join(__dirname, '..', 'data', 'sessions');
  const databases = ['tpch', 'saas'];
  const types = ['rci', 'irc', 'pta', 'dcs', 'sncj'];

  let total = 0;
  let valid = 0;
  const invalid: Array<{ file: string; errors: string[] }> = [];

  for (const db of databases) {
    for (const type of types) {
      const typeDir = join(sessionsDir, db, type);
      try {
        const files = await readdir(typeDir);
        for (const file of files.filter((f) => f.endsWith('.json'))) {
          total++;
          const result = await validateSession(join(typeDir, file));
          if (result.valid) {
            valid++;
            console.log(`✓ ${file}`);
          } else {
            invalid.push({
              file: `${db}/${type}/${file}`,
              errors: result.errors,
            });
            console.log(`✗ ${file}`);
            for (const error of result.errors) {
              console.log(`    - ${error}`);
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }
  }

  console.log(`\n=== Validation Summary ===`);
  console.log(`Total: ${total}`);
  console.log(`Valid: ${valid}`);
  console.log(`Invalid: ${total - valid}`);

  if (invalid.length > 0) {
    console.log('\nInvalid sessions:');
    for (const { file, errors } of invalid) {
      console.log(`  ${file}:`);
      for (const error of errors) {
        console.log(`    - ${error}`);
      }
    }
    process.exit(1);
  }
}

validateAll().catch(console.error);
