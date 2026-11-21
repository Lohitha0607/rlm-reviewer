// Talk to the model. Tests plug in a fake that implements the same interface.

import OpenAI, { APIError } from "openai";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Usage } from "./types";

export type Message = ChatCompletionMessageParam;
export type Tool = ChatCompletionTool;

export interface ChatModel {
  complete(messages: Message[], tools?: Tool[]): Promise<ChatCompletionMessage>;
  usage: Usage;
}

const RETRY_STATUS = new Set([429, 500, 502, 503]);

/** An OpenAI-compatible endpoint (OpenRouter by default). */
export class OpenAIChatModel implements ChatModel {
  usage: Usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  private client: OpenAI;

  constructor(
    private model: string,
    apiKey = process.env.OPENROUTER_API_KEY,
    baseURL = "https://openrouter.ai/api/v1",
  ) {
    if (!apiKey) throw new Error("Set OPENROUTER_API_KEY (or pass an API key).");
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async complete(messages: Message[], tools?: Tool[]): Promise<ChatCompletionMessage> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          ...(tools && tools.length ? { tools } : {}),
        });
        this.usage.modelCalls += 1;
        this.usage.inputTokens += response.usage?.prompt_tokens ?? 0;
        this.usage.outputTokens += response.usage?.completion_tokens ?? 0;
        const message = response.choices[0]?.message;
        if (!message) throw new Error("The model returned no message.");
        return message;
      } catch (error) {
        const retryable = error instanceof APIError && RETRY_STATUS.has(error.status ?? 0);
        if (!retryable || attempt >= 5) throw error;
        await Bun.sleep(Math.min(60_000, 5_000 * 2 ** attempt));
      }
    }
  }
}
