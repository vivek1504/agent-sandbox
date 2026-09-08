import type { Request, Response, NextFunction } from "express";
import { verifyKey, touchKey, type ResolvedKey, type Scope } from "./key-store.js";
import { checkRateLimit } from "./rate-limiter.js";
import { authRequestsTotal, authRateLimitHits } from "../metrics.js";

declare global {
  namespace Express {
    interface Request {
      apiKey?: ResolvedKey;
    }
  }
}

export function extractKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    return key.length > 0 ? key : null;
  }

  return null;
}

export function authMiddleware(...requiredScopes: Scope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.AUTH_ENABLED === "false") {
      return next();
    }

    const rawKey = extractKey(req);
    if (!rawKey) {
      authRequestsTotal.inc({ result: "missing_key" });
      res.status(401).json({ error: "API key required" });
      return;
    }

    const resolved: ResolvedKey | null = verifyKey(rawKey);
    if (!resolved) {
      authRequestsTotal.inc({ result: "invalid_key" });
      res.status(401).json({ error: "Invalid API key" });
      return;
    }

    for (const scope of requiredScopes) {
      if (!resolved.scopes.includes(scope)) {
        authRequestsTotal.inc({ result: "forbidden" });
        res.status(403).json({ error: `Missing required scope: ${scope}` });
        return;
      }
    }

    if (!checkRateLimit(resolved.id, resolved.rateLimit)) {
      authRequestsTotal.inc({ result: "rate_limited" });
      authRateLimitHits.inc({ key_id: resolved.id });
      res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: 60,
      });
      return;
    }

    touchKey(resolved.id);
    req.apiKey = resolved;
    authRequestsTotal.inc({ result: "success" });
    next();
  };
}
