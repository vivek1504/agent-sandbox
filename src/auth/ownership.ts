import type { Request, Response, NextFunction } from "express";
import { getSession } from "../session/session.js";

export function requireOwnership(req: Request, res: Response, next: NextFunction): void {
  if (process.env.AUTH_ENABLED === "false") {
    return next();
  }

  const rawSessionId = req.params.sessionId;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;
  if (!sessionId) {
    return next();
  }

  const session = getSession(sessionId);
  if (!session) {
    return next();
  }

  if (session.ownerId && req.apiKey && session.ownerId !== req.apiKey.id) {
    res.status(403).json({ error: "Session belongs to another API key" });
    return;
  }

  next();
}
