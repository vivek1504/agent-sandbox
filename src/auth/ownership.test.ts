import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertOwnership, requireOwnership } from "./ownership.js";
import { createSession } from "../session/session.js";

describe("assertOwnership", () => {
  it("does not throw if session has no owner", () => {
    expect(() => assertOwnership({ ownerId: undefined }, "key-1")).not.toThrow();
  });

  it("does not throw if callerId matches ownerId", () => {
    expect(() => assertOwnership({ ownerId: "key-1" }, "key-1")).not.toThrow();
  });

  it("does not throw if callerId is undefined", () => {
    expect(() => assertOwnership({ ownerId: "key-1" }, undefined)).not.toThrow();
  });

  it("throws 403 Error if callerId does not match ownerId", () => {
    expect(() => assertOwnership({ ownerId: "key-1" }, "key-2")).toThrowError(
      "Session belongs to another owner",
    );
    try {
      assertOwnership({ ownerId: "key-1" }, "key-2");
    } catch (err: any) {
      expect(err.statusCode).toBe(403);
    }
  });
});

describe("RequireOwnership Middleware", () => {
  const originalAuthEnabled = process.env.AUTH_ENABLED;

  beforeEach(() => {
    process.env.AUTH_ENABLED = "true";
  });

  afterEach(() => {
    process.env.AUTH_ENABLED = originalAuthEnabled;
  });

  it("passes if session has no owner", () => {
    createSession("session-no-owner");
    const req: any = { params: { sessionId: "session-no-owner" }, apiKey: { id: "key-1" } };
    let nextCalled = false;
    const res: any = {};
    requireOwnership(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("passes if apiKey matches ownerId", () => {
    createSession("session-owned", undefined, "key-1");
    const req: any = { params: { sessionId: "session-owned" }, apiKey: { id: "key-1" } };
    let nextCalled = false;
    const res: any = {};
    requireOwnership(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects 403 if apiKey does not match ownerId", () => {
    createSession("session-other-owner", undefined, "key-owner");
    const req: any = { params: { sessionId: "session-other-owner" }, apiKey: { id: "key-attacker" } };
    let statusCode = 0;
    let jsonBody: any = null;
    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (body: any) => {
            jsonBody = body;
          },
        };
      },
    };

    requireOwnership(req, res, () => {});
    expect(statusCode).toBe(403);
    expect(jsonBody).toEqual({ error: "Session belongs to another owner" });
  });

  it("bypasses when AUTH_ENABLED is false", () => {
    process.env.AUTH_ENABLED = "false";
    createSession("session-owned-2", undefined, "key-owner");
    const req: any = { params: { sessionId: "session-owned-2" }, apiKey: { id: "key-other" } };
    let nextCalled = false;
    requireOwnership(req, {} as any, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

