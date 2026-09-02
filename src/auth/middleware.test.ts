import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware, extractKey } from "./middleware.js";
import { createKey, clearKeysStore } from "./key-store.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("Auth Middleware", () => {
  let tmpDir: string;
  let keysPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-mw-test-"));
    keysPath = path.join(tmpDir, "keys.json");
    process.env.AUTH_KEYS_PATH = keysPath;
    process.env.AUTH_ENABLED = "true";
    clearKeysStore();
  });

  afterEach(() => {
    delete process.env.AUTH_KEYS_PATH;
    delete process.env.AUTH_ENABLED;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("extractKey", () => {
    it("extracts key from Authorization Bearer header", () => {
      const req = {
        headers: { authorization: "Bearer sk_test_1234567890" },
        query: {},
      } as any;
      expect(extractKey(req)).toBe("sk_test_1234567890");
    });

    it("extracts key from X-API-Key header", () => {
      const req = {
        headers: { "x-api-key": "sk_test_xapikeyheader" },
        query: {},
      } as any;
      expect(extractKey(req)).toBe("sk_test_xapikeyheader");
    });

    it("does not extract key from query parameters (prevents URL credential leakage)", () => {
      const req = {
        headers: {},
        query: { api_key: "sk_test_querykey", apiKey: "sk_test_querykey2" },
      } as any;
      expect(extractKey(req)).toBeNull();
    });
  });

  describe("authMiddleware handler", () => {
    it("passes request with valid Bearer token", () => {
      const { rawKey } = createKey("test-agent", ["exec"]);
      const req = {
        headers: { authorization: `Bearer ${rawKey}` },
        query: {},
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      const next = vi.fn();

      const middleware = authMiddleware("exec");
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey.name).toBe("test-agent");
    });

    it("rejects request when missing required scope", () => {
      const { rawKey } = createKey("exec-only-agent", ["exec"]);
      const req = {
        headers: { authorization: `Bearer ${rawKey}` },
        query: {},
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      const next = vi.fn();

      const middleware = authMiddleware("admin");
      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Missing required scope") }));
    });

    it("rejects request when API key is passed solely via query string", () => {
      const { rawKey } = createKey("test-agent", ["exec"]);
      const req = {
        headers: {},
        query: { api_key: rawKey },
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      const next = vi.fn();

      const middleware = authMiddleware("exec");
      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "API key required" });
    });

    it("grants legacy MCP token only exec scope with rate limiting", () => {
      process.env.MCP_AUTH_TOKEN = "legacy-secret-token";
      const req = {
        headers: { authorization: "Bearer legacy-secret-token" },
        query: {},
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      const next = vi.fn();

      const middleware = authMiddleware("exec");
      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey.id).toBe("legacy_mcp");
      expect(req.apiKey.scopes).toEqual(["exec"]);
      expect(req.apiKey.rateLimit).toBe(100);

      // Verify it cannot access admin scope
      const adminNext = vi.fn();
      const adminRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;
      const adminMiddleware = authMiddleware("admin");
      adminMiddleware(req, adminRes, adminNext);
      expect(adminNext).not.toHaveBeenCalled();
      expect(adminRes.status).toHaveBeenCalledWith(403);
    });
  });
});
