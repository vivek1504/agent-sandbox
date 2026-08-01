import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "stream";
import type { Socket } from "net";

vi.mock("../runtime/vm-manager.js", () => ({
  createVm: vi.fn(async (_fid: string, fn: any) => {
    const vm = {
      id: "mock-vm",
      state: "ready" as const,
      firecrackerProcess: { kill: vi.fn() },
      apiSock: "/tmp/mock-api.sock",
      vsock: "/tmp/mock-vsock.sock",
      idleTime: Date.now(),
    };
    fn.vms.push(vm);
    fn.readyVms.add(vm);
    return vm;
  }),
}));

vi.mock("../runtime/transport.js", () => ({
  getVmSocket: vi.fn(),
  connectVsock: vi.fn(),
  sendMessage: vi.fn(),
  sendRequest: vi.fn(),
}));

vi.mock("../runtime/protocol.js", () => ({
  readVsockResponse: vi.fn(),
  buildPayload: vi.fn(),
}));

import { ensureSession, sendSessionMessage } from "./gateway.js";
import { runtimeStore } from "../runtime/store.js";
import { createVm } from "../runtime/vm-manager.js";
import { getVmSocket } from "../runtime/transport.js";
import { readVsockResponse } from "../runtime/protocol.js";
import * as sessionModule from "./session.js";
import { getSession, createSession } from "./session.js";
import { Deque } from "../runtime/deque.js";


function makeFakeSocket() {
  const stream = new PassThrough();
  (stream as any).write = vi.fn();
  return stream as unknown as Socket;
}

function prePopulateSession(sessionId: string) {
  const vm = {
    id: "existing-vm",
    state: "ready" as const,
    firecrackerProcess: { kill: vi.fn() },
    apiSock: "/tmp/existing-api.sock",
    vsock: "/tmp/existing-vsock.sock",
    idleTime: Date.now(),
  };

  const fn = {
    functionId: sessionId,
    queue: new Deque(),
    vms: [vm],
    readyVms: new Set([vm]),
    weight: 1,
    inflightCount: 0,
    deficit: 0,
    pendingCreations: 0,
  };

  runtimeStore.functions.set(sessionId, fn as any);
  createSession(sessionId);
  const session = getSession(sessionId)!;
  session.state = "active";

  return { vm, fn };
}

describe("ensureSession", () => {
  beforeEach(() => {
    runtimeStore.reset();
    vi.clearAllMocks();
  });

  it("creates a new session and VM on first call", async () => {
    const vm = await ensureSession("new-session");

    expect(createVm).toHaveBeenCalledWith(
      "new-session",
      expect.any(Object),
      "__exec__",
    );
    expect(vm).toBeDefined();
    expect(vm.id).toBe("mock-vm");
  });

  it("reuses existing VM for active session", async () => {
    const { vm: existingVm } = prePopulateSession("active-session");

    const vm = await ensureSession("active-session");

    expect(createVm).not.toHaveBeenCalled();
    expect(vm.id).toBe(existingVm.id);
  });

  it("provisions new VM if session exists but has no VMs", async () => {
    const fn = {
      functionId: "empty-vm-session",
      queue: new Deque(),
      vms: [] as any[],
      readyVms: new Set(),
      weight: 1,
      inflightCount: 0,
      deficit: 0,
      pendingCreations: 0,
    };
    runtimeStore.functions.set("empty-vm-session", fn as any);
    createSession("empty-vm-session");

    await ensureSession("empty-vm-session");

    expect(createVm).toHaveBeenCalledWith(
      "empty-vm-session",
      expect.any(Object),
      "__exec__",
    );
  });

  it("registers function in runtimeStore on first call", async () => {
    expect(runtimeStore.functions.has("brand-new")).toBe(false);
    await ensureSession("brand-new");
    expect(runtimeStore.functions.has("brand-new")).toBe(true);
  });
});

describe("sendSessionMessage", () => {
  beforeEach(() => {
    runtimeStore.reset();
    vi.clearAllMocks();
  });

  it("sends JSON message to VM socket and returns parsed response", async () => {
    prePopulateSession("s1");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockResolvedValue({
      type: "response",
      data: { exitCode: 0, duration: 100 },
    });

    const result = await sendSessionMessage("s1", {
      type: "execute",
      command: "echo",
      args: ["hello"],
    });

    expect(socket.write).toHaveBeenCalledTimes(1);
    const written = (socket.write as any).mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("execute");
    expect(parsed.command).toBe("echo");
    expect(parsed.id).toBeDefined();

    expect(result.data.exitCode).toBe(0);
  });

  it("calls onStream callback for stream chunks", async () => {
    prePopulateSession("s2");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);

    const streamChunks = [
      { stream: "stdout", data: "line1\n" },
      { stream: "stderr", data: "warn\n" },
    ];

    vi.mocked(readVsockResponse).mockImplementation(
      async (_socket, _timeout, onStream) => {
        for (const chunk of streamChunks) {
          onStream?.(chunk);
        }
        return { type: "response", data: { exitCode: 0 } };
      },
    );

    const collected: any[] = [];
    await sendSessionMessage(
      "s2",
      { type: "execute", command: "sh" },
      (chunk) => collected.push(chunk),
    );

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ stream: "stdout", data: "line1\n" });
    expect(collected[1]).toEqual({ stream: "stderr", data: "warn\n" });
  });

  it("adds generated UUID as message id when not provided", async () => {
    prePopulateSession("s3");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockResolvedValue({
      type: "response",
      data: {},
    });

    await sendSessionMessage("s3", { type: "list_files" });

    const written = (socket.write as any).mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.id).toBeTruthy();
    expect(parsed.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("preserves provided message id", async () => {
    prePopulateSession("s4");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockResolvedValue({
      type: "response",
      data: {},
    });

    await sendSessionMessage("s4", { type: "execute", id: "custom-id-42", command: "echo" });

    const written = (socket.write as any).mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.id).toBe("custom-id-42");
  });

  it("touches session on each message", async () => {
    prePopulateSession("s5");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockResolvedValue({
      type: "response",
      data: {},
    });

    const spy = vi.spyOn(sessionModule, "touchSession");

    await sendSessionMessage("s5", { type: "list_files" });

    expect(spy).toHaveBeenCalledWith("s5");
    spy.mockRestore();
  });

  it("returns messageId in the result", async () => {
    prePopulateSession("s6");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockResolvedValue({
      type: "response",
      data: { exitCode: 0 },
    });

    const result = await sendSessionMessage("s6", { type: "execute", command: "echo" });

    expect(result.messageId).toBeDefined();
  });

  it("throws when readVsockResponse rejects", async () => {
    prePopulateSession("s7");
    const socket = makeFakeSocket();
    vi.mocked(getVmSocket).mockResolvedValue(socket);
    vi.mocked(readVsockResponse).mockRejectedValue(new Error("Function timeout"));

    await expect(
      sendSessionMessage("s7", { type: "execute", command: "sleep", args: ["999"] }),
    ).rejects.toThrow("Function timeout");
  });
});
