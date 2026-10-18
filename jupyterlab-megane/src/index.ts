import { ILayoutRestorer, JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { WidgetTracker } from "@jupyterlab/apputils";
import type { IDocumentWidget } from "@jupyterlab/docregistry";
import { IStatusBar } from "@jupyterlab/statusbar";
import { IDefaultFileBrowser } from "@jupyterlab/filebrowser";
import { setRemoteFileSource } from "@megane/remote/fileSource";
import { exposeAppForTests } from "./testHook";
import { MeganeDocFactory, MeganePipelineDocFactory } from "./factory";
import { setupFrameStatusBar } from "./frameStatusBar";
import { createJupyterFileSource } from "./remoteFiles";
import { builderPlugin } from "./builder/plugin";
import type { MeganeReactView } from "./MeganeDocWidget";
import type { MeganePipelineReactView } from "./MeganePipelineDocWidget";
import {
  FACTORY_NAME,
  FACTORY_NAME_BINARY,
  FACTORY_NAME_PIPELINE,
  PIPELINE_FILETYPE,
  PIPELINE_FILETYPE_NAME,
  STRUCTURE_FILETYPES_TEXT,
  STRUCTURE_FILETYPES_BINARY,
  STRUCTURE_FILETYPE_NAMES_TEXT,
  STRUCTURE_FILETYPE_NAMES_BINARY,
} from "./filetypes";

const PLUGIN_ID = "megane-jupyterlab:plugin";
const TRACKER_NAMESPACE = "megane";
const PIPELINE_TRACKER_NAMESPACE = "megane-pipeline";

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    "Open molecular structure files (PDB, GRO, XYZ, MOL, SDF, CIF, LAMMPS data, ASE traj) and trajectories (XTC, DCD, LAMMPS dump) and megane pipelines",
  autoStart: true,
  requires: [ILayoutRestorer],
  optional: [IStatusBar, IDefaultFileBrowser],
  activate: (
    app: JupyterFrontEnd,
    restorer: ILayoutRestorer,
    statusBar: IStatusBar | null,
    browser?: { model: { path: string } } | null,
  ) => {
    exposeAppForTests(app);

    // The Load nodes' "Open from server..." dialog browses the Jupyter
    // server's files, starting in the file browser's folder.
    setRemoteFileSource(
      createJupyterFileSource(app.serviceManager.contents, () => browser?.model.path ?? ""),
    );

    for (const ft of [...STRUCTURE_FILETYPES_TEXT, ...STRUCTURE_FILETYPES_BINARY]) {
      app.docRegistry.addFileType(ft);
    }
    app.docRegistry.addFileType(PIPELINE_FILETYPE);

    const textFactory = new MeganeDocFactory(
      {
        name: FACTORY_NAME,
        modelName: "text",
        fileTypes: STRUCTURE_FILETYPE_NAMES_TEXT,
        defaultFor: STRUCTURE_FILETYPE_NAMES_TEXT,
        readOnly: true,
      },
      app.serviceManager.contents,
    );
    app.docRegistry.addWidgetFactory(textFactory);

    const binaryFactory = new MeganeDocFactory(
      {
        name: FACTORY_NAME_BINARY,
        modelName: "base64",
        fileTypes: STRUCTURE_FILETYPE_NAMES_BINARY,
        defaultFor: STRUCTURE_FILETYPE_NAMES_BINARY,
        readOnly: true,
      },
      app.serviceManager.contents,
    );
    app.docRegistry.addWidgetFactory(binaryFactory);

    const pipelineFactory = new MeganePipelineDocFactory(
      {
        name: FACTORY_NAME_PIPELINE,
        modelName: "text",
        fileTypes: [PIPELINE_FILETYPE_NAME],
        defaultFor: [PIPELINE_FILETYPE_NAME],
        readOnly: true,
      },
      app.serviceManager.contents,
    );
    app.docRegistry.addWidgetFactory(pipelineFactory);

    const tracker = new WidgetTracker<IDocumentWidget<MeganeReactView>>({
      namespace: TRACKER_NAMESPACE,
    });
    const pipelineTracker = new WidgetTracker<IDocumentWidget<MeganePipelineReactView>>({
      namespace: PIPELINE_TRACKER_NAMESPACE,
    });

    for (const factory of [textFactory, binaryFactory]) {
      factory.widgetCreated.connect((_sender, widget) => {
        widget.context.pathChanged.connect(() => {
          void tracker.save(widget);
        });
        void tracker.add(widget);
      });
    }

    pipelineFactory.widgetCreated.connect((_sender, widget) => {
      widget.context.pathChanged.connect(() => {
        void pipelineTracker.save(widget);
      });
      void pipelineTracker.add(widget);
    });

    const binaryExtensions = new Set(STRUCTURE_FILETYPES_BINARY.flatMap((f) => f.extensions ?? []));
    const factoryForPath = (path: string): string => {
      if (path.toLowerCase().endsWith(".megane.json")) return FACTORY_NAME_PIPELINE;
      const dot = path.lastIndexOf(".");
      const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
      return binaryExtensions.has(ext) ? FACTORY_NAME_BINARY : FACTORY_NAME;
    };

    void restorer.restore(tracker, {
      command: "docmanager:open",
      // Restore via the factory that originally opened the widget so binary
      // documents come back with the base64 model.
      args: (widget) => ({
        path: widget.context.path,
        factory: factoryForPath(widget.context.path),
      }),
      name: (widget) => widget.context.path,
    });

    void restorer.restore(pipelineTracker, {
      command: "docmanager:open",
      args: (widget) => ({
        path: widget.context.path,
        factory: FACTORY_NAME_PIPELINE,
      }),
      name: (widget) => widget.context.path,
    });

    if (statusBar) {
      setupFrameStatusBar(tracker, statusBar);
    }
  },
};

export { plugin, builderPlugin };
export default [plugin, builderPlugin];
