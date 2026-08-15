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
    return auth.slice(7).trim();
  }

  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }

  const queryKey = req.query.api_key || req.query.apiKey;
  if (typeof queryKey === "string" && queryKey.trim()) {
    return queryKey.trim();
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
      // Legacy fallback for MCP_AUTH_TOKEN if explicitly set and matches
      const legacyMcpToken = process.env.MCP_AUTH_TOKEN;
      if (legacyMcpToken) {
        // No key provided
      }
      authRequestsTotal.inc({ result: "missing_key" });
      res.status(401).json({ error: "API key required" });
      return;
    }

    // Check if key matches legacy MCP_AUTH_TOKEN when set
    const legacyToken = process.env.MCP_AUTH_TOKEN;
    if (legacyToken && rawKey === legacyToken) {
      req.apiKey = {
        id: "legacy_mcp",
        name: "Legacy MCP Token",
        scopes: ["exec", "admin", "metrics"],
        rateLimit: 0,
      };
      authRequestsTotal.inc({ result: "success" });
      return next();
    }

    const resolved = verifyKey(rawKey);
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
