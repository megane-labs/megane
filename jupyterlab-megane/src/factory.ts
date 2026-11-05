import { ABCWidgetFactory, DocumentWidget } from "@jupyterlab/docregistry";
import type { DocumentRegistry, IDocumentWidget } from "@jupyterlab/docregistry";
import type { Contents } from "@jupyterlab/services";
import { MeganeReactView } from "./MeganeDocWidget";
import { MeganePipelineReactView } from "./MeganePipelineDocWidget";
import type { ServerRequest } from "./serverFileBytes";

export class MeganeDocFactory extends ABCWidgetFactory<
  IDocumentWidget<MeganeReactView>,
  DocumentRegistry.IModel
> {
  /**
   * @param onForeignFile Called with a widget whose file Megane claimed only
   *   by its LAMMPS-style name and that turned out not to be LAMMPS
   *   (`handOffToOtherEditor`).
   */
  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<IDocumentWidget<MeganeReactView>>,
    private readonly contents: Contents.IManager,
    private readonly request: ServerRequest,
    private readonly onForeignFile?: (widget: IDocumentWidget<MeganeReactView>) => void,
  ) {
    super(options);
  }

  protected createNewWidget(context: DocumentRegistry.Context): IDocumentWidget<MeganeReactView> {
    // The view calls back only after its file has downloaded, by when
    // `widget` is set.
    const content = new MeganeReactView(context, this.contents, this.request, () =>
      this.onForeignFile?.(widget),
    );
    const widget = new DocumentWidget({ content, context });
    widget.title.iconClass = "jp-MaterialIcon jp-FileIcon";
    return widget;
  }
}

export class MeganePipelineDocFactory extends ABCWidgetFactory<
  IDocumentWidget<MeganePipelineReactView>,
  DocumentRegistry.IModel
> {
  constructor(
    options: DocumentRegistry.IWidgetFactoryOptions<IDocumentWidget<MeganePipelineReactView>>,
    private readonly contents: Contents.IManager,
    private readonly request: ServerRequest,
  ) {
    super(options);
  }

  protected createNewWidget(
    context: DocumentRegistry.Context,
  ): IDocumentWidget<MeganePipelineReactView> {
    const content = new MeganePipelineReactView(context, this.contents, this.request);
    const widget = new DocumentWidget({ content, context });
    widget.title.iconClass = "jp-MaterialIcon jp-FileIcon";
    return widget;
  }
}
