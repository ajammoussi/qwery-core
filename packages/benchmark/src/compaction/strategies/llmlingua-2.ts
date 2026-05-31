import { LLMLingua2 } from '@atjsh/llmlingua-2';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import type { MessageContentPart } from '@qwery/agent-factory-sdk/llm';
import { Provider } from '@qwery/agent-factory-sdk/llm';
import { MessagePersistenceService } from '@qwery/agent-factory-sdk';
import { MessageRole } from '@qwery/domain/entities';
import { v4 as uuidv4 } from 'uuid';
import type { CompactionStrategy } from '../strategy.js';
import { makeBoundaryIsOverflow } from '../strategy.js';

// XLM-RoBERTa-large: 514 position embeddings (vs BERT's 512) so the library's
// own chunker — which rounds chunks up to 511 tokens + 2 special = 513 — never
// overflows. Larger model also makes more discriminating keep/drop choices.
// 2.24 GB on first download; cached afterwards. Override with LLMLINGUA_MODEL.
const LLMLINGUA_MODEL =
  process.env.LLMLINGUA_MODEL ??
  'atjsh/llmlingua-2-js-xlm-roberta-large-meetingbank';

// Rate semantics per @atjsh/llmlingua-2 (CompressPromptOptions.rate):
//   "Float between 0 and 1 indicating the rate of compression.
//    0.1 means 10% of the original tokens will be kept."
// Higher rate = lighter compression = more content retained.
const LLMLINGUA_RATE_TOOL = Number(process.env.LLMLINGUA_RATE_TOOL ?? '0.5');
const LLMLINGUA_RATE_LLM = Number(process.env.LLMLINGUA_RATE_LLM ?? '0.8');
const LLMLINGUA_RATE_USER = Number(process.env.LLMLINGUA_RATE_USER ?? '0.85');
const MIN_TOKENS_TO_COMPRESS = Number(
  process.env.LLMLINGUA_MIN_TOKENS ?? '32',
);

// transformers.js 'auto' tries CUDA first on Node, which logs an ONNX provider
// error on CPU-only boxes (missing libcublasLt). Default to 'cpu' for portability;
// set LLMLINGUA_DEVICE=auto|cuda|webgpu to opt into GPU on machines that have it.
type TransformerDevice = 'cpu' | 'auto' | 'cuda' | 'webgpu' | 'wasm';
const LLMLINGUA_DEVICE = (process.env.LLMLINGUA_DEVICE ??
  'cpu') as TransformerDevice;

let oaiTokenizer: Tiktoken | null = null;
const getTokenizer = (): Tiktoken =>
  (oaiTokenizer ??= new Tiktoken(o200k_base));

type Compressor = Awaited<
  ReturnType<typeof LLMLingua2.WithXLMRoBERTa>
>['promptCompressor'];

async function compressText(
  compressor: Compressor,
  text: string,
  rate: number,
): Promise<string> {
  return compressor.compress(text, { rate, forceReserveDigit: true });
}

let compressorPromise: Promise<Compressor> | null = null;
const getCompressor = (): Promise<Compressor> =>
  (compressorPromise ??= LLMLingua2.WithXLMRoBERTa(LLMLINGUA_MODEL, {
    transformerJSConfig: { device: LLMLINGUA_DEVICE, dtype: 'fp32' },
    oaiTokenizer: getTokenizer(),
    // Required for XLM-RoBERTa-large per the package docstring — its weights
    // ship as separate .data files alongside the ONNX graph.
    modelSpecificOptions: { use_external_data_format: true },
  }).then((r) => r.promptCompressor));

function countTokens(text: string): number {
  return getTokenizer().encode(text).length;
}

// Cheap upper-bound estimate (mirrors session-compaction.ts:53-58) used to skip
// the BPE pass on text that's obviously shorter than the compression threshold.
function approxTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 3.6);
}

/**
 * Tool parts in this codebase live in two shapes:
 *  - `{ type: 'tool', state: { output, ... } }` (production agent-factory format)
 *  - `{ type: 'tool-<name>', output, ... }`     (UI-message style; what the benchmark JSONs show)
 * The `input` field (which carries SQL queries) is never touched.
 */
function readToolOutput(part: Record<string, unknown>): unknown | undefined {
  const type = String(part.type ?? '');
  if (type === 'tool') {
    const state = part.state;
    if (typeof state === 'object' && state !== null && 'output' in state) {
      return (state as { output?: unknown }).output;
    }
    return undefined;
  }
  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    return part.output;
  }
  return undefined;
}

function writeToolOutput(
  part: Record<string, unknown>,
  newOutput: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...part, compactedAt: Date.now() };
  const type = String(part.type ?? '');
  if (type === 'tool') {
    const state = part.state;
    if (typeof state === 'object' && state !== null) {
      next.state = { ...(state as Record<string, unknown>), output: newOutput };
    }
    return next;
  }
  next.output = newOutput;
  return next;
}

const TEXT_LIKE_TYPES = new Set(['text', 'reasoning']);

function readTextLike(part: Record<string, unknown>): string | undefined {
  const type = String(part.type ?? '');
  if (!TEXT_LIKE_TYPES.has(type)) return undefined;
  return typeof part.text === 'string' ? part.text : undefined;
}

function writeTextLike(
  part: Record<string, unknown>,
  newText: string,
): Record<string, unknown> {
  return { ...part, text: newText, compactedAt: Date.now() };
}

function isAlreadyCompacted(part: Record<string, unknown>): boolean {
  if (part.compactedAt) return true;
  const state = part.state;
  if (typeof state === 'object' && state !== null) {
    const time = (state as { time?: { compacted?: unknown } }).time;
    if (time && typeof time === 'object' && 'compacted' in time) return true;
  }
  return false;
}

type CompressedBucket = {
  parts: number;
  before: number;
  after: number;
};

function emptyBucket(): CompressedBucket {
  return { parts: 0, before: 0, after: 0 };
}

export const llmlingua2Strategy: CompactionStrategy = {
  name: 'llmlingua-2',
  factory: (ctx) => ({
    isOverflow: makeBoundaryIsOverflow(ctx),

    process: async (input) => {
      // Protect everything from the current user turn onwards (mirrors prune()
      // at packages/agent-factory-sdk/src/agents/session-compaction.ts:170-194).
      const userIndices = input.messages
        .map((m, i) => (m.role === MessageRole.USER ? i : -1))
        .filter((i) => i >= 0);
      const protectedStart =
        userIndices.length >= 1
          ? userIndices[userIndices.length - 1]!
          : input.messages.length;

      const compressor = await getCompressor();

      const buckets = {
        tool: emptyBucket(),
        llm: emptyBucket(),
        user: emptyBucket(),
      };

      let failures = 0;
      const compressOnce = async (
        text: string,
        rate: number,
      ): Promise<{ compressed: string; before: number; after: number } | null> => {
        if (approxTokens(text) < MIN_TOKENS_TO_COMPRESS) return null;
        const before = countTokens(text);
        if (before < MIN_TOKENS_TO_COMPRESS) return null;
        try {
          const compressed = await compressText(compressor, text, rate);
          return { compressed, before, after: countTokens(compressed) };
        } catch (err) {
          failures += 1;
          console.warn(
            `[llmlingua-2] compress() failed (rate=${rate}, ~${before} tok): ` +
              `${err instanceof Error ? err.message : String(err)}; ` +
              `head="${text.slice(0, 80).replace(/\n/g, ' ')}…"`,
          );
          return null;
        }
      };

      const pendingUpdates: Array<Parameters<typeof input.repositories.message.update>[0]> = [];

      for (let mi = 0; mi < protectedStart; mi++) {
        const message = input.messages[mi];
        if (!message) continue;

        const meta = message.metadata as { summary?: boolean } | undefined;
        if (meta?.summary) continue;

        const content = message.content as
          | { parts?: MessageContentPart[] }
          | undefined;
        const parts = content?.parts ?? [];
        if (parts.length === 0) continue;

        const isUserMessage = message.role === MessageRole.USER;
        let mutated = false;
        const nextParts: MessageContentPart[] = parts.slice();

        for (let pi = 0; pi < nextParts.length; pi++) {
          const part = nextParts[pi] as Record<string, unknown>;
          if (!part || typeof part !== 'object') continue;
          if (isAlreadyCompacted(part)) continue;

          // Tool output → aggressive compression. `input` (SQL) stays as-is.
          const output = readToolOutput(part);
          if (output !== undefined && output !== null && output !== '') {
            const outputStr =
              typeof output === 'string' ? output : JSON.stringify(output);
            const result = await compressOnce(outputStr, LLMLINGUA_RATE_TOOL);
            if (!result || result.after >= result.before) continue;
            buckets.tool.parts += 1;
            buckets.tool.before += result.before;
            buckets.tool.after += result.after;
            nextParts[pi] = writeToolOutput(
              part,
              result.compressed,
            ) as MessageContentPart;
            mutated = true;
            continue;
          }

          // text / reasoning → lighter rate; user-message text gets the lightest
          // so callback phrasing ("Note that number for me") mostly survives.
          const textContent = readTextLike(part);
          if (textContent) {
            const rate = isUserMessage
              ? LLMLINGUA_RATE_USER
              : LLMLINGUA_RATE_LLM;
            const result = await compressOnce(textContent, rate);
            if (!result || result.after >= result.before) continue;
            const bucket = isUserMessage ? buckets.user : buckets.llm;
            bucket.parts += 1;
            bucket.before += result.before;
            bucket.after += result.after;
            nextParts[pi] = writeTextLike(
              part,
              result.compressed,
            ) as MessageContentPart;
            mutated = true;
          }
        }

        if (mutated) {
          pendingUpdates.push({
            ...message,
            content: { ...content, parts: nextParts } as typeof message.content,
            updatedAt: new Date(),
            updatedBy: message.updatedBy ?? 'system',
          });
        }
      }

      const totalParts = buckets.tool.parts + buckets.llm.parts + buckets.user.parts;
      if (totalParts === 0) {
        if (failures > 0) {
          console.warn(
            `[llmlingua-2] no parts compressed (${failures} compress() calls failed).`,
          );
        }
        return 'continue';
      }

      const updateResults = await Promise.allSettled(
        pendingUpdates.map((u) => input.repositories.message.update(u)),
      );
      for (const r of updateResults) {
        if (r.status === 'rejected') {
          const err = r.reason;
          if (err instanceof Error && err.message.includes('not found')) {
            console.warn(
              `[llmlingua-2] skipping update — message not found in repository (id may be synthetic): ${err.message}`,
            );
          } else {
            throw err;
          }
        }
      }

      const totalBefore =
        buckets.tool.before + buckets.llm.before + buckets.user.before;
      const totalAfter =
        buckets.tool.after + buckets.llm.after + buckets.user.after;

      // Write a marker summary message so runner.ts:detectCompactionEvent picks
      // up the event cleanly. Hidden from the agent; persists metrics for the
      // benchmark report.
      const lastUser = input.messages.findLast(
        (m) => m.id === input.parentID,
      );
      const userMeta = lastUser?.metadata as
        | { model?: { providerID: string; modelID: string } }
        | undefined;
      const modelStr = userMeta?.model
        ? `${userMeta.model.providerID}/${userMeta.model.modelID}`
        : undefined;
      const model = modelStr
        ? Provider.getModelFromString(modelStr)
        : Provider.getDefaultModel();

      const persistence = new MessagePersistenceService(
        input.repositories.message,
        input.repositories.conversation,
        input.conversationSlug,
      );

      // Absolute tokens removed from the conversation content. The harness turns
      // this into a meaningful ratio against the real prompt size it captured
      // (preCompactionTokens): post = pre - tokensSaved.
      const tokensSaved = totalBefore - totalAfter;
      const partsRatio = totalAfter / Math.max(1, totalBefore);
      const summaryText =
        `[llmlingua-2] compressed parts — tool:${buckets.tool.parts} ` +
        `llm:${buckets.llm.parts} user:${buckets.user.parts}` +
        (failures > 0 ? ` (skipped ${failures} on error)` : '') +
        `; saved ${tokensSaved} tokens (${totalBefore} → ${totalAfter}, ` +
        `${(partsRatio * 100).toFixed(1)}% retained on touched parts).`;

      await persistence.persistMessages(
        [
          {
            id: uuidv4(),
            role: 'assistant',
            parts: [{ type: 'text', text: summaryText }],
            metadata: {
              hidden: true,
              summary: true,
              finish: 'stop',
              parentId: input.parentID,
              compactionTokensSaved: tokensSaved,
              llmlingua2: {
                model: LLMLINGUA_MODEL,
                rates: {
                  tool: LLMLINGUA_RATE_TOOL,
                  llm: LLMLINGUA_RATE_LLM,
                  user: LLMLINGUA_RATE_USER,
                },
                buckets,
                failures,
                originalTokens: totalBefore,
                compressedTokens: totalAfter,
                tokensSaved,
                partsRatio,
              },
              tokens: {
                input: 0,
                output: countTokens(summaryText),
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
            },
          },
        ],
        undefined,
        {
          defaultMetadata: {
            agent: 'compaction',
            model: { modelID: model.id, providerID: model.providerID },
          },
        },
      );

      return 'continue';
    },
  }),
};

/**
 * Internals exposed for the inspection script (src/inspect-llmlingua-2.ts) so it
 * runs the exact same classification, rates and compressor the strategy uses.
 */
export const __llmlingua_internals__ = {
  model: LLMLINGUA_MODEL,
  device: LLMLINGUA_DEVICE,
  rates: {
    tool: LLMLINGUA_RATE_TOOL,
    llm: LLMLINGUA_RATE_LLM,
    user: LLMLINGUA_RATE_USER,
  },
  minTokens: MIN_TOKENS_TO_COMPRESS,
  getCompressor,
  compressText,
  countTokens,
  approxTokens,
  readToolOutput,
  readTextLike,
};
