import type { ArenaEvent, ArenaEventEnvelope } from "@/lib/types";

const events = new Map<string, ArenaEventEnvelope[]>();
let seqCounter = 0;

type EventCallback = (arenaId: string, envelope: ArenaEventEnvelope) => void;
let onEventCallback: EventCallback | null = null;

export function setOnEvent(cb: EventCallback | null): void {
  onEventCallback = cb;
}

export async function publishEvent(
  arenaId: string,
  event: ArenaEvent
): Promise<ArenaEventEnvelope> {
  const ts = Date.now();
  seqCounter++;
  const envelope: ArenaEventEnvelope = {
    seq: seqCounter,
    ts,
    event,
  };

  const list = events.get(arenaId) ?? [];
  list.push(envelope);
  events.set(arenaId, list);

  if (onEventCallback) {
    onEventCallback(arenaId, envelope);
  }

  return envelope;
}

export async function getEventsSince(
  arenaId: string,
  sinceScore: number
): Promise<{ events: ArenaEventEnvelope[]; lastScore: number }> {
  const list = events.get(arenaId) ?? [];
  const filtered: ArenaEventEnvelope[] = [];
  let lastScore = sinceScore;

  for (const envelope of list) {
    const score = envelope.ts + envelope.seq * 0.001;
    if (score > sinceScore) {
      filtered.push(envelope);
      if (score > lastScore) lastScore = score;
    }
  }

  return { events: filtered, lastScore };
}

export function clearEvents(arenaId: string): void {
  events.delete(arenaId);
}
