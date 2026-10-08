/// GROMACS GRO text format parser.
///
/// One frame block:
///   Line 1: title / comment
///   Line 2: number of atoms
///   Lines 3..n+2: fixed-width atom records
///     columns 1-5:  residue number
///     columns 6-10: residue name
///     columns 11-15: atom name
///     columns 16-20: atom number
///     columns 21-28: x (nm)
///     columns 29-36: y (nm)
///     columns 37-44: z (nm)
///     columns 45-68: optional vx vy vz (nm/ps)
///   Last line: box vectors (v1x v2y v3z [v1y v1z v2x v2z v3x v3y])
///
/// The 8-column coordinate fields above are the default `%8.3f` layout. GRO
/// allows any precision: with `n` decimals every coordinate (and velocity)
/// field is `n + 5` columns wide, and the width is inferred from the spacing
/// of the decimal points on the first atom line of each block, exactly as
/// GROMACS's own reader does (`trjconv -ndec` writes such files).
///
/// A trajectory file (e.g. `trjconv` output) concatenates several such blocks;
/// every block is parsed. All length-valued channels are converted uniformly to
/// the canonical Å representation: positions and box nm → Å, velocities
/// nm/ps → Å/ps.
use std::collections::HashSet;

use crate::atomic::element_from_atom_name;
use crate::bonds;
use crate::parser::HeteroFrames;
use crate::trajectory::{VectorChannel, VectorFrame};

/// Columns occupied by the fixed prefix: resnum(5) resname(5) atomname(5) atomnum(5).
const COORD_START: usize = 20;
/// Coordinate field width of the default `%8.3f` layout.
const DEFAULT_FIELD_WIDTH: usize = 8;

/// Infer the coordinate field width from the decimal-point spacing of an atom
/// line (GROMACS `get_w_conf`): `n` decimals → `n + 5` columns per field, so
/// consecutive decimal points sit exactly one field width apart. A line whose
/// coordinates carry fewer than three decimal points cannot be measured and
/// keeps the default width.
fn detect_field_width(line: &str) -> Result<usize, String> {
    let Some(tail) = line.get(COORD_START..) else {
        return Ok(DEFAULT_FIELD_WIDTH);
    };
    let dots: Vec<usize> = tail.match_indices('.').map(|(i, _)| i).take(3).collect();
    if dots.len() < 3 {
        return Ok(DEFAULT_FIELD_WIDTH);
    }
    let width = dots[1] - dots[0];
    if dots[2] - dots[1] != width {
        return Err(format!(
            "inconsistent decimal-point spacing in GRO coordinates ({} vs {} columns)",
            width,
            dots[2] - dots[1]
        ));
    }
    Ok(width)
}

/// The `k`-th fixed-width field after the atom prefix, trimmed. `None` when
/// the line ends before the field or the slice would split a UTF-8 character.
fn field(line: &str, width: usize, k: usize) -> Option<&str> {
    let begin = COORD_START + k * width;
    line.get(begin..begin + width).map(str::trim)
}

/// One parsed frame block. Topology fields (`elements`, `labels`) are filled
/// only when requested (first frame); extra frames need coordinates,
/// velocities, and box only.
struct FrameBlock {
    n_atoms: usize,
    /// Å.
    positions: Vec<f32>,
    /// Å/ps. `Some` only when EVERY atom line in the block has velocity columns.
    velocities: Option<Vec<f32>>,
    elements: Vec<u8>,
    labels: Vec<String>,
    box_matrix: Option<[f32; 9]>,
    /// Index of the first line after this block.
    end: usize,
}

fn parse_frame_block(
    lines: &[&str],
    start: usize,
    collect_topology: bool,
    frame_idx: usize,
) -> Result<FrameBlock, String> {
    // Error context: the first frame keeps plain messages, later frames name
    // the frame so the failing block is identifiable in a long trajectory.
    let ctx = |msg: String| {
        if frame_idx == 0 {
            msg
        } else {
            format!("GRO frame {}: {}", frame_idx + 1, msg)
        }
    };

    // Second block line: atom count
    let n_atoms: usize = lines[start + 1]
        .trim()
        .parse()
        .map_err(|_| ctx("cannot parse atom count in GRO".into()))?;

    if lines.len() < start + n_atoms + 3 {
        return Err(ctx(format!(
            "GRO file has {} lines but expected at least {}",
            lines.len(),
            start + n_atoms + 3
        )));
    }

    let mut positions = Vec::with_capacity(n_atoms * 3);
    let mut elements = Vec::with_capacity(if collect_topology { n_atoms } else { 0 });
    let mut labels = Vec::with_capacity(if collect_topology { n_atoms } else { 0 });
    // Velocity buffer: filled only when ALL atoms have velocity columns (line.len() >= 68).
    let mut velocities: Vec<f32> = Vec::with_capacity(n_atoms * 3);
    let mut has_velocities = true;

    // GRO is fixed-format per block: the first atom line fixes the field
    // width for every atom of the block.
    let width = if n_atoms > 0 {
        detect_field_width(lines[start + 2]).map_err(ctx)?
    } else {
        DEFAULT_FIELD_WIDTH
    };
    let coord_end = COORD_START + 3 * width;
    let vel_end = COORD_START + 6 * width;

    for i in 0..n_atoms {
        let line = lines[start + i + 2];
        if line.len() < coord_end {
            return Err(ctx(format!("GRO atom line {} too short", i + 1)));
        }

        if collect_topology {
            // Residue number (cols 0-5) and residue name (cols 5-10)
            let res_num = if line.len() >= 5 {
                line[0..5].trim()
            } else {
                ""
            };
            let res_name = if line.len() >= 10 {
                line[5..10].trim()
            } else {
                ""
            };
            labels.push(format!("{}{}", res_name, res_num));

            // Atom name: columns 11-15 (0-indexed: 10..15)
            let atom_name = if line.len() >= 15 { &line[10..15] } else { "" };
            elements.push(element_from_atom_name(atom_name));
        }

        // Positions in nm → Angstrom (×10)
        let coord = |k: usize, axis: &str| -> Result<f32, String> {
            field(line, width, k)
                .and_then(|s| s.parse::<f32>().ok())
                .ok_or_else(|| ctx(format!("bad {} coord at atom {}", axis, i + 1)))
        };
        let x = coord(0, "x")?;
        let y = coord(1, "y")?;
        let z = coord(2, "z")?;

        positions.push(x * 10.0);
        positions.push(y * 10.0);
        positions.push(z * 10.0);

        // Optional velocity columns: three more fields of the same width
        // (cols 44-68 in the default layout).
        // Stored in nm/ps → converted to Å/ps so every length-valued channel
        // shares the positions' unit system.
        if has_velocities {
            let parsed = if line.len() >= vel_end {
                let vx: Option<f32> = field(line, width, 3).and_then(|s| s.parse().ok());
                let vy: Option<f32> = field(line, width, 4).and_then(|s| s.parse().ok());
                let vz: Option<f32> = field(line, width, 5).and_then(|s| s.parse().ok());
                vx.zip(vy).zip(vz).map(|((x, y), z)| (x, y, z))
            } else {
                None
            };
            if let Some((vx, vy, vz)) = parsed {
                velocities.push(vx * 10.0);
                velocities.push(vy * 10.0);
                velocities.push(vz * 10.0);
            } else {
                // Atom lacks velocity columns or has unparseable values — disable channel.
                has_velocities = false;
                velocities.clear();
            }
        }
    }

    // Last block line: box vectors
    let box_line = lines[start + n_atoms + 2].trim();
    let box_matrix = parse_box_line(box_line);

    Ok(FrameBlock {
        n_atoms,
        positions,
        velocities: if has_velocities && !velocities.is_empty() {
            Some(velocities)
        } else {
            None
        },
        elements,
        labels,
        box_matrix,
        end: start + n_atoms + 3,
    })
}

pub fn parse(text: &str) -> Result<crate::parser::ParsedStructure, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 {
        return Err("GRO file too short".into());
    }

    // Frame 0 carries the topology (elements, labels).
    let first = parse_frame_block(&lines, 0, true, 0)?;
    let n_atoms = first.n_atoms;
    let positions = first.positions;
    let elements = first.elements;
    let labels = first.labels;
    let box_matrix = first.box_matrix;

    // Any further complete blocks are trajectory frames (trjconv-style
    // concatenation). GRO trajectories are fixed-atom: a diverging count is an
    // error, not a truncation.
    let mut frame_positions_flat: Vec<f32> = Vec::new();
    let mut extra_boxes: Vec<Option<[f32; 9]>> = Vec::new();
    let mut per_frame_velocities: Vec<Option<Vec<f32>>> = vec![first.velocities];
    let mut cursor = first.end;
    while cursor < lines.len() {
        // Pure trailing blank lines are allowed.
        if lines[cursor..].iter().all(|l| l.trim().is_empty()) {
            break;
        }
        // The remaining content must form a complete title/count/atoms/box block.
        let complete = lines.len() >= cursor + 3
            && lines[cursor + 1]
                .trim()
                .parse::<usize>()
                .is_ok_and(|n| lines.len() >= cursor + n + 3);
        if !complete {
            return Err(format!(
                "GRO file has a trailing partial frame block starting at line {}",
                cursor + 1
            ));
        }
        let frame_idx = extra_boxes.len() + 1;
        let block = parse_frame_block(&lines, cursor, false, frame_idx)?;
        if block.n_atoms != n_atoms {
            return Err(format!(
                "GRO frame {} has {} atoms but frame 1 has {}",
                frame_idx + 1,
                block.n_atoms,
                n_atoms
            ));
        }
        frame_positions_flat.extend_from_slice(&block.positions);
        extra_boxes.push(block.box_matrix);
        per_frame_velocities.push(block.velocities);
        cursor = block.end;
    }

    // Infer bonds from frame-0 coordinates.
    let empty_bonds = HashSet::new();
    let bonds = bonds::infer_bonds(&positions, &elements, n_atoms, &empty_bonds);

    let atom_labels = if labels.iter().any(|l| !l.is_empty()) {
        Some(labels)
    } else {
        None
    };

    // Velocity channel: frame-synced when every frame carries velocities,
    // static (frame 0 only) when only some do, absent when frame 0 has none.
    let first_has_velocities = per_frame_velocities[0].is_some();
    let all_have_velocities = per_frame_velocities.iter().all(|v| v.is_some());
    let vector_channels = if first_has_velocities && all_have_velocities {
        let frames = per_frame_velocities
            .into_iter()
            .enumerate()
            .map(|(i, v)| VectorFrame {
                frame: i,
                vectors: v.unwrap(),
            })
            .collect();
        vec![VectorChannel {
            name: "velocity".to_string(),
            frames,
        }]
    } else if first_has_velocities {
        vec![VectorChannel {
            name: "velocity".to_string(),
            frames: vec![VectorFrame {
                frame: 0,
                vectors: per_frame_velocities.swap_remove(0).unwrap(),
            }],
        }]
    } else {
        vec![]
    };

    // A cell that changes across frames needs the per-frame side table; a
    // constant cell keeps the uniform fast path (hetero = None).
    let hetero = if extra_boxes.iter().any(|b| *b != box_matrix) {
        let atom_offsets: Vec<u32> = (0..=extra_boxes.len())
            .map(|i| (i * n_atoms) as u32)
            .collect();
        let mut cells_flat = Vec::with_capacity(extra_boxes.len() * 9);
        for b in &extra_boxes {
            cells_flat.extend_from_slice(&b.unwrap_or([0.0; 9]));
        }
        Some(HeteroFrames {
            atom_offsets,
            elements_flat: Vec::new(),
            cells_flat,
            bond_offsets: Vec::new(),
            bonds_flat: Vec::new(),
            varies_atoms: false,
            varies_cell: true,
            varies_topology: false,
            max_atoms: n_atoms as u32,
        })
    } else {
        None
    };

    Ok(crate::parser::ParsedStructure {
        n_atoms,
        positions,
        elements,
        bonds,
        n_file_bonds: 0,
        bond_orders: None,
        box_matrix,
        box_origin: None,
        frame_positions_flat,
        atom_labels,
        chain_ids: None,
        bfactors: None,
        vector_channels,
        ca_indices: vec![],
        ca_chain_ids: vec![],
        ca_res_nums: vec![],
        ca_ss_type: vec![],
        symmetry_ops: Vec::new(),
        scalar_channels: Vec::new(),
        warnings: Vec::new(),
        hetero,
    })
}

fn parse_box_line(line: &str) -> Option<[f32; 9]> {
    let vals: Vec<f32> = line
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();

    if vals.len() >= 3 {
        // nm → Angstrom
        let mut m = [0.0f32; 9];
        m[0] = vals[0] * 10.0; // v1x
        m[4] = vals[1] * 10.0; // v2y
        m[8] = vals[2] * 10.0; // v3z
        if vals.len() >= 9 {
            m[1] = vals[3] * 10.0; // v1y
            m[2] = vals[4] * 10.0; // v1z
            m[3] = vals[5] * 10.0; // v2x
            m[5] = vals[6] * 10.0; // v2z
            m[6] = vals[7] * 10.0; // v3x
            m[7] = vals[8] * 10.0; // v3y
        }
        Some(m)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_gro() {
        let gro = "Water\n3\n    1SOL     OW    1   0.100   0.200   0.300\n    1SOL    HW1    2   0.150   0.250   0.350\n    1SOL    HW2    3   0.050   0.150   0.250\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.n_atoms, 3);
        // Positions should be in Angstroms (nm * 10)
        assert!((result.positions[0] - 1.0).abs() < 0.01); // 0.100 nm → 1.0 Å
        assert!((result.positions[1] - 2.0).abs() < 0.01); // 0.200 nm → 2.0 Å
        assert!((result.positions[2] - 3.0).abs() < 0.01); // 0.300 nm → 3.0 Å
                                                           // Elements
        assert_eq!(result.elements[0], 8); // O
        assert_eq!(result.elements[1], 1); // H
        assert_eq!(result.elements[2], 1); // H
    }

    #[test]
    fn test_parse_gro_box() {
        let gro = "test\n1\n    1ALA      N    1   0.100   0.200   0.300\n   2.50000   3.00000   3.50000\n";
        let result = parse(gro).expect("parse failed");
        assert!(result.box_matrix.is_some());
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 25.0).abs() < 0.01); // 2.5 nm → 25.0 Å
        assert!((bm[4] - 30.0).abs() < 0.01); // 3.0 nm → 30.0 Å
        assert!((bm[8] - 35.0).abs() < 0.01); // 3.5 nm → 35.0 Å
    }

    #[test]
    fn test_parse_gro_too_short() {
        let result = parse("title\n");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_box_line() {
        let m = parse_box_line("   1.00000   2.00000   3.00000").unwrap();
        assert!((m[0] - 10.0).abs() < 0.01);
        assert!((m[4] - 20.0).abs() < 0.01);
        assert!((m[8] - 30.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_gro_no_velocities() {
        // Lines without velocity columns → no vector channels.
        let gro = "Water\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert!(result.vector_channels.is_empty());
    }

    #[test]
    fn test_parse_gro_with_velocities() {
        // Atom line is exactly 68 chars or more → velocity channel produced.
        // GRO format: resnum(5) resname(5) atomname(5) atomnum(5) x(8) y(8) z(8) vx(8) vy(8) vz(8)
        // Velocities are converted nm/ps → Å/ps (×10), same factor as positions.
        let gro = "MD run\n2\n    1SOL     OW    1   0.100   0.200   0.300   0.010   0.020   0.030\n    1SOL    HW1    2   0.150   0.250   0.350  -0.005   0.015  -0.025\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.vector_channels.len(), 1);
        let ch = &result.vector_channels[0];
        assert_eq!(ch.name, "velocity");
        assert_eq!(ch.frames.len(), 1);
        assert_eq!(ch.frames[0].frame, 0);
        let v = &ch.frames[0].vectors;
        assert_eq!(v.len(), 6); // 2 atoms × 3
        assert!((v[0] - 0.10).abs() < 0.001); // 0.010 nm/ps → 0.10 Å/ps
        assert!((v[1] - 0.20).abs() < 0.001); // vy of atom 0
        assert!((v[2] - 0.30).abs() < 0.001); // vz of atom 0
        assert!((v[3] - (-0.05)).abs() < 0.001); // vx of atom 1
    }

    #[test]
    fn test_parse_gro_partial_velocities_ignored() {
        // First atom has velocity columns, second does not → no channel emitted.
        let gro = "test\n2\n    1SOL     OW    1   0.100   0.200   0.300   0.010   0.020   0.030\n    1SOL    HW1    2   0.150   0.250   0.350\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert!(result.vector_channels.is_empty());
    }

    #[test]
    fn test_parse_single_frame_fixture_no_extra_frames() {
        // A plain single-frame file stays on the uniform fast path.
        let result =
            parse(include_str!("../../../tests/fixtures/water.gro")).expect("parse failed");
        assert_eq!(result.n_atoms, 9);
        assert_eq!(result.extra_frame_count(), 0);
        assert!(result.frame_positions_flat.is_empty());
        assert!(result.hetero.is_none());
        assert!(result.vector_channels.is_empty());
    }

    #[test]
    fn test_parse_multiframe_constant_cell() {
        // Two concatenated frame blocks with the same box: extra frame lands
        // in frame_positions_flat and hetero stays None.
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\nt=1\n1\n    1SOL     OW    1   0.110   0.210   0.310\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.n_atoms, 1);
        assert_eq!(result.extra_frame_count(), 1);
        assert!(result.hetero.is_none());
        // Frame-0 topology comes from the first block only.
        assert!((result.positions[0] - 1.0).abs() < 0.001);
        // Extra frame coordinates are in Å.
        let f0 = result.frame(0);
        assert_eq!(f0.len(), 3);
        assert!((f0[0] - 1.1).abs() < 0.001);
        assert!((f0[1] - 2.1).abs() < 0.001);
        assert!((f0[2] - 3.1).abs() < 0.001);
    }

    #[test]
    fn test_parse_multiframe_varying_cell_fixture() {
        let result = parse(include_str!("../../../tests/fixtures/water_multiframe.gro"))
            .expect("parse failed");
        assert_eq!(result.n_atoms, 3);
        assert_eq!(result.extra_frame_count(), 2);
        // Frame 0 box, Å.
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 12.0).abs() < 0.001);
        // Extra-frame coordinates, Å.
        assert!((result.frame(0)[0] - 2.4).abs() < 0.001);
        assert!((result.frame(1)[0] - 2.5).abs() < 0.001);
        // The box changes per frame → cell side table, everything else uniform.
        let h = result.hetero.as_ref().expect("hetero expected");
        assert!(h.varies_cell);
        assert!(!h.varies_atoms);
        assert!(!h.varies_topology);
        assert_eq!(h.atom_offsets, vec![0, 3, 6]);
        assert_eq!(h.max_atoms, 3);
        assert!(h.elements_flat.is_empty());
        assert!(h.bond_offsets.is_empty());
        assert!(h.bonds_flat.is_empty());
        assert_eq!(h.cells_flat.len(), 18);
        assert!((h.cells_flat[0] - 12.5).abs() < 0.001); // frame 1 v1x
        assert!((h.cells_flat[9] - 13.0).abs() < 0.001); // frame 2 v1x
                                                         // Per-frame velocities become one frame-synced channel, Å/ps.
        assert_eq!(result.vector_channels.len(), 1);
        let ch = &result.vector_channels[0];
        assert_eq!(ch.name, "velocity");
        assert_eq!(ch.frames.len(), 3);
        assert_eq!(ch.frames[0].frame, 0);
        assert_eq!(ch.frames[2].frame, 2);
        assert!((ch.frames[0].vectors[0] - 0.10).abs() < 0.001); // 0.010 nm/ps
        assert!((ch.frames[1].vectors[0] - 0.11).abs() < 0.001); // 0.011 nm/ps
        assert!((ch.frames[2].vectors[0] - 0.12).abs() < 0.001); // 0.012 nm/ps
    }

    #[test]
    fn test_parse_multiframe_partial_velocities_static_channel() {
        // Frame 0 has velocities but frame 1 does not → single static channel.
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300   0.010   0.020   0.030\n   1.00000   1.00000   1.00000\nt=1\n1\n    1SOL     OW    1   0.110   0.210   0.310\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.extra_frame_count(), 1);
        assert_eq!(result.vector_channels.len(), 1);
        let ch = &result.vector_channels[0];
        assert_eq!(ch.frames.len(), 1);
        assert_eq!(ch.frames[0].frame, 0);
        assert!((ch.frames[0].vectors[0] - 0.10).abs() < 0.001);
    }

    #[test]
    fn test_parse_multiframe_atom_count_mismatch() {
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\nt=1\n2\n    1SOL     OW    1   0.110   0.210   0.310\n    1SOL    HW1    2   0.150   0.250   0.350\n   1.00000   1.00000   1.00000\n";
        let err = parse(gro).err().expect("mismatch must fail");
        assert!(err.contains("frame 2"), "err: {}", err);
        assert!(err.contains("2 atoms"), "err: {}", err);
        assert!(err.contains("frame 1 has 1"), "err: {}", err);
    }

    #[test]
    fn test_parse_trailing_partial_block_err() {
        // A second block that declares more atoms than remain is a partial
        // frame, not ignorable garbage.
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\nt=1\n3\n    1SOL     OW    1   0.110   0.210   0.310\n";
        let err = parse(gro).err().expect("partial block must fail");
        assert!(err.contains("trailing partial frame block"), "err: {}", err);
    }

    #[test]
    fn test_parse_trailing_blank_lines_ok() {
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\n\n   \n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.extra_frame_count(), 0);
        assert!(result.hetero.is_none());
    }

    #[test]
    fn test_parse_multiframe_bad_coord_names_frame() {
        // A malformed atom line in a later (complete) block reports the frame.
        let gro = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\nt=1\n1\n    1SOL     OW    1   xxxxxx   0.210   0.310\n   1.00000   1.00000   1.00000\n";
        let err = parse(gro).err().expect("bad coord must fail");
        assert!(err.contains("GRO frame 2"), "err: {}", err);
        assert!(err.contains("bad x coord"), "err: {}", err);
    }

    #[test]
    fn test_detect_field_width() {
        // Default %8.3f layout.
        assert_eq!(
            detect_field_width("    1SOL     OW    1   0.100   0.200   0.300").unwrap(),
            8
        );
        // 8 decimals → 13 columns.
        assert_eq!(
            detect_field_width("    1MOL      C    1  15.34893685   2.62489948   0.22520719")
                .unwrap(),
            13
        );
        // A '.' inside the residue/atom name prefix must not be counted.
        assert_eq!(
            detect_field_width("    1A.B    C.1    1   0.100   0.200   0.300").unwrap(),
            8
        );
        // Fewer than three decimal points: nothing to measure, default width.
        assert_eq!(
            detect_field_width("    1SOL     OW    1       1       2       3").unwrap(),
            8
        );
        assert_eq!(detect_field_width("short").unwrap(), 8);
        // Mixed spacing is not a fixed-format line.
        let err = detect_field_width("    1SOL     OW    1   0.100    0.200   0.300").unwrap_err();
        assert!(err.contains("decimal-point spacing"), "err: {}", err);
    }

    #[test]
    fn test_field_slices_after_prefix() {
        let line = "    1SOL     OW    1   0.100   0.200   0.300";
        assert_eq!(field(line, 8, 0), Some("0.100"));
        assert_eq!(field(line, 8, 2), Some("0.300"));
        // Past the end of the line.
        assert_eq!(field(line, 8, 3), None);
        // A slice that would split a multi-byte character is not a field.
        assert_eq!(
            field("    1SOL     OW    1   0.10é   0.200   0.300", 8, 0),
            None
        );
    }

    #[test]
    #[allow(clippy::excessive_precision)] // literals mirror the fixture text
    fn test_parse_high_precision_fixture() {
        // Issue #695: 8-decimal coordinates occupy 13 columns each, so the
        // default 8-column slices straddle two numbers and misread every
        // coordinate ("bad y coord at atom 11"). Values must be checked too:
        // with a single atom the misaligned slices still parse, just wrong.
        let result = parse(include_str!("../../../tests/fixtures/high_precision.gro"))
            .expect("high-precision GRO must parse");
        assert_eq!(result.n_atoms, 11);
        assert_eq!(result.extra_frame_count(), 0);
        let p = &result.positions;
        // Atom 1: (15.34893685, 2.62489948, 0.22520719) nm → Å.
        assert!((p[0] - 153.4893685).abs() < 1e-3, "x0 = {}", p[0]);
        assert!((p[1] - 26.2489948).abs() < 1e-4, "y0 = {}", p[1]);
        assert!((p[2] - 2.2520719).abs() < 1e-4, "z0 = {}", p[2]);
        // Atom 2 carries a negative z.
        assert!((p[5] - (-1.1602152)).abs() < 1e-4, "z1 = {}", p[5]);
        // Atom 11 (the one the old slicing choked on).
        assert!((p[30] - 155.5595796).abs() < 1e-3, "x10 = {}", p[30]);
        assert!((p[31] - 148.8182486).abs() < 1e-3, "y10 = {}", p[31]);
        assert!((p[32] - 23.9361028).abs() < 1e-4, "z10 = {}", p[32]);
        // Every atom is carbon; labels keep residue name + number.
        assert!(result.elements.iter().all(|&e| e == 6));
        let labels = result.atom_labels.as_ref().unwrap();
        assert_eq!(labels[0], "MOL1");
        assert_eq!(labels[10], "MOL2");
        // Velocities share the 13-column width: nm/ps → Å/ps.
        assert_eq!(result.vector_channels.len(), 1);
        let v = &result.vector_channels[0].frames[0].vectors;
        assert_eq!(v.len(), 33);
        assert!((v[0] - (-1.1565698)).abs() < 1e-4, "vx0 = {}", v[0]);
        assert!((v[1] - (-0.1820693)).abs() < 1e-4, "vy0 = {}", v[1]);
        assert!((v[2] - (-1.3229954)).abs() < 1e-4, "vz0 = {}", v[2]);
        assert!((v[32] - 2.8744587).abs() < 1e-4, "vz10 = {}", v[32]);
        // Box: 17.15761 nm cube → Å.
        let bm = result.box_matrix.unwrap();
        assert!((bm[0] - 171.5761).abs() < 1e-3);
        assert!((bm[4] - 171.5761).abs() < 1e-3);
        assert!((bm[8] - 171.5761).abs() < 1e-3);
    }

    #[test]
    #[allow(clippy::excessive_precision)] // literals mirror the fixture text
    fn test_parse_high_precision_without_velocities() {
        // Same widths, coordinates only (the issue's second reproduction).
        let gro = "hp\n2\n    1MOL      C    1  15.34893685   2.62489948   0.22520719\n    2MOL      C    2  15.55595796  14.88182486   2.39361028\n  17.15761  17.15761  17.15761\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.n_atoms, 2);
        assert!(result.vector_channels.is_empty());
        assert!((result.positions[4] - 148.8182486).abs() < 1e-3);
        assert!((result.positions[5] - 23.9361028).abs() < 1e-4);
    }

    #[test]
    fn test_parse_precision_detected_per_frame_block() {
        // trjconv -ndec 5 output: 10-column fields, two frames; the width is
        // re-measured on each block, so a later block may differ.
        let gro = "t=0\n1\n    1SOL     OW    1   0.10000   0.20000   0.30000\n   1.00000   1.00000   1.00000\nt=1\n1\n    1SOL     OW    1   0.110   0.210   0.310\n   1.00000   1.00000   1.00000\n";
        let result = parse(gro).expect("parse failed");
        assert_eq!(result.extra_frame_count(), 1);
        assert!((result.positions[1] - 2.0).abs() < 1e-4);
        assert!((result.frame(0)[1] - 2.1).abs() < 1e-4);
    }

    #[test]
    fn test_parse_inconsistent_spacing_err() {
        let gro = "bad\n1\n    1SOL     OW    1   0.100    0.200   0.300\n   1.00000   1.00000   1.00000\n";
        let err = parse(gro).err().expect("must fail");
        assert!(err.contains("decimal-point spacing"), "err: {}", err);
        // Later blocks name the frame.
        let gro2 = "t=0\n1\n    1SOL     OW    1   0.100   0.200   0.300\n   1.00000   1.00000   1.00000\nt=1\n1\n    1SOL     OW    1   0.100    0.200   0.300\n   1.00000   1.00000   1.00000\n";
        let err2 = parse(gro2).err().expect("must fail");
        assert!(err2.contains("GRO frame 2"), "err: {}", err2);
    }

    #[test]
    fn test_parse_high_precision_line_too_short() {
        // A 13-column block whose second line only fits the default layout.
        let gro = "hp\n2\n    1MOL      C    1  15.34893685   2.62489948   0.22520719\n    2MOL      C    2   0.100   0.200   0.300\n  17.15761  17.15761  17.15761\n";
        let err = parse(gro).err().expect("must fail");
        assert!(err.contains("line 2 too short"), "err: {}", err);
    }

    #[test]
    fn test_parse_zero_atoms_block() {
        // No atom line to measure: nothing to parse, no panic.
        let result = parse("empty\n0\n   1.00000   1.00000   1.00000\n").expect("parse failed");
        assert_eq!(result.n_atoms, 0);
    }
}
