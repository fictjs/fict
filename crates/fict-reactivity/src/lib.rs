#![forbid(unsafe_code)]

//! CFG, SSA, reactivity, region, and optimizer passes over Fict-owned HIR.

mod alias;
mod cfg;
mod effects;
mod scopes;
mod shapes;
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
pub use scopes::{
    ReactiveBindingFact, ReactiveBindingKind, ReactiveBlockFact, ReactiveScopeAnalysis,
    ReactiveScopeStats, analyze_reactive_scopes, verify_reactive_scopes,
};
pub use shapes::{
    PropertyAccessFact, PropertyAccessKind, ShapeAnalysis, ShapeFact, ShapeKey, ShapeKind,
    ShapeSource, ShapeStats, ValueShape, analyze_shapes, verify_shapes,
};
pub use ssa::{
    SsaAnalysis, SsaDefinition, SsaDefinitionKind, SsaDefinitionLocation, SsaPhi, SsaStats, SsaUse,
    SsaUseKind, SsaUseLocation, analyze_ssa, materialize_ssa, print_ssa, verify_ssa,
};
