import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./session/session.js", () => ({
  getAllSessions: vi.fn(() => [
    { sessionId: "s1" },
    { sessionId: "s2" },
  ]),
  destroySession: vi.fn(async () => true),
}));

import { installShutdownHandler } from "./shutdown.js";
import { destroySession, getAllSessions } from "./session/session.js";

describe("shutdown handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers SIGTERM and SIGINT listeners on process", () => {
    const fakeServer: any = { close: vi.fn() };
    const onSpy = vi.spyOn(process, "on");

    installShutdownHandler(fakeServer);

    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });
});
