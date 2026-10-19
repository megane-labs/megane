/**
 * The VS Code side of the Builder's tool bridge: where the servers come from
 * (the `megane.builder.mcpServers` setting), how the user is asked before one
 * is used (a modal), where a server's stderr goes (the *megane Builder Tools*
 * output channel), and the pool of connections every Builder tab shares. The
 * logic lives in `builderTools.ts`; this file only binds it to the VS Code API.
 */

import * as vscode from "vscode";
import * as os from "os";
import {
  BuilderToolsBridge,
  SETTING_KEY,
  SETTING_SECTION,
  ToolServerPool,
  createPermissionGate,
  defaultServer,
  extraSearchDirs,
  findExecutable,
  parseServerConfigs,
  withDefaultServer,
  type ServerConfig,
} from "./builderTools";

export interface BuilderToolsHost {
  /** The bridge for one Builder tab, answering through its webview. */
  bridgeFor: (webview: vscode.Webview) => BuilderToolsBridge;
  dispose: () => void;
}

/** The question asked before megane first uses a server (Builder Tool Contract §9). */
export function permissionDetail(config: ServerConfig, description: string): string {
  return config.kind === "stdio"
    ? `megane Builder will run this command on your computer to provide its tool buttons:\n\n${description}\n\nAllow only servers you trust.`
    : `megane Builder will send the structures you build with its tools to:\n\n${description}\n\nAllow only servers you trust.`;
}

export function createBuilderToolsHost(
  context: vscode.ExtensionContext,
  find: (name: string) => string | null = (name) =>
    findExecutable(name, { extraDirs: extraSearchDirs(os.homedir()) }),
): BuilderToolsHost {
  let channel: vscode.OutputChannel | undefined;
  const log = (line: string) => {
    channel ??= vscode.window.createOutputChannel("megane Builder Tools");
    channel.appendLine(line);
  };
  // The SDK is a bundle of its own, loaded on the first connection.
  const pool = new ToolServerPool(async (config) =>
    (await import("./sdkClient")).connectWithSdk(config, log),
  );
  const allow = createPermissionGate(context.globalState, async (config, description) => {
    const choice = await vscode.window.showWarningMessage(
      `Allow the tool server "${config.id}"?`,
      { modal: true, detail: permissionDetail(config, description) },
      "Allow",
    );
    return choice === "Allow";
  });

  let shownProblems = "";
  const servers = () => {
    const raw = vscode.workspace.getConfiguration(SETTING_SECTION).get(SETTING_KEY);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // The reference server is offered without any setting.
    const parsed = withDefaultServer(
      raw,
      parseServerConfigs(raw, { workspaceFolder, userHome: os.homedir() }),
      () => defaultServer(find, workspaceFolder),
    );
    // Say once what is wrong with the setting, not on every listing.
    const problems = parsed.problems.join("; ");
    if (problems && problems !== shownProblems) {
      void vscode.window.showWarningMessage(`megane.builder.mcpServers: ${problems}`);
    }
    shownProblems = problems;
    return parsed;
  };

  return {
    bridgeFor: (webview) =>
      new BuilderToolsBridge({
        servers,
        pool,
        allow,
        post: (message) => void webview.postMessage(message),
        openSettings: () =>
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            `${SETTING_SECTION}.${SETTING_KEY}`,
          ),
        log,
      }),
    dispose: () => {
      pool.dispose();
      channel?.dispose();
    },
  };
}
