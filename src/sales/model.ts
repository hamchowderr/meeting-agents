import { createOpenAI } from '@ai-sdk/openai'
import type { MastraModelConfig } from '@mastra/core/llm'

/**
 * The model behind the sales-call agent, and the one switch between real and mocked:
 *
 * - Default: Claude Haiku 5.5 through Mastra's model router (`ANTHROPIC_API_KEY`),
 *   or `SALES_CALL_MODEL` to try another.
 * - `USE_AIMOCK=true`: AIMock (`@copilotkit/aimock`, `npm run aimock` on :4010), an
 *   OpenAI-compatible mock that answers from `fixtures/*.json`, so tests and demos
 *   run the real agent with no key and no network. `AIMOCK_URL`, `AIMOCK_MODEL` override.
 */
export function salesCallModel(): MastraModelConfig {
  if (process.env.USE_AIMOCK === 'true') {
    const base = (process.env.AIMOCK_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '')
    return createOpenAI({ baseURL: `${base}/v1`, apiKey: 'mock' }).chat(process.env.AIMOCK_MODEL ?? 'gpt-4o-mini')
  }
  return (process.env.SALES_CALL_MODEL || 'anthropic/claude-haiku-5-5') as MastraModelConfig
}
