//! Compatibility re-exports for the historical `parser` module.
//!
//! `parser.rs` used to hold both the PDB parser and the result types every
//! structure parser shares. They now live in [`crate::pdb`] and
//! [`crate::structure`]; this module re-exports everything it used to expose
//! so existing `crate::parser::…` / `megane_core::parser::…` paths (the WASM
//! and PyO3 bindings, downstream code) keep compiling unchanged.
//!
//! New code should import from [`crate::structure`], [`crate::pdb`],
//! [`crate::atomic`] or [`crate::cell`] directly.
pub use crate::atomic::{capitalize, symbol_to_atomic_num};
pub use crate::cell::cell_params_to_matrix;
pub use crate::pdb::{
    build_index, decode_model_at, parse, parse_frame0, parse_frame0_prefix, Atom, PdbIndex,
};
pub use crate::structure::{FrameChange, HeteroFrames, HeteroFramesBuilder, ParsedStructure};
