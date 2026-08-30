/**
 * Provider selection.
 *
 * `LLM_PROVIDER` picks explicitly. If it is unset, whichever key is present
 * wins, in the order Gemini → Groq → Anthropic — so dropping a single key into
 * the environment is enough to get running, which is what you want when the
 * person deploying this is not the person who wrote it.
 */

import { type LlmProvider, type ProviderId, LlmError } from './types.ts';
import { GeminiProvider } from './gemini.ts';
import { GroqProvider } from './groq.ts';
import { AnthropicProvider } from './anthropic.ts';

export * from './types.ts';
export { GeminiProvider, GroqProvider, AnthropicProvider };

const KEY_ENV: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const MODEL_ENV: Record<ProviderId, string> = {
  gemini: 'GEMINI_MODEL',
  groq: 'GROQ_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
};

const BASE_ENV: Record<ProviderId, string> = {
  gemini: 'GEMINI_BASE_URL',
  groq: 'GROQ_BASE_URL',
  anthropic: 'ANTHROPIC_BASE_URL',
};

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function configuredProviders(): ProviderId[] {
  return (Object.keys(KEY_ENV) as ProviderId[]).filter((id) => env(KEY_ENV[id]));
}

/** Which provider would be used, without constructing it. Safe for health checks. */
export function selectedProviderId(): ProviderId | null {
  const explicit = env('LLM_PROVIDER')?.toLowerCase() as ProviderId | undefined;
  if (explicit && explicit in KEY_ENV) return explicit;
  return configuredProviders()[0] ?? null;
}

export function createProvider(): LlmProvider {
  const id = selectedProviderId();

  if (!id) {
    throw new LlmError(
      'No LLM API key is configured. Set one of GEMINI_API_KEY (free at aistudio.google.com), ' +
      'GROQ_API_KEY (free at console.groq.com) or ANTHROPIC_API_KEY.',
      { provider: 'gemini', recoverable: false },
    );
  }

  const apiKey = env(KEY_ENV[id]);
  if (!apiKey) {
    const available = configuredProviders();
    throw new LlmError(
      `LLM_PROVIDER is set to "${id}" but ${KEY_ENV[id]} is empty.` +
      (available.length ? ` A key IS present for: ${available.join(', ')}.` : ''),
      { provider: id, recoverable: false },
    );
  }

  const opts = { apiKey, model: env(MODEL_ENV[id]), baseUrl: env(BASE_ENV[id]) };
  switch (id) {
    case 'gemini': return new GeminiProvider(opts);
    case 'groq': return new GroqProvider(opts);
    case 'anthropic': return new AnthropicProvider(opts);
  }
}
