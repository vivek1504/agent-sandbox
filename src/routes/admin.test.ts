import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../auth/key-store.js", () => ({
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
  rotateKey: vi.fn(),
  deleteKey: vi.fn(),
}));

import supertest from "supertest";
import { app } from "../app.js";
import {
  listKeys,
  createKey,
  revokeKey,
  rotateKey,
  deleteKey,
} from "../auth/key-store.js";

describe("Admin REST Routes (/admin/*)", () => {
  const originalAuth = process.env.AUTH_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_ENABLED = "false";
  });

  afterEach(() => {
    if (originalAuth !== undefined) {
      process.env.AUTH_ENABLED = originalAuth;
    } else {
      delete process.env.AUTH_ENABLED;
    }
  });

  describe("GET /admin/keys", () => {
    it("returns list of keys", async () => {
      vi.mocked(listKeys).mockReturnValue([
        {
          id: "k1",
          name: "agent-1",
          keyPrefix: "sk_test_1234",
          scopes: ["exec"],
          rateLimit: 100,
          createdAt: 1000,
          lastUsedAt: 1000,
          enabled: true,
        },
      ]);

      const res = await supertest(app).get("/admin/keys");
      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].id).toBe("k1");
    });
  });

  describe("POST /admin/keys", () => {
    it("rejects missing name with 400", async () => {
      const res = await supertest(app).post("/admin/keys").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name is required");
    });

    it("creates an API key with defaults", async () => {
      vi.mocked(createKey).mockReturnValue({
        rawKey: "sk_test_secret1234567890",
        record: {
          id: "k2",
          name: "agent-2",
          keyHash: "hash",
          keyPrefix: "sk_test_secr",
          scopes: ["exec"],
          rateLimit: 0,
          createdAt: 2000,
          lastUsedAt: 2000,
          enabled: true,
        },
      });

      const res = await supertest(app).post("/admin/keys").send({ name: "agent-2" });
      expect(res.status).toBe(201);
      expect(res.body.key).toBe("sk_test_secret1234567890");
      expect(res.body.record.id).toBe("k2");
    });
  });

  describe("POST /admin/keys/:id/revoke", () => {
    it("revokes an existing key", async () => {
      vi.mocked(revokeKey).mockReturnValue(true);

      const res = await supertest(app).post("/admin/keys/k1/revoke");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for unknown key", async () => {
      vi.mocked(revokeKey).mockReturnValue(false);

      const res = await supertest(app).post("/admin/keys/unknown/revoke");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /admin/keys/:id/rotate", () => {
    it("rotates an existing key", async () => {
      vi.mocked(rotateKey).mockReturnValue({
        rawKey: "sk_test_rotated_raw",
        record: {
          id: "k-new",
          name: "rotated-agent",
          keyHash: "hash",
          keyPrefix: "sk_test_rota",
          scopes: ["exec"],
          rateLimit: 60,
          createdAt: 3000,
          lastUsedAt: 3000,
          enabled: true,
        },
      });

      const res = await supertest(app).post("/admin/keys/k1/rotate");
      expect(res.status).toBe(200);
      expect(res.body.key).toBe("sk_test_rotated_raw");
    });

    it("returns 404 when rotating non-existent key", async () => {
      vi.mocked(rotateKey).mockReturnValue(null);

      const res = await supertest(app).post("/admin/keys/unknown/rotate");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /admin/keys/:id", () => {
    it("deletes an existing key", async () => {
      vi.mocked(deleteKey).mockReturnValue(true);

      const res = await supertest(app).delete("/admin/keys/k1");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 when deleting non-existent key", async () => {
      vi.mocked(deleteKey).mockReturnValue(false);

      const res = await supertest(app).delete("/admin/keys/unknown");
      expect(res.status).toBe(404);
    });
  });
});
