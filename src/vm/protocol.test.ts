import { describe, it, expect } from "vitest";
import { readVsockResponse } from "./protocol.js";
import { PassThrough } from "stream";
import type { Socket } from "net";

describe("readVsockResponse", () => {
  function makeFakeSocket() {
    return new PassThrough() as unknown as Socket;
  }

  it("resolves on a valid response message", async () => {
    const socket = makeFakeSocket();
    const promise = readVsockResponse(socket, 5000);

    socket.push(
      JSON.stringify({
        type: "response",
        data: { statusCode: 200, body: "ok" },
      }) + "\n",
    );

    const msg = await promise;
    expect(msg.type).toBe("response");
    expect(msg.data.statusCode).toBe(200);
  });

  it("resolves on an error message", async () => {
    const socket = makeFakeSocket();
    const promise = readVsockResponse(socket, 5000);

    socket.push(
      JSON.stringify({ type: "error", data: null, error: "boom" }) + "\n",
    );

    const msg = await promise;
    expect(msg.type).toBe("error");
    expect(msg.error).toBe("boom");
  });

  it("skips OK lines and waits for real response", async () => {
    const socket = makeFakeSocket();
    const promise = readVsockResponse(socket, 5000);

    socket.push("OK\n");
    socket.push(
      JSON.stringify({ type: "response", data: { statusCode: 201 } }) + "\n",
    );

    const msg = await promise;
    expect(msg.data.statusCode).toBe(201);
  });

  it("rejects on timeout", async () => {
    const socket = makeFakeSocket();
    (socket as any).destroy = () => socket.end();

    await expect(readVsockResponse(socket, 100)).rejects.toThrow(
      "Function timeout",
    );
  });

  it("delivers stream chunks and completes with final response", async () => {
    const socket = makeFakeSocket();
    const chunks: any[] = [];
    const promise = readVsockResponse(
      socket,
      500,
      (chunk) => chunks.push(chunk),
      "msg-123",
    );

    socket.push(
      JSON.stringify({ type: "stream", id: "msg-123", stream: "stdout", data: "chunk 1\n" }) + "\n",
    );
    socket.push(
      JSON.stringify({ type: "stream", id: "msg-123", stream: "stdout", data: "chunk 2\n" }) + "\n",
    );
    socket.push(
      JSON.stringify({ type: "response", id: "msg-123", data: { exitCode: 0 } }) + "\n",
    );

    const res = await promise;
    expect(chunks).toHaveLength(2);
    expect(chunks[0].data).toBe("chunk 1\n");
    expect(chunks[1].data).toBe("chunk 2\n");
    expect(res.data.exitCode).toBe(0);
  });
});
