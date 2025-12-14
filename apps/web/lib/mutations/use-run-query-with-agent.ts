import { useMutation } from '@tanstack/react-query';

import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { useAgents } from '~/lib/hooks/use-agents';

type RunQueryWithAgentPayload = {
  cellId: number;
  query: string;
  datasourceId: string;
  datasourceRepository: IDatasourceRepository;
  projectId: string;
  userId: string;
  notebookId?: string;
};

type NotebookPromptResponse = {
  sqlQuery: string | null;
  hasSql: boolean;
  conversationSlug: string;
  needSQL?: boolean;
  shouldPaste?: boolean;
};

export function useRunQueryWithAgent(
  onSuccess: (
    result: NotebookPromptResponse,
    cellId: number,
    datasourceId: string,
  ) => void,
  onError: (error: Error, cellId: number, query: string) => void,
) {
  const { runNotebookPromptWithAgent } = useAgents();

  return useMutation({
    mutationFn: async (
      payload: RunQueryWithAgentPayload,
    ): Promise<NotebookPromptResponse> => {
      const {
        query,
        datasourceId,
        datasourceRepository,
        projectId,
        userId,
        notebookId,
      } = payload;

      const result = await runNotebookPromptWithAgent(
        datasourceRepository,
        query,
        datasourceId,
        projectId,
        userId,
        notebookId,
      );

      return result;
    },
    onSuccess: (result, variables) => {
      onSuccess(result, variables.cellId, variables.datasourceId);
    },
    onError: (error, variables) => {
      onError(
        error instanceof Error ? error : new Error('Unknown error'),
        variables.cellId,
        variables.query,
      );
    },
  });
}
