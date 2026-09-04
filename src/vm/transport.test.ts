import { describe, expect, it, vi, beforeEach } from "vitest";
import net from "net";
import { getVmSocket, acquireVmLock } from "./transport.js";
import type { Vm } from "./vm-manager.js";

vi.mock("net");

describe("transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses existing undestroyed socket", async () => {
    const mockSocket: any = { destroyed: false, write: vi.fn() };
    const vm: Vm = {
      id: "vm-1",
      state: "ready",
      firecrackerProcess: {} as any,
      apiSock: "/tmp/api.sock",
      vsock: "/tmp/vsock.sock",
      socket: mockSocket,
    };

    const sock = await getVmSocket(vm);
    expect(sock).toBe(mockSocket);
    expect(net.createConnection).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent getVmSocket calls without leaking sockets", async () => {
    let connectCallback: (() => void) | undefined;
    const mockSocket: any = {
      destroyed: false,
      write: vi.fn(),
      once: vi.fn((event, cb) => {
        if (event === "connect") {
          connectCallback = cb;
        }
      }),
      destroy: vi.fn(),
    };

    vi.mocked(net.createConnection).mockReturnValue(mockSocket);

    const vm: Vm = {
      id: "vm-2",
      state: "ready",
      firecrackerProcess: {} as any,
      apiSock: "/tmp/api.sock",
      vsock: "/tmp/vsock.sock",
    };

    // Trigger two concurrent getVmSocket calls before connection completes
    const p1 = getVmSocket(vm);
    const p2 = getVmSocket(vm);

    expect(net.createConnection).toHaveBeenCalledTimes(1);

    // Simulate connection established
    connectCallback?.();

    const [sock1, sock2] = await Promise.all([p1, p2]);
    expect(sock1).toBe(mockSocket);
    expect(sock2).toBe(mockSocket);
    expect(mockSocket.write).toHaveBeenCalledWith("CONNECT 5000\n");
    expect(vm.socket).toBe(mockSocket);
  });

  it("serializes access using acquireVmLock", async () => {
    const lock1 = await acquireVmLock("vm-lock-test");
    let lock2Acquired = false;

    const p = acquireVmLock("vm-lock-test").then((release) => {
      lock2Acquired = true;
      release();
    });

    expect(lock2Acquired).toBe(false);
    lock1();
    await p;
    expect(lock2Acquired).toBe(true);
  });
});
