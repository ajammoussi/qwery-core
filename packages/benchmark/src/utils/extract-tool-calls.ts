import type { MessagePartDetail, ToolCallResult } from '../types.js';

export function extractToolCallsFromParts(
  parts: MessagePartDetail[],
): ToolCallResult[] {
  const toolCalls: ToolCallResult[] = [];

  for (const part of parts) {
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolPart = part as {
        type: string;
        toolCallId?: string;
        toolName?: string;
        input?: Record<string, unknown>;
        output?: unknown;
        errorText?: string;
        state?: string;
        isError?: boolean;
      };

      const existingCall = toolCalls.find(
        (tc) => tc.toolCallId === toolPart.toolCallId,
      );

      if (existingCall) {
        if (toolPart.output !== undefined) {
          existingCall.toolOutput = toolPart.output;
          existingCall.success = !toolPart.isError;
        }
        if (toolPart.errorText) {
          existingCall.error = toolPart.errorText;
          existingCall.success = false;
        }
      } else {
        const inferredName =
          toolPart.toolName ??
          (typeof toolPart.type === 'string' && toolPart.type.startsWith('tool-')
            ? toolPart.type.slice(5)
            : undefined);
        if (inferredName) {
          toolCalls.push({
            toolName: inferredName,
            toolCallId: toolPart.toolCallId,
            toolInput: toolPart.input ?? {},
            toolOutput: toolPart.output,
            executionTimeMs: 0,
            success:
              toolPart.state === 'output-available' ||
              (toolPart.output !== undefined && !toolPart.isError),
            error: toolPart.errorText,
          });
        }
      }
    }
  }

  return toolCalls;
}
