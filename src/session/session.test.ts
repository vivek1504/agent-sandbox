import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vm/cleanup.js", () => ({
  cleanupVm: vi.fn(async () => {}),
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
import { removeEntry } from "./manifest.js";

describe("Session State Machine & Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and retrieves a session", () => {
    const s = createSession("test-s1", "python", "owner-1");
    expect(s.sessionId).toBe("test-s1");
    expect(s.template).toBe("python");
    expect(s.ownerId).toBe("owner-1");
    expect(s.state).toBe("creating");

    const retrieved = getSession("test-s1");
    expect(retrieved).toBe(s);
  });

  it("updates lastActivityAt on touchSession", async () => {
    const s = createSession("test-s2");
    const initialActivity = s.lastActivityAt;

    // Small delay to ensure timestamp increments
    await new Promise((r) => setTimeout(r, 10));
    touchSession("test-s2");

    expect(s.lastActivityAt).toBeGreaterThan(initialActivity);
  });

  it("destroys an active session and invokes cleanupVm", async () => {
    const s = createSession("test-s3");
    s.state = "active";
    s.vm = { id: "vm-test-3" } as any;

    const destroyed = await destroySession("test-s3");
    expect(destroyed).toBe(true);
    expect(cleanupVm).toHaveBeenCalledWith("test-s3", s.vm);
    expect(removeEntry).toHaveBeenCalledWith("test-s3");
    expect(getSession("test-s3")).toBeUndefined();
  });

  it("returns false when destroying a non-existent session", async () => {
    const destroyed = await destroySession("non-existent-session");
    expect(destroyed).toBe(false);
  });

  it("awaits in-flight VM creation before cleaning up during destroySession", async () => {
    const s = createSession("test-s4");
    let resolveCreation: (vm: any) => void;
    s.creation = new Promise((resolve) => {
      resolveCreation = resolve;
    });

    const destroyPromise = destroySession("test-s4");

    // Resolve creation with a VM
    const mockVm = { id: "vm-in-flight" } as any;
    s.vm = mockVm;
    resolveCreation!(mockVm);

    await destroyPromise;

    expect(cleanupVm).toHaveBeenCalledWith("test-s4", mockVm);
    expect(getSession("test-s4")).toBeUndefined();
  });

  it("lists all active sessions", () => {
    createSession("list-s1");
    createSession("list-s2");
    const list = getAllSessions();
    expect(list.some((s) => s.sessionId === "list-s1")).toBe(true);
    expect(list.some((s) => s.sessionId === "list-s2")).toBe(true);
  });

  it("rejects destroySession if called with mismatched ownerId", async () => {
    const s = createSession("owned-s1", "node", "tenant-1");
    s.state = "active";

    await expect(destroySession("owned-s1", "tenant-2")).rejects.toThrow(
      /Session belongs to another owner/,
    );
    expect(getSession("owned-s1")).toBeDefined();

    const destroyed = await destroySession("owned-s1", "tenant-1");
    expect(destroyed).toBe(true);
    expect(getSession("owned-s1")).toBeUndefined();
  });
});
