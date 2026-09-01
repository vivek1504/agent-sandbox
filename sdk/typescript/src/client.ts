import { Session } from "./session.js";
import { SandboxError } from "./types.js";
import type {
  SandboxClientOptions,
  Template,
  SessionInfo,
} from "./types.js";


export class Sandbox {
  private readonly _baseUrl: string;
  private readonly _defaultTemplate: string;
  private readonly _defaultTimeout: number;
  private readonly _headers: Record<string, string>;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(opts: SandboxClientOptions = {}) {
    const raw = opts.baseUrl ?? "http://localhost:3000";
    this._baseUrl = raw.replace(/\/+$/, "");
    this._defaultTemplate = opts.defaultTemplate ?? "node";
    this._defaultTimeout = opts.defaultTimeout ?? 30_000;
    this._headers = { ...opts.headers };
    if (opts.apiKey) {
      this._headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    this._fetch = globalThis.fetch.bind(globalThis);
  }

  session(
    id: string,
    opts: { template?: string } = {},
  ): Session {
    return new Session(
      id,
      this._baseUrl,
      opts.template ?? this._defaultTemplate,
      this._defaultTimeout,
      this._headers,
      this._fetch,
    );
  }

  create(opts: { template?: string } = {}): Session {
    const id = globalThis.crypto?.randomUUID?.() ?? _fallbackUuid();
    return this.session(id, opts);
  }

  async templates(): Promise<Template[]> {
    const res = await this._fetch(`${this._baseUrl}/exec/templates`, {
      headers: this._headers,
    });
    if (!res.ok) throw new SandboxError("Failed to list templates", res.status);
    const data = (await res.json()) as { templates: Template[] };
    return data.templates;
  }

  async sessions(): Promise<SessionInfo[]> {
    const res = await this._fetch(`${this._baseUrl}/exec/`, {
      headers: this._headers,
    });
    if (!res.ok) throw new SandboxError("Failed to list sessions", res.status);
    const data = (await res.json()) as { sessions: SessionInfo[] };
    return data.sessions;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this._fetch(`${this._baseUrl}/health`, {
        headers: this._headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}


function _fallbackUuid(): string {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
