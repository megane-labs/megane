/**
 * megane - Public library exports.
 * Use these to embed megane in your own React application.
 */

// React components
export { MeganeViewer, DEFAULT_MEGANE_VIEWER_UI } from "./components/MeganeViewer";
export type { MeganeViewerUiOptions } from "./components/MeganeViewer";
export { PipelineViewer } from "./components/PipelineViewer";
export { Viewport } from "./components/Viewport";
export { Sidebar } from "./components/Sidebar";
export { Timeline } from "./components/Timeline";

// Sidebar config types
export type { BondConfig, TrajectoryConfig } from "./components/Sidebar";

// Pipeline
export { PipelineEditor } from "./components/PipelineEditor";
export { usePipelineStore, createPipelineStore } from "./pipeline/store";
export type { PipelineStore } from "./pipeline/store";

// Multi-instance support (#672). Wrap each viewer in its own provider and the
// viewers stop sharing state; with no provider mounted every hook falls back
// to the module-global stores, so existing embedders are unaffected.
export {
  MeganeProvider,
  useMeganeStores,
  usePipelineStoreApi,
  usePlaybackStoreApi,
  useMeasurementStoreApi,
  useViewStateStoreApi,
  usePipelineUIStoreApi,
  useInspectorStoreApi,
  useScopedPipelineStore,
  useScopedPlaybackStore,
  useScopedMeasurementStore,
  useScopedViewStateStore,
  useScopedPipelineUIStore,
  useScopedInspectorStore,
} from "./stores/MeganeProvider";
export type { MeganeProviderProps } from "./stores/MeganeProvider";
export { createMeganeStores, globalMeganeStores } from "./stores/meganeStores";
export type { MeganeStores, CreateMeganeStoresOptions } from "./stores/meganeStores";
export { executePipeline } from "./pipeline/execute";
export { applyViewportState } from "./pipeline/apply";
export { serializePipeline, deserializePipeline } from "./pipeline/serialize";
export type {
  PipelineNodeType,
  PipelineNodeParams,
  PipelineDataType,
  PipelineData,
  ParticleData,
  PeriodicAtomImageData,
  DrawingBoundaryData,
  PeriodicBondTopologyData,
  BondData,
  CoordinationData,
  CellData,
  LabelData,
  MeshData,
  DrawingBoundaryParams,
  BoundaryCompletionParams,
  CoordinationGeneratorParams,
  PolyhedronGeneratorParams,
  ViewportState,
  SerializedPipeline,
} from "./pipeline/types";

// Structure parsers
export { parseStructureFile, parseStructureText } from "./parsers/structure";
export type { StructureParseResult } from "./parsers/structure";

// Core renderer (framework-agnostic)
export { MoleculeRenderer } from "./renderer/MoleculeRenderer";

// Pipeline builder API
export {
  Pipeline,
  LoadStructure,
  LoadTrajectory,
  Streaming,
  LoadVector,
  Filter,
  Modify,
  DrawingBoundary,
  BoundaryCompletion,
  Color,
  Representation,
  AddBonds,
  AddCoordination,
  AddLabels,
  AddPolyhedra,
  VectorOverlay,
  Viewport as ViewportNode,
} from "./pipeline/builder";

// Worker pool for off-main-thread decoding
export { WorkerPool } from "./protocol/WorkerPool";

// Protocol
export {
  decodeSnapshot,
  decodeFrame,
  decodeMetadata,
  decodeHeader,
  MSG_SNAPSHOT,
  MSG_FRAME,
  MSG_METADATA,
} from "./protocol/protocol";

// Types
export type {
  Snapshot,
  Frame,
  TrajectoryMeta,
  BondSource,
  TrajectorySource,
  AtomRenderer,
  BondRenderer,
  HoverInfo,
  AtomHoverInfo,
  BondHoverInfo,
  SelectionState,
  Measurement,
} from "./types";
