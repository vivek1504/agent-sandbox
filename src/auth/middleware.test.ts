import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { extractKey, authMiddleware } from "./middleware.js";
import * as keyStore from "./key-store.js";

vi.mock("./key-store.js");
vi.mock("./rate-limiter.js", () => ({
  checkRateLimit: vi.fn(() => true),
}));

describe("auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUTH_ENABLED;
  });

  describe("extractKey", () => {
    it("extracts key from Authorization Bearer header", () => {
      const req = {
        headers: { authorization: "Bearer sk_test_secret123" },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBe("sk_test_secret123");
    });

    it("extracts key from x-api-key header", () => {
      const req = {
        headers: { "x-api-key": "sk_test_header123" },
        query: {},
      } as unknown as Request;
      expect(extractKey(req)).toBe("sk_test_header123");
    });

    it("rejects/ignores query parameter API keys (OWASP compliance)", () => {
      const req = {
        headers: {},
        query: { api_key: "sk_test_query123", apiKey: "sk_test_query456" },
      } as unknown as Request;
      expect(extractKey(req)).toBeNull();
    });
  });

  describe("authMiddleware", () => {
    it("rejects requests missing an API key header with 401", () => {
      const req = { headers: {}, query: {} } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "API key required" });
      expect(next).not.toHaveBeenCalled();
    });

    it("allows valid requests with matching scope", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-1",
        name: "Test Key",
        scopes: ["exec", "admin"],
        rateLimit: 100,
      });

      const req = {
        headers: { authorization: "Bearer sk_test_valid" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey?.id).toBe("key-1");
    });

    it("rejects requests with missing required scope with 403", () => {
      vi.mocked(keyStore.verifyKey).mockReturnValue({
        id: "key-2",
        name: "Exec Only",
        scopes: ["exec"],
        rateLimit: 100,
      });

      const req = {
        headers: { authorization: "Bearer sk_test_exec" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("admin")(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Missing required scope: admin",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("grants only exec scope to legacy MCP_AUTH_TOKEN", () => {
      process.env.MCP_AUTH_TOKEN = "legacy-token-secret";
      const req = {
        headers: { authorization: "Bearer legacy-token-secret" },
        query: {},
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn();

      authMiddleware("exec")(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.apiKey).toBeDefined();
      expect(req.apiKey?.scopes).toEqual(["exec"]);
      expect(req.apiKey?.rateLimit).toBe(100);

      // Now verify it fails admin check
      const adminNext = vi.fn();
      authMiddleware("admin")(req, res, adminNext);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(adminNext).not.toHaveBeenCalled();
    });
  });
});
