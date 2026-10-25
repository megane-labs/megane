use crate::atomic::symbol_to_atomic_num;

/// Atomic number from an XYZ element column: a symbol (`O`), or an explicit
/// atomic number (`8`), which some writers emit and which is the most
/// authoritative element field a file can carry.
fn element_number(token: &str) -> u8 {
    match token.parse::<i32>() {
        Ok(n) if (1..=118).contains(&n) => n as u8,
        Ok(_) => 0,
        Err(_) => symbol_to_atomic_num(&crate::atomic::capitalize(token)),
    }
}
use crate::bonds;
use crate::structure::{FrameChange, HeteroFramesBuilder};
use crate::trajectory::{ScalarChannel, ScalarFrame, VectorChannel, VectorFrame};
/// XYZ text format parser.
///
/// Format (repeating blocks for multi-frame):
///   Line 1: number of atoms
///   Line 2: comment
///   Lines 3..n+2: element x y z [extra_fields...] (Angstrom)
///
/// Extended-XYZ `Properties=` declarations turn declared per-atom columns into
/// channels: 3-column reals (velocities, forces, ...) become vector channels
/// and 1-column numbers (charges, ids, ...) become scalar channels, instead of
/// being flattened into the atom label.
use std::collections::HashSet;

/// Parse `Lattice="ax ay az bx by bz cx cy cz"` from an extended XYZ comment line.
fn parse_lattice(comment: &str) -> Option<[f32; 9]> {
    let idx = comment.find("Lattice=")?;
    let rest = &comment[idx + 8..];
    let quote_char = rest.chars().next()?;
    if quote_char != '"' && quote_char != '\'' {
        return None;
    }
    let inner_start = quote_char.len_utf8();
    let inner_end = rest[inner_start..].find(quote_char)?;
    let inner = &rest[inner_start..inner_start + inner_end];
    let vals: Vec<f32> = inner
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    if vals.len() == 9 {
        let mut m = [0.0f32; 9];
        m.copy_from_slice(&vals);
        Some(m)
    } else {
        None
    }
}

/// Parse the extXYZ `Properties=name:type:cols:...` declaration into
/// (name, type char, column count) triples. `None` when absent or malformed.
fn parse_properties(comment: &str) -> Option<Vec<(String, char, usize)>> {
    let idx = comment.find("Properties=")?;
    let rest = &comment[idx + 11..];
    // The value may be quoted; unquoted it runs to the next whitespace.
    let value = match rest.chars().next()? {
        q @ ('"' | '\'') => {
            let inner = &rest[1..];
            &inner[..inner.find(q)?]
        }
        _ => rest.split_whitespace().next()?,
    };
    let fields: Vec<&str> = value.split(':').collect();
    if fields.is_empty() || !fields.len().is_multiple_of(3) {
        return None;
    }
    let mut props = Vec::with_capacity(fields.len() / 3);
    for triple in fields.chunks(3) {
        let name = triple[0];
        let mut kind_chars = triple[1].chars();
        let kind = kind_chars.next()?;
        let cols: usize = triple[2].parse().ok()?;
        if name.is_empty() || kind_chars.next().is_some() || cols == 0 {
            return None;
        }
        props.push((name.to_string(), kind, cols));
    }
    Some(props)
}

/// Map common extXYZ property names onto megane's conventional channel names
/// (matching the GRO/lammpstrj "velocity" and lammpstrj/XSF "force" channels).
fn canonical_channel_name(name: &str) -> &str {
    match name {
        "vel" | "velo" | "velocities" => "velocity",
        "forces" => "force",
        _ => name,
    }
}

/// One extractable per-atom column group from an extXYZ `Properties=`
/// declaration: 3-column reals become vector channels, 1-column numbers
/// become scalar channels.
struct PropPlan {
    name: String,
    /// First whitespace-split column of the group on each atom line.
    start: usize,
    /// Column count: 3 (vector) or 1 (scalar).
    cols: usize,
}

/// Build the channel-extraction plan for a comment line. Empty when there is
/// no `Properties=` declaration, it is malformed, or its leading columns don't
/// match the fixed species + pos layout this parser reads (column 0 = symbol,
/// columns 1-3 = coordinates).
fn channel_plan(comment: &str) -> Vec<PropPlan> {
    let Some(props) = parse_properties(comment) else {
        return Vec::new();
    };
    if props.len() < 2
        || props[0].1 != 'S'
        || props[0].2 != 1
        || props[1].0 != "pos"
        || props[1].1 != 'R'
        || props[1].2 != 3
    {
        return Vec::new();
    }
    let mut plan: Vec<PropPlan> = Vec::new();
    let mut start = 0usize;
    for (name, kind, cols) in &props {
        // Only columns past x/y/z are candidates; anything that is not a
        // 3-column real or 1-column number stays in the atom label.
        let extract = start >= 4 && matches!((kind, cols), ('R', 3) | ('R', 1) | ('I', 1));
        if extract {
            let name = canonical_channel_name(name).to_string();
            if !plan.iter().any(|p| p.name == name) {
                plan.push(PropPlan {
                    name,
                    start,
                    cols: *cols,
                });
            }
        }
        start += cols;
    }
    plan
}

/// Parse one atom line's planned numeric columns into the channel buffers.
/// Returns false when a declared column is missing or non-numeric (the caller
/// then abandons extraction for the whole frame).
fn extract_atom_props(parts: &[&str], plan: &[PropPlan], data: &mut [Vec<f32>]) -> bool {
    for (p, buf) in plan.iter().zip(data.iter_mut()) {
        if parts.len() < p.start + p.cols {
            return false;
        }
        for c in 0..p.cols {
            match parts[p.start + c].parse::<f32>() {
                Ok(v) => buf.push(v),
                Err(_) => return false,
            }
        }
    }
    true
}

/// Label columns left after channel extraction: everything past x/y/z that no
/// extracted property covers (string properties, undeclared trailing columns).
fn reduced_label(parts: &[&str], plan: &[PropPlan]) -> String {
    let covered = |j: usize| plan.iter().any(|p| j >= p.start && j < p.start + p.cols);
    (4..parts.len())
        .filter(|&j| !covered(j))
        .map(|j| parts[j])
        .collect::<Vec<_>>()
        .join(" ")
}

/// Per-property accumulator over the frames that carried it.
struct ChannelAccum {
    name: String,
    is_vector: bool,
    /// (overall frame index, flat per-atom data) in frame order.
    frames: Vec<(usize, Vec<f32>)>,
}

fn record_channels(
    accums: &mut Vec<ChannelAccum>,
    plan: &[PropPlan],
    frame: usize,
    data: Vec<Vec<f32>>,
) {
    for (p, buf) in plan.iter().zip(data) {
        let is_vector = p.cols == 3;
        if let Some(acc) = accums.iter_mut().find(|a| a.name == p.name) {
            // A shape mismatch across frames counts as a missing frame.
            if acc.is_vector == is_vector {
                acc.frames.push((frame, buf));
            }
        } else {
            accums.push(ChannelAccum {
                name: p.name.clone(),
                is_vector,
                frames: vec![(frame, buf)],
            });
        }
    }
}

pub fn parse(text: &str) -> Result<crate::structure::ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 2 {
        return Err("XYZ file too short".into());
    }

    let mut offset = 0;
    let mut first_positions: Option<Vec<f32>> = None;
    let mut first_elements: Option<Vec<u8>> = None;
    let mut first_labels: Option<Vec<String>> = None;
    let mut first_n_atoms = 0usize;
    // Frame-0 lattice (also the fallback cell carried into frames that omit one).
    let mut box_matrix: Option<[f32; 9]> = None;
    // Extra frames (frame 0 lives in `first_positions`) and their lazily
    // recorded heterogeneity side table; re-seeded with frame 0's atom count
    // once frame 0 is read. A uniform multi-frame XYZ allocates no side table.
    let mut frames = HeteroFramesBuilder::new(0);
    // Per-atom channels declared by extXYZ Properties, accumulated per frame.
    let mut channel_accums: Vec<ChannelAccum> = Vec::new();
    // Reused across every atom line so each line's split does not allocate a Vec.
    let mut parts: Vec<&str> = Vec::new();

    while offset < lines.len() {
        // Line 1: atom count
        let count_line = lines[offset].trim();
        if count_line.is_empty() {
            offset += 1;
            continue;
        }
        let n_atoms: usize = count_line
            .parse()
            .map_err(|_| format!("cannot parse atom count at line {}", offset + 1))?;

        if offset + 2 + n_atoms > lines.len() {
            break; // incomplete frame, skip
        }

        // Line 2: comment — parse this frame's lattice and channel plan.
        let frame_lattice = parse_lattice(lines[offset + 1]);
        let plan = channel_plan(lines[offset + 1]);
        offset += 2;

        let is_first = first_positions.is_none();
        let mut positions = Vec::with_capacity(n_atoms * 3);
        let mut elements = Vec::with_capacity(n_atoms);
        let mut labels = Vec::with_capacity(n_atoms);
        // Channel buffers for this frame; extraction is abandoned wholesale
        // (falling back to the joined-label behavior) on any bad column.
        let mut ext_ok = !plan.is_empty();
        let mut ext_data: Vec<Vec<f32>> = plan
            .iter()
            .map(|p| Vec::with_capacity(n_atoms * p.cols))
            .collect();
        let mut ext_labels: Vec<String> = Vec::new();

        for i in 0..n_atoms {
            let line = lines[offset + i];
            parts.clear();
            parts.extend(line.split_whitespace());
            if parts.len() < 4 {
                return Err(format!("XYZ atom line {} too short", offset + i + 1));
            }

            // Element symbol (or atomic number)
            elements.push(element_number(parts[0]));

            // Extra fields after x y z as label
            let label = if parts.len() > 4 {
                parts[4..].join(" ")
            } else {
                String::new()
            };
            labels.push(label);

            if ext_ok {
                if extract_atom_props(&parts, &plan, &mut ext_data) {
                    if is_first {
                        ext_labels.push(reduced_label(&parts, &plan));
                    }
                } else {
                    ext_ok = false;
                    ext_data.clear();
                    ext_labels.clear();
                }
            }

            // Coordinates (already in Angstrom)
            let x: f32 = parts[1]
                .parse()
                .map_err(|_| format!("bad x coord at line {}", offset + i + 1))?;
            let y: f32 = parts[2]
                .parse()
                .map_err(|_| format!("bad y coord at line {}", offset + i + 1))?;
            let z: f32 = parts[3]
                .parse()
                .map_err(|_| format!("bad z coord at line {}", offset + i + 1))?;

            positions.push(x);
            positions.push(y);
            positions.push(z);
        }

        offset += n_atoms;

        if ext_ok {
            // Extracted columns leave the label; only string/undeclared ones stay.
            if is_first {
                labels = ext_labels;
            }
            let frame_no = if is_first {
                0
            } else {
                frames.extra_frames() + 1
            };
            record_channels(&mut channel_accums, &plan, frame_no, ext_data);
        }

        if is_first {
            first_n_atoms = n_atoms;
            frames = HeteroFramesBuilder::new(n_atoms);
            box_matrix = frame_lattice;
            first_positions = Some(positions);
            first_elements = Some(elements);
            first_labels = Some(labels);
            continue;
        }

        // Extra frame: every frame is kept (jagged), unlike the old fixed-stride
        // path that silently dropped mismatched frames. Topology changes when
        // the element list differs from frame 0; a frame that omits `Lattice=`
        // inherits frame 0's cell (no variation) — only a present-and-different
        // lattice counts as a change.
        let first_elems = first_elements.as_deref().unwrap_or_default();
        let change = FrameChange {
            topology: !frames.varies_topology() && elements != first_elems,
            cell: !frames.varies_cell() && frame_lattice.is_some_and(|fl| Some(fl) != box_matrix),
        };
        frames.push_frame(
            &positions,
            move || elements,
            frame_lattice.or(box_matrix),
            change,
        );
    }

    let positions = first_positions.ok_or("XYZ file contains no atoms")?;
    // SAFETY: first_elements is always set when first_positions is set
    let elements = first_elements.ok_or("XYZ file contains no atoms")?;

    // Infer bonds from first frame
    let empty_bonds = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, first_n_atoms, &empty_bonds);

    let atom_labels = first_labels.filter(|labels| labels.iter().any(|l| !l.is_empty()));

    // Assemble the heterogeneous side-table only when some channel varies; a
    // uniform multi-frame XYZ keeps `hetero: None` and the fast fixed-stride path.
    let varies_atoms = frames.varies_atoms();
    let total_frames = 1 + frames.extra_frames();
    let (frame_positions_flat, hetero) = frames.finish(&elements, box_matrix);

    // Emit extXYZ channels: frame-synced when every frame (with a fixed atom
    // count — channels assume a fixed per-atom stride) carried the property,
    // otherwise a static frame-0 channel plus one aggregated warning.
    let mut vector_channels: Vec<VectorChannel> = Vec::new();
    let mut scalar_channels: Vec<ScalarChannel> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut partial: Vec<String> = Vec::new();
    for acc in channel_accums {
        let complete = !varies_atoms && acc.frames.len() == total_frames;
        let frames = if complete {
            acc.frames
        } else {
            partial.push(acc.name.clone());
            match acc.frames.into_iter().next() {
                Some((0, data)) => vec![(0, data)],
                _ => continue, // no frame-0 data to keep
            }
        };
        if acc.is_vector {
            vector_channels.push(VectorChannel {
                name: acc.name,
                frames: frames
                    .into_iter()
                    .map(|(frame, vectors)| VectorFrame { frame, vectors })
                    .collect(),
            });
        } else {
            scalar_channels.push(ScalarChannel {
                name: acc.name,
                frames: frames
                    .into_iter()
                    .map(|(frame, values)| ScalarFrame { frame, values })
                    .collect(),
            });
        }
    }
    if !partial.is_empty() {
        warnings.push(format!(
            "extXYZ per-atom properties not captured for every frame: {}; only frame-0 values were kept",
            partial.join(", ")
        ));
    }

    Ok(crate::structure::ParsedStructure {
        n_atoms: first_n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        frame_positions_flat,
        atom_labels,
        vector_channels,
        scalar_channels,
        warnings,
        hetero,
        ..Default::default()
    })
}

// ---------- Lazy / streaming support ----------

/// Lightweight index over a multi-frame XYZ: byte offset of each EXTRA frame
/// (frames 1..N; frame 0 is the eager snapshot), built without parsing
/// coordinates. Frames whose atom count differs from frame 0 are skipped, exactly
/// as the eager parser drops them.
pub struct XyzIndex {
    pub n_atoms: usize,
    /// Number of extra frames (excludes frame 0).
    pub n_extra_frames: usize,
    /// Byte offset of each extra frame's count line.
    pub offsets: Vec<usize>,
    /// True when the file is *heterogeneous* — some frame's atom count or
    /// per-frame `Lattice=` differs from frame 0, or an extra frame declares
    /// extractable per-atom `Properties=` channels. The lazy positions-only
    /// decode path cannot represent such frames, so the host falls back to an
    /// eager parse (which builds the full `HeteroFrames` side table and the
    /// frame-synced channels). Detected cheaply from the count and comment
    /// lines without decoding any atom coordinates.
    /// (A same-atom-count frame that varies only in element identity is not
    /// detectable here without parsing atoms and is left to the eager path.)
    pub heterogeneous: bool,
    /// Byte offset just past frame 0's last line: `text[..frame0_end]` holds
    /// all of frame 0, so it can be parsed without the rest of the file.
    pub frame0_end: u64,
}

/// Parse only the first frame of an XYZ file into a `ParsedStructure` (topology,
/// elements, bonds, box, frame-0 coordinates), leaving `frame_positions_flat`
/// empty. Used to build the lazy snapshot without decoding every frame.
pub fn parse_frame0(text: &str) -> Result<crate::structure::ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 {
        return Err("XYZ file too short".into());
    }

    let mut offset = 0;
    // Skip leading blank count lines (matches the eager parser).
    while offset < lines.len() && lines[offset].trim().is_empty() {
        offset += 1;
    }
    if offset + 2 > lines.len() {
        return Err("XYZ file contains no atoms".into());
    }
    let n_atoms: usize = lines[offset]
        .trim()
        .parse()
        .map_err(|_| format!("cannot parse atom count at line {}", offset + 1))?;
    if offset + 2 + n_atoms > lines.len() {
        return Err("XYZ first frame incomplete".into());
    }

    let box_matrix = parse_lattice(lines[offset + 1]);
    let plan = channel_plan(lines[offset + 1]);
    offset += 2;

    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut elements = Vec::with_capacity(n_atoms);
    let mut labels = Vec::with_capacity(n_atoms);
    let mut ext_ok = !plan.is_empty();
    let mut ext_data: Vec<Vec<f32>> = plan
        .iter()
        .map(|p| Vec::with_capacity(n_atoms * p.cols))
        .collect();
    let mut ext_labels: Vec<String> = Vec::new();
    let mut parts: Vec<&str> = Vec::new();
    for i in 0..n_atoms {
        let line = lines[offset + i];
        parts.clear();
        parts.extend(line.split_whitespace());
        if parts.len() < 4 {
            return Err(format!("XYZ atom line {} too short", offset + i + 1));
        }
        elements.push(element_number(parts[0]));
        let label = if parts.len() > 4 {
            parts[4..].join(" ")
        } else {
            String::new()
        };
        labels.push(label);
        if ext_ok {
            if extract_atom_props(&parts, &plan, &mut ext_data) {
                ext_labels.push(reduced_label(&parts, &plan));
            } else {
                ext_ok = false;
                ext_data.clear();
                ext_labels.clear();
            }
        }
        let x: f32 = parts[1]
            .parse()
            .map_err(|_| format!("bad x coord at line {}", offset + i + 1))?;
        let y: f32 = parts[2]
            .parse()
            .map_err(|_| format!("bad y coord at line {}", offset + i + 1))?;
        let z: f32 = parts[3]
            .parse()
            .map_err(|_| format!("bad z coord at line {}", offset + i + 1))?;
        positions.push(x);
        positions.push(y);
        positions.push(z);
    }

    // Frame-0 snapshot: extracted properties become static channels here; any
    // later-frame values are picked up by the eager fallback (`build_index`
    // marks files whose extra frames declare channels as heterogeneous).
    let mut vector_channels: Vec<VectorChannel> = Vec::new();
    let mut scalar_channels: Vec<ScalarChannel> = Vec::new();
    if ext_ok {
        labels = ext_labels;
        for (p, data) in plan.iter().zip(ext_data) {
            if p.cols == 3 {
                vector_channels.push(VectorChannel {
                    name: p.name.clone(),
                    frames: vec![VectorFrame {
                        frame: 0,
                        vectors: data,
                    }],
                });
            } else {
                scalar_channels.push(ScalarChannel {
                    name: p.name.clone(),
                    frames: vec![ScalarFrame {
                        frame: 0,
                        values: data,
                    }],
                });
            }
        }
    }

    let empty_bonds = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);
    let atom_labels = if labels.iter().any(|l| !l.is_empty()) {
        Some(labels)
    } else {
        None
    };

    Ok(crate::structure::ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        box_matrix,
        atom_labels,
        vector_channels,
        scalar_channels,
        ..Default::default()
    })
}

/// Scan a multi-frame XYZ and record each EXTRA frame's byte offset without
/// decoding coordinates.
pub fn build_index(text: &str) -> Result<XyzIndex, String> {
    let mut builder = XyzIndexBuilder::default();
    crate::lines::for_each_line(text, |line, start, end| builder.push_line(line, start, end))?;
    builder.finish()
}

/// Where the XYZ index scan is within a frame.
#[derive(Default)]
enum XyzScan {
    /// Expecting a frame's atom-count line (blank lines are skipped).
    #[default]
    Count,
    /// Expecting the comment line of a frame of `n_atoms` atoms.
    Comment { start: u64, n_atoms: usize },
    /// Skipping `remaining` atom lines of a frame.
    Atoms {
        start: u64,
        n_atoms: usize,
        remaining: usize,
        lattice: Option<[f32; 9]>,
        has_channels: bool,
    },
}

/// The [`build_index`] scan, fed one line at a time (see `crate::lines`), so a
/// file can be indexed window by window without being held whole.
#[derive(Default)]
pub struct XyzIndexBuilder {
    scan: XyzScan,
    line_no: usize,
    first_n_atoms: Option<usize>,
    first_lattice: Option<[f32; 9]>,
    offsets: Vec<u64>,
    heterogeneous: bool,
    frame0_end: u64,
}

impl XyzIndexBuilder {
    /// Take the next line (without its line break), spanning bytes `start..end`.
    pub fn push_line(&mut self, line: &str, start: u64, end: u64) -> Result<(), String> {
        self.line_no += 1;
        match std::mem::take(&mut self.scan) {
            XyzScan::Count => {
                let count_line = line.trim();
                if count_line.is_empty() {
                    return Ok(());
                }
                let n_atoms: usize = count_line
                    .parse()
                    .map_err(|_| format!("cannot parse atom count at line {}", self.line_no))?;
                self.scan = XyzScan::Comment { start, n_atoms };
            }
            XyzScan::Comment { start, n_atoms } => {
                let lattice = parse_lattice(line);
                // An extra frame that declares extractable per-atom properties
                // needs the eager parser (which turns them into channels); the
                // positions-only lazy decode would silently drop them.
                let has_channels = self.first_n_atoms.is_some()
                    && !self.heterogeneous
                    && !channel_plan(line).is_empty();
                if n_atoms == 0 {
                    self.complete(start, n_atoms, lattice, has_channels, end);
                } else {
                    self.scan = XyzScan::Atoms {
                        start,
                        n_atoms,
                        remaining: n_atoms,
                        lattice,
                        has_channels,
                    };
                }
            }
            XyzScan::Atoms {
                start,
                n_atoms,
                remaining,
                lattice,
                has_channels,
            } => {
                if remaining == 1 {
                    self.complete(start, n_atoms, lattice, has_channels, end);
                } else {
                    self.scan = XyzScan::Atoms {
                        start,
                        n_atoms,
                        remaining: remaining - 1,
                        lattice,
                        has_channels,
                    };
                }
            }
        }
        Ok(())
    }

    /// A whole frame was seen (an incomplete last frame never gets here, so it
    /// is dropped, as the eager parser does).
    fn complete(
        &mut self,
        start: u64,
        n_atoms: usize,
        lattice: Option<[f32; 9]>,
        has_channels: bool,
        end: u64,
    ) {
        match self.first_n_atoms {
            None => {
                // frame 0 is the eager snapshot — not an extra frame
                self.first_n_atoms = Some(n_atoms);
                self.first_lattice = lattice;
                self.frame0_end = end;
            }
            Some(n0) => {
                if n_atoms != n0 {
                    self.heterogeneous = true;
                }
                // A present-and-different per-frame cell also makes the file
                // heterogeneous (a missing lattice inherits frame 0's cell).
                if let Some(fl) = lattice {
                    if Some(fl) != self.first_lattice {
                        self.heterogeneous = true;
                    }
                }
                if has_channels {
                    self.heterogeneous = true;
                }
                self.offsets.push(start);
            }
        }
    }

    /// The index of everything pushed so far.
    pub fn finish(self) -> Result<XyzIndex, String> {
        let n_atoms = self.first_n_atoms.ok_or("XYZ file contains no atoms")?;
        Ok(XyzIndex {
            n_atoms,
            n_extra_frames: self.offsets.len(),
            offsets: self.offsets.into_iter().map(|o| o as usize).collect(),
            heterogeneous: self.heterogeneous,
            frame0_end: self.frame0_end,
        })
    }

    /// Byte offset of each extra frame's count line, as file offsets.
    pub fn file_offsets(&self) -> &[u64] {
        &self.offsets
    }
}

/// Decode a single XYZ frame's positions (Å) given its count-line byte offset.
pub fn decode_frame_at(
    text: &str,
    byte_offset: usize,
    expected_n_atoms: usize,
) -> Result<Vec<f32>, String> {
    if byte_offset > text.len() {
        return Err("frame offset past end of data".into());
    }
    let slice = &text[byte_offset..];
    let mut it = slice.lines();
    let count_line = it.next().ok_or("empty frame")?.trim();
    let n_atoms: usize = count_line
        .parse()
        .map_err(|_| "frame offset is not at a count-line boundary".to_string())?;
    if n_atoms != expected_n_atoms {
        return Err(format!(
            "frame atom count {} != expected {}",
            n_atoms, expected_n_atoms
        ));
    }
    let _comment = it.next().ok_or("missing comment line")?;
    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut parts: Vec<&str> = Vec::new();
    for _ in 0..n_atoms {
        let line = it.next().ok_or("truncated frame")?;
        parts.clear();
        parts.extend(line.split_whitespace());
        if parts.len() < 4 {
            return Err("XYZ atom line too short".into());
        }
        let x: f32 = parts[1].parse().map_err(|_| "bad x coord".to_string())?;
        let y: f32 = parts[2].parse().map_err(|_| "bad y coord".to_string())?;
        let z: f32 = parts[3].parse().map_err(|_| "bad z coord".to_string())?;
        positions.push(x);
        positions.push(y);
        positions.push(z);
    }
    Ok(positions)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Some writers put the atomic number in the element column (`8 0 0 0`).
    /// An explicit atomic number is the most authoritative element field, so
    /// it is read as Z instead of failing the symbol lookup (Z = 0).
    #[test]
    fn an_atomic_number_in_the_element_column_is_the_element() {
        let text =
            "3\nwater with atomic numbers\n8 0.0 0.0 0.0\n1 0.96 0.0 0.0\n1 -0.24 0.93 0.0\n";
        assert_eq!(parse(text).unwrap().elements, vec![8, 1, 1]);
        assert_eq!(parse_frame0(text).unwrap().elements, vec![8, 1, 1]);
        // Out-of-range numbers are not elements.
        let bad = "2\n\n0 0 0 0\n200 1 0 0\n";
        assert_eq!(parse(bad).unwrap().elements, vec![0, 0]);
    }

    /// Jmol writes plain XYZ under the `.jxyz` extension, with extra per-atom
    /// columns (an atom name and a partial charge) after x/y/z. megane
    /// dispatches `.jxyz` straight to this parser, so the extra columns must
    /// land in the atom label rather than break the coordinate read.
    fn index_in_windows(text: &str, window: usize) -> XyzIndex {
        let mut b = XyzIndexBuilder::default();
        crate::lines::feed_in_windows(text, window, |l, s, e| b.push_line(l, s, e)).unwrap();
        b.finish().unwrap()
    }

    #[test]
    fn windowed_index_matches_the_whole_text_index() {
        for name in [
            "water_multiframe.xyz",
            "hetero_atoms.xyz",
            "hetero_cell.xyz",
            "water_md.extxyz",
        ] {
            let text = std::fs::read_to_string(format!(
                "{}/../../tests/fixtures/{name}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            let whole = build_index(&text).unwrap();
            for window in [1, 7, 64, 1000, text.len()] {
                let got = index_in_windows(&text, window);
                assert_eq!(got.offsets, whole.offsets, "{name} @ {window}");
                assert_eq!(got.n_atoms, whole.n_atoms);
                assert_eq!(got.heterogeneous, whole.heterogeneous, "{name}");
                assert_eq!(got.frame0_end, whole.frame0_end);
            }
        }
    }

    #[test]
    fn frame0_parses_from_the_text_before_frame0_end() {
        let text = "3\nfirst\nO 0 0 0\nH 0.96 0 0\nH 0 0.96 0\n\n3\nsecond\nO 1 0 0\nH 1.96 0 0\nH 1 0.96 0\n";
        let idx = build_index(text).unwrap();
        assert_eq!(idx.offsets, vec![text.find("3\nsecond").unwrap()]);
        let head = &text[..idx.frame0_end as usize];
        assert!(head.ends_with("H 0 0.96 0\n"));
        let a = parse_frame0(head).unwrap();
        let b = parse_frame0(text).unwrap();
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.elements, b.elements);
    }

    #[test]
    fn index_drops_a_truncated_last_frame_and_keeps_line_numbers_in_errors() {
        let text = "2\na\nH 0 0 0\nH 0 0 1\n2\nb\nH 0 0 0\n";
        let idx = build_index(text).unwrap();
        assert_eq!(idx.n_extra_frames, 0);
        let err = build_index("1\nc\nH 0 0 0\n\nnope\n").err().unwrap();
        assert!(err.contains("line 5"), "{err}");
        assert!(build_index("\n\n").is_err());
        // A zero-atom frame is complete after its comment line.
        let zero = build_index("0\nempty\n0\nagain\n").unwrap();
        assert_eq!(zero.offsets, vec![8]);
    }

    #[test]
    fn parses_the_jmol_extra_column_form() {
        let text = "\
3
water written by Jmol
O   0.000000   0.000000   0.117300  O1  -0.834
H   0.000000   0.757200  -0.469200  H1   0.417
H   0.000000  -0.757200  -0.469200  H2   0.417
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 3);
        assert_eq!(s.elements, vec![8, 1, 1]);
        assert!((s.positions[4] - 0.7572).abs() < 1e-5);
        let labels = s.atom_labels.expect("extra columns become the atom label");
        assert_eq!(labels[0], "O1 -0.834");
        assert_eq!(labels[2], "H2 0.417");
        // Extra columns must not disturb bond inference.
        assert_eq!(s.bonds.len(), 2);
        // No Properties declaration → no channels, label join only.
        assert!(s.vector_channels.is_empty());
        assert!(s.scalar_channels.is_empty());
    }

    /// The Build panel's "Empty Box" template starts from an extended-XYZ file
    /// with zero atoms and only a `Lattice=` header: the parser must return the
    /// cell without complaining that there is nothing in it.
    #[test]
    fn parses_an_empty_frame_with_a_lattice() {
        let text = "0\nLattice=\"10.0 0.0 0.0 0.0 10.0 0.0 0.0 0.0 10.0\" Properties=species:S:1:pos:R:3 empty\n";
        let s = parse(text).expect("a zero-atom frame is a valid structure");
        assert_eq!(s.n_atoms, 0);
        assert!(s.positions.is_empty());
        assert!(s.elements.is_empty());
        assert!(s.bonds.is_empty());
        let cell = s
            .box_matrix
            .expect("the lattice header survives without atoms");
        assert!((cell[0] - 10.0).abs() < 1e-6);
        assert!((cell[4] - 10.0).abs() < 1e-6);
        assert!((cell[8] - 10.0).abs() < 1e-6);
        assert_eq!(s.extra_frame_count(), 0);
    }

    #[test]
    fn test_parse_multiframe_flat() {
        // Two frames of 2 atoms each; frame 0 lives in `positions`, frame 1 flat.
        let text = "2\nframe 0\nH 0.0 0.0 0.0\nH 1.0 0.0 0.0\n\
                    2\nframe 1\nH 0.0 0.0 0.0\nH 2.0 0.0 0.0\n";
        let result = parse(text).expect("parse multi-frame XYZ");
        assert_eq!(result.n_atoms, 2);
        // Frame 0 coordinates in `positions`.
        assert!((result.positions[3] - 1.0).abs() < 1e-5);
        // One extra frame stored flat.
        assert_eq!(result.extra_frame_count(), 1);
        let f1 = result.frame(0);
        assert_eq!(f1.len(), 6);
        assert!((f1[3] - 2.0).abs() < 1e-5); // second atom x moved to 2.0
                                             // Uniform trajectory: fast path, no side table allocated.
        assert!(result.hetero.is_none());
    }

    #[test]
    fn test_multiframe_variable_atom_count() {
        // The second frame has a different atom count. It used to be silently
        // dropped; now it is captured as a heterogeneous extra frame.
        let text = "2\nframe 0\nH 0.0 0.0 0.0\nH 1.0 0.0 0.0\n\
                    1\nframe 1\nO 5.0 0.0 0.0\n";
        let result = parse(text).expect("parse XYZ");
        assert_eq!(result.n_atoms, 2);
        assert_eq!(result.extra_frame_count(), 1);
        let h = result.hetero.as_ref().expect("heterogeneous side table");
        assert!(h.varies_atoms);
        assert!(h.varies_topology); // atom count change implies element change
        assert_eq!(h.max_atoms, 2);
        // Extra frame 0 (overall frame 1) has a single atom at x=5.
        assert_eq!(result.frame_atom_count(0), 1);
        let f0 = result.frame(0);
        assert_eq!(f0.len(), 3);
        assert!((f0[0] - 5.0).abs() < 1e-5);
        // Its per-frame element is oxygen (8), not the frame-0 hydrogens.
        let elems = result.frame_elements(0).expect("per-frame elements");
        assert_eq!(elems, &[8u8]);
    }

    #[test]
    fn test_multiframe_variable_cell() {
        // Constant 1-atom topology, per-frame Lattice= changes → varies_cell only.
        let text = "1\nLattice=\"10 0 0 0 10 0 0 0 10\"\nH 0 0 0\n\
                    1\nLattice=\"12 0 0 0 12 0 0 0 12\"\nH 0 0 0\n";
        let result = parse(text).expect("parse XYZ");
        let h = result.hetero.as_ref().expect("heterogeneous side table");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!(!h.varies_topology);
        // Frame-0 cell is 10; extra frame 0 (overall frame 1) is 12.
        assert!((result.box_matrix.unwrap()[0] - 10.0).abs() < 1e-5);
        let cell = result.frame_cell(0).expect("per-frame cell");
        assert!((cell[0] - 12.0).abs() < 1e-5);
        // Topology unchanged → no per-frame elements table.
        assert!(result.frame_elements(0).is_none());
    }

    #[test]
    fn test_multiframe_variable_topology_same_count() {
        // Same atom count, element identity changes → varies_topology, not atoms.
        let text = "1\ncomment\nH 0 0 0\n\
                    1\ncomment\nO 0 0 0\n";
        let result = parse(text).expect("parse XYZ");
        let h = result.hetero.as_ref().expect("heterogeneous side table");
        assert!(h.varies_topology);
        assert!(!h.varies_atoms);
        let elems = result.frame_elements(0).expect("per-frame elements");
        assert_eq!(elems, &[8u8]);
    }

    #[test]
    fn test_parse_lattice_double_quotes() {
        let comment = r#"Lattice="5.44 0.0 0.0 0.0 5.44 0.0 0.0 0.0 5.44""#;
        let m = parse_lattice(comment).unwrap();
        assert!((m[0] - 5.44).abs() < 1e-5);
        assert!((m[4] - 5.44).abs() < 1e-5);
        assert!((m[8] - 5.44).abs() < 1e-5);
        assert!((m[1]).abs() < 1e-5);
    }

    #[test]
    fn test_parse_lattice_single_quotes() {
        let comment = "Lattice='10.0 0.0 0.0 0.0 10.0 0.0 0.0 0.0 10.0'";
        let m = parse_lattice(comment).unwrap();
        assert!((m[0] - 10.0).abs() < 1e-5);
    }

    #[test]
    fn test_parse_lattice_with_other_keys() {
        let comment = r#"Lattice="5.44 0.0 0.0 0.0 5.44 0.0 0.0 0.0 5.44" Properties=species:S:1:pos:R:3 pbc="T T T""#;
        let m = parse_lattice(comment).unwrap();
        assert!((m[0] - 5.44).abs() < 1e-5);
        assert!((m[8] - 5.44).abs() < 1e-5);
    }

    #[test]
    fn test_parse_lattice_missing() {
        assert!(parse_lattice("just a comment").is_none());
        assert!(parse_lattice("").is_none());
    }

    #[test]
    fn test_parse_lattice_incomplete() {
        let comment = r#"Lattice="1.0 2.0 3.0""#;
        assert!(parse_lattice(comment).is_none());
    }

    #[test]
    fn test_parse_xyz_with_lattice() {
        let xyz = r#"2
Lattice="10.0 0.0 0.0 0.0 10.0 0.0 0.0 0.0 10.0"
H 0.0 0.0 0.0
O 1.0 0.0 0.0
"#;
        let result = parse(xyz).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        let bm = result.box_matrix.expect("box_matrix should be Some");
        assert!((bm[0] - 10.0).abs() < 1e-5);
        assert!((bm[4] - 10.0).abs() < 1e-5);
        assert!((bm[8] - 10.0).abs() < 1e-5);
    }

    #[test]
    fn test_parse_xyz_without_lattice() {
        let xyz = "2\nwater molecule\nH 0.0 0.0 0.0\nO 1.0 0.0 0.0\n";
        let result = parse(xyz).expect("parse failed");
        assert!(result.box_matrix.is_none());
    }

    #[test]
    fn test_parse_xyz_fixture() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/si_diamond.xyz"
        ))
        .expect("read fixture");
        let result = parse(&text).expect("parse failed");
        assert_eq!(result.n_atoms, 8);
        assert!(result.elements.iter().all(|&e| e == 14)); // Si = 14
        let bm = result.box_matrix.expect("box_matrix should be Some");
        assert!((bm[0] - 5.44).abs() < 1e-5);
        assert!((bm[4] - 5.44).abs() < 1e-5);
        assert!((bm[8] - 5.44).abs() < 1e-5);
    }

    #[test]
    fn extxyz_properties_become_channels() {
        let text = "\
2
Lattice=\"10 0 0 0 10 0 0 0 10\" Properties=species:S:1:pos:R:3:vel:R:3:forces:R:3:charge:R:1
O 0.0 0.0 0.0 0.1 0.2 0.3 1.0 2.0 3.0 -0.8
H 1.0 0.0 0.0 0.4 0.5 0.6 4.0 5.0 6.0 0.4
";
        let s = parse(text).unwrap();
        assert_eq!(s.n_atoms, 2);
        assert_eq!(s.vector_channels.len(), 2);
        // Property names map to megane's conventional channel names.
        let vel = &s.vector_channels[0];
        assert_eq!(vel.name, "velocity");
        assert_eq!(vel.frames.len(), 1);
        assert_eq!(vel.frames[0].frame, 0);
        assert_eq!(vel.frames[0].vectors, vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
        let force = &s.vector_channels[1];
        assert_eq!(force.name, "force");
        assert_eq!(force.frames[0].vectors, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        assert_eq!(s.scalar_channels.len(), 1);
        let charge = &s.scalar_channels[0];
        assert_eq!(charge.name, "charge");
        assert_eq!(charge.frames[0].values, vec![-0.8, 0.4]);
        // All extra columns were consumed by channels — no residual labels.
        assert!(s.atom_labels.is_none());
        assert!(s.warnings.is_empty());
        // Coordinates and cell are untouched by the extra columns.
        assert!((s.positions[3] - 1.0).abs() < 1e-5);
        assert!((s.box_matrix.unwrap()[0] - 10.0).abs() < 1e-5);
    }

    #[test]
    fn extxyz_integer_property_becomes_scalar_channel() {
        let text = "\
2
Properties=species:S:1:pos:R:3:mol_id:I:1
H 0.0 0.0 0.0 1
H 0.8 0.0 0.0 2
";
        let s = parse(text).unwrap();
        assert!(s.vector_channels.is_empty());
        assert_eq!(s.scalar_channels.len(), 1);
        assert_eq!(s.scalar_channels[0].name, "mol_id");
        assert_eq!(s.scalar_channels[0].frames[0].values, vec![1.0, 2.0]);
        assert!(s.atom_labels.is_none());
    }

    #[test]
    fn extxyz_string_property_stays_in_label() {
        // A string column between pos and charge keeps the label path while
        // the numeric column still becomes a channel.
        let text = "\
2
Properties=species:S:1:pos:R:3:tag:S:1:charge:R:1
O 0.0 0.0 0.0 core -0.8
H 1.0 0.0 0.0 shell 0.4
";
        let s = parse(text).unwrap();
        assert_eq!(s.scalar_channels.len(), 1);
        assert_eq!(s.scalar_channels[0].name, "charge");
        assert_eq!(s.scalar_channels[0].frames[0].values, vec![-0.8, 0.4]);
        let labels = s.atom_labels.expect("string column stays in the label");
        assert_eq!(labels, vec!["core", "shell"]);
    }

    #[test]
    fn extxyz_multiframe_forces_one_channel() {
        // Both frames declare forces → one channel with 2 frames, indices
        // following the overall frame numbering (0 = base structure).
        let text = "\
2
Properties=species:S:1:pos:R:3:forces:R:3
H 0.0 0.0 0.0 1.0 0.0 0.0
H 1.0 0.0 0.0 -1.0 0.0 0.0
2
Properties=species:S:1:pos:R:3:forces:R:3
H 0.0 0.0 0.0 2.0 0.0 0.0
H 2.0 0.0 0.0 -2.0 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.extra_frame_count(), 1);
        assert_eq!(s.vector_channels.len(), 1);
        let ch = &s.vector_channels[0];
        assert_eq!(ch.name, "force");
        assert_eq!(ch.frames.len(), 2);
        assert_eq!(ch.frames[0].frame, 0);
        assert_eq!(ch.frames[1].frame, 1);
        assert!((ch.frames[0].vectors[0] - 1.0).abs() < 1e-5);
        assert!((ch.frames[1].vectors[3] + 2.0).abs() < 1e-5);
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn extxyz_partial_property_falls_back_to_static_with_warning() {
        // Only frame 0 carries forces → static frame-0 channel + one warning.
        let text = "\
2
Properties=species:S:1:pos:R:3:forces:R:3
H 0.0 0.0 0.0 1.0 0.0 0.0
H 1.0 0.0 0.0 -1.0 0.0 0.0
2
frame 1 without forces
H 0.0 0.0 0.0
H 2.0 0.0 0.0
";
        let s = parse(text).unwrap();
        assert_eq!(s.vector_channels.len(), 1);
        let ch = &s.vector_channels[0];
        assert_eq!(ch.name, "force");
        assert_eq!(ch.frames.len(), 1);
        assert_eq!(ch.frames[0].frame, 0);
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains("force"));
    }

    #[test]
    fn malformed_properties_keeps_label_join() {
        // Truncated triple → declaration ignored, extra columns stay a label.
        let text = "\
1
Properties=species:S:1:pos:R:3:vel:R
H 0.0 0.0 0.0 0.1 0.2 0.3
";
        let s = parse(text).unwrap();
        assert!(s.vector_channels.is_empty());
        assert!(s.scalar_channels.is_empty());
        let labels = s.atom_labels.expect("extra columns become the atom label");
        assert_eq!(labels[0], "0.1 0.2 0.3");
    }

    #[test]
    fn declared_columns_missing_from_line_keep_label_join() {
        // Declaration promises vel but the atom lines don't carry the columns
        // → extraction is abandoned and the current label behavior is kept.
        let text = "\
2
Properties=species:S:1:pos:R:3:vel:R:3
H 0.0 0.0 0.0 word
H 1.0 0.0 0.0 word
";
        let s = parse(text).unwrap();
        assert!(s.vector_channels.is_empty());
        let labels = s.atom_labels.expect("fallback label");
        assert_eq!(labels[0], "word");
    }

    #[test]
    fn plain_xyz_has_no_channels() {
        let text = "2\nwater molecule\nH 0.0 0.0 0.0\nO 1.0 0.0 0.0\n";
        let s = parse(text).unwrap();
        assert!(s.vector_channels.is_empty());
        assert!(s.scalar_channels.is_empty());
        assert!(s.warnings.is_empty());
    }

    #[test]
    fn parse_frame0_extracts_static_channels() {
        let text = "\
2
Properties=species:S:1:pos:R:3:vel:R:3
H 0.0 0.0 0.0 0.1 0.2 0.3
H 1.0 0.0 0.0 0.4 0.5 0.6
2
Properties=species:S:1:pos:R:3:vel:R:3
H 0.0 0.0 0.0 0.7 0.8 0.9
H 2.0 0.0 0.0 1.0 1.1 1.2
";
        let f0 = parse_frame0(text).unwrap();
        assert_eq!(f0.vector_channels.len(), 1);
        assert_eq!(f0.vector_channels[0].name, "velocity");
        assert_eq!(
            f0.vector_channels[0].frames[0].vectors,
            vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
        );
        // The index flags the file so the host reparses eagerly and gets the
        // frame-synced channel instead of the lazy positions-only path.
        let idx = build_index(text).unwrap();
        assert!(idx.heterogeneous);
        // Eager parse of the same file yields the full 2-frame channel.
        let eager = parse(text).unwrap();
        assert_eq!(eager.vector_channels[0].frames.len(), 2);
    }

    #[test]
    fn lazy_frame0_and_decode_match_eager() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/water_multiframe.xyz"
        ))
        .expect("read fixture");

        let eager = parse(&text).unwrap();
        let f0 = parse_frame0(&text).unwrap();
        let idx = build_index(&text).unwrap();

        // Frame-0 snapshot is byte-identical to the eager frame 0.
        assert_eq!(f0.positions, eager.positions);
        assert_eq!(f0.elements, eager.elements);
        assert_eq!(f0.n_atoms, eager.n_atoms);
        assert!(f0.frame_positions_flat.is_empty());

        assert_eq!(idx.n_atoms, eager.n_atoms);
        assert_eq!(idx.n_extra_frames, eager.extra_frame_count());

        // Every extra frame decoded lazily is byte-identical to the eager frame.
        for k in 0..idx.n_extra_frames {
            let p = decode_frame_at(&text, idx.offsets[k], idx.n_atoms).unwrap();
            assert_eq!(p, eager.frame(k).to_vec(), "extra frame {k}");
        }
    }
}
