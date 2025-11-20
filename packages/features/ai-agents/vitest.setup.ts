import { vi } from 'vitest';

vi.mock('@mlc-ai/web-llm', () => {
  type InitProgressCallback = (progress: {
    progress: number;
    text: string;
  }) => void;

  class MockChatCompletions {
    async create({
      messages,
    }: {
      messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }>;
      stream?: boolean;
      temperature?: number;
    }) {
      const lastUserMessage =
        [...messages].reverse().find((msg) => msg.role === 'user') ||
        messages[messages.length - 1];

      const content = `Mock response: ${lastUserMessage?.content || 'Hello from mock model.'}`;

      return {
        choices: [
          {
            message: {
              content,
              tool_calls: [],
            },
          },
        ],
      };
    }
  }

  class MockChat {
    completions = new MockChatCompletions();
  }

  class MockMLCEngine {
    chat = new MockChat();
    private progressCallback?: InitProgressCallback;

    setInitProgressCallback(callback: InitProgressCallback) {
      this.progressCallback = callback;
    }

    async reload(model: string) {
      this.progressCallback?.({
        progress: 0.25,
        text: `Downloading ${model}`,
      });

      this.progressCallback?.({
        progress: 1,
        text: `${model} ready`,
      });
    }
  }

  return {
    MLCEngine: MockMLCEngine,
  };
});
