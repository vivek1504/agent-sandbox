import type { Socket } from "net";
import { vmLogger } from "../logger.js";
import { vsockErrors } from "../metrics.js";

export function readVsockResponse(
  socket: Socket,
  timeout: number,
  onStreamChunk?: (chunk: any) => void,
  expectedId?: string,
): Promise<{ type: string; data: any; error?: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    let onData: (chunk: Buffer) => void;
    let onError: (err: Error) => void;
    let onEnd: () => void;

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
    };

    const timer = setTimeout(() => {
      vmLogger.error({ timeoutMs: timeout }, "function execution timeout");
      vsockErrors.inc({ error_type: "timeout" });
      socket.destroy();
      reject(new Error("Function timeout"));
    }, timeout);

    onData = (chunk: Buffer) => {
      buffer += chunk.toString();

      if (buffer.length > 10 * 1024 * 1024) {
        clearTimeout(timer);
        cleanup();
        socket.destroy();
        reject(new Error("Response too large"));
        return;
      }

      let index;

      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);

        buffer = buffer.slice(index + 1);

        if (!line.trim() || line.startsWith("OK")) continue;

        try {
          const msg = JSON.parse(line);

          if (msg.type === "stream") {
            if (!expectedId || msg.id === expectedId) {
              onStreamChunk?.(msg);
            }
            continue;
          }

          if (msg.type === "response" || msg.type === "error") {
            if (expectedId && msg.id !== expectedId) {
              vmLogger.warn(
                { expectedId, receivedId: msg.id },
                "received response for unexpected message id, discarding",
              );
              continue;
            }

            clearTimeout(timer);
            cleanup();
            if (msg.type === "error") {
              vmLogger.warn(
                { errorData: msg.data, errorMsg: msg.error },
                "VM returned error response",
              );
            }
            resolve(msg);
            return;
          }
        } catch {
          vsockErrors.inc({ error_type: "parse_error" });
          vmLogger.error({ rawLine: line }, "invalid JSON received from VM");
        }
      }
    };

    onError = (err) => {
      clearTimeout(timer);
      cleanup();
      vsockErrors.inc({ error_type: "connection_error" });
      vmLogger.error({ err }, "vsock read error");
      reject(err);
    };

    onEnd = () => {
      clearTimeout(timer);
      cleanup();
      vsockErrors.inc({ error_type: "connection_closed" });
      vmLogger.error("vsock connection closed before response received");
      reject(new Error("Connection closed before response"));
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
  });
}

