import { Router } from "express";
import {
  createKey,
  listKeys,
  revokeKey,
  deleteKey,
  rotateKey,
  type Scope,
} from "../auth/key-store.js";

export const adminRouter = Router();

adminRouter.get("/keys", (_req, res) => {
  res.json({ keys: listKeys() });
});

adminRouter.post("/keys", (req, res) => {
  const { name, scopes, rateLimit, expiresAt } = req.body;
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const validScopes: Scope[] = Array.isArray(scopes) ? scopes : ["exec"];
  const limit = typeof rateLimit === "number" ? rateLimit : 0;
  const expiry = typeof expiresAt === "number" ? expiresAt : undefined;

  const result = createKey(name, validScopes, limit, expiry);
  res.status(201).json({
    key: result.rawKey,
    record: {
      id: result.record.id,
      name: result.record.name,
      keyPrefix: result.record.keyPrefix,
      scopes: result.record.scopes,
      rateLimit: result.record.rateLimit,
      createdAt: result.record.createdAt,
      expiresAt: result.record.expiresAt,
      enabled: result.record.enabled,
    },
  });
});

adminRouter.post("/keys/:id/revoke", (req, res) => {
  const { id } = req.params;
  const revoked = revokeKey(id);
  if (!revoked) {
    res.status(404).json({ error: "Key not found" });
    return;
  }
  res.json({ success: true, message: `Key ${id} revoked` });
});

adminRouter.post("/keys/:id/rotate", (req, res) => {
  const { id } = req.params;
  const result = rotateKey(id);
  if (!result) {
    res.status(404).json({ error: "Key not found" });
    return;
  }
  res.json({
    key: result.rawKey,
    record: {
      id: result.record.id,
      name: result.record.name,
      keyPrefix: result.record.keyPrefix,
      scopes: result.record.scopes,
      rateLimit: result.record.rateLimit,
      createdAt: result.record.createdAt,
      expiresAt: result.record.expiresAt,
      enabled: result.record.enabled,
    },
  });
});

adminRouter.delete("/keys/:id", (req, res) => {
  const { id } = req.params;
  const deleted = deleteKey(id);
  if (!deleted) {
    res.status(404).json({ error: "Key not found" });
    return;
  }
  res.json({ success: true, message: `Key ${id} deleted` });
});
