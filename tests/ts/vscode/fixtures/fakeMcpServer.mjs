// A minimal MCP server for the bridge's tests: newline-delimited JSON-RPC on
// stdio (run as a script), or `handle` behind an HTTP endpoint. Two pages of
// tools, progress on `progressToken`, and a line on stderr at start.

/** Answer one JSON-RPC request; `notify` sends a notification first. */
export function handle(message, notify) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-tools", version: "9.9" },
      };
    case "tools/list":
      return message.params?.cursor
        ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "2" };
    case "tools/call": {
      const token = message.params._meta?.progressToken;
      if (token !== undefined) {
        notify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 2, message: "half" },
        });
      }
      return {
        content: [{ type: "text", text: "echoed" }],
        structuredContent: { arguments: message.params.arguments },
      };
    }
    default:
      return {};
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  process.stderr.write(`fake-tools started in ${process.cwd()} with FAKE=${process.env.FAKE}\n`);
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue; // notifications
      const result = handle(message, send);
      // Answer a call a moment after its progress, as a real tool does.
      const delay = message.method === "tools/call" ? 50 : 0;
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result }), delay);
    }
  });
}
