import type { CompactionStrategy } from '../strategy.js';
import { makeBoundaryIsOverflow } from '../strategy.js';
import type { ProcessInput } from '@qwery/agent-factory-sdk';
import { ZoneContextManager } from '../../zone-architecture/zone-context-manager.js';
import {
  createZoneSegment,
  extractQueryFromMessages,
  extractTurnNumberFromMessages,
  extractTextFromMessage,
  isUserCorrection,
  createSimpleCompressionBackend,
} from '../../zone-architecture/zone-strategy-base.js';
import type { ZoneSegment } from '../../zone-architecture/types.js';
import { v4 as uuidv4 } from 'uuid';

const sessionZoneManagers = new Map<string, ZoneContextManager>();

export const entityStateStrategy: CompactionStrategy = {
  name: 'entity-state',
  factory: (ctx, originals) => {
    const isOverflow = makeBoundaryIsOverflow(ctx);

    const process: typeof originals.process = async (input) => {
      const query = extractQueryFromMessages(input.messages);
      const turnNumber = extractTurnNumberFromMessages(input.messages);

      let zoneManager = sessionZoneManagers.get(input.parentID);
      if (!zoneManager) {
        zoneManager = new ZoneContextManager({
          activeWindow: {
            enabled: true,
            maxTurns: 6,
          },
          compressedArchive: {
            enabled: true,
            maxSegments: 50,
            retrievalTopK: 3,
          },
        });
        sessionZoneManagers.set(input.parentID, zoneManager);
      }

      const entityStateTracker = zoneManager.getEntityStateTracker();
      const compressionBackend = createSimpleCompressionBackend(0.5);

      const messages = input.messages;
      const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
      const lastAssistantMessage = messages.filter((m) => m.role === 'assistant').pop();

      if (lastUserMessage) {
        const userContent = extractTextFromMessage(lastUserMessage);
        const isCorrection = isUserCorrection(lastUserMessage);

        const userSegment = createZoneSegment(userContent, 'active-window', {
          turnNumber,
          segmentType: isCorrection ? 'user_correction' : 'user_turn',
        });

        zoneManager.addToZoneC(userSegment);

        const extraction = entityStateTracker.extractFromText(userContent, isCorrection);
        entityStateTracker.addOpenThread(`User query at turn ${turnNumber}: ${userContent.substring(0, 100)}...`);
      }

      if (lastAssistantMessage) {
        const assistantContent = extractTextFromMessage(lastAssistantMessage);

        const assistantSegment = createZoneSegment(assistantContent, 'active-window', {
          turnNumber,
          segmentType: 'assistant_turn',
        });

        zoneManager.addToZoneC(assistantSegment);

        const extraction = entityStateTracker.extractFromText(assistantContent, false);
      }

      zoneManager.syncEntityStateToZoneB();

      const assembly = zoneManager.assembleContext(query);

      if (assembly.totalTokens > 0) {
        const summaryMessage = `Session state: ${zoneManager.getEntityStateTracker().toJSON()}\n\nContext assembled with ${assembly.totalTokens} tokens across zones.\n\nZone breakdown:\n- Frozen prefix: ${assembly.zoneBreakdown['frozen-prefix'].tokens} tokens\n- Entity state: ${assembly.zoneBreakdown['entity-state'].tokens} tokens\n- Active window: ${assembly.zoneBreakdown['active-window'].tokens} tokens\n- Compressed archive: ${assembly.zoneBreakdown['compressed-archive'].tokens} tokens`;

        try {
          const repositories = input.repositories as {
            message: {
              create: (data: {
                id: string;
                conversationId: string;
                role: 'assistant';
                content: { parts: Array<{ type: string; text: string }> };
                metadata: { summary: boolean; tokens?: { output: number } };
                createdAt: Date;
                updatedAt: Date;
                createdBy: string;
                updatedBy: string;
              }) => Promise<unknown>;
            };
          };

          if (repositories?.message) {
            await repositories.message.create({
              id: uuidv4(),
              conversationId: input.parentID,
              role: 'assistant',
              content: {
                parts: [{ type: 'text', text: summaryMessage }],
              },
              metadata: {
                summary: true,
                tokens: { output: Math.ceil(summaryMessage.length / 4) },
              },
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: 'system',
              updatedBy: 'system',
            });
          }
        } catch (error) {
          console.warn('Failed to persist entity state summary:', error);
        }
      }

      return 'continue';
    };

    return {
      isOverflow,
      process,
    };
  },
};
