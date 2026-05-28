import nlp from 'compromise';
import { v4 as uuidv4 } from 'uuid';
import type { CompactionStrategy, StrategyOriginals } from '../strategy.js';
import { makeBoundaryIsOverflow } from '../strategy.js';
import type { ProcessInput } from '@qwery/agent-factory-sdk';

type EmbeddingFn = (
  texts: string[],
  opts?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array; dims: number[]; tolist: () => number[][] }>;

let embedPipeline: EmbeddingFn | null = null;
let embedPipelinePromise: Promise<EmbeddingFn> | null = null;

type TaggedSentence = {
  text: string;
  role: 'user' | 'assistant';
  isCorrection: boolean;
  index: number;
};

function isCorrectionMessage(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    'from now on',
    'for all our analyses',
    'for all subsequent',
    'for the rest of',
    'going forward',
    'when i say',
    'whenever i',
    'remember to',
    'make sure to',
  ];
  if (patterns.some((p) => lower.includes(p))) return true;
  if (/^always (use|exclude|include)/i.test(text.trim())) return true;
  if (/^never (use|include|show)/i.test(text.trim())) return true;
  if (/\b(always|never) .+ (not|instead of|rather than)/i.test(text)) return true;
  if (/^please (always|never)/i.test(text.trim())) return true;
  if (/^(from now on|for all|we should|we need to).*\b(exclude|only)\b/i.test(text)) return true;
  return false;
}

function extractTaggedSentences(messages: ProcessInput['messages']): TaggedSentence[] {
  const result: TaggedSentence[] = [];
  let index = 0;
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = extractTextFromMessage(msg);
    if (!text) continue;
    const sentences = splitSentences(text);
    for (const sentence of sentences) {
      const isCorrection = msg.role === 'user' && isCorrectionMessage(sentence);
      result.push({
        text: sentence,
        role: msg.role as 'user' | 'assistant',
        isCorrection,
        index: index++,
      });
    }
  }
  return result;
}

function extractTextFromMessage(msg: {
  role?: string;
  content?: { parts?: Array<{ type: string; text?: string }> } | string;
}): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts = msg.content?.parts;
  if (!parts) return '';
  return parts
    .filter(
      (p): p is { type: string; text: string } =>
        p.type === 'text' && typeof p.text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
}

function extractQueryFromMessages(messages: ProcessInput['messages']): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) return extractTextFromMessage(lastUser);

  // Benchmark does not persist user messages — fall back to the last
  // assistant message.  Its initial reasoning part typically paraphrases
  // the user's current question.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant) {
    const text = extractTextFromMessage(lastAssistant);
    return text.slice(0, 200);
  }

  return '';
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  try {
    const doc = nlp(text);
    const sents = doc.sentences().out('array') as string[];
    const result: string[] = [];
    for (const s of sents) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      // compromise misses paragraph breaks inside markdown tables;
      // split on double newlines to recover those boundaries
      const parts = trimmed.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
      result.push(...parts);
    }
    return result;
  } catch {
    const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const result: string[] = [];
    for (const p of parts) {
      const sub = p.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
      result.push(...sub);
    }
    return result;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function dotProductSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function selectTopK(scores: number[], k: number): number[] {
  if (scores.length <= k) {
    return Array.from({ length: scores.length }, (_, i) => i);
  }
  const indexed = scores.map((score, i) => ({ score, i }));
  indexed.sort((a, b) => b.score - a.score);
  const selected = indexed.slice(0, k).map((x) => x.i);
  selected.sort((a, b) => a - b);
  return selected;
}

async function getEmbeddingPipeline(): Promise<EmbeddingFn> {
  if (embedPipeline) return embedPipeline;
  if (embedPipelinePromise) return embedPipelinePromise;
  embedPipelinePromise = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      const modelId = process.env.RECOMP_MODEL || 'Xenova/bge-base-en-v1.5';
      embedPipeline = (await pipeline(
        'feature-extraction',
        modelId,
      )) as unknown as EmbeddingFn;
      return embedPipeline;
    } catch (err) {
      embedPipelinePromise = null;
      throw err;
    }
  })();
  return embedPipelinePromise;
}

async function findCurrentQuery(input: ProcessInput): Promise<string> {
  // In 4-zone mode the current query is embedded in the system message
  // by with4Zone — extract it directly rather than parsing the archive content.
  for (const msg of input.messages) {
    if (msg.role === 'system') {
      const text = extractTextFromMessage(msg);
      const match = text.match(/^\[CURRENT QUERY\]:\s*(.+?)\n\n/);
      if (match) return match[1]!;
    }
  }

  return extractQueryFromMessages(input.messages);
}

async function recompCompress(
  tagged: TaggedSentence[],
  query: string,
  topK: number,
): Promise<{ compressed: string; tokensBefore: number; tokensAfter: number }> {
  const text = tagged.map((s) => s.text).join(' ');
  const tokensBefore = estimateTokens(text);

  if (tagged.length === 0) {
    return { compressed: text, tokensBefore, tokensAfter: tokensBefore };
  }

  // Stage 1: structural corrections are always preserved
  const corrections = tagged.filter((s) => s.isCorrection);
  const candidates = tagged.filter((s) => !s.isCorrection);

  if (candidates.length === 0 || !query) {
    return { compressed: text, tokensBefore, tokensAfter: tokensBefore };
  }

  if (candidates.length <= Math.max(topK - corrections.length, 0)) {
    const allSelected = [...corrections, ...candidates]
      .sort((a, b) => a.index - b.index)
      .map((s) => s.text)
      .join(' ')
      .trim();
    return { compressed: allSelected, tokensBefore, tokensAfter: estimateTokens(allSelected) };
  }

  // Stage 2: embed candidates and score against query
  const pipe = await getEmbeddingPipeline();
  const allTexts = [query, ...candidates.map((s) => s.text)];
  const embeddings = await pipe(allTexts, { pooling: 'mean', normalize: false });
  const embList = embeddings.tolist();
  const queryEmb: number[] = embList[0] ?? [];
  const candidateEmbs: number[][] = embList.slice(1) as number[][];

  const useCosine = (process.env.RECOMP_SIMILARITY || 'cosine') !== 'dot';
  const simFn = useCosine ? cosineSimilarity : dotProductSimilarity;
  const scores = candidateEmbs.map((emb: number[], i: number) => {
    const sim = simFn(queryEmb, emb);
    const roleBonus = candidates[i]!.role === 'user' ? 0.3 : 0;
    return sim + roleBonus;
  });

  const selectedIndices = selectTopK(scores, Math.max(topK - corrections.length, 0));

  // Merge corrections + selected candidates, sort by original position
  const selectedCandidateIndices = new Set(selectedIndices.map((i) => candidates[i]!.index));
  const keptIndices = new Set([
    ...corrections.map((s) => s.index),
    ...selectedCandidateIndices,
  ]);

  const compressed = tagged
    .filter((s) => keptIndices.has(s.index))
    .sort((a, b) => a.index - b.index)
    .map((s) => s.text)
    .join(' ')
    .trim();
  const tokensAfter = estimateTokens(compressed);

  return { compressed, tokensBefore, tokensAfter };
}

export const recompExtractiveStrategy: CompactionStrategy = {
  name: 'recomp-extractive',

  factory: (ctx, originals: StrategyOriginals) => {
    getEmbeddingPipeline();
    return {
      isOverflow: makeBoundaryIsOverflow(ctx),

      process: async (input: ProcessInput) => {
        const topK = Number(process.env.RECOMP_K) || 10;

        const tagged = extractTaggedSentences(input.messages);
        if (tagged.length === 0) {
          const conversation = await input.repositories.conversation.findBySlug(
            input.conversationSlug,
          );
          if (conversation) {
            const emptyMsg = {
              id: uuidv4(),
              conversationId: conversation.id,
              role: 'assistant' as const,
              content: { parts: [{ type: 'text' as const, text: '' }] },
              metadata: { summary: true, type: 'compaction' as const, tokens: { input: 0, output: 0 } },
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: 'system',
              updatedBy: 'system',
            };
            await (input.repositories.message.create as any)(emptyMsg);
          }
          return 'continue' as const;
        }

        const query = await findCurrentQuery(input);

        let compressedText: string;
        let tokensBefore: number;
        let tokensAfter: number;

        try {
          const result = await recompCompress(tagged, query, topK);
          compressedText = result.compressed;
          tokensBefore = result.tokensBefore;
          tokensAfter = result.tokensAfter;
        } catch (err) {
          throw new Error(
            `RECOMP Extractive compression failed: ${err instanceof Error ? err.message : String(err)}\n` +
              'The ONNX model will be downloaded and cached on first run (~440MB).\n' +
              'Set RECOMP_MODEL to a different model ID (e.g. Xenova/all-MiniLM-L6-v2).\n' +
              'Set RECOMP_K to control sentences retained (default: 10).',
          );
        }

        if (compressedText) {
          const conversation = await input.repositories.conversation.findBySlug(
            input.conversationSlug,
          );
          if (conversation) {
            const compressionRatio =
              tokensBefore > 0 ? tokensAfter / tokensBefore : 0;
            const summaryText = [
              `Method: RECOMP Extractive`,
              `Tokens before: ${tokensBefore}`,
              `Tokens after: ${tokensAfter}`,
              `Compression ratio: ${(compressionRatio * 100).toFixed(1)}%`,
              `Query: ${query ? query.slice(0, 300) : '(none)'}`,
            ].join('\n');

            const message = {
              id: uuidv4(),
              conversationId: conversation.id,
              role: 'assistant' as const,
              content: {
                parts: [
                  { type: 'text' as const, text: compressedText },
                  { type: 'text' as const, text: summaryText },
                ],
              },
              metadata: {
                summary: true,
                type: 'compaction',
                recomp: {
                  tokensBefore,
                  tokensAfter,
                  compressionRatio,
                },
                tokens: {
                  input: tokensBefore,
                  output: tokensAfter,
                },
              },
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: 'system',
              updatedBy: 'system',
            };

            await (input.repositories.message.create as any)(message);
          }
        }

        return 'continue' as const;
      },

      prune: originals.prune,
    };
  },
};
