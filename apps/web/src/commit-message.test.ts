import { describe, expect, it, vi } from 'vitest';
import { ChromeCommitMessageGenerator, CommitMessageUnavailableError } from './commit-message.js';

function session(options: { contextWindow?: number; prompt?: (input: string, options?: ChromeLanguageModelPromptOptions) => string | Promise<string> } = {}): ChromeLanguageModelSession {
  return {
    contextUsage: 0,
    contextWindow: options.contextWindow ?? 20_000,
    measureContextUsage: async (input) => input.length,
    prompt: async (input, promptOptions) => {
      if (promptOptions?.signal?.aborted) throw promptOptions.signal.reason;
      return options.prompt?.(input, promptOptions) ?? JSON.stringify({ type: 'docs', scope: 'editor', subject: 'summarize saved changes', body: 'Describe the saved document changes.' });
    },
    destroy: vi.fn(),
  };
}

function factory(create: () => ChromeLanguageModelSession, availability: ChromeLanguageModelAvailability = 'available'): ChromeLanguageModelFactory {
  return { availability: vi.fn(async () => availability), create: vi.fn(async () => create()) };
}

describe('ChromeCommitMessageGenerator', () => {
  it('reports unavailable devices without creating a session', async () => {
    const model = factory(() => session(), 'unavailable');
    await expect(new ChromeCommitMessageGenerator(model).prepare()).rejects.toBeInstanceOf(CommitMessageUnavailableError);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('reports model download progress and returns validated structured output', async () => {
    const progress: Array<{ phase: string; loaded?: number }> = [];
    const model: ChromeLanguageModelFactory = {
      availability: vi.fn(async (): Promise<ChromeLanguageModelAvailability> => 'downloadable'),
      create: vi.fn(async (options) => {
        const monitor = new EventTarget();
        options?.monitor?.(monitor);
        const event = new Event('downloadprogress') as Event & { loaded: number };
        Object.defineProperty(event, 'loaded', { value: 0.75 });
        monitor.dispatchEvent(event);
        return session();
      }),
    };
    const prepared = await new ChromeCommitMessageGenerator(model).prepare({ onProgress: (value) => progress.push(value) });
    await expect(prepared.generate('diff --git a/a.md b/a.md\n+New')).resolves.toEqual({
      subject: 'docs(editor): summarize saved changes',
      body: 'Describe the saved document changes.',
    });
    expect(model.create).toHaveBeenCalledOnce();
    expect(progress).toContainEqual({ phase: 'downloading', message: 'Chrome is starting the on-device AI model download' });
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'downloading', loaded: 0.75 }));
    prepared.destroy();
  });

  it('chunks oversized diffs and combines their summaries', async () => {
    let prompts = 0;
    const model = factory(() => session({
      contextWindow: 900,
      prompt(input) {
        prompts += 1;
        if (input.startsWith('Summarize')) return JSON.stringify({ summary: 'Update one document section.' });
        return JSON.stringify({ type: 'docs', scope: '', subject: 'update document sections', body: '' });
      },
    }));
    const prepared = await new ChromeCommitMessageGenerator(model).prepare();
    const diff = Array.from({ length: 4 }, (_, index) => `diff --git a/${index}.md b/${index}.md\n${`+Changed line ${index}\n`.repeat(18)}`).join('\n');
    await expect(prepared.generate(diff)).resolves.toEqual({ subject: 'docs: update document sections', body: '' });
    expect(prompts).toBeGreaterThan(1);
  });

  it('hierarchically reduces summaries that do not fit the final prompt', async () => {
    let reductionPrompts = 0;
    const model = factory(() => session({
      contextWindow: 1_000,
      prompt(input) {
        if (input.startsWith('Summarize')) {
          if (input.includes('PARTIAL SUMMARIES')) { reductionPrompts += 1; return JSON.stringify({ summary: 'Condensed related edits.' }); }
          return JSON.stringify({ summary: `Detailed section summary ${'x'.repeat(95)}` });
        }
        return JSON.stringify({ type: 'refactor', scope: 'git', subject: 'combine candidate summaries', body: '' });
      },
    }));
    const prepared = await new ChromeCommitMessageGenerator(model).prepare();
    const diff = Array.from({ length: 6 }, (_, index) => `diff --git a/${index}.ts b/${index}.ts\n${`+const value${index} = true;\n`.repeat(8)}`).join('\n');
    await expect(prepared.generate(diff)).resolves.toEqual({ subject: 'refactor(git): combine candidate summaries', body: '' });
    expect(reductionPrompts).toBeGreaterThan(0);
  });

  it('rejects invalid model output and honors cancellation', async () => {
    const invalid = await new ChromeCommitMessageGenerator(factory(() => session({ prompt: () => '{"type":"made-up"}' }))).prepare();
    await expect(invalid.generate('diff --git a/a b/a\n+x')).rejects.toThrow('invalid commit message');

    const controller = new AbortController();
    const cancelled = await new ChromeCommitMessageGenerator(factory(() => session({ contextWindow: 100 }))).prepare();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(cancelled.generate(`diff --git a/a b/a\n${'+x\n'.repeat(200)}`, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
