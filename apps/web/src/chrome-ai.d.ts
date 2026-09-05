export {};

declare global {
  type ChromeLanguageModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

  interface ChromeLanguageModelPromptOptions {
    signal?: AbortSignal;
    responseConstraint?: object;
    omitResponseConstraintInput?: boolean;
  }

  interface ChromeLanguageModelSession {
    readonly contextUsage: number;
    readonly contextWindow: number;
    measureContextUsage(input: string, options?: ChromeLanguageModelPromptOptions): Promise<number>;
    prompt(input: string, options?: ChromeLanguageModelPromptOptions): Promise<string>;
    destroy(): void;
  }

  interface ChromeLanguageModelCreateOptions {
    signal?: AbortSignal;
    initialPrompts?: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
    expectedInputs?: readonly { type: 'text'; languages: readonly string[] }[];
    expectedOutputs?: readonly { type: 'text'; languages: readonly string[] }[];
    monitor?: (monitor: EventTarget) => void;
  }

  interface ChromeLanguageModelFactory {
    availability(options?: Pick<ChromeLanguageModelCreateOptions, 'expectedInputs' | 'expectedOutputs'>): Promise<ChromeLanguageModelAvailability>;
    create(options?: ChromeLanguageModelCreateOptions): Promise<ChromeLanguageModelSession>;
  }

  var LanguageModel: ChromeLanguageModelFactory | undefined;
}
