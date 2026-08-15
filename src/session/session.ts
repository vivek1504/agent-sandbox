import { cleanupVm } from "../vm/cleanup.js";
import type { Vm } from "../vm/vm-manager.js";
import { sessionLogger } from "../logger.js";
import {
  execSessionsActive,
  execSessionDurationSeconds,
} from "../metrics.js";
import { removeEntry } from "./manifest.js";

export interface Session {
  sessionId: string;
  ownerId?: string | undefined;
  createdAt: number;
  lastActivityAt: number;
  state: "creating" | "active" | "destroying";
  template?: string | undefined;
  vm?: Vm;
  creation?: Promise<Vm> | undefined;
}

const sessions = new Map<string, Session>();

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function createSession(sessionId: string, template?: string, ownerId?: string): Session {
  const session: Session = {
    sessionId,
    ownerId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    state: "creating",
    ...(template ? { template } : {}),
  };
  sessions.set(sessionId, session);
  execSessionsActive.inc();
  return session;
}

export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.lastActivityAt = Date.now();
}

export async function destroySession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.state = "destroying";

  try {
    await session.creation;
  } catch {
    // VM creation already failed; there is no VM to clean up.
  }
  if (session.vm) await cleanupVm(sessionId, session.vm);

  sessions.delete(sessionId);
  removeEntry(sessionId);
  execSessionsActive.dec();
  execSessionDurationSeconds.observe((Date.now() - session.createdAt) / 1000);
  sessionLogger.info({ sessionId }, "session destroyed");
  return true;
}

export function getAllSessions(): Session[] {
  return [...sessions.values()];
}

export function startSessionReaper(ttlMs: number = 30 * 60 * 1000): void {
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt > ttlMs && session.state === "active") {
        sessionLogger.info(
          { sessionId: id, idleMs: now - session.lastActivityAt },
          "reaping idle session",
        );
        destroySession(id).catch((err) => {
          sessionLogger.error({ sessionId: id, err }, "session reap failed");
        });
      }
    }
  }, 60_000);
}
