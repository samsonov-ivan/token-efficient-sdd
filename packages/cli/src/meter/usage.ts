export type Entry = Record<string, unknown>;

export function record(value: unknown): Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected object');
  return value as Entry;
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('missing identifier');
  return value;
}

export function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid token count');
  return Number(value);
}

export const fields = ['t_in', 't_cache_read', 't_cache_write', 't_out', 't_reasoning'] as const;
export type Tokens = Record<(typeof fields)[number], number>;

export function normalize(schema: string, data: unknown): Tokens {
  const usage = record(data);
  let input: number, read: number, write: number, output: number, reasoning: number;
  switch (schema) {
    case 'opencode-v1': {
      const cache = record(usage.cache);
      input = count(usage.input);
      read = count(cache.read);
      write = count(cache.write);
      output = count(usage.output);
      reasoning = count(usage.reasoning);
      break;
    }
    case 'opencode-go-chat': {
      const ext = record(record(usage.opencode).tokens);
      input = count(ext.input);
      read = count(ext.cache_read);
      write = count(count(ext.cache_write_5m) + count(ext.cache_write_1h));
      reasoning = count(ext.reasoning);
      output = count(count(ext.output) - reasoning);
      const standard = normalize('openai-chat', usage);
      if (
        standard.t_in + standard.t_cache_read !== input + read + write ||
        standard.t_out + standard.t_reasoning !== output + reasoning
      )
        throw new Error('OpenCode billing token totals differ from API usage');
      const inDetail = record(usage.prompt_tokens_details ?? {});
      const outDetail = record(usage.completion_tokens_details ?? {});
      if (
        (inDetail.cached_tokens != null && standard.t_cache_read !== read) ||
        (outDetail.reasoning_tokens != null && standard.t_reasoning !== reasoning)
      )
        throw new Error('OpenCode billing token details differ from API usage');
      break;
    }
    case 'openai-chat': {
      const detailsIn = record(usage.prompt_tokens_details ?? {});
      const detailsOut = record(usage.completion_tokens_details ?? {});
      read = count(detailsIn.cached_tokens ?? 0);
      write = 0;
      input = count(count(usage.prompt_tokens) - read);
      reasoning = count(detailsOut.reasoning_tokens ?? 0);
      output = count(count(usage.completion_tokens) - reasoning);
      break;
    }
    case 'anthropic-messages': {
      input = count(usage.input_tokens);
      read = count(usage.cache_read_input_tokens ?? 0);
      write = count(usage.cache_creation_input_tokens ?? 0);
      // Messages usage counts all generated output together, including thinking.
      output = count(usage.output_tokens);
      reasoning = 0;
      break;
    }
    default:
      throw new Error(`unsupported usage schema ${schema}`);
  }
  const tokens = {
    t_in: input,
    t_cache_read: read,
    t_cache_write: write,
    t_out: output,
    t_reasoning: reasoning,
  };
  const total = usage.total ?? usage.total_tokens;
  if (total != null && count(total) !== rpt(tokens))
    throw new Error('reported total differs from component sum');
  return tokens;
}

export function rpt(tokens: Tokens): number {
  return count(fields.reduce((sum, key) => sum + tokens[key], 0));
}

export function equal(a: Tokens, b: Tokens): boolean {
  return fields.every((field) => a[field] === b[field]);
}

export function timestamp(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
