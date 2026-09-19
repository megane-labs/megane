//! Atomic data: element symbols, atomic numbers, masses, and radii.
//!
//! Central module for all element-related lookups previously scattered across
//! parser.rs, bonds.rs, lammps_data.rs, and gro.rs.

// ── Symbol ↔ atomic number ────────────────────────────────────────────────

/// Maps element symbol strings (e.g. "Fe", "Na") to their atomic numbers.
pub fn symbol_to_atomic_num(sym: &str) -> u8 {
    match sym {
        "H" => 1,
        "He" => 2,
        "Li" => 3,
        "Be" => 4,
        "B" => 5,
        "C" => 6,
        "N" => 7,
        "O" => 8,
        "F" => 9,
        "Ne" => 10,
        "Na" => 11,
        "Mg" => 12,
        "Al" => 13,
        "Si" => 14,
        "P" => 15,
        "S" => 16,
        "Cl" => 17,
        "Ar" => 18,
        "K" => 19,
        "Ca" => 20,
        "Sc" => 21,
        "Ti" => 22,
        "V" => 23,
        "Cr" => 24,
        "Mn" => 25,
        "Fe" => 26,
        "Co" => 27,
        "Ni" => 28,
        "Cu" => 29,
        "Zn" => 30,
        "Ga" => 31,
        "Ge" => 32,
        "As" => 33,
        "Se" => 34,
        "Br" => 35,
        "Kr" => 36,
        "Rb" => 37,
        "Sr" => 38,
        "Y" => 39,
        "Zr" => 40,
        "Mo" => 42,
        "Ru" => 44,
        "Rh" => 45,
        "Pd" => 46,
        "Ag" => 47,
        "Cd" => 48,
        "In" => 49,
        "Sn" => 50,
        "Sb" => 51,
        "Te" => 52,
        "I" => 53,
        "Xe" => 54,
        "Cs" => 55,
        "Ba" => 56,
        "La" => 57,
        "Ce" => 58,
        "Nd" => 60,
        "Sm" => 62,
        "Eu" => 63,
        "Gd" => 64,
        "Tb" => 65,
        "Dy" => 66,
        "Ho" => 67,
        "Er" => 68,
        "Yb" => 70,
        "Lu" => 71,
        "Hf" => 72,
        "Ta" => 73,
        "W" => 74,
        "Re" => 75,
        "Os" => 76,
        "Ir" => 77,
        "Pt" => 78,
        "Au" => 79,
        "Hg" => 80,
        "Tl" => 81,
        "Pb" => 82,
        "Bi" => 83,
        "Th" => 90,
        "U" => 92,
        _ => 0,
    }
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

/// Map atomic mass (in amu) to atomic number.
/// Uses closest match within tolerance of 0.5 amu.
pub(crate) fn mass_to_atomic_num(mass: f32) -> u8 {
    const TABLE: &[(f32, u8)] = &[
        (1.008, 1),   // H
        (4.003, 2),   // He
        (6.941, 3),   // Li
        (9.012, 4),   // Be
        (10.81, 5),   // B
        (12.011, 6),  // C
        (14.007, 7),  // N
        (15.999, 8),  // O
        (18.998, 9),  // F
        (20.180, 10), // Ne
        (22.990, 11), // Na
        (24.305, 12), // Mg
        (26.982, 13), // Al
        (28.086, 14), // Si
        (30.974, 15), // P
        (32.065, 16), // S
        (35.453, 17), // Cl
        (39.948, 18), // Ar
        (39.098, 19), // K
        (40.078, 20), // Ca
        (44.956, 21), // Sc
        (47.867, 22), // Ti
        (50.942, 23), // V
        (51.996, 24), // Cr
        (54.938, 25), // Mn
        (55.845, 26), // Fe
        (58.933, 27), // Co
        (58.693, 28), // Ni
        (63.546, 29), // Cu
        (65.380, 30), // Zn
        (69.723, 31), // Ga
        (72.630, 32), // Ge
        (74.922, 33), // As
        (78.971, 34), // Se
        (79.904, 35), // Br
        (83.798, 36), // Kr
        (85.468, 37), // Rb
        (87.620, 38), // Sr
        (88.906, 39), // Y
        (91.224, 40), // Zr
        (95.950, 42), // Mo
        (101.07, 44), // Ru
        (102.91, 45), // Rh
        (106.42, 46), // Pd
        (107.87, 47), // Ag
        (112.41, 48), // Cd
        (114.82, 49), // In
        (118.71, 50), // Sn
        (121.76, 51), // Sb
        (127.60, 52), // Te
        (126.90, 53), // I
        (131.29, 54), // Xe
        (132.91, 55), // Cs
        (137.33, 56), // Ba
        (138.91, 57), // La
        (140.12, 58), // Ce
        (144.24, 60), // Nd
        (150.36, 62), // Sm
        (151.96, 63), // Eu
        (157.25, 64), // Gd
        (158.93, 65), // Tb
        (162.50, 66), // Dy
        (164.93, 67), // Ho
        (167.26, 68), // Er
        (173.05, 70), // Yb
        (174.97, 71), // Lu
        (178.49, 72), // Hf
        (180.95, 73), // Ta
        (183.84, 74), // W
        (186.21, 75), // Re
        (190.23, 76), // Os
        (192.22, 77), // Ir
        (195.08, 78), // Pt
        (196.97, 79), // Au
        (200.59, 80), // Hg
        (204.38, 81), // Tl
        (207.20, 82), // Pb
        (208.98, 83), // Bi
        (232.04, 90), // Th
        (238.03, 92), // U
    ];

    let mut best_z: u8 = 0;
    let mut best_diff = 0.5_f32;

    for &(m, z) in TABLE {
        let diff = (mass - m).abs();
        if diff < best_diff {
            best_diff = diff;
            best_z = z;
        }
    }

    best_z
}

// ── Atom-name heuristics ──────────────────────────────────────────────────

/// Guess atomic number from a GRO-style atom name (e.g. "CA", "OW", "HW1").
///
/// Tries a two-character symbol first (e.g. "Cl", "Fe"), then falls back to
/// the first character.
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
    // Unicode-aware path (they never match an ASCII symbol anyway), so the
    // returned atomic number is identical for every input.

    // Two-character symbol first (e.g. "CL" → "Cl", "FE" → "Fe").
    if let Some(second) = second {
        let num = if first.is_ascii() && second.is_ascii() {
            let buf = [
                first.to_ascii_uppercase() as u8,
                second.to_ascii_lowercase() as u8,
            ];
            symbol_to_atomic_num(std::str::from_utf8(&buf).unwrap_or(""))
        } else {
            let two: String = first.to_uppercase().chain(second.to_lowercase()).collect();
            symbol_to_atomic_num(&two)
        };
        if num != 0 {
            return num;
        }
    }

    // Fall back to a single-character symbol.
    if first.is_ascii() {
        let buf = [first.to_ascii_uppercase() as u8];
        symbol_to_atomic_num(std::str::from_utf8(&buf).unwrap_or(""))
    } else {
        let one: String = first.to_uppercase().collect();
        symbol_to_atomic_num(&one)
    }
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
        // Every symbol the forward table knows maps back to the same Z.
        for z in 1..=118u8 {
            let sym = atomic_num_to_symbol(z);
            let back = symbol_to_atomic_num(sym);
            if back != 0 {
                assert_eq!(back, z, "round trip failed for {sym}");
            }
        }
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
    }

    #[test]
    fn test_element_from_atom_name() {
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
}
