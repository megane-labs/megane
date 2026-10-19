/**
 * The bridge between megane Builder tabs and MCP tool servers (Builder Tool
 * Contract §8, the VS Code row).
 *
 * A Builder webview cannot reach a tool server itself: it may not start a
 * process (stdio servers), its CSP blocks loopback requests, and its origin
 * changes with every tab, so no HTTP server can allow it. The extension host
 * does it instead. The user lists servers in the `megane.builder.mcpServers`
 * setting, in the `mcpServers` format LLM clients use:
 *
 * ```json
 * "megane.builder.mcpServers": {
 *   "builder-tools": { "command": "uvx", "args": ["megane-builder-tools"] },
 *   "lab": { "url": "https://tools.example.org/mcp", "headers": { "Authorization": "Bearer …" } }
 * }
 * ```
 *
 * Each Builder tab gets a `BuilderToolsBridge`, which answers the page's
 * messages (`src/builder/tools/bridgeProtocol.ts`): it lists the servers,
 * connects, relays a call with its progress, and cancels. Nothing else is
 * forwarded. Connections live in a `ToolServerPool` shared by all tabs, so a
 * stdio server is started once however many tabs use it, and stopped when the
 * last tab lets go of it.
 *
 * Without any setting, the reference server (`megane-builder-tools`: liquid
 * box, polymer chain, solvate) is offered too, started from the user's PATH or
 * else with uv at a pinned version (`defaultServer`); an entry of the same
 * name replaces it, and `"megane-builder-tools": null` hides it.
 *
 * Adding a server is installing software (§9): the first connection to a
 * server asks the user, showing the command line or URL, and the answer is
 * remembered for exactly that command or URL. The setting is restricted in
 * untrusted workspaces (`package.json` `capabilities`), so a cloned repository
 * cannot put a command there.
 */

import * as fs from "fs";
import * as path from "path";
import {
  isBridgeRequest,
  type BridgeConnected,
  type BridgeReply,
  type BridgeRequest,
  type BridgeServer,
} from "../../src/builder/tools/bridgeProtocol";

export const SETTING_SECTION = "megane.builder";
export const SETTING_KEY = "mcpServers";

export type ServerConfig =
  | {
      id: string;
      kind: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | { id: string; kind: "http"; url: string; headers: Record<string, string> };

/** Values `${…}` in a server entry may name. */
export interface ConfigVariables {
  workspaceFolder?: string;
  userHome?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

/** Replace `${workspaceFolder}` and `${userHome}`; an unknown or unset variable is left as written. */
export function substitute(text: string, vars: ConfigVariables): string {
  return text.replace(/\$\{(workspaceFolder|userHome)\}/g, (whole, name: keyof ConfigVariables) => {
    return vars[name] ?? whole;
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An HTTP server must use HTTPS unless it is on this machine (§9). */
export function checkServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol === "http:") return "must use https:// unless the server is on this machine";
  return "must be an http(s) URL";
}

/**
 * Read the `megane.builder.mcpServers` setting. Entries that cannot be used
 * are skipped and described in `problems`, so one typo does not hide the rest.
 */
export function parseServerConfigs(
  raw: unknown,
  vars: ConfigVariables = {},
): { servers: ServerConfig[]; problems: string[] } {
  const servers: ServerConfig[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { servers, problems };
  if (!isRecord(raw)) return { servers, problems: ["the setting must be an object of servers"] };
  for (const [id, entry] of Object.entries(raw)) {
    const fail = (why: string) => problems.push(`"${id}" ${why}`);
    if (entry === null || entry === false) continue; // turned off (hides the default server)
    if (!isRecord(entry)) {
      fail("must be an object with a command or a url");
      continue;
    }
    const type = entry.type;
    if (typeof entry.command === "string" && entry.command.trim()) {
      if (type !== undefined && type !== "stdio") {
        fail(`has a command but type "${String(type)}"`);
        continue;
      }
      const args = entry.args ?? [];
      const env = stringRecord(entry.env);
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
        fail("args must be a list of strings");
        continue;
      }
      if (!env) {
        fail("env must map names to strings");
        continue;
      }
      if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
        fail("cwd must be a string");
        continue;
      }
      servers.push({
        id,
        kind: "stdio",
        command: substitute(entry.command, vars),
        args: (args as string[]).map((a) => substitute(a, vars)),
        env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, substitute(v, vars)])),
        cwd: typeof entry.cwd === "string" ? substitute(entry.cwd, vars) : vars.workspaceFolder,
      });
    } else if (typeof entry.url === "string") {
      if (type !== undefined && type !== "http" && type !== "streamable-http") {
        fail(`has a url but type "${String(type)}" (only Streamable HTTP is supported)`);
        continue;
      }
      const url = substitute(entry.url, vars);
      const urlProblem = checkServerUrl(url);
      const headers = stringRecord(entry.headers);
      if (urlProblem) {
        fail(`url ${urlProblem}`);
        continue;
      }
      if (!headers) {
        fail("headers must map names to strings");
        continue;
      }
      servers.push({ id, kind: "http", url, headers });
    } else {
      fail("needs a command (stdio) or a url (Streamable HTTP)");
    }
  }
  return { servers, problems };
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line or URL, as the user is asked about it and the page shows it. */
export function describeServer(config: ServerConfig): string {
  return config.kind === "stdio"
    ? [config.command, ...config.args].map(quote).join(" ")
    : config.url;
}

/** What the user's permission covers: everything that decides what runs or where data goes. */
export function serverFingerprint(config: ServerConfig): string {
  return config.kind === "stdio"
    ? JSON.stringify(["stdio", config.command, config.args, config.env, config.cwd ?? null])
    : JSON.stringify(["http", config.url]);
}

/** The reference tool server, offered without any setting. */
export const DEFAULT_SERVER_ID = "megane-builder-tools";
/**
 * The version uv starts when `megane-builder-tools` is not installed: a commit
 * of hodakamori/megane-builder-tools, pinned so megane never runs code it was
 * not tested with. Move it with megane releases.
 */
export const DEFAULT_SERVER_SOURCE =
  "git+https://github.com/hodakamori/megane-builder-tools@b2aa9436c6030889ae18f04607fabe47c3a1f19f";

/**
 * Where a program is looked for besides PATH. An editor started from the Dock
 * or the Start menu does not see the shell's PATH, while uv and the tools it
 * installs live in `~/.local/bin` (formerly `~/.cargo/bin`).
 */
export function extraSearchDirs(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  return dirs;
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The full path of program `name` on PATH or in `extraDirs`, or null. */
export function findExecutable(
  name: string,
  options: {
    env?: Record<string, string | undefined>;
    extraDirs?: string[];
    platform?: NodeJS.Platform;
    isExecutable?: (file: string) => boolean;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = [...(env.PATH ?? "").split(separator), ...(options.extraDirs ?? [])].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext.toLowerCase());
      if (isExecutable(file)) return file;
    }
  }
  return null;
}

/**
 * The reference server as a stdio entry: `megane-builder-tools` from PATH if
 * the user installed it, else run by uvx at `DEFAULT_SERVER_SOURCE`, else
 * null (neither is available).
 */
export function defaultServer(
  find: (name: string) => string | null,
  cwd?: string,
): ServerConfig | null {
  const own = find("megane-builder-tools");
  if (own) return { id: DEFAULT_SERVER_ID, kind: "stdio", command: own, args: [], env: {}, cwd };
  const uvx = find("uvx");
  if (!uvx) return null;
  return {
    id: DEFAULT_SERVER_ID,
    kind: "stdio",
    command: uvx,
    args: ["--from", DEFAULT_SERVER_SOURCE, "megane-builder-tools"],
    env: {},
    cwd,
  };
}

/**
 * The configured servers plus the default one, unless the setting names a
 * server `megane-builder-tools` (its own, or `null` to hide it).
 */
export function withDefaultServer(
  raw: unknown,
  parsed: { servers: ServerConfig[]; problems: string[] },
  fallback: () => ServerConfig | null,
): { servers: ServerConfig[]; problems: string[] } {
  if (isRecord(raw) && DEFAULT_SERVER_ID in raw) return parsed;
  const server = fallback();
  return server ? { ...parsed, servers: [server, ...parsed.servers] } : parsed;
}

export function toBridgeServer(config: ServerConfig): BridgeServer {
  return { id: config.id, kind: config.kind, description: describeServer(config) };
}

/** A connected MCP client, reduced to what the bridge relays. */
export interface ToolClient {
  serverName: string;
  serverVersion: string | null;
  /** False once the server went away (the process exited, the session ended). */
  readonly open: boolean;
  /** `tools/list`, every page. */
  listTools: () => Promise<unknown[]>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      onProgress: (progress: number, total?: number, message?: string) => void;
    },
  ) => Promise<unknown>;
  close: () => Promise<void>;
}

export type ToolClientFactory = (config: ServerConfig) => Promise<ToolClient>;

/** One holder's use of a pooled connection. */
export interface Lease {
  client: ToolClient;
  /** Let go of the connection; the last holder's release closes it. Idempotent. */
  release: () => void;
}

interface PoolEntry {
  client: Promise<ToolClient>;
  holders: number;
}

/**
 * Connections shared by every Builder tab: one per server entry, started on
 * the first `acquire` and closed when the last holder releases it. A changed
 * entry is a different server (its fingerprint changed), and a connection
 * whose server went away is replaced on the next `acquire`; holders of the old
 * one release the old one.
 */
export class ToolServerPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(private readonly factory: ToolClientFactory) {}

  private key(config: ServerConfig): string {
    return `${config.id}\u0000${serverFingerprint(config)}`;
  }

  async acquire(config: ServerConfig): Promise<Lease> {
    const key = this.key(config);
    let entry = this.entries.get(key);
    if (entry) {
      const existing = await entry.client.catch(() => null);
      if (!existing?.open && this.entries.get(key) === entry) {
        this.entries.delete(key);
        entry = undefined;
      }
    }
    if (!entry) {
      entry = { client: this.factory(config), holders: 0 };
      this.entries.set(key, entry);
    }
    const held = entry;
    held.holders += 1;
    let client: ToolClient;
    try {
      client = await held.client;
    } catch (err) {
      held.holders -= 1;
      if (this.entries.get(key) === held) this.entries.delete(key);
      throw err;
    }
    let released = false;
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        held.holders -= 1;
        if (held.holders > 0) return;
        if (this.entries.get(key) === held) this.entries.delete(key);
        void client.close().catch(() => undefined);
      },
    };
  }

  /** Close every connection (the extension is deactivating). */
  dispose(): void {
    for (const entry of this.entries.values()) {
      void entry.client.then((client) => client.close()).catch(() => undefined);
    }
    this.entries.clear();
  }

  /** How many servers are connected (tests). */
  get size(): number {
    return this.entries.size;
  }
}

/** Where the user's permissions are remembered (`ExtensionContext.globalState`). */
export interface PermissionStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const PERMISSIONS_KEY = "megane.builder.allowedToolServers";

/**
 * Ask once per command line or URL whether megane may use a server (§9).
 * `ask` shows the question and resolves to whether the user allowed it.
 */
export function createPermissionGate(
  store: PermissionStore,
  ask: (config: ServerConfig, description: string) => Promise<boolean>,
): (config: ServerConfig) => Promise<boolean> {
  return async (config) => {
    const fingerprint = serverFingerprint(config);
    const allowed = store.get<string[]>(PERMISSIONS_KEY, []);
    if (allowed.includes(fingerprint)) return true;
    if (!(await ask(config, describeServer(config)))) return false;
    await store.update(PERMISSIONS_KEY, [...store.get<string[]>(PERMISSIONS_KEY, []), fingerprint]);
    return true;
  };
}

export interface BridgeDeps {
  /** The configured servers, read fresh on each request. */
  servers: () => { servers: ServerConfig[]; problems: string[] };
  pool: ToolServerPool;
  allow: (config: ServerConfig) => Promise<boolean>;
  post: (message: BridgeReply) => void;
  openSettings: () => void;
  log: (line: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One Builder tab's end of the bridge. */
export class BuilderToolsBridge {
  private readonly held = new Map<string, { config: ServerConfig; lease: Lease }>();
  private readonly calls = new Map<number, { server: string; controller: AbortController }>();
  private disposed = false;

  constructor(private readonly deps: BridgeDeps) {}

  /** Handle a message from the page; returns false when it is not a bridge request. */
  handle(message: unknown): boolean {
    if (!isBridgeRequest(message)) return false;
    void this.dispatch(message);
    return true;
  }

  private reply(
    requestId: number,
    result: { ok: true; value: unknown } | { ok: false; error: string },
  ) {
    if (this.disposed) return;
    this.deps.post({ type: "tools:reply", requestId, ...result } as BridgeReply);
  }

  private async dispatch(message: BridgeRequest): Promise<void> {
    switch (message.type) {
      case "tools:servers": {
        const { servers, problems } = this.deps.servers();
        for (const problem of problems) this.deps.log(`megane.builder.mcpServers: ${problem}`);
        this.reply(message.requestId, { ok: true, value: servers.map(toBridgeServer) });
        return;
      }
      case "tools:connect":
        try {
          this.reply(message.requestId, { ok: true, value: await this.connect(message.server) });
        } catch (err) {
          this.reply(message.requestId, { ok: false, error: errorText(err) });
        }
        return;
      case "tools:call":
        await this.call(message);
        return;
      case "tools:cancel":
        this.calls.get(message.requestId)?.controller.abort();
        return;
      case "tools:disconnect":
        this.drop(message.server);
        return;
      case "tools:openSettings":
        this.deps.openSettings();
        return;
    }
  }

  private async connect(id: string): Promise<BridgeConnected> {
    const config = this.deps.servers().servers.find((s) => s.id === id);
    if (!config) throw new Error(`There is no tool server "${id}" in megane.builder.mcpServers.`);
    if (!(await this.deps.allow(config))) {
      throw new Error(`Not allowed to use "${id}" (${describeServer(config)}).`);
    }
    const held = this.held.get(id);
    let client: ToolClient;
    if (
      held &&
      held.lease.client.open &&
      serverFingerprint(held.config) === serverFingerprint(config)
    ) {
      client = held.lease.client;
    } else {
      this.drop(id);
      const lease = await this.deps.pool.acquire(config);
      if (this.disposed) {
        lease.release();
        throw new Error("The Builder tab was closed.");
      }
      this.held.set(id, { config, lease });
      client = lease.client;
    }
    return {
      serverName: client.serverName,
      serverVersion: client.serverVersion,
      tools: await client.listTools(),
    };
  }

  private async call(message: Extract<BridgeRequest, { type: "tools:call" }>): Promise<void> {
    const { requestId, server } = message;
    const held = this.held.get(server);
    if (!held) {
      this.reply(requestId, { ok: false, error: `Not connected to "${server}".` });
      return;
    }
    const controller = new AbortController();
    this.calls.set(requestId, { server, controller });
    try {
      const value = await held.lease.client.callTool(message.name, message.arguments, {
        signal: controller.signal,
        timeoutMs: message.timeoutMs,
        onProgress: (progress, total, text) => {
          if (this.disposed || controller.signal.aborted) return;
          this.deps.post({ type: "tools:progress", requestId, progress, total, message: text });
        },
      });
      this.reply(requestId, { ok: true, value });
    } catch (err) {
      this.reply(requestId, {
        ok: false,
        error: controller.signal.aborted ? "Cancelled." : errorText(err),
      });
    } finally {
      this.calls.delete(requestId);
    }
  }

  /** Let go of a server: its calls from this tab are cancelled. */
  private drop(server: string): void {
    for (const call of this.calls.values()) {
      if (call.server === server) call.controller.abort();
    }
    const held = this.held.get(server);
    if (!held) return;
    this.held.delete(server);
    held.lease.release();
  }

  /** The tab closed: cancel its calls and release its servers. */
  dispose(): void {
    for (const server of [...this.held.keys()]) this.drop(server);
    for (const call of this.calls.values()) call.controller.abort();
    this.disposed = true;
  }
}
