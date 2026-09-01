import { describe, it, expect, beforeEach } from "vitest";
import supertest from "supertest";
import { app } from "../app.js";
import { createKey, clearKeysStore } from "../auth/key-store.js";

describe("Admin Routes", () => {
  let adminKey: string;
  let userKey: string;

  beforeEach(() => {
    process.env.AUTH_ENABLED = "true";
    clearKeysStore();
    const adminRes = createKey("admin-user", ["exec", "admin", "metrics"]);
    adminKey = adminRes.rawKey;
    const userRes = createKey("regular-user", ["exec"]);
    userKey = userRes.rawKey;
  });

  it("rejects unauthorized access without admin scope with 403", async () => {
    const res = await supertest(app)
      .get("/admin/keys")
      .set("Authorization", `Bearer ${userKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Missing required scope: admin");
  });

  it("lists all API keys with admin token", async () => {
    const res = await supertest(app)
      .get("/admin/keys")
      .set("Authorization", `Bearer ${adminKey}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys.length).toBe(2);
  });

  it("creates a new API key", async () => {
    const res = await supertest(app)
      .post("/admin/keys")
      .set("Authorization", `Bearer ${adminKey}`)
      .send({ name: "agent-alpha", scopes: ["exec"], rateLimit: 60 });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^sk_test_/);
    expect(res.body.record.name).toBe("agent-alpha");
    expect(res.body.record.rateLimit).toBe(60);
  });

  it("rejects creating key without name with 400", async () => {
    const res = await supertest(app)
      .post("/admin/keys")
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name is required");
  });

  it("revokes an existing key", async () => {
    const { record } = createKey("key-to-revoke");

    const res = await supertest(app)
      .post(`/admin/keys/${record.id}/revoke`)
      .set("Authorization", `Bearer ${adminKey}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rotates an existing key", async () => {
    const { record } = createKey("key-to-rotate");

    const res = await supertest(app)
      .post(`/admin/keys/${record.id}/rotate`)
      .set("Authorization", `Bearer ${adminKey}`);

    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/^sk_test_/);
    expect(res.body.record.name).toBe("key-to-rotate");
  });

  it("deletes a key", async () => {
    const { record } = createKey("key-to-delete");

    const res = await supertest(app)
      .delete(`/admin/keys/${record.id}`)
      .set("Authorization", `Bearer ${adminKey}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 when operating on non-existent key ID", async () => {
    const res = await supertest(app)
      .post(`/admin/keys/non-existent-id/revoke`)
      .set("Authorization", `Bearer ${adminKey}`);

    expect(res.status).toBe(404);
  });
});
