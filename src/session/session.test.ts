import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vm/cleanup.js", () => ({
  cleanupVm: vi.fn(),
}));

vi.mock("./manifest.js", () => ({
  removeEntry: vi.fn(),
  addEntry: vi.fn(),
}));

import {
  createSession,
  getSession,
  touchSession,
  destroySession,
  getAllSessions,
} from "./session.js";
import { cleanupVm } from "../vm/cleanup.js";

describe("session state management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and retrieves a session", () => {
    const session = createSession("session-123", "python", "owner-1");
    expect(session.sessionId).toBe("session-123");
    expect(session.template).toBe("python");
    expect(session.ownerId).toBe("owner-1");
    expect(session.state).toBe("creating");

    const retrieved = getSession("session-123");
    expect(retrieved).toBe(session);
  });

  it("touches session to update lastActivityAt", () => {
    const session = createSession("session-touch");
    const oldTime = session.lastActivityAt;

    // Small delay or manually verify lastActivityAt changes
    session.lastActivityAt = oldTime - 5000;
    touchSession("session-touch");

    expect(session.lastActivityAt).toBeGreaterThan(oldTime - 5000);
  });

  it("destroys an active session and invokes VM cleanup", async () => {
    const session = createSession("session-destroy");
    const fakeVm: any = { id: "vm-to-clean", state: "ready" };
    session.vm = fakeVm;
    session.state = "active";

    const destroyed = await destroySession("session-destroy");

    expect(destroyed).toBe(true);
    expect(cleanupVm).toHaveBeenCalledWith("session-destroy", fakeVm);
    expect(getSession("session-destroy")).toBeUndefined();
  });

  it("returns false when destroying non-existent session", async () => {
    const destroyed = await destroySession("non-existent-session");
    expect(destroyed).toBe(false);
  });

  it("awaits pending in-flight VM creation before cleaning up", async () => {
    const session = createSession("session-inflight");
    const fakeVm: any = { id: "vm-inflight", state: "ready" };

    session.creation = (async () => {
      session.vm = fakeVm;
      return fakeVm;
    })();

    const destroyed = await destroySession("session-inflight");

    expect(destroyed).toBe(true);
    expect(cleanupVm).toHaveBeenCalledWith("session-inflight", fakeVm);
  });

  it("lists all active sessions", () => {
    createSession("s-list-1");
    createSession("s-list-2");

    const all = getAllSessions();
    expect(all.some((s) => s.sessionId === "s-list-1")).toBe(true);
    expect(all.some((s) => s.sessionId === "s-list-2")).toBe(true);
  });

  it("enforces ownership when destroying session", async () => {
    createSession("owned-session", "node", "owner-alice");
    await expect(destroySession("owned-session", "owner-bob")).rejects.toThrow("Session belongs to another API key");

    const destroyed = await destroySession("owned-session", "owner-alice");
    expect(destroyed).toBe(true);
  });
});
