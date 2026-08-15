import type {
  ExecOptions,
  ExecResult,
  WriteResult,
  ReadResult,
  FileEntry,
  ListFilesResult,
  StreamChunk,
  SandboxClientOptions,
} from "./types.js";
import { SandboxError } from "./types.js";

export class Session {
  /** @internal */
  constructor(
    public readonly id: string,
    private readonly _baseUrl: string,
    private readonly _template: string | undefined,
    private readonly _defaultTimeout: number,
    private readonly _headers: Record<string, string>,
    private readonly _fetch: typeof globalThis.fetch,
  ) { }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const body = {
      command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout ?? this._defaultTimeout,
      template: this._template,
    };

    const res = await this._request("POST", `/${this.id}/execute`, body);
    return res as ExecResult;
  }

  async *execStream(
    command: string,
    opts: ExecOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const body = {
      command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout ?? this._defaultTimeout,
      template: this._template,
    };

    const url = `${this._baseUrl}/exec/${this.id}/execute?format=ndjson`;
    const res = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        ...this._headers,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SandboxError(
        `exec stream failed: ${res.status} ${res.statusText}`,
        res.status,
        text,
      );
    }

    const reader = res.body?.getReader();
    if (!reader) throw new SandboxError("No response body", 0);

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          yield JSON.parse(trimmed) as StreamChunk;
        }
      }

      if (buffer.trim()) {
        yield JSON.parse(buffer.trim()) as StreamChunk;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async run(shellCommand: string, opts: Omit<ExecOptions, "args"> = {}): Promise<ExecResult> {
    return this.exec("sh", { ...opts, args: ["-c", shellCommand] });
  }

  async runCode(code: string, opts: Omit<ExecOptions, "args"> = {}): Promise<ExecResult> {
    const tpl = this._template ?? "node";

    switch (tpl) {
      case "node":
        return this.exec("node", { ...opts, args: ["-e", code] });

      case "python":
        return this.exec("python3", { ...opts, args: ["-c", code] });

      case "go": {
        await this.writeFile("main.go", code);
        return this.exec("go", { ...opts, args: ["run", "main.go"] });
      }

      default:
        return this.exec("sh", { ...opts, args: ["-c", code] });
    }
  }

  async writeFile(path: string, content: string): Promise<WriteResult> {
    return this._request("POST", `/${this.id}/write`, { path, content }) as Promise<WriteResult>;
  }

  async readFile(path: string): Promise<ReadResult> {
    return this._request("GET", `/${this.id}/read?path=${encodeURIComponent(path)}`) as Promise<ReadResult>;
  }

  async listFiles(
    path: string = ".",
    opts: { recursive?: boolean } = {},
  ): Promise<ListFilesResult> {
    const params = new URLSearchParams({ path });
    if (opts.recursive) params.set("recursive", "true");
    return this._request("GET", `/${this.id}/files?${params}`) as Promise<ListFilesResult>;
  }

  async destroy(): Promise<boolean> {
    const res = await this._request("DELETE", `/${this.id}`);
    return (res as { destroyed: boolean }).destroyed;
  }

  /** @internal */
  private async _request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this._baseUrl}/exec${path}`;
    const init: RequestInit = {
      method,
      headers: { ...this._headers, "Content-Type": "application/json" },
    };

    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body);
    }

    const res = await this._fetch(url, init);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const msg =
        (json as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
      throw new SandboxError(msg, res.status, json);
    }

    return json;
  }
}
