import { Message } from '../../entities';
import { RepositoryPort } from '../base-repository.port';
import { PaginationOptions, PaginatedResult } from '../../common';

export abstract class IMessageRepository extends RepositoryPort<
  Message,
  string
> {
  public abstract findByConversationId(
    conversationId: string,
  ): Promise<Message[]>;

  public abstract findByConversationIdPaginated(
    conversationId: string,
    options: PaginationOptions,
  ): Promise<PaginatedResult<Message>>;
}
