import type { Request, Response, NextFunction } from "express";
import { getSession } from "../session/session.js";

export function assertOwnership(
  session: { ownerId?: string | undefined },
  callerId?: string | undefined,
): void {
  if (session.ownerId && callerId && session.ownerId !== callerId) {
    const err = new Error("Session belongs to another owner");
    (err as any).statusCode = 403;
    throw err;
  }
}

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

  try {
    assertOwnership(session, req.apiKey?.id);
    next();
  } catch (err: any) {
    res.status(err.statusCode ?? 403).json({ error: err.message });
  }
}

