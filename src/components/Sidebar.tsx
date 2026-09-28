/**
 * Left sidebar panel for file management and viewer controls.
 */

import type { BondSource, TrajectorySource } from "../types";
import {
  STRUCTURE_ACCEPT,
  STRUCTURE_EXTS,
  TRAJECTORY_ACCEPT,
  TRAJECTORY_EXTS,
} from "../parsers/fileNames";
import {
  sectionLabelStyle,
  smallBtnStyle,
  activeBtnStyle,
  fileNameStyle,
  statsStyle,
  placeholderStyle,
  DropZone,
  TabSelector,
} from "./ui";

export interface BondConfig {
  source: BondSource;
  onSourceChange: (source: BondSource) => void;
  onUploadFile: (file: File) => void;
  fileName: string | null;
  count: number;
}

export interface TrajectoryConfig {
  source: TrajectorySource;
  onSourceChange: (source: TrajectorySource) => void;
  hasStructureFrames: boolean;
  hasFileFrames: boolean;
  fileName: string | null;
  totalFrames: number;
  timestepPs: number;
  onUploadXtc: (file: File) => void;
}

interface SidebarProps {
  mode: "streaming" | "local";
  onToggleMode?: () => void;
  structure: { atomCount: number; fileName: string | null };
  bonds: BondConfig;
  trajectory: TrajectoryConfig;
  onUploadStructure: (file: File) => void;
  onResetView: () => void;
  hasCell: boolean;
  cellVisible: boolean;
  onToggleCell: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const BOND_FILE_ACCEPT = ".pdb,.top";
const BOND_FILE_EXTS = [".pdb", ".top"];

export function Sidebar({
  mode,
  onToggleMode,
  structure,
  bonds,
  trajectory,
  onUploadStructure,
  onResetView,
  hasCell,
  cellVisible,
  onToggleCell,
  collapsed,
  onToggleCollapse,
}: SidebarProps) {
  if (collapsed) {
    return (
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 10,
        }}
        data-testid="sidebar-root"
        data-collapsed="true"
      >
        <button
          onClick={onToggleCollapse}
          data-testid="sidebar-toggle"
          style={{
            background: "var(--megane-surface)",
            backdropFilter: "blur(16px)",
            WebkitBackdropFilter: "blur(16px)",
            border: "1px solid var(--megane-border)",
            borderRadius: 10,
            padding: "8px 12px",
            cursor: "pointer",
            boxShadow: "0 1px 8px var(--megane-shadow)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 700,
            color: "var(--megane-text)",
            letterSpacing: "-0.02em",
          }}
          title="Open sidebar"
        >
          megane
          <span style={{ fontSize: 11, color: "var(--megane-text-muted)", fontWeight: 400 }}>
            &#9654;
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="sidebar-root"
      data-collapsed="false"
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        bottom: 60,
        width: 240,
        zIndex: 10,
        background: "var(--megane-surface)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRadius: 12,
        boxShadow: "0 1px 8px var(--megane-shadow)",
        border: "1px solid var(--megane-border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--megane-border)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            color: "var(--megane-text)",
            fontSize: 14,
            letterSpacing: "-0.02em",
          }}
        >
          megane
        </span>
        <button
          onClick={onToggleCollapse}
          data-testid="sidebar-toggle"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            color: "var(--megane-text-muted)",
            padding: "2px 4px",
          }}
          title="Collapse sidebar"
        >
          &#9664;
        </button>
      </div>

      {/* Scrollable content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {/* Mode Section (hidden when embedded / stream mode unavailable) */}
        {onToggleMode && (
          <div>
            <div style={sectionLabelStyle}>Mode</div>
            <div
              style={{
                display: "flex",
                borderRadius: 6,
                overflow: "hidden",
                border: "1px solid var(--megane-border-solid)",
              }}
            >
              <button
                onClick={mode === "local" ? undefined : onToggleMode}
                style={{
                  flex: 1,
                  background: mode === "local" ? "rgba(59,130,246,0.08)" : "none",
                  border: "none",
                  borderRight: "1px solid var(--megane-border-solid)",
                  padding: "4px 0",
                  cursor: mode === "local" ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  color: mode === "local" ? "var(--megane-primary)" : "var(--megane-text-muted)",
                  transition: "all 0.15s",
                }}
              >
                Local
              </button>
              <button
                onClick={mode === "streaming" ? undefined : onToggleMode}
                style={{
                  flex: 1,
                  background: mode === "streaming" ? "rgba(59,130,246,0.08)" : "none",
                  border: "none",
                  padding: "4px 0",
                  cursor: mode === "streaming" ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  color:
                    mode === "streaming" ? "var(--megane-primary)" : "var(--megane-text-muted)",
                  transition: "all 0.15s",
                }}
              >
                Stream
              </button>
            </div>
          </div>
        )}

        {/* Structure Section */}
        <div>
          <div style={sectionLabelStyle}>Structure</div>
          <DropZone
            accept={STRUCTURE_ACCEPT}
            exts={STRUCTURE_EXTS}
            onFile={onUploadStructure}
            label="Change..."
            testId="structure-upload"
          >
            {structure.fileName ? (
              <>
                <div style={fileNameStyle}>{structure.fileName}</div>
                {structure.atomCount > 0 && (
                  <div style={statsStyle}>{structure.atomCount.toLocaleString()} atoms</div>
                )}
              </>
            ) : (
              <div style={placeholderStyle}>No structure loaded</div>
            )}
          </DropZone>
        </div>

        {/* Bonds Section */}
        <div>
          <div style={sectionLabelStyle}>Bonds</div>
          <TabSelector<BondSource>
            options={[
              { value: "none", label: "None" },
              { value: "structure", label: "Structure" },
              { value: "file", label: "File" },
              { value: "distance", label: "Distance" },
            ]}
            value={bonds.source}
            onChange={bonds.onSourceChange}
          />
          {bonds.source === "file" && (
            <DropZone
              accept={BOND_FILE_ACCEPT}
              exts={BOND_FILE_EXTS}
              onFile={bonds.onUploadFile}
              label="Load PDB/TOP..."
              testId="bonds-upload"
            >
              {bonds.fileName && <div style={fileNameStyle}>{bonds.fileName}</div>}
            </DropZone>
          )}
          <div style={statsStyle}>{bonds.count.toLocaleString()} bonds</div>
        </div>

        {/* Trajectory Section */}
        <div>
          <div style={sectionLabelStyle}>Trajectory</div>
          <TabSelector<TrajectorySource>
            options={[
              { value: "structure", label: "Structure" },
              { value: "file", label: "File" },
            ]}
            value={trajectory.source}
            onChange={trajectory.onSourceChange}
            disabledOptions={
              new Set<TrajectorySource>([
                ...(!trajectory.hasStructureFrames ? ["structure" as TrajectorySource] : []),
              ])
            }
          />
          {trajectory.source === "file" && (
            <DropZone
              accept={TRAJECTORY_ACCEPT}
              exts={TRAJECTORY_EXTS}
              onFile={trajectory.onUploadXtc}
              label="Load trajectory..."
              testId="trajectory-upload"
            >
              {trajectory.fileName ? (
                <>
                  <div style={fileNameStyle}>{trajectory.fileName}</div>
                  <div style={statsStyle}>
                    {trajectory.totalFrames.toLocaleString()} frames
                    {trajectory.timestepPs > 0 &&
                      ` \u00b7 ${trajectory.timestepPs.toFixed(1)} ps/frame`}
                  </div>
                </>
              ) : (
                <div style={placeholderStyle}>No trajectory loaded</div>
              )}
            </DropZone>
          )}
          {trajectory.source === "structure" &&
            (trajectory.fileName ? (
              <>
                <div style={fileNameStyle}>{trajectory.fileName}</div>
                <div style={statsStyle}>{trajectory.totalFrames.toLocaleString()} frames</div>
              </>
            ) : (
              <div style={placeholderStyle}>No multi-model data</div>
            ))}
        </div>
      </div>

      {/* Footer actions */}
      <div
        style={{
          padding: "8px 14px",
          borderTop: "1px solid var(--megane-border)",
          display: "flex",
          gap: 6,
          flexShrink: 0,
        }}
      >
        <button onClick={onResetView} style={smallBtnStyle} title="Reset view">
          Reset
        </button>
        {hasCell && (
          <button
            onClick={onToggleCell}
            style={cellVisible ? activeBtnStyle : smallBtnStyle}
            title="Toggle simulation cell"
          >
            Cell
          </button>
        )}
      </div>
    </div>
  );
}
