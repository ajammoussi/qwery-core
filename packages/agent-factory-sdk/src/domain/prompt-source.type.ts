/**
 * Prompt source type to differentiate between prompts coming from
 * notebook cells (inline) vs chat interface
 */
export const PROMPT_SOURCE = {
  INLINE: 'inline',
  CHAT: 'chat',
} as const;

export type PromptSource = (typeof PROMPT_SOURCE)[keyof typeof PROMPT_SOURCE];
