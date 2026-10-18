//! The single registry of file formats the bindings expose.
//!
//! Every per-format `parse_*` function in the WASM (`megane-wasm`) and PyO3
//! (`megane-python`) bindings is generated from the two tables below,
//! [`for_each_structure_format!`] and [`for_each_trajectory_format!`]. A format
//! added here therefore appears on both hosts at once with the same name and
//! signature — CRITICAL RULE #6 (host consistency) by construction rather than
//! by review. The tables also drive [`StructureFormat`] / [`TrajectoryFormat`],
//! whose `parse` is the one place a format is dispatched to its parser.
//!
//! A binding consumes a table with the callback pattern: it defines a
//! `macro_rules!` that turns one entry into one exported function and passes
//! that macro's name to the table macro.
//!
//! Host-specific exports that are deliberately *not* in these tables (each
//! binding's parity test keeps an explicit allowlist of them):
//!
//! - WASM only: the lazy decoders (`XtcDecoder`, `LammpstrjDecoder`,
//!   `StructureFrameDecoder`), the bounded-prefix first-paint helpers
//!   (`parse_structure_prefix`, `decode_trajectory_frame0`), and the
//!   topology-side helpers the browser calls on text it already holds
//!   (`parse_top_bonds`, `parse_top_bonds_with_includes`, `parse_pdb_bonds`,
//!   `extract_labels`).
//! - Python only: `parse_amber(prmtop, inpcrd)` (a two-file parse; the browser
//!   joins prmtop + inpcrd in its pipeline instead) and
//!   `parse_top_bonds_from_path` (resolves `#include`s from the filesystem).
//! - Both, but not structures: `parse_jcampdx` (a spectrum, no coordinates) and
//!   `parse_psf_bonds` (bond pairs only).

use crate::parser::ParsedStructure;
use crate::trajectory::TrajectoryData;

/// Every structure format, as `Variant => binding_fn(arg: type);`.
///
/// `binding_fn` is the exported name on both hosts (`megane_wasm.parse_pdb`,
/// `megane_parser.parse_pdb`); `arg: type` is its single argument, `&str` for
/// text formats and `&[u8]` for binary ones. The `#[doc]` attributes on each
/// entry become the exported function's documentation. They are plain string
/// attributes rather than `///` comments because `macro_rules!` turns `///`
/// into raw-string literals, which `wasm-bindgen` copies verbatim (`r"…"`)
/// into the generated `.d.ts`.
///
/// Call it with the name of a macro that accepts
/// `$( $(#[doc = $doc:tt])* $variant:ident => $binding:ident($arg:ident: $ty:ty); )*`.
#[macro_export]
macro_rules! for_each_structure_format {
    ($callback:ident) => {
        $callback! {
            #[doc = " Parse a PDB file text and return structured data."]
            Pdb => parse_pdb(text: &str);
            #[doc = " Parse a GRO file text and return structured data."]
            Gro => parse_gro(text: &str);
            #[doc = " Parse an XYZ file text and return structured data."]
            Xyz => parse_xyz(text: &str);
            #[doc = " Parse an XCrySDen structure file (`.xsf` / `.axsf`) and return"]
            #[doc = " structured data. An `ANIMSTEPS` animation yields a multi-frame"]
            #[doc = " structure."]
            Xsf => parse_xsf(text: &str);
            #[doc = " Parse a Chemical Markup Language (`.cml`) document and return"]
            #[doc = " structured data."]
            Cml => parse_cml(text: &str);
            #[doc = " Parse a VASP POSCAR / CONTCAR / XDATCAR (also `.vasp`) text and"]
            #[doc = " return structured data. An XDATCAR yields a multi-frame structure."]
            Vasp => parse_vasp(text: &str);
            #[doc = " Parse a Molden file (`.molden`) and return structured data. A"]
            #[doc = " `[GEOMETRIES] XYZ` block yields a multi-frame structure."]
            Molden => parse_molden(text: &str);
            #[doc = " Parse a Chem3D XML (`.c3xml`) document and return structured data."]
            C3xml => parse_c3xml(text: &str);
            #[doc = " Parse a Wavefunction Odyssey (`.xodydata` / `.odydata`) file and"]
            #[doc = " return structured data. The XML and text flavours are detected"]
            #[doc = " from the content."]
            Odydata => parse_odydata(text: &str);
            #[doc = " Parse a CASTEP / Quantum ESPRESSO NMR `.magres` file and return"]
            #[doc = " structured data from its `[atoms]` block."]
            Magres => parse_magres(text: &str);
            #[doc = " Parse a GAMESS (US / Firefly) output file and return structured"]
            #[doc = " data. Each `COORDINATES OF ALL ATOMS ARE` block becomes a frame."]
            Gamess => parse_gamess(text: &str);
            #[doc = " Parse a CASTEP `.phonon` lattice-dynamics file and return the"]
            #[doc = " periodic structure from its header."]
            Phonon => parse_phonon(text: &str);
            #[doc = " Parse an MDL Molfile (V2000) text and return structured data."]
            Mol => parse_mol(text: &str);
            #[doc = " Parse a Tripos MOL2 file text and return structured data."]
            Mol2 => parse_mol2(text: &str);
            #[doc = " Parse a CIF file text and return structured data."]
            #[doc = ""]
            #[doc = " Auto-detects mmCIF (PDBx/macromolecular) vs small-molecule CIF"]
            #[doc = " and routes to the appropriate parser."]
            Cif => parse_cif(text: &str);
            #[doc = " Parse an mmCIF (PDBx) file text and return structured data."]
            Mmcif => parse_mmcif(text: &str);
            #[doc = " Parse a LAMMPS data file text and return structured data."]
            LammpsData => parse_lammps_data(text: &str);
            #[doc = " Parse an AMBER prmtop topology file (topology only, positions at"]
            #[doc = " origin)."]
            Prmtop => parse_prmtop(text: &str);
            #[doc = " Parse a LAMMPS dump as a standalone multi-frame **structure**"]
            #[doc = " (frame-0 topology + extra frames). Element identities are the"]
            #[doc = " integer LAMMPS `type` ids used as an atomic-number proxy; bonds"]
            #[doc = " are inferred from frame 0."]
            LammpsDump => parse_lammpstrj_structure(text: &str);
            #[doc = " Parse an ASE .traj file (ULM binary format) and return"]
            #[doc = " structured data."]
            AseTraj => parse_traj(data: &[u8]);
        }
    };
}

/// Every trajectory format (frames attached to a separately loaded topology),
/// as `Variant => wasm_fn / python_fn(arg: type);`.
///
/// The two hosts historically name these differently (`parse_xtc_file` in the
/// browser, `parse_xtc` in Python) and both names are public API, so each
/// entry carries both; a binding uses its own and ignores the other.
///
/// Call it with the name of a macro that accepts
/// `$( $(#[doc = $doc:tt])* $variant:ident => $wasm:ident / $py:ident($arg:ident: $ty:ty); )*`.
#[macro_export]
macro_rules! for_each_trajectory_format {
    ($callback:ident) => {
        $callback! {
            #[doc = " Parse an XTC trajectory binary and return frame data."]
            Xtc => parse_xtc_file / parse_xtc(data: &[u8]);
            #[doc = " Parse a DCD trajectory binary (CHARMM/NAMD/X-PLOR) and return"]
            #[doc = " frame data."]
            Dcd => parse_dcd_file / parse_dcd(data: &[u8]);
            #[doc = " Parse an AMBER NetCDF trajectory binary (`.nc`) and return frame"]
            #[doc = " data."]
            NetCdf => parse_netcdf_file / parse_netcdf(data: &[u8]);
            #[doc = " Parse a LAMMPS dump trajectory (`.lammpstrj`) text and return"]
            #[doc = " frame data."]
            LammpsDump => parse_lammpstrj_file / parse_lammpstrj(text: &str);
        }
    };
}

/// Whether a format's parser reads text or raw bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Text,
    Binary,
}

impl Encoding {
    /// `"text"` / `"binary"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Encoding::Text => "text",
            Encoding::Binary => "binary",
        }
    }
}

/// Maps a binding argument type (`&str` / `&[u8]`) to its [`Encoding`], so the
/// tables above state each format's encoding exactly once — in its signature.
pub trait InputEncoding {
    const ENCODING: Encoding;
}

impl InputEncoding for &str {
    const ENCODING: Encoding = Encoding::Text;
}

impl InputEncoding for &[u8] {
    const ENCODING: Encoding = Encoding::Binary;
}

/// The file contents handed to a format's parser.
///
/// Either form is accepted for any format: a binary format reads text input as
/// its UTF-8 bytes, and a text format rejects bytes that are not valid UTF-8.
#[derive(Debug, Clone, Copy)]
pub enum FormatInput<'a> {
    Text(&'a str),
    Bytes(&'a [u8]),
}

impl<'a> From<&'a str> for FormatInput<'a> {
    fn from(text: &'a str) -> Self {
        FormatInput::Text(text)
    }
}

impl<'a> From<&'a [u8]> for FormatInput<'a> {
    fn from(data: &'a [u8]) -> Self {
        FormatInput::Bytes(data)
    }
}

impl<'a> FormatInput<'a> {
    fn text(self) -> Result<&'a str, String> {
        match self {
            FormatInput::Text(text) => Ok(text),
            FormatInput::Bytes(data) => {
                std::str::from_utf8(data).map_err(|e| format!("file is not valid UTF-8: {e}"))
            }
        }
    }

    fn bytes(self) -> &'a [u8] {
        match self {
            FormatInput::Text(text) => text.as_bytes(),
            FormatInput::Bytes(data) => data,
        }
    }
}

/// Normalise an extension for lookup: lowercase with a leading dot, so
/// `"PDB"`, `"pdb"`, and `".pdb"` all match.
fn normalize_extension(ext: &str) -> String {
    let lower = ext.to_ascii_lowercase();
    if lower.starts_with('.') {
        lower
    } else {
        format!(".{lower}")
    }
}

macro_rules! define_structure_formats {
    ($( $(#[doc = $doc:tt])* $variant:ident => $binding:ident($arg:ident: $ty:ty); )*) => {
        /// A structure format megane parses (topology + frame 0, optionally
        /// extra frames). Generated from [`for_each_structure_format!`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum StructureFormat {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl StructureFormat {
            /// Every structure format, in table order.
            pub const ALL: &'static [StructureFormat] = &[$(StructureFormat::$variant),*];

            /// The exported `parse_*` function name on both hosts.
            pub const fn binding_name(self) -> &'static str {
                match self {
                    $( StructureFormat::$variant => stringify!($binding), )*
                }
            }

            /// Whether the binding takes the file as text or bytes.
            pub const fn encoding(self) -> Encoding {
                match self {
                    $( StructureFormat::$variant => <$ty as InputEncoding>::ENCODING, )*
                }
            }
        }
    };
}

for_each_structure_format!(define_structure_formats);

macro_rules! define_trajectory_formats {
    ($( $(#[doc = $doc:tt])* $variant:ident => $wasm:ident / $py:ident($arg:ident: $ty:ty); )*) => {
        /// A trajectory format (frames attached to a separately loaded
        /// topology). Generated from [`for_each_trajectory_format!`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum TrajectoryFormat {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl TrajectoryFormat {
            /// Every trajectory format, in table order.
            pub const ALL: &'static [TrajectoryFormat] = &[$(TrajectoryFormat::$variant),*];

            /// The exported function name in the WASM binding.
            pub const fn wasm_binding_name(self) -> &'static str {
                match self {
                    $( TrajectoryFormat::$variant => stringify!($wasm), )*
                }
            }

            /// The exported function name in the Python binding.
            pub const fn python_binding_name(self) -> &'static str {
                match self {
                    $( TrajectoryFormat::$variant => stringify!($py), )*
                }
            }

            /// Whether the binding takes the file as text or bytes.
            pub const fn encoding(self) -> Encoding {
                match self {
                    $( TrajectoryFormat::$variant => <$ty as InputEncoding>::ENCODING, )*
                }
            }
        }
    };
}

for_each_trajectory_format!(define_trajectory_formats);

/// Parse a `.cif` file, auto-detecting mmCIF (PDBx/macromolecular) vs
/// small-molecule CIF and routing to the matching parser.
pub fn parse_cif_auto(text: &str) -> Result<ParsedStructure, String> {
    if crate::mmcif::is_mmcif(text) {
        crate::mmcif::parse(text)
    } else {
        crate::cif::parse(text)
    }
}

impl StructureFormat {
    /// The file extensions (lowercase, with the leading dot) a structure file of
    /// this format is opened by. Mirrors `STRUCTURE_EXTS` in
    /// `src/parsers/fileNames.ts` and `TEXT_PARSERS` / `BINARY_PARSERS` in
    /// `python/megane/parsers/dispatch.py` (the bindings' parity tests pin all
    /// three together). VASP's extensionless `POSCAR` / `CONTCAR` / `XDATCAR`
    /// names are matched by basename on each host and resolve to `.vasp`.
    pub const fn extensions(self) -> &'static [&'static str] {
        match self {
            StructureFormat::Pdb => &[".pdb"],
            StructureFormat::Gro => &[".gro"],
            StructureFormat::Xyz => &[".xyz", ".jxyz", ".extxyz"],
            StructureFormat::Xsf => &[".xsf", ".axsf"],
            StructureFormat::Cml => &[".cml"],
            StructureFormat::Vasp => &[".vasp"],
            StructureFormat::Molden => &[".molden"],
            StructureFormat::C3xml => &[".c3xml"],
            StructureFormat::Odydata => &[".xodydata", ".odydata"],
            StructureFormat::Magres => &[".magres"],
            StructureFormat::Gamess => &[".gamess"],
            StructureFormat::Phonon => &[".phonon"],
            StructureFormat::Mol => &[".mol", ".sdf"],
            StructureFormat::Mol2 => &[".mol2"],
            StructureFormat::Cif => &[".cif"],
            StructureFormat::Mmcif => &[".mmcif"],
            StructureFormat::LammpsData => &[".data", ".lammps"],
            StructureFormat::Prmtop => &[".prmtop"],
            StructureFormat::LammpsDump => &[".lammpstrj", ".dump", ".trj"],
            StructureFormat::AseTraj => &[".traj"],
        }
    }

    /// The structure format a file extension opens as (case-insensitive, with
    /// or without the leading dot), or `None` for an unknown extension.
    pub fn from_extension(ext: &str) -> Option<Self> {
        let ext = normalize_extension(ext);
        Self::ALL
            .iter()
            .copied()
            .find(|f| f.extensions().contains(&ext.as_str()))
    }

    /// Parse `input` as this format.
    pub fn parse(self, input: FormatInput<'_>) -> Result<ParsedStructure, String> {
        use crate::*;
        match self {
            StructureFormat::Pdb => parser::parse(input.text()?),
            StructureFormat::Gro => gro::parse(input.text()?),
            StructureFormat::Xyz => xyz::parse(input.text()?),
            StructureFormat::Xsf => xsf::parse(input.text()?),
            StructureFormat::Cml => cml::parse(input.text()?),
            StructureFormat::Vasp => vasp::parse(input.text()?),
            StructureFormat::Molden => molden::parse(input.text()?),
            StructureFormat::C3xml => c3xml::parse(input.text()?),
            StructureFormat::Odydata => odydata::parse(input.text()?),
            StructureFormat::Magres => magres::parse(input.text()?),
            StructureFormat::Gamess => gamess::parse(input.text()?),
            StructureFormat::Phonon => phonon::parse(input.text()?),
            StructureFormat::Mol => mol::parse(input.text()?),
            StructureFormat::Mol2 => mol2::parse(input.text()?),
            StructureFormat::Cif => parse_cif_auto(input.text()?),
            StructureFormat::Mmcif => mmcif::parse(input.text()?),
            StructureFormat::LammpsData => lammps_data::parse(input.text()?),
            StructureFormat::Prmtop => amber::parse_prmtop(input.text()?),
            StructureFormat::LammpsDump => lammpstrj::parse_lammpstrj_structure(input.text()?),
            StructureFormat::AseTraj => traj::parse_traj(input.bytes()),
        }
    }
}

/// Parse `input` as structure format `format` (shorthand for
/// [`StructureFormat::parse`]).
pub fn parse_structure<'a>(
    format: StructureFormat,
    input: impl Into<FormatInput<'a>>,
) -> Result<ParsedStructure, String> {
    format.parse(input.into())
}

impl TrajectoryFormat {
    /// The file extensions (lowercase, with the leading dot) a trajectory of
    /// this format is attached by. Mirrors `TRAJECTORY_EXTS` in
    /// `src/parsers/fileNames.ts`.
    pub const fn extensions(self) -> &'static [&'static str] {
        match self {
            TrajectoryFormat::Xtc => &[".xtc"],
            TrajectoryFormat::Dcd => &[".dcd"],
            TrajectoryFormat::NetCdf => &[".nc"],
            TrajectoryFormat::LammpsDump => &[".lammpstrj", ".dump", ".trj"],
        }
    }

    /// The trajectory format a file extension attaches as (case-insensitive,
    /// with or without the leading dot), or `None` for an unknown extension.
    pub fn from_extension(ext: &str) -> Option<Self> {
        let ext = normalize_extension(ext);
        Self::ALL
            .iter()
            .copied()
            .find(|f| f.extensions().contains(&ext.as_str()))
    }

    /// Parse `input` as this format.
    pub fn parse(self, input: FormatInput<'_>) -> Result<TrajectoryData, String> {
        match self {
            TrajectoryFormat::Xtc => crate::xtc::parse_xtc(input.bytes()),
            TrajectoryFormat::Dcd => crate::dcd::parse_dcd(input.bytes()),
            TrajectoryFormat::NetCdf => crate::netcdf::parse_netcdf(input.bytes()),
            TrajectoryFormat::LammpsDump => crate::lammpstrj::parse_lammpstrj(input.text()?),
        }
    }
}

/// Parse `input` as trajectory format `format` (shorthand for
/// [`TrajectoryFormat::parse`]).
pub fn parse_trajectory<'a>(
    format: TrajectoryFormat,
    input: impl Into<FormatInput<'a>>,
) -> Result<TrajectoryData, String> {
    format.parse(input.into())
}

fn json_string_list(items: &[&str]) -> String {
    let quoted: Vec<String> = items.iter().map(|s| format!("\"{s}\"")).collect();
    format!("[{}]", quoted.join(","))
}

/// The registry as JSON, exposed by both bindings as `format_registry()` so
/// each host's tests can check its exports and extension tables against the
/// one source of truth:
///
/// ```json
/// {"structure":[{"binding":"parse_pdb","encoding":"text","extensions":[".pdb"]},…],
///  "trajectory":[{"wasm":"parse_xtc_file","python":"parse_xtc","encoding":"binary","extensions":[".xtc"]},…]}
/// ```
///
/// Every value is a fixed identifier or extension from the tables above, so no
/// JSON escaping is needed.
pub fn registry_json() -> String {
    let structure: Vec<String> = StructureFormat::ALL
        .iter()
        .map(|f| {
            format!(
                r#"{{"binding":"{}","encoding":"{}","extensions":{}}}"#,
                f.binding_name(),
                f.encoding().as_str(),
                json_string_list(f.extensions())
            )
        })
        .collect();
    let trajectory: Vec<String> = TrajectoryFormat::ALL
        .iter()
        .map(|f| {
            format!(
                r#"{{"wasm":"{}","python":"{}","encoding":"{}","extensions":{}}}"#,
                f.wasm_binding_name(),
                f.python_binding_name(),
                f.encoding().as_str(),
                json_string_list(f.extensions())
            )
        })
        .collect();
    format!(
        r#"{{"structure":[{}],"trajectory":[{}]}}"#,
        structure.join(","),
        trajectory.join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../../../tests/fixtures/", $name))
        };
    }
    macro_rules! fixture_bytes {
        ($name:literal) => {
            include_bytes!(concat!("../../../tests/fixtures/", $name))
        };
    }

    #[test]
    fn binding_names_are_unique_and_prefixed() {
        let names: HashSet<_> = StructureFormat::ALL
            .iter()
            .map(|f| f.binding_name())
            .collect();
        assert_eq!(names.len(), StructureFormat::ALL.len());
        assert!(names.iter().all(|n| n.starts_with("parse_")));
        assert!(names.contains("parse_pdb"));
        assert!(names.contains("parse_lammpstrj_structure"));

        let wasm: HashSet<_> = TrajectoryFormat::ALL
            .iter()
            .map(|f| f.wasm_binding_name())
            .collect();
        let py: HashSet<_> = TrajectoryFormat::ALL
            .iter()
            .map(|f| f.python_binding_name())
            .collect();
        assert_eq!(wasm.len(), TrajectoryFormat::ALL.len());
        assert_eq!(py.len(), TrajectoryFormat::ALL.len());
        assert_eq!(TrajectoryFormat::Xtc.wasm_binding_name(), "parse_xtc_file");
        assert_eq!(TrajectoryFormat::Xtc.python_binding_name(), "parse_xtc");
        // No trajectory binding may shadow a structure binding on either host.
        assert!(wasm.is_disjoint(&names));
        assert!(py.is_disjoint(&names));
    }

    #[test]
    fn encodings_follow_the_binding_signature() {
        for f in StructureFormat::ALL {
            let expected = if *f == StructureFormat::AseTraj {
                Encoding::Binary
            } else {
                Encoding::Text
            };
            assert_eq!(f.encoding(), expected, "{f:?}");
        }
        assert_eq!(TrajectoryFormat::Xtc.encoding(), Encoding::Binary);
        assert_eq!(TrajectoryFormat::Dcd.encoding(), Encoding::Binary);
        assert_eq!(TrajectoryFormat::NetCdf.encoding(), Encoding::Binary);
        assert_eq!(TrajectoryFormat::LammpsDump.encoding(), Encoding::Text);
        assert_eq!(Encoding::Text.as_str(), "text");
        assert_eq!(Encoding::Binary.as_str(), "binary");
    }

    #[test]
    fn every_extension_round_trips_to_its_format() {
        let mut seen = HashSet::new();
        for f in StructureFormat::ALL {
            assert!(!f.extensions().is_empty(), "{f:?}");
            for ext in f.extensions() {
                assert!(seen.insert(*ext), "duplicate structure extension {ext}");
                assert_eq!(StructureFormat::from_extension(ext), Some(*f));
            }
        }
        let mut seen = HashSet::new();
        for f in TrajectoryFormat::ALL {
            for ext in f.extensions() {
                assert!(seen.insert(*ext), "duplicate trajectory extension {ext}");
                assert_eq!(TrajectoryFormat::from_extension(ext), Some(*f));
            }
        }
    }

    #[test]
    fn from_extension_normalizes_case_and_dot() {
        assert_eq!(
            StructureFormat::from_extension("PDB"),
            Some(StructureFormat::Pdb)
        );
        assert_eq!(
            StructureFormat::from_extension(".SDF"),
            Some(StructureFormat::Mol)
        );
        assert_eq!(
            StructureFormat::from_extension("cif"),
            Some(StructureFormat::Cif)
        );
        assert_eq!(StructureFormat::from_extension(".xtc"), None);
        assert_eq!(StructureFormat::from_extension(""), None);
        assert_eq!(
            TrajectoryFormat::from_extension("NC"),
            Some(TrajectoryFormat::NetCdf)
        );
        assert_eq!(
            TrajectoryFormat::from_extension(".dump"),
            Some(TrajectoryFormat::LammpsDump)
        );
        assert_eq!(TrajectoryFormat::from_extension(".pdb"), None);
    }

    /// Each table entry dispatches to the same parser the bindings used to call
    /// directly: compare against the per-module entry point on a fixture.
    #[test]
    fn structure_dispatch_matches_the_module_parsers() {
        use crate::*;
        let cases: Vec<(StructureFormat, &str, Result<ParsedStructure, String>)> = vec![
            (
                StructureFormat::Pdb,
                fixture!("1crn.pdb"),
                parser::parse(fixture!("1crn.pdb")),
            ),
            (
                StructureFormat::Gro,
                fixture!("water.gro"),
                gro::parse(fixture!("water.gro")),
            ),
            (
                StructureFormat::Xyz,
                fixture!("si_diamond.xyz"),
                xyz::parse(fixture!("si_diamond.xyz")),
            ),
            (
                StructureFormat::Xsf,
                fixture!("si_diamond.xsf"),
                xsf::parse(fixture!("si_diamond.xsf")),
            ),
            (
                StructureFormat::Cml,
                fixture!("ethanol.cml"),
                cml::parse(fixture!("ethanol.cml")),
            ),
            (
                StructureFormat::Vasp,
                fixture!("POSCAR_si_diamond"),
                vasp::parse(fixture!("POSCAR_si_diamond")),
            ),
            (
                StructureFormat::Molden,
                fixture!("water.molden"),
                molden::parse(fixture!("water.molden")),
            ),
            (
                StructureFormat::C3xml,
                fixture!("benzene_chem3d.c3xml"),
                c3xml::parse(fixture!("benzene_chem3d.c3xml")),
            ),
            (
                StructureFormat::Odydata,
                fixture!("ethanol.xodydata"),
                odydata::parse(fixture!("ethanol.xodydata")),
            ),
            (
                StructureFormat::Magres,
                fixture!("si_nmr.magres"),
                magres::parse(fixture!("si_nmr.magres")),
            ),
            (
                StructureFormat::Gamess,
                fixture!("water_opt.gamess"),
                gamess::parse(fixture!("water_opt.gamess")),
            ),
            (
                StructureFormat::Phonon,
                fixture!("si_gamma.phonon"),
                phonon::parse(fixture!("si_gamma.phonon")),
            ),
            (
                StructureFormat::Mol,
                fixture!("methane.mol"),
                mol::parse(fixture!("methane.mol")),
            ),
            (
                StructureFormat::Mol2,
                fixture!("methanol.mol2"),
                mol2::parse(fixture!("methanol.mol2")),
            ),
            (
                StructureFormat::Cif,
                fixture!("nacl.cif"),
                cif::parse(fixture!("nacl.cif")),
            ),
            (
                StructureFormat::Mmcif,
                fixture!("1ala.mmcif"),
                mmcif::parse(fixture!("1ala.mmcif")),
            ),
            (
                StructureFormat::LammpsData,
                fixture!("water.lammps"),
                lammps_data::parse(fixture!("water.lammps")),
            ),
            (
                StructureFormat::LammpsDump,
                fixture!("water.lammpstrj"),
                lammpstrj::parse_lammpstrj_structure(fixture!("water.lammpstrj")),
            ),
            // No prmtop fixture ships; an empty file exercises the dispatch arm
            // and must fail exactly like the direct call.
            (StructureFormat::Prmtop, "", amber::parse_prmtop("")),
        ];
        let covered: HashSet<_> = cases.iter().map(|(f, _, _)| *f).collect();
        for f in StructureFormat::ALL {
            assert!(
                covered.contains(f) || *f == StructureFormat::AseTraj,
                "{f:?} has no dispatch test case"
            );
        }
        for (format, text, direct) in cases {
            let via_registry = parse_structure(format, text);
            match (via_registry, direct) {
                (Ok(a), Ok(b)) => {
                    assert_eq!(a.n_atoms, b.n_atoms, "{format:?}");
                    assert_eq!(a.positions, b.positions, "{format:?}");
                    assert_eq!(a.bonds, b.bonds, "{format:?}");
                    assert!(a.n_atoms > 0, "{format:?}");
                }
                (Err(a), Err(b)) => assert_eq!(a, b, "{format:?}"),
                (a, b) => panic!(
                    "{format:?}: registry {:?} vs direct {:?}",
                    a.is_ok(),
                    b.is_ok()
                ),
            }
        }
    }

    #[test]
    fn ase_traj_accepts_bytes_or_text() {
        let bytes: &[u8] = fixture_bytes!("water.traj");
        let s = parse_structure(StructureFormat::AseTraj, bytes).unwrap();
        assert_eq!(s.n_atoms, crate::traj::parse_traj(bytes).unwrap().n_atoms);
        // Text input reaches a binary parser as its UTF-8 bytes.
        assert_eq!(
            parse_structure(StructureFormat::AseTraj, "not a traj")
                .err()
                .unwrap(),
            crate::traj::parse_traj(b"not a traj").err().unwrap()
        );
    }

    #[test]
    fn text_formats_accept_utf8_bytes_and_reject_invalid_utf8() {
        let text = fixture!("water.gro");
        let from_bytes = parse_structure(StructureFormat::Gro, text.as_bytes()).unwrap();
        assert_eq!(from_bytes.n_atoms, crate::gro::parse(text).unwrap().n_atoms);

        let invalid: &[u8] = &[0xff, 0xfe, 0x00];
        let err = parse_structure(StructureFormat::Gro, invalid)
            .err()
            .unwrap();
        assert!(err.contains("not valid UTF-8"), "{err}");
        let err = parse_trajectory(TrajectoryFormat::LammpsDump, invalid)
            .err()
            .unwrap();
        assert!(err.contains("not valid UTF-8"), "{err}");
    }

    #[test]
    fn cif_auto_detects_mmcif() {
        let mm = fixture!("1ala.mmcif");
        let small = fixture!("nacl.cif");
        assert_eq!(
            parse_cif_auto(mm).unwrap().n_atoms,
            crate::mmcif::parse(mm).unwrap().n_atoms
        );
        assert_eq!(
            parse_cif_auto(small).unwrap().n_atoms,
            crate::cif::parse(small).unwrap().n_atoms
        );
        // `.cif` routes through the detector, so an mmCIF body under the
        // small-molecule extension still gets the macromolecular parser.
        assert_eq!(
            parse_structure(StructureFormat::Cif, mm).unwrap().n_atoms,
            crate::mmcif::parse(mm).unwrap().n_atoms
        );
    }

    #[test]
    fn trajectory_dispatch_matches_the_module_parsers() {
        let xtc: &[u8] = fixture_bytes!("1crn_vibration.xtc");
        let dcd: &[u8] = fixture_bytes!("water.dcd");
        let nc: &[u8] = fixture_bytes!("water.nc");
        let dump = fixture!("water.lammpstrj");
        let cases = [
            (
                parse_trajectory(TrajectoryFormat::Xtc, xtc),
                crate::xtc::parse_xtc(xtc),
            ),
            (
                parse_trajectory(TrajectoryFormat::Dcd, dcd),
                crate::dcd::parse_dcd(dcd),
            ),
            (
                parse_trajectory(TrajectoryFormat::NetCdf, nc),
                crate::netcdf::parse_netcdf(nc),
            ),
            (
                parse_trajectory(TrajectoryFormat::LammpsDump, dump),
                crate::lammpstrj::parse_lammpstrj(dump),
            ),
        ];
        for (via_registry, direct) in cases {
            let (a, b) = (via_registry.unwrap(), direct.unwrap());
            assert!(a.n_frames > 0);
            assert_eq!(a.n_atoms, b.n_atoms);
            assert_eq!(a.n_frames, b.n_frames);
            assert_eq!(a.frame_positions_flat, b.frame_positions_flat);
        }
    }

    #[test]
    fn registry_json_lists_every_format() {
        let json = registry_json();
        assert!(json.starts_with(
            r#"{"structure":[{"binding":"parse_pdb","encoding":"text","extensions":[".pdb"]}"#
        ));
        assert!(
            json.contains(r#"{"binding":"parse_traj","encoding":"binary","extensions":[".traj"]}"#)
        );
        assert!(json.contains(
            r#"{"wasm":"parse_lammpstrj_file","python":"parse_lammpstrj","encoding":"text","extensions":[".lammpstrj",".dump",".trj"]}"#
        ));
        assert!(json.ends_with("]}"));
        for f in StructureFormat::ALL {
            assert!(json.contains(&format!("\"{}\"", f.binding_name())), "{f:?}");
        }
        assert_eq!(
            json.matches("\"binding\":").count(),
            StructureFormat::ALL.len()
        );
        assert_eq!(
            json.matches("\"wasm\":").count(),
            TrajectoryFormat::ALL.len()
        );
    }
}
