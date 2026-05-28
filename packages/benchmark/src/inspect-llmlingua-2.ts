/**
 * Inspect what the llmlingua-2 strategy does to a conversation, without running
 * the agent or the DB. Loads a benchmark result/session JSON, runs the exact same
 * classification + compressor the strategy uses, and prints a before/after diff
 * per part so you can judge compression quality by eye.
 *
 * Usage:
 *   pnpm inspect:llmlingua-2 [path/to/result.json] [--only tool|llm|user] [--full]
 *
 * Defaults to the baseline saas-dcs-001 result (which carries full message parts).
 * Env: LLMLINGUA_MODEL, LLMLINGUA_RATE_TOOL/LLM/USER, LLMLINGUA_DEVICE, INSPECT_MAXCHARS.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { __llmlingua_internals__ as L } from './compaction/strategies/llmlingua-2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Category = 'tool' | 'llm' | 'user';
type Item = {
  turn: number;
  role: string;
  type: string;
  category: Category;
  rate: number;
  text: string;
};

const MAXCHARS = Number(process.env.INSPECT_MAXCHARS ?? '240');

function snip(text: string, full: boolean): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (full || oneLine.length <= MAXCHARS) return oneLine;
  return `${oneLine.slice(0, MAXCHARS)}… (+${oneLine.length - MAXCHARS} chars)`;
}

function collectItems(data: {
  turns?: Array<{
    turnNumber: number;
    userMessage?: string;
    assistantMessages?: Array<{ parts?: Array<Record<string, unknown>> }>;
  }>;
}): Item[] {
  const items: Item[] = [];
  for (const turn of data.turns ?? []) {
    if (typeof turn.userMessage === 'string' && turn.userMessage.length > 0) {
      items.push({
        turn: turn.turnNumber,
        role: 'user',
        type: 'text',
        category: 'user',
        rate: L.rates.user,
        text: turn.userMessage,
      });
    }
    for (const am of turn.assistantMessages ?? []) {
      for (const part of am.parts ?? []) {
        const output = L.readToolOutput(part);
        if (output !== undefined && output !== null && output !== '') {
          items.push({
            turn: turn.turnNumber,
            role: 'assistant',
            type: String(part.type ?? ''),
            category: 'tool',
            rate: L.rates.tool,
            text: typeof output === 'string' ? output : JSON.stringify(output),
          });
          continue;
        }
        const text = L.readTextLike(part);
        if (text) {
          items.push({
            turn: turn.turnNumber,
            role: 'assistant',
            type: String(part.type ?? ''),
            category: 'llm',
            rate: L.rates.llm,
            text,
          });
        }
      }
    }
  }
  return items;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const full = args.includes('--full');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] as Category) : undefined;
  const pathArg = args.find((a) => !a.startsWith('--') && a !== only);

  const sourcePath =
    pathArg ??
    join(
      __dirname,
      '..',
      'data',
      'results',
      'baseline-no-compression',
      'saas',
      'dcs',
      'saas-dcs-001.json',
    );

  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch {
    console.error(`Could not read conversation JSON: ${sourcePath}`);
    console.error(
      'Pass a path explicitly, e.g.\n  pnpm inspect:llmlingua-2 data/results/baseline-no-compression/saas/dcs/saas-dcs-001.json',
    );
    process.exit(1);
  }

  const data = JSON.parse(raw);
  let items = collectItems(data);
  if (only) items = items.filter((i) => i.category === only);

  console.log(`Source: ${sourcePath}`);
  console.log(
    `Model: ${L.model} (device=${L.device})  rates: tool=${L.rates.tool} llm=${L.rates.llm} user=${L.rates.user}  minTokens=${L.minTokens}`,
  );
  console.log(`Compressible parts found: ${items.length}\n`);
  console.log('Loading model (first run downloads weights)…\n');

  const compressor = await L.getCompressor();

  const totals: Record<Category, { parts: number; before: number; after: number }> = {
    tool: { parts: 0, before: 0, after: 0 },
    llm: { parts: 0, before: 0, after: 0 },
    user: { parts: 0, before: 0, after: 0 },
  };
  let skippedShort = 0;
  let failed = 0;

  for (const item of items) {
    if (L.approxTokens(item.text) < L.minTokens) {
      skippedShort += 1;
      continue;
    }
    const before = L.countTokens(item.text);
    if (before < L.minTokens) {
      skippedShort += 1;
      continue;
    }

    let compressed: string;
    try {
      compressed = await L.compressText(compressor, item.text, item.rate);
    } catch (err) {
      failed += 1;
      console.log(
        `── turn ${item.turn} · ${item.role}/${item.type} · ${item.category} @ rate ${item.rate}`,
      );
      console.log(
        `   FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log(`   TEXT : ${snip(item.text, full)}\n`);
      continue;
    }

    const after = L.countTokens(compressed);
    const bucket = totals[item.category];
    bucket.parts += 1;
    bucket.before += before;
    bucket.after += after;

    const pct = ((after / Math.max(1, before)) * 100).toFixed(0);
    console.log(
      `── turn ${item.turn} · ${item.role}/${item.type} · ${item.category} @ rate ${item.rate} · ${before}→${after} tok (${pct}% kept)`,
    );
    console.log(`   BEFORE: ${snip(item.text, full)}`);
    console.log(`   AFTER : ${snip(compressed, full)}\n`);
  }

  const sum = (k: 'parts' | 'before' | 'after') =>
    totals.tool[k] + totals.llm[k] + totals.user[k];
  const before = sum('before');
  const after = sum('after');
  const saved = before - after;

  console.log('═══ Totals ═══');
  for (const cat of ['tool', 'llm', 'user'] as const) {
    const t = totals[cat];
    if (t.parts === 0) continue;
    console.log(
      `  ${cat.padEnd(5)}: ${t.parts} parts, ${t.before}→${t.after} tok ` +
        `(${((t.after / Math.max(1, t.before)) * 100).toFixed(1)}% kept)`,
    );
  }
  console.log(
    `  TOTAL: ${sum('parts')} parts, ${before}→${after} tok, saved ${saved} ` +
      `(${((after / Math.max(1, before)) * 100).toFixed(1)}% kept on touched parts)`,
  );
  if (skippedShort > 0) console.log(`  skipped (too short): ${skippedShort}`);
  if (failed > 0) console.log(`  failed compress(): ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
