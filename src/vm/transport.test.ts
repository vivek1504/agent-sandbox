import { describe, it, expect, vi } from "vitest";
import net from "net";
import { EventEmitter } from "events";
import { acquireVmLock, getVmSocket } from "./transport.js";

describe("transport & lock serialization", () => {
  it("serializes concurrent access with acquireVmLock", async () => {
    const order: number[] = [];

    const task1 = async () => {
      const release = await acquireVmLock("vm-test");
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(2);
      release();
    };

    const task2 = async () => {
      // Slight delay so task1 acquires first
      await new Promise((resolve) => setTimeout(resolve, 5));
      const release = await acquireVmLock("vm-test");
      order.push(3);
      release();
    };

    await Promise.all([task1(), task2()]);

    // Task 1 must complete before Task 2 can acquire lock
    expect(order).toEqual([1, 2, 3]);
  });

  it("reuses existing undestroyed socket in getVmSocket", async () => {
    const fakeSocket: any = { destroyed: false, write: vi.fn() };
    const vm: any = {
      id: "vm-existing-sock",
      vsock: "/tmp/fake.sock",
      socket: fakeSocket,
    };

    const sock = await getVmSocket(vm);
    expect(sock).toBe(fakeSocket);
  });

  it("deduplicates concurrent getVmSocket calls without creating multiple connections", async () => {
    let connectCalls = 0;
    const fakeSocket: any = { destroyed: false, write: vi.fn() };
    const vm: any = {
      id: "vm-concurrent-connect",
      vsock: "/tmp/fake2.sock",
    };

    vi.spyOn(net, "createConnection").mockImplementation(() => {
      connectCalls++;
      const emitter = new EventEmitter() as any;
      emitter.destroy = vi.fn();
      emitter.write = vi.fn();
      setTimeout(() => emitter.emit("connect"), 10);
      return emitter;
    });

    const [sock1, sock2] = await Promise.all([
      getVmSocket(vm),
      getVmSocket(vm),
    ]);

    expect(connectCalls).toBe(1);
    expect(sock1).toBe(sock2);
  });
});
