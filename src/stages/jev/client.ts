import * as fs from 'fs';
import { TypeSafeClient, Questions, EntryType, APIError } from '@typesafe-ai/sdk';
import { env, paths, settings } from '../../config/config';
import { FatalPipelineError } from '../news/newsAgent';
import { record } from '../../utils/costMeter';

/**
 * TypeSafe's Jev decision model (System One API, https://docs.typesafe.ai/api.md):
 * one request carries a state and a set of typed questions, answered in parallel.
 */
export interface DecisionResult {
  model: string;
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
}

let client: TypeSafeClient | null = null;

export async function evaluate(state: EntryType, questions: Questions): Promise<DecisionResult> {
  if (!client) {
    if (!env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set on the server');
    // One request carries a whole candidate pool, so allow more than the 10s SDK default.
    client = new TypeSafeClient({ defaultModel: settings.jev.model, timeout: 30_000 });
  }
  try {
    const res = await client.systemOne({ state, questions });
    record({ jevCalls: 1, jevIn: res.usage?.input_tokens ?? 0 });
    return { model: res.model, answers: res.answers as any, usage: { ...res.usage } };
  } catch (err: any) {
    // Bad key or exhausted credits fail every later call too; a per-match fallback would
    // quietly drop the whole slate as "Jev unavailable". Stop the run instead.
    if (err instanceof APIError && [401, 402, 403].includes(err.status as number)) {
      throw new FatalPipelineError(`TypeSafe Jev unusable (HTTP ${err.status}): ${err.message}`);
    }
    throw err;
  }
}

export type JevRole = 'match-filter' | 'builder-check';

/** Every Jev call, inputs and outputs, so any drop or price can be audited later. */
export function logDecision(entry: {
  role: JevRole;
  eventId: string;
  match: string;
  state: unknown;
  questions: unknown;
  result?: DecisionResult;
  error?: string;
  decision: unknown;
}): void {
  fs.appendFileSync(paths.jevDecisionsJsonl, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
