#![forbid(unsafe_code)]

//! CFG, SSA, reactivity, region, and optimizer passes over Fict-owned HIR.

mod alias;
mod cfg;
mod effects;
mod ssa;

pub use alias::{
    AliasAnalysis, AliasClass, AliasEdge, AliasInvalidation, AliasInvalidationReason, AliasStats,
    analyze_aliases, verify_aliases,
};
pub use cfg::{CfgAnalysis, analyze_cfg};
pub use effects::{
    BarrierFact, BarrierKind, CallbackDisposition, CallbackFact, DependencyAnalysis,
    DependencyBase, DependencyPath, DependencySegment, DependencyStats, EscapeFact, EscapeKind,
    InstructionLocation, ReadFact, WriteFact, analyze_dependencies, verify_dependencies,
};
pub use ssa::{
    SsaAnalysis, SsaDefinition, SsaDefinitionKind, SsaDefinitionLocation, SsaPhi, SsaStats, SsaUse,
    SsaUseKind, SsaUseLocation, analyze_ssa, materialize_ssa, print_ssa, verify_ssa,
};
