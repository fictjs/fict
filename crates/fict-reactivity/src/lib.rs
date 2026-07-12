#![forbid(unsafe_code)]

//! CFG, SSA, reactivity, region, and optimizer passes over Fict-owned HIR.

mod cfg;
mod ssa;

pub use cfg::{CfgAnalysis, analyze_cfg};
pub use ssa::{
    SsaAnalysis, SsaDefinition, SsaDefinitionKind, SsaDefinitionLocation, SsaPhi, SsaStats, SsaUse,
    SsaUseKind, SsaUseLocation, analyze_ssa, materialize_ssa, print_ssa, verify_ssa,
};
