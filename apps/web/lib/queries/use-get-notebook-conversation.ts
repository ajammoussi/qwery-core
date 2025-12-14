import { useQuery } from '@tanstack/react-query';
import type { Conversation } from '@qwery/domain/entities';
import type { IConversationRepository } from '@qwery/domain/repositories';

/**
 * Find the conversation associated with a notebook
 * Notebooks use the title pattern "Notebook - {notebookId}" to identify their conversations
 */
export function useGetNotebookConversation(
  conversationRepository: IConversationRepository,
  notebookId: string | undefined,
  projectId: string | undefined,
) {
  return useQuery<Conversation | null>({
    queryKey: ['notebook-conversation', notebookId, projectId],
    queryFn: async () => {
      if (!notebookId || !projectId) {
        return null;
      }

      // Find all conversations for this project
      const conversations =
        await conversationRepository.findByProjectId(projectId);

      // Look for conversation with title matching this notebook
      const notebookTitle = `Notebook - ${notebookId}`;
      const matchingConversation = conversations.find(
        (conv) => conv.title === notebookTitle,
      );

      return matchingConversation || null;
    },
    enabled: !!notebookId && !!projectId,
    staleTime: 30 * 1000, // Cache for 30 seconds
  });
}
