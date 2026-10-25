/// GROMACS .top / .itp topology file parser.
///
/// Parses bond pairs from the [ bonds ], [ constraints ] and [ settles ]
/// sections and resolves `#include` directives so that real-world multi-file
/// topologies work. Constraints and settles are file-declared connectivity
/// (rigid TIP3P/SPC water carries no [ bonds ] entries at all), so they are
/// emitted as regular bonds alongside the explicit ones.
use std::collections::{HashMap, HashSet};

// ── Virtual filesystem abstraction ────────────────────────────────────────────

/// Abstraction over a filesystem used to resolve `#include` directives.
///
/// Implement this trait to provide custom include resolution (e.g. for
/// WASM/browser contexts where real I/O is not available).
pub trait TopFileSystem {
    /// Return the contents of `path`, or `None` if the file does not exist.
    fn read(&self, path: &str) -> Option<String>;
}

/// A [`TopFileSystem`] backed by the real OS filesystem.
///
/// Include paths are resolved relative to `base_dir` first, then tried as
/// absolute paths.
#[cfg(not(target_arch = "wasm32"))]
pub struct RealTopFileSystem {
    /// Directory of the top-level `.top` file.
    pub base_dir: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl TopFileSystem for RealTopFileSystem {
    fn read(&self, path: &str) -> Option<String> {
        let in_base = std::path::Path::new(&self.base_dir).join(path);
        std::fs::read_to_string(&in_base)
            .or_else(|_| std::fs::read_to_string(path))
            .ok()
    }
}

/// A [`TopFileSystem`] backed by an in-memory map of path → content.
///
/// Used in WASM/browser contexts where caller provides all included file
/// contents upfront.
pub struct VirtualTopFileSystem {
    files: HashMap<String, String>,
}

impl VirtualTopFileSystem {
    pub fn new(files: HashMap<String, String>) -> Self {
        Self { files }
    }
}

impl TopFileSystem for VirtualTopFileSystem {
    fn read(&self, path: &str) -> Option<String> {
        self.files.get(path).cloned()
    }
}

// ── Include resolution ─────────────────────────────────────────────────────────

/// Extract the include path from a `#include "path"` or `#include <path>` line.
fn parse_include_directive(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("#include") {
        return None;
    }
    let rest = trimmed["#include".len()..].trim();
    if let Some(inner) = rest.strip_prefix('"') {
        inner.find('"').map(|end| inner[..end].to_string())
    } else if let Some(inner) = rest.strip_prefix('<') {
        inner.find('>').map(|end| inner[..end].to_string())
    } else {
        None
    }
}

// ── Preprocessor ──────────────────────────────────────────────────────────────

/// One open `#ifdef` / `#ifndef` (or unsupported `#if`) group.
struct CondGroup {
    /// Whether the enclosing text is active.
    parent_active: bool,
    /// Whether the current branch of this group is active.
    active: bool,
    /// Whether a branch of this group has already been taken (so `#else`
    /// must not be).
    taken: bool,
}

/// Run the GROMACS preprocessor subset over `text`, appending active lines
/// to `out`.
///
/// grompp feeds topologies through a C-preprocessor-like pass: `#define` /
/// `#undef` manage symbols, `#ifdef` / `#ifndef` / `#else` / `#endif` select
/// lines, and `#include` splices in another file. Without it both branches
/// of a conditional are read — CHARMM36's `tip3p.itp` lists its `[ atoms ]`
/// twice (`#ifdef HEAVY_H … #else … #endif`), which doubled the molecule's
/// atom count and shifted every later molecule's bonds.
///
/// Symbols are undefined unless the topology itself `#define`s them: the
/// `define = -D…` options of an `.mdp` file are not available here, so the
/// result is what grompp produces with no extra defines. `#if` / `#elif`
/// expressions (which grompp's own preprocessor does not support either) are
/// treated as false. Directive lines are never emitted.
///
/// `#include` is resolved through `fs` only in active text; with no
/// filesystem the include is dropped. Missing includes (e.g. system
/// force-field files) are skipped silently. Defines made in an included file
/// stay in effect afterwards, as with cpp.
fn preprocess<F: TopFileSystem>(
    text: &str,
    fs: Option<&F>,
    defines: &mut HashSet<String>,
    include_stack: &mut Vec<String>,
    out: &mut String,
) -> Result<(), String> {
    let mut groups: Vec<CondGroup> = Vec::new();
    for line in text.lines() {
        let active = groups.last().is_none_or(|g| g.active);
        let Some(directive) = line.trim_start().strip_prefix('#') else {
            if active {
                out.push_str(line);
                out.push('\n');
            }
            continue;
        };
        let mut words = directive.split_whitespace();
        let keyword = words.next().unwrap_or("");
        let symbol = words.next().unwrap_or("");
        match keyword {
            "ifdef" | "ifndef" | "if" => {
                let take = match keyword {
                    "ifdef" => defines.contains(symbol),
                    "ifndef" => !defines.contains(symbol),
                    _ => false,
                };
                groups.push(CondGroup {
                    parent_active: active,
                    active: active && take,
                    taken: take,
                });
            }
            "elif" => {
                if let Some(g) = groups.last_mut() {
                    g.active = false;
                }
            }
            "else" => {
                if let Some(g) = groups.last_mut() {
                    g.active = g.parent_active && !g.taken;
                    g.taken = true;
                }
            }
            "endif" => {
                groups.pop();
            }
            "define" if active && !symbol.is_empty() => {
                defines.insert(symbol.to_string());
            }
            "undef" if active => {
                defines.remove(symbol);
            }
            "include" if active => {
                let (Some(fs), Some(include_path)) = (fs, parse_include_directive(line)) else {
                    continue;
                };
                if include_stack.contains(&include_path) {
                    return Err(format!(
                        "Circular include detected: {} -> {}",
                        include_stack.join(" -> "),
                        include_path
                    ));
                }
                // Missing include (e.g. system forcefield files) — skip silently.
                if let Some(included_text) = fs.read(&include_path) {
                    include_stack.push(include_path);
                    preprocess(&included_text, Some(fs), defines, include_stack, out)?;
                    include_stack.pop();
                }
            }
            // Directives in inactive text, and ones without meaning here.
            _ => {}
        }
    }
    Ok(())
}

/// [`preprocess`] a whole topology with a fresh symbol table.
fn preprocess_top<F: TopFileSystem>(text: &str, fs: Option<&F>) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    preprocess(text, fs, &mut HashSet::new(), &mut Vec::new(), &mut out)?;
    Ok(out)
}

// ── Molecule-type-aware parsing ───────────────────────────────────────────────

/// A `[ moleculetype ]` block: its atom count and its bonds expressed with
/// LOCAL (0-indexed, relative to the molecule's own first atom) indices.
struct MoleculeType {
    n_atoms: usize,
    bonds: Vec<(u32, u32)>,
}

/// Strip an inline `;` comment and return the trimmed remainder, or `None`
/// if the line is empty/comment-only.
fn data_line(trimmed: &str) -> Option<&str> {
    let data = match trimmed.find(';') {
        Some(pos) => &trimmed[..pos],
        None => trimmed,
    };
    let data = data.trim();
    if data.is_empty() {
        None
    } else {
        Some(data)
    }
}

/// Store the currently-accumulated `[ moleculetype ]` block (if any) into
/// `moltypes`, recording first-seen order in `order`.
fn finalize_moltype(
    moltypes: &mut HashMap<String, MoleculeType>,
    order: &mut Vec<String>,
    name: Option<String>,
    atoms_max_id: usize,
    max_atom_index: u32,
    bonds: Vec<(u32, u32)>,
) {
    let Some(name) = name else { return };
    let n_atoms = if atoms_max_id > 0 {
        atoms_max_id
    } else {
        max_atom_index as usize
    };
    // Deduplicate within the molecule: the same pair may be listed both as an
    // explicit [ bonds ] entry and as a [ constraints ] / [ settles ] one.
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let bonds: Vec<(u32, u32)> = bonds.into_iter().filter(|b| seen.insert(*b)).collect();
    if !moltypes.contains_key(&name) {
        order.push(name.clone());
    }
    moltypes.insert(name, MoleculeType { n_atoms, bonds });
}

/// Parse `text` honoring GROMACS `[ moleculetype ]` / `[ molecules ]`
/// semantics: bonds inside a `[ moleculetype ]` block use atom indices LOCAL
/// to that molecule, and the `[ molecules ]` section lists how many copies of
/// each molecule type appear (in order) in the actual system. Each copy
/// contributes its own bonds, offset by the cumulative atom count of all
/// preceding molecule instances.
///
/// Returns `None` if `text` contains no `[ moleculetype ]` block, so the
/// caller can fall back to flat parsing for bare `.itp` snippets that don't
/// follow the full molecule-type structure (e.g. force-field fragments).
///
/// If the `[ molecules ]` section references a molecule type that could not
/// be resolved (e.g. its `#include` was missing), replication stops at that
/// point — continuing would require guessing that molecule's atom count and
/// could produce bonds at incorrect offsets for everything after it.
fn parse_top_bonds_grouped(text: &str, n_atoms: usize) -> Option<Vec<(u32, u32)>> {
    #[derive(PartialEq)]
    enum Section {
        None,
        Atoms,
        Bonds,
        Constraints,
        Settles,
        Molecules,
    }

    let mut moltypes: HashMap<String, MoleculeType> = HashMap::new();
    let mut moltype_order: Vec<String> = Vec::new();
    let mut molecules: Vec<(String, usize)> = Vec::new();

    let mut current_name: Option<String> = None;
    let mut awaiting_name = false;
    let mut current_atoms_max_id = 0usize;
    let mut current_max_atom_index = 0u32;
    let mut current_bonds: Vec<(u32, u32)> = Vec::new();
    let mut section = Section::None;
    let mut found_moleculetype = false;

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }

        if trimmed.starts_with('[') {
            let section_name = trimmed
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim()
                .to_lowercase();

            match section_name.as_str() {
                "moleculetype" => {
                    finalize_moltype(
                        &mut moltypes,
                        &mut moltype_order,
                        current_name.take(),
                        current_atoms_max_id,
                        current_max_atom_index,
                        std::mem::take(&mut current_bonds),
                    );
                    current_atoms_max_id = 0;
                    current_max_atom_index = 0;
                    awaiting_name = true;
                    found_moleculetype = true;
                    section = Section::None;
                }
                "molecules" => {
                    finalize_moltype(
                        &mut moltypes,
                        &mut moltype_order,
                        current_name.take(),
                        current_atoms_max_id,
                        current_max_atom_index,
                        std::mem::take(&mut current_bonds),
                    );
                    current_atoms_max_id = 0;
                    current_max_atom_index = 0;
                    section = Section::Molecules;
                }
                "atoms" => section = Section::Atoms,
                "bonds" => section = Section::Bonds,
                "constraints" => section = Section::Constraints,
                "settles" => section = Section::Settles,
                _ => section = Section::None,
            }
            continue;
        }

        let Some(data) = data_line(trimmed) else {
            continue;
        };

        if awaiting_name {
            if let Some(name) = data.split_whitespace().next() {
                current_name = Some(name.to_string());
            }
            awaiting_name = false;
            continue;
        }

        match section {
            // A molecule's size is its highest `[ atoms ]` id (grompp requires
            // ids 1..N), not its line count, so a repeated line cannot
            // inflate it.
            Section::Atoms => {
                if let Some(idx) = data
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u32>().ok())
                {
                    current_atoms_max_id = current_atoms_max_id.max(idx as usize);
                    current_max_atom_index = current_max_atom_index.max(idx);
                }
            }
            // Constraints (funct 1 and 2) are file-declared connectivity with
            // the same `ai aj funct b0` shape as [ bonds ].
            Section::Bonds | Section::Constraints => {
                let mut parts = data.split_whitespace();
                let ai: u32 = match parts.next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => continue,
                };
                let aj: u32 = match parts.next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => continue,
                };
                if ai == 0 || aj == 0 {
                    continue;
                }
                current_max_atom_index = current_max_atom_index.max(ai).max(aj);
                current_bonds.push(((ai - 1).min(aj - 1), (ai - 1).max(aj - 1)));
            }
            // A settle (`ow funct doh dhh`) rigidifies a 3-site water whose
            // hydrogens are by convention the two atoms following OW, so it
            // implies bonds OW-(OW+1) and OW-(OW+2).
            Section::Settles => {
                let ow: u32 = match data.split_whitespace().next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => continue,
                };
                if ow == 0 {
                    continue;
                }
                current_max_atom_index = current_max_atom_index.max(ow + 2);
                current_bonds.push((ow - 1, ow));
                current_bonds.push((ow - 1, ow + 1));
            }
            Section::Molecules => {
                let mut parts = data.split_whitespace();
                let name = match parts.next() {
                    Some(v) => v.to_string(),
                    None => continue,
                };
                let count: usize = match parts.next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => continue,
                };
                molecules.push((name, count));
            }
            Section::None => {}
        }
    }

    finalize_moltype(
        &mut moltypes,
        &mut moltype_order,
        current_name,
        current_atoms_max_id,
        current_max_atom_index,
        current_bonds,
    );

    if !found_moleculetype {
        return None;
    }

    // Prefer the explicit `[ molecules ]` system composition; fall back to
    // "each molecule type appears once, in definition order" when absent
    // (e.g. a single-molecule `.top` with no `[ molecules ]` section).
    let order: Vec<(String, usize)> = if !molecules.is_empty() {
        molecules
    } else {
        moltype_order.into_iter().map(|name| (name, 1)).collect()
    };

    let mut bonds = Vec::new();
    let mut offset: u32 = 0;
    for (name, count) in order {
        let Some(moltype) = moltypes.get(&name) else {
            // Unresolvable molecule type (e.g. missing #include) — stop here
            // rather than guess its atom count and miscompute later offsets.
            break;
        };
        for _ in 0..count {
            for &(a, b) in &moltype.bonds {
                let (ga, gb) = (offset + a, offset + b);
                if (gb as usize) < n_atoms {
                    bonds.push((ga, gb));
                }
            }
            offset += moltype.n_atoms as u32;
        }
    }

    Some(bonds)
}

/// Flat fallback: scan every `[ bonds ]`, `[ constraints ]` and `[ settles ]`
/// section in `text` and treat the listed atom indices as global
/// (system-wide) 1-based indices.
///
/// This matches the historical behaviour and is used for inputs that contain
/// no `[ moleculetype ]` block (e.g. bare `.itp` bond fragments), where there
/// is no molecule structure to replicate against.
fn parse_top_bonds_flat(text: &str, n_atoms: usize) -> Vec<(u32, u32)> {
    let mut bonds = Vec::new();
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut section = "";

    let mut push = |a: u32, b: u32, bonds: &mut Vec<(u32, u32)>| {
        let pair = (a.min(b), a.max(b));
        if (pair.1 as usize) < n_atoms && seen.insert(pair) {
            bonds.push(pair);
        }
    };

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }

        if trimmed.starts_with('[') {
            let section_name = trimmed
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim()
                .to_lowercase();
            section = match section_name.as_str() {
                "bonds" => "bonds",
                "constraints" => "constraints",
                "settles" => "settles",
                _ => "",
            };
            continue;
        }

        if section.is_empty() {
            continue;
        }

        let Some(data) = data_line(trimmed) else {
            continue;
        };

        let mut parts = data.split_whitespace();
        if section == "settles" {
            // `ow funct doh dhh` — implies bonds OW-(OW+1) and OW-(OW+2).
            let ow: u32 = match parts.next().and_then(|s| s.parse().ok()) {
                Some(v) => v,
                None => continue,
            };
            if ow == 0 {
                continue;
            }
            push(ow - 1, ow, &mut bonds);
            push(ow - 1, ow + 1, &mut bonds);
            continue;
        }

        // [ bonds ] and [ constraints ] share the `ai aj funct …` shape.
        let ai: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let aj: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };

        if ai == 0 || aj == 0 {
            continue;
        }
        push(ai - 1, aj - 1, &mut bonds);
    }

    bonds
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse a GROMACS `.top` / `.itp` text and extract bond pairs.
///
/// Connectivity is read from `[ bonds ]`, `[ constraints ]` (funct 1 and 2)
/// and `[ settles ]` sections; a settle on atom OW implies the two OW-H bonds
/// of a rigid 3-site water. Pairs listed in more than one of these sections
/// are emitted once.
///
/// Honors `[ moleculetype ]` / `[ molecules ]` semantics: atom indices inside
/// a `[ moleculetype ]` block's `[ bonds ]` section are LOCAL to that molecule,
/// and the `[ molecules ]` section lists how many copies of each molecule type
/// the system contains. Each copy's bonds are emitted with indices offset by
/// the cumulative atom count of preceding molecule instances, so a system
/// with e.g. 1000 copies of a 3-atom water molecule yields 1000 sets of
/// equivalent bonds rather than just the ones written literally in the file.
///
/// Inputs without any `[ moleculetype ]` block (bare bond fragments) fall
/// back to treating listed indices as global 1-based atom indices, matching
/// historical behaviour.
///
/// The GROMACS preprocessor conditionals (`#define`, `#undef`, `#ifdef`,
/// `#ifndef`, `#else`, `#endif`) are evaluated first, with every symbol
/// undefined unless the text `#define`s it (see the `preprocess` helper).
///
/// Returns `Vec<(a, b)>` with 0-indexed atom pairs where `a < b`.
/// `#include` directives are **not** resolved; pass pre-expanded text or use
/// [`parse_top_bonds_with_fs`] / [`parse_top_bonds_from_path`] instead.
pub fn parse_top_bonds(text: &str, n_atoms: usize) -> Vec<(u32, u32)> {
    // Without a filesystem `preprocess` drops `#include`s and so cannot fail.
    let text = preprocess_top(text, None::<&VirtualTopFileSystem>).unwrap_or_default();
    parse_preprocessed(&text, n_atoms)
}

/// Bond extraction over text the preprocessor has already run on.
fn parse_preprocessed(text: &str, n_atoms: usize) -> Vec<(u32, u32)> {
    match parse_top_bonds_grouped(text, n_atoms) {
        Some(bonds) => bonds,
        None => parse_top_bonds_flat(text, n_atoms),
    }
}

/// Parse a GROMACS `.top` text with `#include` resolution via a custom
/// filesystem implementation.
///
/// Returns an error string if a circular include is detected.
pub fn parse_top_bonds_with_fs<F: TopFileSystem>(
    top_text: &str,
    fs: &F,
    n_atoms: usize,
) -> Result<Vec<(u32, u32)>, String> {
    let expanded = preprocess_top(top_text, Some(fs))?;
    Ok(parse_preprocessed(&expanded, n_atoms))
}

/// Parse a GROMACS `.top` file at `path`, resolving `#include` directives
/// from the real filesystem.
///
/// Include paths are resolved relative to the directory of `path`.
#[cfg(not(target_arch = "wasm32"))]
pub fn parse_top_bonds_from_path(path: &str, n_atoms: usize) -> Result<Vec<(u32, u32)>, String> {
    use std::path::Path;

    let top_path = Path::new(path);
    let base_dir = top_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let text = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {path}: {e}"))?;

    let fs = RealTopFileSystem { base_dir };
    parse_top_bonds_with_fs(&text, &fs, n_atoms)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_top_bonds (existing behaviour) ──────────────────────────────────

    #[test]
    fn test_parse_top_bonds() {
        let text = r#"
; Comment line
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01

[ bonds ]
     1     2     1  ; bond 1-2
     2     3     1  ; bond 2-3
    10    11     1  ; bond 10-11

[ angles ]
     1     2     3     1
"#;
        let bonds = parse_top_bonds(text, 20);
        assert_eq!(bonds.len(), 3);
        assert_eq!(bonds[0], (0, 1));
        assert_eq!(bonds[1], (1, 2));
        assert_eq!(bonds[2], (9, 10));
    }

    #[test]
    fn test_out_of_range_bonds_filtered() {
        let text = "[ bonds ]\n1 2 1\n5 6 1\n";
        let bonds = parse_top_bonds(text, 3);
        assert_eq!(bonds.len(), 1);
        assert_eq!(bonds[0], (0, 1));
    }

    // ── molecule replication via [ molecules ] ────────────────────────────────

    #[test]
    fn test_molecule_replication_multiple_copies() {
        // A 3-atom "SOL" molecule with bonds 1-2 and 2-3 (local), replicated
        // 4 times by [ molecules ] -> bonds should appear at every offset.
        let text = r#"
[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1   0.0   16.00
     2  HW1  1  SOL  HW1  2   0.0    1.01
     3  HW2  1  SOL  HW2  3   0.0    1.01

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
SOL  4
"#;
        let bonds = parse_top_bonds(text, 12);
        assert_eq!(
            bonds,
            vec![
                (0, 1),
                (0, 2),
                (3, 4),
                (3, 5),
                (6, 7),
                (6, 8),
                (9, 10),
                (9, 11),
            ]
        );
    }

    #[test]
    fn test_molecule_replication_multiple_types() {
        // protein (5 atoms, 4 bonds) appears once, then SOL (3 atoms, 2 bonds)
        // appears twice -- offsets must account for the preceding molecules.
        let text = r#"
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01
     3  C    1  ALA  C    3   0.6   12.01
     4  O    1  ALA  O    4  -0.5   16.00
     5  CB   1  ALA  CB   5  -0.1   12.01

[ bonds ]
     1     2     1
     2     3     1
     3     4     1
     2     5     1

[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1   0.0   16.00
     2  HW1  1  SOL  HW1  2   0.0    1.01
     3  HW2  1  SOL  HW2  3   0.0    1.01

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
protein  1
SOL      2
"#;
        let bonds = parse_top_bonds(text, 11);
        assert_eq!(
            bonds,
            vec![
                (0, 1),
                (1, 2),
                (2, 3),
                (1, 4),
                (5, 6),
                (5, 7),
                (8, 9),
                (8, 10),
            ]
        );
    }

    #[test]
    fn test_molecule_replication_default_order_without_molecules_section() {
        // No [ molecules ] section: each moleculetype is assumed to appear
        // exactly once, in file order, so a single-molecule .top behaves
        // exactly like the legacy flat parser.
        let text = r#"
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01

[ bonds ]
     1     2     1
"#;
        let bonds = parse_top_bonds(text, 2);
        assert_eq!(bonds, vec![(0, 1)]);
    }

    #[test]
    fn test_molecule_replication_unresolved_type_stops_replication() {
        // SOL has no [ moleculetype ] definition (e.g. its #include was
        // missing); replication should stop there rather than guess its
        // atom count and miscompute offsets for anything that follows.
        let text = r#"
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01

[ bonds ]
     1     2     1

[ molecules ]
protein  1
SOL      10
"#;
        let bonds = parse_top_bonds(text, 32);
        assert_eq!(bonds, vec![(0, 1)]);
    }

    #[test]
    fn test_molecule_replication_n_atoms_inferred_without_atoms_section() {
        // No [ atoms ] section: molecule atom count is inferred from the
        // highest atom index referenced in [ bonds ].
        let text = r#"
[ moleculetype ]
SOL  2

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
SOL  2
"#;
        let bonds = parse_top_bonds(text, 6);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4), (3, 5)]);
    }

    // ── [ settles ] and [ constraints ] ───────────────────────────────────────

    #[test]
    fn test_settles_imply_water_bonds_replicated() {
        // Rigid TIP3P water: no [ bonds ] section at all, one settle on OW.
        // Each of the 3 copies must get its two OW-H bonds.
        let text = r#"
[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1  -0.834  16.00
     2  HW1  1  SOL  HW1  2   0.417   1.01
     3  HW2  1  SOL  HW2  3   0.417   1.01

[ settles ]
; OW  funct  doh      dhh
   1   1     0.09572  0.15139

[ molecules ]
SOL  3
"#;
        let bonds = parse_top_bonds(text, 9);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4), (3, 5), (6, 7), (6, 8)]);
    }

    #[test]
    fn test_constraints_parsed_as_bonds() {
        // Both funct 1 (bond-replacing) and funct 2 (exclusion-free) count.
        let text = r#"
[ moleculetype ]
MOL  2

[ atoms ]
     1  C1   1  MOL  C1   1   0.0  12.01
     2  C2   1  MOL  C2   2   0.0  12.01
     3  C3   1  MOL  C3   3   0.0  12.01

[ constraints ]
     1     2     1   0.100
     2     3     2   0.100
"#;
        let bonds = parse_top_bonds(text, 3);
        assert_eq!(bonds, vec![(0, 1), (1, 2)]);
    }

    #[test]
    fn test_constraints_deduplicated_against_bonds() {
        // The same pair in [ bonds ] and [ constraints ] must appear once,
        // and the dedup must hold across every replicated copy.
        let text = r#"
[ moleculetype ]
MOL  2

[ atoms ]
     1  C1   1  MOL  C1   1   0.0  12.01
     2  C2   1  MOL  C2   2   0.0  12.01

[ bonds ]
     1     2     1

[ constraints ]
     1     2     1   0.100

[ molecules ]
MOL  2
"#;
        let bonds = parse_top_bonds(text, 4);
        assert_eq!(bonds, vec![(0, 1), (2, 3)]);
    }

    #[test]
    fn test_settles_deduplicated_against_bonds() {
        // Some topologies carry both flexible [ bonds ] and a [ settles ]
        // entry for the same water; the OW-H pairs must not be doubled.
        let text = r#"
[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1  -0.834  16.00
     2  HW1  1  SOL  HW1  2   0.417   1.01
     3  HW2  1  SOL  HW2  3   0.417   1.01

[ bonds ]
     1     2     1
     1     3     1

[ settles ]
   1   1     0.09572  0.15139
"#;
        let bonds = parse_top_bonds(text, 3);
        assert_eq!(bonds, vec![(0, 1), (0, 2)]);
    }

    #[test]
    fn test_settles_infer_molecule_size_without_atoms_section() {
        // No [ atoms ] section: the settle's implied H indices (OW+1, OW+2)
        // must feed the molecule atom count so replication offsets are right.
        let text = r#"
[ moleculetype ]
SOL  2

[ settles ]
   1   1     0.09572  0.15139

[ molecules ]
SOL  2
"#;
        let bonds = parse_top_bonds(text, 6);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4), (3, 5)]);
    }

    #[test]
    fn test_flat_fallback_reads_settles_and_constraints() {
        // Bare fragment without [ moleculetype ]: indices are global 1-based.
        let text = "[ settles ]\n1 1 0.09572 0.15139\n[ constraints ]\n4 5 1 0.1\n";
        let bonds = parse_top_bonds(text, 5);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4)]);
    }

    #[test]
    fn test_flat_fallback_dedups_bonds_and_constraints() {
        let text = "[ bonds ]\n1 2 1\n[ constraints ]\n1 2 1 0.1\n2 1 2 0.1\n";
        let bonds = parse_top_bonds(text, 5);
        assert_eq!(bonds, vec![(0, 1)]);
    }

    // ── parse_include_directive ───────────────────────────────────────────────

    #[test]
    fn test_parse_include_double_quote() {
        assert_eq!(
            parse_include_directive(r#"#include "molecule.itp""#),
            Some("molecule.itp".to_string())
        );
    }

    #[test]
    fn test_parse_include_angle_bracket() {
        assert_eq!(
            parse_include_directive("#include <forcefield.itp>"),
            Some("forcefield.itp".to_string())
        );
    }

    #[test]
    fn test_parse_include_with_leading_whitespace() {
        assert_eq!(
            parse_include_directive(r#"  #include "ions.itp""#),
            Some("ions.itp".to_string())
        );
    }

    #[test]
    fn test_parse_include_none_for_normal_line() {
        assert_eq!(parse_include_directive("[ bonds ]"), None);
        assert_eq!(parse_include_directive("; comment"), None);
        assert_eq!(parse_include_directive("1 2 1"), None);
    }

    // ── VirtualTopFileSystem + parse_top_bonds_with_fs ────────────────────────

    fn make_vfs(entries: &[(&str, &str)]) -> VirtualTopFileSystem {
        VirtualTopFileSystem::new(
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[test]
    fn test_vfs_flat_include() {
        // molecule.itp provides the [ bonds ] section
        let vfs = make_vfs(&[("molecule.itp", "[ bonds ]\n1 2 1\n2 3 1\n")]);
        let top = r#"#include "molecule.itp""#;
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        assert_eq!(bonds.len(), 2);
        assert_eq!(bonds[0], (0, 1));
        assert_eq!(bonds[1], (1, 2));
    }

    #[test]
    fn test_vfs_nested_includes() {
        // top.top → mol.itp → atoms.itp (which has [ bonds ])
        let vfs = make_vfs(&[
            ("mol.itp", r#"#include "atoms.itp""#),
            ("atoms.itp", "[ bonds ]\n1 2 1\n3 4 1\n"),
        ]);
        let top = r#"#include "mol.itp""#;
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        assert_eq!(bonds.len(), 2);
        assert_eq!(bonds[0], (0, 1));
        assert_eq!(bonds[1], (2, 3));
    }

    #[test]
    fn test_vfs_missing_include_skipped() {
        // system.itp is not in the vfs; should be skipped silently
        let vfs = make_vfs(&[("mol.itp", "[ bonds ]\n1 2 1\n")]);
        let top = "#include <system.itp>\n#include \"mol.itp\"";
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        assert_eq!(bonds.len(), 1);
    }

    #[test]
    fn test_vfs_circular_include_detected() {
        // a.itp includes b.itp which includes a.itp → circular
        let vfs = make_vfs(&[
            ("a.itp", r#"#include "b.itp""#),
            ("b.itp", r#"#include "a.itp""#),
        ]);
        let top = r#"#include "a.itp""#;
        let result = parse_top_bonds_with_fs(top, &vfs, 10);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("Circular include"), "unexpected error: {msg}");
    }

    #[test]
    fn test_vfs_bonds_in_top_and_itp() {
        // Bonds come from both the main file and an included one
        let vfs = make_vfs(&[("extra.itp", "[ bonds ]\n3 4 1\n")]);
        let top = "[ bonds ]\n1 2 1\n#include \"extra.itp\"\n";
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        // Bonds from main file: (0,1)
        // After include expansion the extra section follows; parser sees two [ bonds ] sections.
        // The second occurrence resets in_bonds_section = true, so both are collected.
        assert!(bonds.contains(&(0, 1)));
        assert!(bonds.contains(&(2, 3)));
    }

    #[test]
    fn test_vfs_diamond_include_allowed() {
        // A includes B and C; both include D — this is legal (not circular).
        let vfs = make_vfs(&[
            ("b.itp", "#include \"d.itp\""),
            ("c.itp", "#include \"d.itp\""),
            ("d.itp", "[ bonds ]\n1 2 1\n"),
        ]);
        let top = "#include \"b.itp\"\n#include \"c.itp\"\n";
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        // d.itp is expanded twice; both occurrences yield the same bond.
        assert!(!bonds.is_empty());
    }

    // ── Preprocessor conditionals ─────────────────────────────────────────────

    /// CHARMM36 `tip3p.itp`: `[ atoms ]` is listed twice under
    /// `#ifdef HEAVY_H … #else … #endif`, and the connectivity is a settle
    /// unless FLEXIBLE is defined. Only one branch of each may be read, so
    /// every water is 3 atoms and the bonds stay on their own molecule.
    #[test]
    fn test_ifdef_branches_select_one_atoms_list() {
        let text = "\
[ moleculetype ]
SOL 2
[ atoms ]
#ifdef HEAVY_H
1 OWT3 1 SOL OW 1 -0.834 9.95140
2 HWT3 1 SOL HW1 1 0.417 4.03200
3 HWT3 1 SOL HW2 1 0.417 4.03200
#else
1 OWT3 1 SOL OW 1 -0.834 15.9994
2 HWT3 1 SOL HW1 1 0.417 1.0080
3 HWT3 1 SOL HW2 1 0.417 1.0080
#endif
#ifndef FLEXIBLE
[ settles ]
1 1 0.09572 0.15139
#else
[ bonds ]
1 2 1 0.09572 502416.0
1 3 1 0.09572 502416.0
2 3 1 0.15139 502416.0
#endif
[ system ]
water
[ molecules ]
SOL 3
";
        let bonds = parse_top_bonds(text, 9);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4), (3, 5), (6, 7), (6, 8)]);

        // `#define FLEXIBLE` in the file selects the [ bonds ] branch (with
        // its extra H-H entry) instead of the settle.
        let flexible = format!("#define FLEXIBLE\n{text}");
        let bonds = parse_top_bonds(&flexible, 9);
        assert_eq!(bonds.len(), 9);
        assert!(bonds.contains(&(1, 2)) && bonds.contains(&(7, 8)));
    }

    #[test]
    fn test_define_undef_and_nested_conditionals() {
        let text = "\
#define A
[ bonds ]
#ifdef A
1 2 1
#ifdef B
9 10 1
#else
2 3 1
#endif
#else
1 3 1
#endif
#undef A
#ifdef A
3 4 1
#endif
#ifndef B
#ifdef A
5 6 1
#else
4 5 1
#endif
#endif
#ifdef UNDEFINED
#ifndef ALSO_UNDEFINED
6 7 1
#else
7 8 1
#endif
#endif
";
        // Flat (no moleculetype) path: global indices.
        let bonds = parse_top_bonds(text, 20);
        assert_eq!(bonds, vec![(0, 1), (1, 2), (3, 4)]);
    }

    /// `#if` / `#elif` expressions are not evaluated (grompp's preprocessor
    /// rejects them as well): they count as false, the `#else` branch is
    /// taken, and stray `#else` / `#endif` lines are ignored.
    #[test]
    fn test_if_expressions_are_false_and_stray_directives_ignored() {
        let text = "\
#endif
#else
[ bonds ]
#if defined(X)
1 2 1
#elif 1
1 3 1
#else
2 3 1
#endif
#define
#pragma once
3 4 1
";
        let bonds = parse_top_bonds(text, 10);
        assert_eq!(bonds, vec![(1, 2), (2, 3)]);
    }

    /// An `#include` in an inactive branch is never read (a POSRES include
    /// can point at a file that is not there, or would recurse), while a
    /// `#define` made inside an included file stays in effect afterwards.
    #[test]
    fn test_includes_follow_conditionals_and_carry_defines() {
        let vfs = make_vfs(&[
            ("self.itp", "#include \"self.itp\"\n"),
            ("defs.itp", "#define FROM_INCLUDE\n"),
            ("posre.itp", "[ bonds ]\n8 9 1\n"),
        ]);
        let top = "\
#ifdef POSRES
#include \"self.itp\"
#endif
#include \"defs.itp\"
[ bonds ]
#ifdef FROM_INCLUDE
1 2 1
#endif
#ifndef POSRES
#include \"posre.itp\"
#endif
";
        let bonds = parse_top_bonds_with_fs(top, &vfs, 10).unwrap();
        assert_eq!(bonds, vec![(0, 1), (7, 8)]);

        // Without a filesystem the include lines are simply dropped.
        assert!(parse_top_bonds(top, 10).is_empty());
    }

    /// A molecule's size is its highest `[ atoms ]` id, so a repeated line
    /// (or one without a numeric id) does not shift later molecules.
    #[test]
    fn test_moleculetype_size_is_the_highest_atom_id() {
        let text = "\
[ moleculetype ]
W 2
[ atoms ]
1 OW 1 SOL OW 1 0 16
2 HW 1 SOL HW1 1 0 1
3 HW 1 SOL HW2 1 0 1
3 HW 1 SOL HW2 1 0 1
x junk
[ bonds ]
1 2
1 3
[ molecules ]
W 2
";
        let bonds = parse_top_bonds(text, 6);
        assert_eq!(bonds, vec![(0, 1), (0, 2), (3, 4), (3, 5)]);
    }

    // ── parse_top_bonds_from_path (native only) ───────────────────────────────

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn test_from_path_with_itp() {
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();

        let itp_path = dir.path().join("mol.itp");
        fs::write(&itp_path, "[ bonds ]\n1 2 1\n2 3 1\n").unwrap();

        let top_content = "#include \"mol.itp\"\n".to_string();
        let top_path = dir.path().join("system.top");
        fs::write(&top_path, top_content).unwrap();

        let bonds = parse_top_bonds_from_path(top_path.to_str().unwrap(), 10).unwrap();
        assert_eq!(bonds.len(), 2);
        assert_eq!(bonds[0], (0, 1));
        assert_eq!(bonds[1], (1, 2));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn test_from_path_missing_file_error() {
        let result = parse_top_bonds_from_path("/nonexistent/path.top", 10);
        assert!(result.is_err());
    }
}
