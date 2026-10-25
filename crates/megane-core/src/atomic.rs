//! Atomic data: element symbols, atomic numbers, masses, and radii.
//!
//! Central module for all element-related lookups previously scattered across
//! parser.rs, bonds.rs, lammps_data.rs, and gro.rs.

// ── Symbol ↔ atomic number ────────────────────────────────────────────────

/// Maps an element symbol in canonical case (e.g. "Fe", "Na", "Nb", "Pu") to
/// its atomic number, or `0` when it names no element.
///
/// Every element H..Og (Z = 1..=118) is known: the lookup is derived from
/// [`SYMBOLS`], so it can never fall out of step with
/// [`atomic_num_to_symbol`]. The deuterium symbol `"D"` (used for deuterated
/// sites in PDB/mmCIF element columns, neutron-diffraction CIFs and MDL
/// molfiles) resolves to hydrogen. The match is case-sensitive: callers
/// normalise with [`capitalize`] first, so `"FE"` and `"fe"` return `0`.
pub fn symbol_to_atomic_num(sym: &str) -> u8 {
    if sym == "D" {
        return 1;
    }
    indexed_symbol_str(sym)
}

/// [`SYMBOL_INDEX`] lookup of a canonical-case one- or two-letter string.
/// Unlike [`symbol_to_atomic_num`] it does not know `"D"`.
fn indexed_symbol_str(sym: &str) -> u8 {
    match *sym.as_bytes() {
        [first] => indexed_symbol(first, None),
        [first, second] => indexed_symbol(first, Some(second)),
        _ => 0,
    }
}

/// Number of slots per leading letter in [`SYMBOL_INDEX`]: slot 0 is the
/// one-letter symbol, slots 1..=26 the two-letter symbols `Xa`..`Xz`.
const SYMBOL_INDEX_STRIDE: usize = 27;

/// `(first letter, optional second letter)` → atomic number, built at compile
/// time from [`SYMBOLS`] so every symbol it holds maps back to its own Z.
const SYMBOL_INDEX: [u8; 26 * SYMBOL_INDEX_STRIDE] = build_symbol_index();

const fn build_symbol_index() -> [u8; 26 * SYMBOL_INDEX_STRIDE] {
    let mut index = [0u8; 26 * SYMBOL_INDEX_STRIDE];
    let mut z = 1;
    while z < SYMBOLS.len() {
        let sym = SYMBOLS[z].as_bytes();
        let slot = if sym.len() == 2 {
            (sym[1] - b'a') as usize + 1
        } else {
            0
        };
        index[(sym[0] - b'A') as usize * SYMBOL_INDEX_STRIDE + slot] = z as u8;
        z += 1;
    }
    index
}

/// Look a canonical-case symbol (upper-case `first`, lower-case `second`) up
/// in [`SYMBOL_INDEX`]. Any other byte means "not a symbol" and yields `0`.
fn indexed_symbol(first: u8, second: Option<u8>) -> u8 {
    if !first.is_ascii_uppercase() {
        return 0;
    }
    let slot = match second {
        None => 0,
        Some(c) if c.is_ascii_lowercase() => (c - b'a') as usize + 1,
        Some(_) => return 0,
    };
    SYMBOL_INDEX[(first - b'A') as usize * SYMBOL_INDEX_STRIDE + slot]
}

/// Element symbols indexed by atomic number (`SYMBOLS[0]` is the empty
/// string for unknown / virtual atoms). Covers Z = 1..=118.
const SYMBOLS: [&str; 119] = [
    "", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S",
    "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge",
    "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd",
    "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm",
    "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
    "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];

/// Inverse of [`symbol_to_atomic_num`]: the element symbol for an atomic
/// number, or `""` for `0` and anything past Og (118).
pub fn atomic_num_to_symbol(atomic_num: u8) -> &'static str {
    SYMBOLS.get(atomic_num as usize).copied().unwrap_or("")
}

// ── String utilities ──────────────────────────────────────────────────────

/// Capitalize a string: first character uppercase, rest lowercase.
///
/// Used for normalizing element symbols (e.g. "FE" → "Fe", "fe" → "Fe").
pub fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    let first = match chars.next() {
        None => return String::new(),
        Some(c) => c,
    };
    // Fast path: element symbols are almost always ASCII (1–2 chars). Build the
    // result in a single allocation instead of the three the Unicode path needs
    // (two `collect()` Strings plus the `format!`). For ASCII, ascii case folding
    // is identical to `to_uppercase`/`to_lowercase`.
    if s.is_ascii() {
        let mut out = String::with_capacity(s.len());
        out.push(first.to_ascii_uppercase());
        for c in chars {
            out.push(c.to_ascii_lowercase());
        }
        return out;
    }
    // Unicode fallback (rare): preserve the original semantics exactly.
    let upper: String = first.to_uppercase().collect();
    let lower: String = chars.flat_map(|c| c.to_lowercase()).collect();
    format!("{}{}", upper, lower)
}

// ── Radii ─────────────────────────────────────────────────────────────────

/// Covalent radii in Angstroms, indexed by atomic number.
pub(crate) fn covalent_radius(atomic_num: u8) -> f32 {
    match atomic_num {
        1 => 0.31,  // H
        5 => 0.84,  // B
        6 => 0.76,  // C
        7 => 0.71,  // N
        8 => 0.66,  // O
        9 => 0.57,  // F
        11 => 1.66, // Na
        12 => 1.41, // Mg
        14 => 1.11, // Si
        15 => 1.07, // P
        16 => 1.05, // S
        17 => 1.02, // Cl
        19 => 2.03, // K
        20 => 1.76, // Ca
        25 => 1.39, // Mn
        26 => 1.32, // Fe
        27 => 1.26, // Co
        28 => 1.24, // Ni
        29 => 1.32, // Cu
        30 => 1.22, // Zn
        34 => 1.20, // Se
        35 => 1.20, // Br
        53 => 1.39, // I
        _ => 0.77,
    }
}

/// Van der Waals radii in Angstroms, indexed by atomic number.
/// Matches the constants in src/core/constants.ts.
pub fn vdw_radius(atomic_num: u8) -> f32 {
    match atomic_num {
        1 => 1.20,  // H
        6 => 1.70,  // C
        7 => 1.55,  // N
        8 => 1.52,  // O
        9 => 1.47,  // F
        11 => 2.27, // Na
        12 => 1.73, // Mg
        15 => 1.80, // P
        16 => 1.80, // S
        17 => 1.75, // Cl
        19 => 2.75, // K
        20 => 2.31, // Ca
        26 => 2.04, // Fe
        29 => 1.40, // Cu
        30 => 1.39, // Zn
        _ => 1.50,
    }
}

// ── Mass → atomic number ──────────────────────────────────────────────────

/// `(mass in amu, atomic number)` for every element [`mass_to_atomic_num`]
/// can recognise, in Z order.
///
/// Standard atomic weights are used where IUPAC defines one; elements with no
/// stable isotope use the mass of their longest-lived isotope (Tc-98, Pm-145,
/// At-210, Rn-222, ..., Lr-262). Three groups are left out on purpose, because
/// a mass alone cannot tell them apart from a neighbour:
///
/// * Po (Po-209, 208.98) is indistinguishable from Bi (208.98);
/// * Bk (Bk-247, 247.07) is indistinguishable from Cm (247.07);
/// * the transactinides (Z >= 104) have no settled isotope masses, and several
///   coincide (Ds/Rg 281, Fl/Mc 289, Lv/Ts 293).
const MASS_TABLE: &[(f32, u8)] = &[
    (1.008, 1),    // H
    (4.003, 2),    // He
    (6.941, 3),    // Li
    (9.012, 4),    // Be
    (10.81, 5),    // B
    (12.011, 6),   // C
    (14.007, 7),   // N
    (15.999, 8),   // O
    (18.998, 9),   // F
    (20.180, 10),  // Ne
    (22.990, 11),  // Na
    (24.305, 12),  // Mg
    (26.982, 13),  // Al
    (28.086, 14),  // Si
    (30.974, 15),  // P
    (32.065, 16),  // S
    (35.453, 17),  // Cl
    (39.948, 18),  // Ar
    (39.098, 19),  // K
    (40.078, 20),  // Ca
    (44.956, 21),  // Sc
    (47.867, 22),  // Ti
    (50.942, 23),  // V
    (51.996, 24),  // Cr
    (54.938, 25),  // Mn
    (55.845, 26),  // Fe
    (58.933, 27),  // Co
    (58.693, 28),  // Ni
    (63.546, 29),  // Cu
    (65.380, 30),  // Zn
    (69.723, 31),  // Ga
    (72.630, 32),  // Ge
    (74.922, 33),  // As
    (78.971, 34),  // Se
    (79.904, 35),  // Br
    (83.798, 36),  // Kr
    (85.468, 37),  // Rb
    (87.620, 38),  // Sr
    (88.906, 39),  // Y
    (91.224, 40),  // Zr
    (92.906, 41),  // Nb
    (95.950, 42),  // Mo
    (97.907, 43),  // Tc
    (101.07, 44),  // Ru
    (102.91, 45),  // Rh
    (106.42, 46),  // Pd
    (107.87, 47),  // Ag
    (112.41, 48),  // Cd
    (114.82, 49),  // In
    (118.71, 50),  // Sn
    (121.76, 51),  // Sb
    (127.60, 52),  // Te
    (126.90, 53),  // I
    (131.29, 54),  // Xe
    (132.91, 55),  // Cs
    (137.33, 56),  // Ba
    (138.91, 57),  // La
    (140.12, 58),  // Ce
    (140.91, 59),  // Pr
    (144.24, 60),  // Nd
    (144.91, 61),  // Pm
    (150.36, 62),  // Sm
    (151.96, 63),  // Eu
    (157.25, 64),  // Gd
    (158.93, 65),  // Tb
    (162.50, 66),  // Dy
    (164.93, 67),  // Ho
    (167.26, 68),  // Er
    (168.93, 69),  // Tm
    (173.05, 70),  // Yb
    (174.97, 71),  // Lu
    (178.49, 72),  // Hf
    (180.95, 73),  // Ta
    (183.84, 74),  // W
    (186.21, 75),  // Re
    (190.23, 76),  // Os
    (192.22, 77),  // Ir
    (195.08, 78),  // Pt
    (196.97, 79),  // Au
    (200.59, 80),  // Hg
    (204.38, 81),  // Tl
    (207.20, 82),  // Pb
    (208.98, 83),  // Bi
    (209.99, 85),  // At
    (222.02, 86),  // Rn
    (223.02, 87),  // Fr
    (226.03, 88),  // Ra
    (227.03, 89),  // Ac
    (232.04, 90),  // Th
    (231.04, 91),  // Pa
    (238.03, 92),  // U
    (237.05, 93),  // Np
    (244.06, 94),  // Pu
    (243.06, 95),  // Am
    (247.07, 96),  // Cm
    (251.08, 98),  // Cf
    (252.08, 99),  // Es
    (257.10, 100), // Fm
    (258.10, 101), // Md
    (259.10, 102), // No
    (262.11, 103), // Lr
];

/// Map atomic mass (in amu) to atomic number.
/// Uses closest match within tolerance of 0.5 amu.
pub(crate) fn mass_to_atomic_num(mass: f32) -> u8 {
    let mut best_z: u8 = 0;
    let mut best_diff = 0.5_f32;

    for &(m, z) in MASS_TABLE {
        let diff = (mass - m).abs();
        if diff < best_diff {
            best_diff = diff;
            best_z = z;
        }
    }

    best_z
}

// ── Atom-name heuristics ──────────────────────────────────────────────────

/// Case-fold a one- or two-letter ASCII symbol (`first` upper-cased, `second`
/// lower-cased) and look it up in [`SYMBOL_INDEX`] without allocating.
/// Returns 0 for any non-ASCII letter, which can never be part of an element
/// symbol.
fn ascii_indexed_symbol(first: char, second: Option<char>) -> u8 {
    if !first.is_ascii() {
        return 0;
    }
    let second = match second {
        None => None,
        Some(c) if c.is_ascii() => Some(c.to_ascii_lowercase() as u8),
        Some(_) => return 0,
    };
    indexed_symbol(first.to_ascii_uppercase() as u8, second)
}

/// [`symbol_to_atomic_num`] for a case-insensitive one- or two-letter ASCII
/// symbol taken from an explicit element field. Knows every element plus the
/// deuterium symbol `"D"`.
fn ascii_symbol_to_atomic_num(first: char, second: Option<char>) -> u8 {
    if second.is_none() && first.eq_ignore_ascii_case(&'D') {
        return 1;
    }
    ascii_indexed_symbol(first, second)
}

/// Elements an atom **name** may resolve to.
///
/// An explicit element field can name any element, but an atom name is only
/// a hint, and most rare or radioactive two-letter symbols collide with
/// ordinary atom names: heme "NB" (Nb), ATP "PA" (Pa), ligand "CM" (Cm),
/// "NH" (Nh), "HS" (Hs), "NO" (No), "CN" (Cn), "OG" (Og). Name guessing
/// therefore keeps to the elements that force fields and ligand libraries
/// actually name atoms after, so those names keep falling back to their
/// first letter, and never to deuterium.
fn is_name_guess_element(z: u8) -> bool {
    matches!(z, 1..=40 | 42 | 44..=58 | 60 | 62..=68 | 70..=83 | 90 | 92)
}

/// Keep `z` only if an atom name may resolve to it (see
/// [`is_name_guess_element`]); otherwise `0`.
fn name_guess(z: u8) -> u8 {
    if is_name_guess_element(z) {
        z
    } else {
        0
    }
}

/// [`ascii_indexed_symbol`] restricted to the elements an atom name may
/// resolve to.
fn name_symbol_to_atomic_num(first: char, second: Option<char>) -> u8 {
    name_guess(ascii_indexed_symbol(first, second))
}

/// Resolve an element from an explicit element-symbol field such as a CIF /
/// mmCIF `_atom_site_type_symbol` (`"Fe2+"`, `"O2-"`, `"FE"`) or a CIF site
/// label (`"Na1"`, `"O2"`).
///
/// The leading alphabetic run is the symbol; charge and index suffixes are
/// ignored. When that run is not itself a symbol (e.g. `"Cla"`), the first
/// letter alone is tried. Allocation-free.
pub(crate) fn element_from_symbol(s: &str) -> u8 {
    let mut run = s.chars().take_while(|c| c.is_alphabetic());
    let Some(first) = run.next() else {
        return 0;
    };
    let second = run.next();
    // Element symbols are at most two letters, so a longer run can only
    // resolve through its first letter.
    if second.is_some() && run.next().is_none() {
        let z = ascii_symbol_to_atomic_num(first, second);
        if z != 0 {
            return z;
        }
    }
    ascii_symbol_to_atomic_num(first, None)
}

/// Guess atomic number from an atom name **without** residue context
/// (e.g. "CL", "FE", "OW", "HW1").
///
/// Tries a two-character symbol first (e.g. "Cl", "Fe"), then falls back to
/// the first character, considering only the elements of
/// [`is_name_guess_element`]. Because a name alone cannot distinguish a protein
/// α-carbon "CA" from a calcium ion "CA", prefer
/// [`element_from_atom_name_in_residue`] whenever the residue name is known.
pub(crate) fn element_from_atom_name(name: &str) -> u8 {
    // Take the first two alphabetic characters without allocating an
    // intermediate "cleaned" string.
    let mut alpha = name.chars().filter(|c| c.is_alphabetic());
    let first = match alpha.next() {
        Some(c) => c,
        None => return 0,
    };
    let second = alpha.next();

    // Element symbols are ASCII (1–2 letters), so for the overwhelmingly
    // common ASCII case we case-fold into a small stack buffer and avoid the
    // per-call heap allocations. Exotic non-ASCII names keep the original
    // Unicode-aware path, so the returned atomic number is identical for
    // every input.

    // Two-character symbol first (e.g. "CL" → "Cl", "FE" → "Fe").
    if let Some(second) = second {
        let num = if first.is_ascii() && second.is_ascii() {
            name_symbol_to_atomic_num(first, Some(second))
        } else {
            let two: String = first.to_uppercase().chain(second.to_lowercase()).collect();
            name_guess(indexed_symbol_str(&two))
        };
        if num != 0 {
            return num;
        }
    }

    // Fall back to a single-character symbol.
    if first.is_ascii() {
        name_symbol_to_atomic_num(first, None)
    } else {
        let one: String = first.to_uppercase().collect();
        name_guess(indexed_symbol_str(&one))
    }
}

/// The 20 standard amino acids plus the common force-field protonation /
/// disulfide / modified variants (AMBER, CHARMM, GROMACS, OPLS naming).
/// Every atom of these residues is H, C, N, O or S — except the Se of
/// MSE/SEC, handled in [`element_from_atom_name_in_residue`].
fn is_amino_acid(res: &str) -> bool {
    matches!(
        res,
        "ALA" | "ARG" | "ASN" | "ASP" | "CYS" | "GLN" | "GLU" | "GLY" | "HIS" | "ILE"
            | "LEU" | "LYS" | "MET" | "PHE" | "PRO" | "SER" | "THR" | "TRP" | "TYR" | "VAL"
            // Histidine tautomers / protonation states.
            | "HID" | "HIE" | "HIP" | "HSD" | "HSE" | "HSP" | "HISA" | "HISB" | "HISD"
            | "HISE" | "HISH" | "HIS1" | "HIS2"
            // Other protonation / disulfide / deprotonated variants.
            | "CYX" | "CYM" | "CYS2" | "CYSH" | "ASH" | "ASPH" | "GLH" | "GLUH" | "LYN"
            | "LYSH" | "LYSN" | "ARGN" | "HYP"
            // Selenium-bearing residues and common caps.
            | "MSE" | "SEC" | "ACE" | "NME" | "NHE" | "NH2"
    )
}

/// Nucleic-acid residue names (PDB, AMBER terminal 5'/3' variants, CHARMM).
/// Every atom is H, C, N, O or P.
fn is_nucleic_acid(res: &str) -> bool {
    matches!(
        res,
        // PDB one-letter (RNA) and DNA names.
        "A" | "C" | "G" | "U" | "T" | "I" | "DA" | "DC" | "DG" | "DT" | "DU" | "DI"
            // AMBER RNA names and 5'/3'-terminal variants.
            | "RA" | "RC" | "RG" | "RU" | "DA5" | "DC5" | "DG5" | "DT5" | "DA3" | "DC3"
            | "DG3" | "DT3" | "RA5" | "RC5" | "RG5" | "RU5" | "RA3" | "RC3" | "RG3" | "RU3"
            | "A5" | "C5" | "G5" | "U5" | "A3" | "C3" | "G3" | "U3"
            // CHARMM names.
            | "ADE" | "CYT" | "GUA" | "THY" | "URA"
    )
}

/// Water residue names across force fields and file formats.
fn is_water(res: &str) -> bool {
    matches!(
        res,
        // PDB / AMBER / GROMACS names.
        "HOH" | "WAT" | "SOL" | "H2O" | "DOD"
            // CHARMM / force-field-specific names.
            | "TIP" | "TIP3" | "TIP4" | "TIP5" | "TP3" | "TP4" | "TP5" | "T3P" | "T4P"
            | "T5P" | "SPC" | "SPCE"
    )
}

/// Upper-case a residue name (≤ 4 ASCII characters after trimming) into a
/// stack buffer. Returns `None` for anything that cannot be a standard
/// residue name, so callers fall back to the context-free guess.
fn upper_residue(res_name: &str, buf: &mut [u8; 4]) -> Option<usize> {
    let res = res_name.trim();
    if res.is_empty() || res.len() > buf.len() || !res.is_ascii() {
        return None;
    }
    for (b, c) in buf.iter_mut().zip(res.bytes()) {
        *b = c.to_ascii_uppercase();
    }
    Some(res.len())
}

/// True when `res_name` names a standard biopolymer residue (amino acid,
/// incl. AMBER `N`/`C`-prefixed terminal variants like "NALA"/"CLYS"),
/// nucleic acid, or water — residues whose atoms are all H/C/N/O/S/P (plus
/// Se in MSE/SEC), so their atom names start with a one-letter element.
pub(crate) fn is_standard_residue(res_name: &str) -> bool {
    let mut buf = [0u8; 4];
    let Some(len) = upper_residue(res_name, &mut buf) else {
        return false;
    };
    // `upper_residue` only accepts ASCII, so this never falls back.
    let res = std::str::from_utf8(&buf[..len]).unwrap_or("");
    is_amino_acid(res)
        || is_nucleic_acid(res)
        || is_water(res)
        || (len == 4 && matches!(buf[0], b'N' | b'C') && is_amino_acid(&res[1..]))
}

/// Guess atomic number from an atom name **with** its residue name.
///
/// This is the policy every parser that only has a name to go on (GRO, PDB
/// without an element column, AMBER/PSF topologies missing the atomic-number
/// and mass fields) uses:
///
/// * Inside a standard biopolymer or water residue (see
///   [`is_standard_residue`]) the element is the **first letter** of the
///   name, because those residues contain no two-letter elements: protein
///   "CA" (Cα), "CD", "NE", "HG", "SG", "OG" resolve to C, C, N, H, S, O —
///   not calcium, cadmium, neon, mercury, seaborgium, oganesson. The one
///   exception is the selenium "SE" of selenomethionine (MSE) and
///   selenocysteine (SEC).
/// * Everywhere else — ion residues whose name repeats the atom name
///   ("CA CA", "NA NA", "CL CL", "ZN ZN", "MG MG") and ligands — the
///   context-free two-letter-first [`element_from_atom_name`] applies.
///
/// Allocation-free.
pub(crate) fn element_from_atom_name_in_residue(name: &str, res_name: &str) -> u8 {
    if !is_standard_residue(res_name) {
        return element_from_atom_name(name);
    }
    let mut alpha = name.chars().filter(|c| c.is_alphabetic());
    let Some(first) = alpha.next() else {
        return 0;
    };
    let res = res_name.trim();
    if (res.eq_ignore_ascii_case("MSE") || res.eq_ignore_ascii_case("SEC"))
        && first.eq_ignore_ascii_case(&'S')
        && alpha.next().is_some_and(|c| c.eq_ignore_ascii_case(&'E'))
    {
        return 34; // Se
    }
    name_symbol_to_atomic_num(first, None)
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_num_to_symbol_round_trip() {
        assert_eq!(atomic_num_to_symbol(0), "");
        assert_eq!(atomic_num_to_symbol(1), "H");
        assert_eq!(atomic_num_to_symbol(26), "Fe");
        assert_eq!(atomic_num_to_symbol(118), "Og");
        assert_eq!(atomic_num_to_symbol(119), "");
        // The compile-time index is what a runtime build produces.
        assert_eq!(build_symbol_index(), SYMBOL_INDEX);
        // Every element's symbol maps back to the same Z — no gaps allowed.
        for z in 1..=118u8 {
            let sym = atomic_num_to_symbol(z);
            assert_eq!(symbol_to_atomic_num(sym), z, "round trip failed for {sym}");
        }
    }

    #[test]
    fn test_symbol_to_atomic_num_previously_missing_elements() {
        for (sym, z) in [
            ("Nb", 41),
            ("Tc", 43),
            ("Pr", 59),
            ("Pm", 61),
            ("Tm", 69),
            ("Po", 84),
            ("At", 85),
            ("Rn", 86),
            ("Fr", 87),
            ("Ra", 88),
            ("Ac", 89),
            ("Pa", 91),
            ("Np", 93),
            ("Pu", 94),
            ("Am", 95),
            ("Og", 118),
        ] {
            assert_eq!(symbol_to_atomic_num(sym), z, "{sym}");
        }
        // Deuterium is hydrogen; tritium's "T" is not resolved (zeolite CIFs
        // label tetrahedral sites "T1", "T2", …).
        assert_eq!(symbol_to_atomic_num("D"), 1);
        assert_eq!(symbol_to_atomic_num("T"), 0);
        // Case-sensitive, like the match table it replaces.
        assert_eq!(symbol_to_atomic_num("NB"), 0);
        assert_eq!(symbol_to_atomic_num("nb"), 0);
        assert_eq!(symbol_to_atomic_num("fe"), 0);
        assert_eq!(symbol_to_atomic_num("Fe "), 0);
        assert_eq!(symbol_to_atomic_num("N1"), 0);
        assert_eq!(symbol_to_atomic_num("Ω"), 0);
    }

    #[test]
    fn test_parsers_resolve_previously_missing_elements() {
        let xyz = "4\nLiNbO3 fragment\nLi 0 0 0\nNb 2 0 0\nPr 4 0 0\nTm 6 0 0\n";
        assert_eq!(
            crate::xyz::parse(xyz).unwrap().elements,
            vec![3, 41, 59, 69]
        );

        let cif = "data_x\n_cell_length_a 5.15\n_cell_length_b 5.15\n_cell_length_c 13.86\n\
                   _cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 120\n\
                   loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n\
                   _atom_site_fract_y\n_atom_site_fract_z\nLi1 Li 0 0 0.28\nNb1 Nb 0 0 0\n\
                   O1 O 0.05 0.34 0.06\nPu1 Pu 0.5 0.5 0.5\n";
        assert_eq!(crate::cif::parse(cif).unwrap().elements, vec![3, 41, 8, 94]);

        let poscar = "LiNbO3\n1.0\n5 0 0\n0 5 0\n0 0 5\nLi Nb O\n1 1 1\nDirect\n\
                      0 0 0\n0.5 0.5 0.5\n0.25 0.25 0.25\n";
        assert_eq!(crate::vasp::parse(poscar).unwrap().elements, vec![3, 41, 8]);

        let pdb =
            "HETATM    1 NB   NB  A   1       0.000   0.000   0.000  1.00  0.00          NB\n\
                   HETATM    2 PR   PR  A   2       3.000   0.000   0.000  1.00  0.00          PR\n\
                   HETATM    3  D   HOH A   3       6.000   0.000   0.000  1.00  0.00           D\n\
                   END\n";
        assert_eq!(crate::pdb::parse(pdb).unwrap().elements, vec![41, 59, 1]);
    }

    #[test]
    fn test_symbol_to_atomic_num_common() {
        assert_eq!(symbol_to_atomic_num("H"), 1);
        assert_eq!(symbol_to_atomic_num("C"), 6);
        assert_eq!(symbol_to_atomic_num("N"), 7);
        assert_eq!(symbol_to_atomic_num("O"), 8);
        assert_eq!(symbol_to_atomic_num("S"), 16);
        assert_eq!(symbol_to_atomic_num("Fe"), 26);
        assert_eq!(symbol_to_atomic_num("Na"), 11);
    }

    #[test]
    fn test_symbol_to_atomic_num_unknown() {
        assert_eq!(symbol_to_atomic_num("Xx"), 0);
        assert_eq!(symbol_to_atomic_num(""), 0);
    }

    #[test]
    fn test_capitalize() {
        assert_eq!(capitalize("fe"), "Fe");
        assert_eq!(capitalize("FE"), "Fe");
        assert_eq!(capitalize("c"), "C");
        assert_eq!(capitalize(""), "");
        // Mixed case and longer ASCII symbols normalize to first-upper, rest-lower.
        assert_eq!(capitalize("cL"), "Cl");
        assert_eq!(capitalize("Uuo"), "Uuo");
        // ASCII fast path leaves non-letter characters untouched.
        assert_eq!(capitalize("h2o"), "H2o");
        // Non-ASCII input takes the Unicode fallback path.
        assert_eq!(capitalize("ça"), "Ça");
    }

    #[test]
    fn test_mass_to_atomic_num() {
        assert_eq!(mass_to_atomic_num(1.008), 1); // H
        assert_eq!(mass_to_atomic_num(12.011), 6); // C
        assert_eq!(mass_to_atomic_num(14.007), 7); // N
        assert_eq!(mass_to_atomic_num(15.999), 8); // O
        assert_eq!(mass_to_atomic_num(55.845), 26); // Fe
        assert_eq!(mass_to_atomic_num(196.97), 79); // Au
        assert_eq!(mass_to_atomic_num(999.0), 0); // unknown
                                                  // Previously missing elements.
        assert_eq!(mass_to_atomic_num(92.906), 41); // Nb
        assert_eq!(mass_to_atomic_num(140.91), 59); // Pr
        assert_eq!(mass_to_atomic_num(168.93), 69); // Tm
        assert_eq!(mass_to_atomic_num(231.04), 91); // Pa
        assert_eq!(mass_to_atomic_num(244.06), 94); // Pu
                                                    // Po-209 would be indistinguishable from Bi, so Bi keeps its mass.
        assert_eq!(mass_to_atomic_num(208.98), 83);
    }

    #[test]
    fn test_mass_table_is_complete_and_unambiguous() {
        // Z order, and every entry resolves back to its own element.
        for pair in MASS_TABLE.windows(2) {
            assert!(pair[0].1 < pair[1].1, "MASS_TABLE out of Z order");
        }
        for &(mass, z) in MASS_TABLE {
            assert_eq!(mass_to_atomic_num(mass), z, "mass {mass} round trip");
        }
        // Everything up to Lr is present except the two documented
        // collisions (Po with Bi, Bk with Cm).
        let present: Vec<u8> = MASS_TABLE.iter().map(|&(_, z)| z).collect();
        let expected: Vec<u8> = (1..=103u8).filter(|z| !matches!(z, 84 | 97)).collect();
        assert_eq!(present, expected);
    }

    #[test]
    fn test_element_from_atom_name() {
        // Context-free: a bare "CA" reads as calcium. Parsers that know the
        // residue must use `element_from_atom_name_in_residue`, which resolves
        // a protein Cα to carbon (see `test_element_from_atom_name_in_residue`).
        assert_eq!(element_from_atom_name("CA"), 20); // Ca (Calcium)
        assert_eq!(element_from_atom_name("OW"), 8); // Oxygen (water)
        assert_eq!(element_from_atom_name("HW1"), 1); // Hydrogen
        assert_eq!(element_from_atom_name("N"), 7); // Nitrogen
        assert_eq!(element_from_atom_name("  CL"), 17); // Chlorine
        assert_eq!(element_from_atom_name(""), 0); // Empty
        assert_eq!(element_from_atom_name("C"), 6); // Single char
        assert_eq!(element_from_atom_name("fe"), 26); // Lowercase two-char
        assert_eq!(element_from_atom_name("2HW"), 1); // Digit prefix, "Hw"→fallback "H"
        assert_eq!(element_from_atom_name("123"), 0); // No alphabetic chars
        assert_eq!(element_from_atom_name("Zz"), 0); // Unknown two-char, no single fallback

        // Non-ASCII names exercise the Unicode-aware fallback paths (which can
        // never match an ASCII element symbol, so they resolve to 0).
        assert_eq!(element_from_atom_name("Ωz"), 0); // two-char + single-char Unicode fallback
        assert_eq!(element_from_atom_name("Ω"), 0); // single-char Unicode fallback
    }

    #[test]
    fn test_element_from_symbol() {
        assert_eq!(element_from_symbol("C"), 6);
        assert_eq!(element_from_symbol("FE"), 26);
        assert_eq!(element_from_symbol("Na"), 11);
        assert_eq!(element_from_symbol("Fe2+"), 26); // charge suffix
        assert_eq!(element_from_symbol("O2-"), 8);
        assert_eq!(element_from_symbol("Na1"), 11); // site label index
        assert_eq!(element_from_symbol("Cla"), 6); // 3-letter run → first letter
        assert_eq!(element_from_symbol("Xq"), 0); // neither "Xq" nor "X"
        assert_eq!(element_from_symbol("Ow"), 8); // "Ow" unknown → "O"
        assert_eq!(element_from_symbol(""), 0);
        assert_eq!(element_from_symbol("2+"), 0); // no leading letters
                                                  // Non-ASCII letters never form a symbol (and must not panic).
        assert_eq!(element_from_symbol("Ω"), 0);
        assert_eq!(element_from_symbol("Cé"), 6);
        // Every element, including the ones the old table was missing.
        assert_eq!(element_from_symbol("Nb"), 41); // was N
        assert_eq!(element_from_symbol("NB"), 41);
        assert_eq!(element_from_symbol("Nb5+"), 41);
        assert_eq!(element_from_symbol("Pu1"), 94); // was P
        assert_eq!(element_from_symbol("Pr3+"), 59); // was P
        assert_eq!(element_from_symbol("Np"), 93); // was N
        assert_eq!(element_from_symbol("D"), 1); // deuterium
        assert_eq!(element_from_symbol("D12"), 1);
        assert_eq!(element_from_symbol("T1"), 0); // zeolite T site, not tritium
    }

    /// The elements atom-name guessing resolved to before the symbol table was
    /// completed. Name guessing must keep exactly this set.
    const NAME_GUESS_SYMBOLS: &[&str] = &[
        "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S",
        "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga",
        "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Mo", "Ru", "Rh", "Pd", "Ag", "Cd",
        "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Nd", "Sm", "Eu", "Gd", "Tb",
        "Dy", "Ho", "Er", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl",
        "Pb", "Bi", "Th", "U",
    ];

    #[test]
    fn test_atom_name_guessing_unchanged_by_complete_table() {
        let oracle = |sym: &str| -> u8 {
            if NAME_GUESS_SYMBOLS.contains(&sym) {
                symbol_to_atomic_num(sym)
            } else {
                0
            }
        };
        let letters: Vec<char> = ('A'..='Z').chain('a'..='z').collect();
        for &a in &letters {
            let one = a.to_ascii_uppercase().to_string();
            assert_eq!(element_from_atom_name(&a.to_string()), oracle(&one), "{a}");
            for &b in &letters {
                let name: String = [a, b].iter().collect();
                let two = capitalize(&name);
                let want = match oracle(&two) {
                    0 => oracle(&one),
                    z => z,
                };
                assert_eq!(element_from_atom_name(&name), want, "{name}");
            }
        }
        // Atom names that would otherwise read as rare elements.
        assert_eq!(element_from_atom_name("NB"), 7); // heme pyrrole N, not Nb
        assert_eq!(element_from_atom_name("PA"), 15); // ATP alpha-P, not Pa
        assert_eq!(element_from_atom_name("CM"), 6); // not Cm
        assert_eq!(element_from_atom_name("NH1"), 7); // not Nh
        assert_eq!(element_from_atom_name("D1"), 0); // never deuterium
        assert_eq!(element_from_atom_name("ſ"), 16); // Unicode path: 'ſ' upper-cases to 'S'
        assert_eq!(element_from_atom_name("Nſ"), 7); // "NS" is no element → 'N'
        assert_eq!(element_from_atom_name("Pſ"), 15);
        assert_eq!(element_from_atom_name_in_residue("D", "ALA"), 0);
        assert_eq!(element_from_atom_name_in_residue("PA", "ATP"), 15);
        assert_eq!(element_from_atom_name_in_residue("NB", "HEM"), 7);
    }

    #[test]
    fn test_is_standard_residue() {
        for res in [
            "ALA", "gly", " HIS ", "HIE", "CYX", "MSE", "NALA", "CLYS", "NHIE",
        ] {
            assert!(is_standard_residue(res), "{res} should be an amino acid");
        }
        for res in ["DA", "DT5", "RU3", "A", "URA"] {
            assert!(is_standard_residue(res), "{res} should be a nucleic acid");
        }
        for res in ["SOL", "WAT", "HOH", "TIP3", "SPCE"] {
            assert!(is_standard_residue(res), "{res} should be water");
        }
        // Ions, ligands, and names that cannot be standard residues.
        for res in [
            "CA", "NA", "CL", "ZN", "MG", "LIG", "HEM", "", "   ", "NXXX", "XALA",
        ] {
            assert!(!is_standard_residue(res), "{res} must not be standard");
        }
        assert!(!is_standard_residue("TOOLONG"));
        assert!(!is_standard_residue("ÀLA"));
    }

    #[test]
    fn test_element_from_atom_name_in_residue() {
        // Protein atoms whose two-letter reading is a real (wrong) element.
        assert_eq!(element_from_atom_name_in_residue("CA", "ALA"), 6); // not Ca
        assert_eq!(element_from_atom_name_in_residue("CB", "ALA"), 6);
        assert_eq!(element_from_atom_name_in_residue("HG", "SER"), 1); // not Hg
        assert_eq!(element_from_atom_name_in_residue("NE", "ARG"), 7); // not Ne
        assert_eq!(element_from_atom_name_in_residue("CD", "GLU"), 6); // not Cd
        assert_eq!(element_from_atom_name_in_residue("SG", "CYS"), 16); // not Sg
        assert_eq!(element_from_atom_name_in_residue("OG", "SER"), 8); // not Og
        assert_eq!(element_from_atom_name_in_residue("1HG1", "VAL"), 1);
        assert_eq!(element_from_atom_name_in_residue("CA", "NALA"), 6);
        // Selenium in selenomethionine / selenocysteine.
        assert_eq!(element_from_atom_name_in_residue("SE", "MSE"), 34);
        assert_eq!(element_from_atom_name_in_residue("Se", "sec"), 34);
        assert_eq!(element_from_atom_name_in_residue("SD", "MET"), 16);
        assert_eq!(element_from_atom_name_in_residue("CE", "MSE"), 6);
        assert_eq!(element_from_atom_name_in_residue("S", "MSE"), 16);
        // Nucleic acids and water.
        assert_eq!(element_from_atom_name_in_residue("P", "DA"), 15);
        assert_eq!(element_from_atom_name_in_residue("OP1", "DG"), 8);
        assert_eq!(element_from_atom_name_in_residue("OW", "SOL"), 8);
        assert_eq!(element_from_atom_name_in_residue("HW1", "SOL"), 1);
        assert_eq!(element_from_atom_name_in_residue("MW", "SOL"), 0); // virtual site
        assert_eq!(element_from_atom_name_in_residue("", "SOL"), 0);
        assert_eq!(element_from_atom_name_in_residue("Ω", "SOL"), 0);
        // Ion residues (residue name repeats the atom name) keep two letters.
        assert_eq!(element_from_atom_name_in_residue("CA", "CA"), 20);
        assert_eq!(element_from_atom_name_in_residue("NA", "NA"), 11);
        assert_eq!(element_from_atom_name_in_residue("CL", "CL"), 17);
        assert_eq!(element_from_atom_name_in_residue("ZN", "ZN"), 30);
        assert_eq!(element_from_atom_name_in_residue("MG", "MG"), 12);
        // Ligands / unknown residues use the context-free guess.
        assert_eq!(element_from_atom_name_in_residue("CL1", "LIG"), 17);
        assert_eq!(element_from_atom_name_in_residue("C1", "LIG"), 6);
        assert_eq!(element_from_atom_name_in_residue("FE", ""), 26);
    }
}
