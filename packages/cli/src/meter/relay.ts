import type { Inputs, Observation } from './sources.js';
import { count, type Entry, id, record, timestamp } from './usage.js';

interface Line {
  row: Entry;
  ref: string;
  order: number;
}
interface Packet {
  begin: Line;
  end: Line;
  session: string;
  user: string | null;
  assistant: string | null;
  agent: string | null;
  usage: Entry;
  model: string;
  status: number;
  ordinal: number | null;
}
const stringOrNull = (v: unknown) => (typeof v === 'string' && v.length ? v : null);
const association = (session: string, user: string | null, assistant: string | null) =>
  JSON.stringify([session, user, assistant]);

/** Link transport attempts only by pinned session/message identities and unambiguous order. */
export class Relay {
  private readonly begin = new Map<string, Line>();
  private readonly end = new Map<string, Line>();
  private line = 0;

  add(row: Entry, ref: string) {
    const key = id(row.id);
    const target = row.event === 'begin' ? this.begin : row.event === 'end' ? this.end : null;
    if (!target) throw new Error('invalid relay record type');
    if (target.has(key)) throw new Error('duplicate relay lifecycle record');
    target.set(key, { row, ref, order: ++this.line });
  }

  private packet(begin: Line, end: Line): Packet {
    const a = begin.row,
      b = end.row;
    const started = timestamp(a.ts),
      finished = timestamp(b.ts);
    if (end.order <= begin.order || !started || !finished || started > finished)
      throw new Error('invalid relay request boundaries');
    if (
      b.complete !== true ||
      !Array.isArray(b.issues) ||
      b.issues.length > 0 ||
      typeof b.status !== 'number'
    )
      throw new Error('incomplete relay response or transport issue');
    for (const key of [
      'session_id',
      'user_id',
      'assistant_id',
      'step_index',
      'attempt_id',
      'agent',
      'requested_model',
    ]) {
      if (b[key] != null && a[key] != null && b[key] !== a[key])
        throw new Error('conflicting relay correlation metadata');
    }
    const model = id(b.model_id);
    if (model !== id(a.requested_model))
      throw new Error('response model differs from requested model');
    return {
      begin,
      end,
      session: id(a.session_id),
      user: stringOrNull(a.user_id),
      assistant: stringOrNull(a.assistant_id),
      agent: stringOrNull(a.agent),
      usage: record(b.usage),
      model,
      status: b.status,
      ordinal: a.step_index == null ? null : count(a.step_index),
    };
  }

  reconcile(data: Inputs, provider: string) {
    const groups = new Map<string, Packet[]>();
    const used = new Set<string>();
    function store(pkt: Packet, part?: Observation, attempt = 1, kind?: string) {
      const b = pkt.end.row;
      const request = id(b.upstream_id);
      const schema = pkt.usage.opencode != null ? 'opencode-go-chat' : 'openai-chat';
      if (used.has(request))
        throw new Error('same upstream response ID on different transport attempts');
      used.add(request);
      data.provider(
        {
          request_id: request,
          source_schema: schema,
          model_id: pkt.model,
          provider_id: provider,
          session_id: pkt.session,
          message_id: part?.message ?? pkt.assistant,
          part_id: part?.key,
          ts: pkt.end.row.ts,
          usage: pkt.usage,
          cost: pkt.usage.cost,
          attempt,
          kind,
        },
        pkt.end.ref,
      );
    }
    for (const [key, start] of this.begin) {
      const end = this.end.get(key);
      if (!end) {
        data.issues.add(`${start.ref}: relay request has no terminal record`);
        continue;
      }
      data.checked(end.ref, () => {
        const pkt = this.packet(start, end);
        if (!pkt.assistant && !pkt.user)
          throw new Error('missing relay assistant and parent-user identity');
        if (pkt.agent === 'title') {
          store(pkt, undefined, 1, 'service');
          return;
        }
        const key = association(pkt.session, pkt.user, pkt.assistant);
        const group = groups.get(key) ?? [];
        group.push(pkt);
        groups.set(key, group);
      });
    }
    for (const [key, end] of this.end)
      if (!this.begin.has(key)) data.issues.add(`${end.ref}: response with no request`);
    if (!this.begin.size) data.issues.add('raw/relay.jsonl: no provider attempts');
    const storage = new Map<string, Observation>();
    for (const part of data.rows)
      if (part.origin === 'storage' && !storage.has(part.key)) storage.set(part.key, part);
    const joined = new Set<string>();
    for (const group of groups.values()) {
      const head = group[0];
      data.checked(head.begin.ref, () => {
        const parts = [...storage.values()]
          .filter((part) => {
            if (part.session !== head.session || !part.message) return false;
            if (head.assistant && part.message !== head.assistant) return false;
            if (head.user && data.userByMessage.get(part.message) !== head.user) return false;
            return !joined.has(part.key);
          })
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        // When V1 exposes only the user ID, several sequential LLM turns share it. SQLite
        // finish parts are chronological ULIDs; verify causality and cardinality before joining.
        const complete = group.filter((p) => p.status >= 200 && p.status < 300);
        if (complete.length !== parts.length || !parts.length)
          throw new Error('ambiguous relay-to-step cardinality');
        let counter = 0,
          attempt = 0;
        for (let i = 0; i < group.length; i++) {
          const pkt = group[i],
            next = group[i + 1];
          if (next && pkt.end.order >= next.begin.order)
            throw new Error('overlapping requests with shared correlation identity');
          const part = parts[counter];
          if (!part) throw new Error('missing step for relay attempt');
          if (
            pkt.agent &&
            data.agentByMessage.has(id(part.message)) &&
            data.agentByMessage.get(id(part.message)) !== pkt.agent
          )
            throw new Error('relay agent disagrees with assistant message');
          if (pkt.ordinal !== null && next?.ordinal != null && next.ordinal < pkt.ordinal)
            throw new Error('relay step ordinal went backwards');
          attempt++;
          if (pkt.status < 200 || pkt.status >= 300) {
            store(pkt, undefined, attempt, 'retry');
            continue;
          }
          const started = timestamp(pkt.begin.row.ts);
          const nextStart = next ? timestamp(next.begin.row.ts) : null;
          if (
            complete.length > 1 &&
            (!part.ts || !started || started > part.ts || (nextStart && part.ts > nextStart))
          )
            throw new Error('relay chronology disagrees with stored step order');
          store(pkt, part, attempt);
          joined.add(part.key);
          attempt = 0;
          counter++;
        }
      });
    }
  }
}
