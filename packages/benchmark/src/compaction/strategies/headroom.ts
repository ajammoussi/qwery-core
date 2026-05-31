import { compress } from 'headroom-ai';
import { v4 as uuidv4 } from 'uuid';
import type { CompactionStrategy, StrategyOriginals } from '../strategy.js';
import { makeBoundaryIsOverflow } from '../strategy.js';
import type { ProcessInput } from '@qwery/agent-factory-sdk';

function extractTextFromMessage(msg: {
  role?: string;
  content?: { parts?: Array<{ type: string; text?: string }> };
}): string {
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

function messagesToOpenAIFormat(
  messages: ProcessInput['messages'],
): Array<{ role: string; content: string }> {
  return messages.map((msg) => ({
    role: msg.role ?? 'user',
    content: extractTextFromMessage(msg),
  }));
}

function basicTruncationFallback(
  messages: Array<{ role: string; content: string }>,
): { text: string; tokensBefore: number; tokensAfter: number } {
  const fullText = messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join('\n\n');
  const estimatedTokens = Math.ceil(fullText.length / 3.6);
  const MAX_FALLBACK_TOKENS = 2000;
  if (estimatedTokens <= MAX_FALLBACK_TOKENS) {
    return {
      text: fullText,
      tokensBefore: estimatedTokens,
      tokensAfter: estimatedTokens,
    };
  }
  const ratio = MAX_FALLBACK_TOKENS / estimatedTokens;
  const truncateAt = Math.floor(fullText.length * ratio);
  const truncated = fullText.slice(0, truncateAt) + '\n\n[truncated]';
  return {
    text: truncated,
    tokensBefore: estimatedTokens,
    tokensAfter: MAX_FALLBACK_TOKENS,
  };
}

export const headroomStrategy: CompactionStrategy = {
  name: 'headroom',

  factory: (ctx, originals: StrategyOriginals) => ({
    isOverflow: makeBoundaryIsOverflow(ctx),

    process: async (input: ProcessInput) => {
      const baseUrl = process.env.HEADROOM_URL ?? 'http://localhost:8787';
      const model = process.env.HEADROOM_MODEL ?? 'gpt-4o';
      const openaiMessages = messagesToOpenAIFormat(input.messages);
      const useFallback = process.env.HEADROOM_FALLBACK !== 'false';

      let result;
      try {
        result = await compress(openaiMessages, {
          model,
          baseUrl,
          timeout: 600_000,
          fallback: useFallback,
        });
      } catch (err) {
        throw new Error(
          `Headroom compression failed: ${err instanceof Error ? err.message : String(err)}\n` +
            `Ensure the Headroom proxy is running at ${baseUrl}\n` +
            `  pip install "headroom-ai[proxy]"\n` +
            `  Or set HEADROOM_PYTHON to a Python env with headroom installed`,
        );
      }

      let compressedText: string;
      let tokensBefore: number;
      let tokensAfter: number;
      let compressionRatio: number;

      if (!result.compressed) {
        // Headroom proxy returned uncompressed (e.g. backend unreachable).
        // Fall back to basic truncation so compression still happens.
        const fallback = basicTruncationFallback(openaiMessages);
        compressedText = fallback.text;
        tokensBefore = fallback.tokensBefore;
        tokensAfter = fallback.tokensAfter;
        compressionRatio = tokensAfter / tokensBefore;
      } else {
        compressedText = result.messages
          .filter((m: { content?: string }) => typeof m.content === 'string')
          .map((m: { content: string }) => m.content)
          .filter(Boolean)
          .join('\n');
        tokensBefore = result.tokensBefore;
        tokensAfter = result.tokensAfter;
        compressionRatio = result.compressionRatio;
      }

      if (compressedText) {
        const conversation = await input.repositories.conversation.findBySlug(
          input.conversationSlug,
        );

        if (conversation) {
          const summaryText = [
            result.compressed ? `Method: Headroom (Compress)` : `Method: Fallback (Truncation)`,
            `Tokens before: ${tokensBefore}`,
            `Tokens after: ${tokensAfter}`,
            `Compression ratio: ${(compressionRatio * 100).toFixed(1)}%`,
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
              headroom: {
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
  }),
};
