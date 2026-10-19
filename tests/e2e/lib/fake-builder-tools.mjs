// A stdio MCP server that replays the reference tool server's recorded
// responses (tests/fixtures/builder-tools/, recorded from
// hodakamori/megane-builder-tools with `make fixtures`), so the VS Code
// Builder's tool bridge can be exercised end to end without Python.
//
// Run as `node fake-builder-tools.mjs`; speaks newline-delimited JSON-RPC.
// Each call reports one progress step before its recorded result.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "builder-tools",
);
const read = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const TOOLS = read("tools-list.json").tools;
const CALLS = {
  liquid_box: read("call-liquid_box.json").result,
  polymer_chain: read("call-polymer_chain.json").result,
  solvate: read("call-solvate.json").result,
};

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stderr.write("fake-builder-tools: ready\n");

function answer(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "megane-builder-tools", version: "0.1.0" },
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const token = message.params._meta?.progressToken;
      if (token !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 2, message: "replaying" },
        });
      }
      return (
        CALLS[message.params.name] ?? {
          isError: true,
          content: [{ type: "text", text: `No recording for ${message.params.name}.` }],
        }
      );
    }
    default:
      return {};
  }
}

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
    const result = answer(message);
    const delay = message.method === "tools/call" ? 300 : 0;
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result }), delay);
  }
});
