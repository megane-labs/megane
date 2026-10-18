/**
 * Compile-time guard for jupyterlab-megane/src/megane-modules.d.ts.
 *
 * The labextension cannot import the shared `src/` types (its tsc would pull
 * those files outside its rootDir), so the shim mirrors the declarations the
 * JupyterLab host uses. This file is part of the root `tsc --noEmit` program
 * (see tsconfig.json `include`) and fails it when a mirror drifts from the
 * real module. Nothing here runs; it is not a vitest file.
 */
import type { ComponentProps } from "react";
import type {
  MeganeViewer as RealMeganeViewer,
  MeganeViewerUiOptions as RealUiOptions,
} from "@/components/MeganeViewer";
import type { MeganeLocalState as RealLocalState } from "@/hooks/useMeganeLocal";
import type { MeganeCameraState as RealCameraState } from "@/renderer/MoleculeRenderer";
import type { SelectionState as RealSelection, Measurement as RealMeasurement } from "@/types";
import type {
  MeganeViewerProps as ShimProps,
  MeganeViewerUiOptions as ShimUiOptions,
  MeganeCameraState as ShimCameraState,
} from "@megane/components/MeganeViewer";
import type { MeganeLocalState as ShimLocalState } from "@megane/hooks/useMeganeLocal";
import type {
  SelectionState as ShimSelection,
  Measurement as ShimMeasurement,
} from "@megane/types";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assignable<From, To> = [From] extends [To] ? true : false;
type NoExtraKeys<Shim, Real> = [Exclude<keyof Shim, keyof Real>] extends [never] ? true : false;

type RealProps = ComponentProps<typeof RealMeganeViewer>;

/** Deprecated, never-called props the shim deliberately leaves out. */
type DeprecatedProps =
  | "onBondSourceChange"
  | "onLabelSourceChange"
  | "onLoadLabelFile"
  | "onVectorSourceChange"
  | "onLoadVectorFile"
  | "onLoadDemoVectors";

export type MeganeModulesShimChecks = [
  // Every prop the host may pass per the shim is accepted by the real viewer…
  Assert<Assignable<ShimProps, RealProps>>,
  // …the shim lists exactly the real, non-deprecated props…
  Assert<Equal<keyof ShimProps, Exclude<keyof RealProps, DeprecatedProps>>>,
  // …and the deprecated list names real props (drop it once they are removed).
  Assert<Assignable<DeprecatedProps, keyof RealProps>>,
  Assert<Equal<ShimUiOptions, RealUiOptions>>,
  Assert<Equal<ShimCameraState, RealCameraState>>,
  Assert<Equal<ShimSelection, RealSelection>>,
  Assert<Equal<ShimMeasurement, RealMeasurement>>,
  // The real hook provides everything the shim promises, and nothing the
  // shim lists is missing from it.
  Assert<Assignable<RealLocalState, ShimLocalState>>,
  Assert<NoExtraKeys<ShimLocalState, RealLocalState>>,
];
