#![forbid(unsafe_code)]

//! CFG, SSA, reactivity, region, and optimizer passes over Fict-owned HIR.

mod alias;
mod cfg;
mod cycles;
mod effects;
mod optimize;
mod regions;
mod scopes;
mod shapes;
mod ssa;
mod structurize;

pub use alias::{
    AliasAnalysis, AliasClass, AliasEdge, AliasInvalidation, AliasInvalidationReason, AliasStats,
    analyze_aliases, verify_aliases,
};
pub use cfg::{CfgAnalysis, analyze_cfg};
pub use cycles::{
    ReactiveCycle, ReactiveCycleAnalysis, ReactiveCycleKind, ReactiveCycleStats, ReactiveGraphEdge,
    analyze_reactive_cycles, verify_reactive_cycles,
};
pub use effects::{
    BarrierFact, BarrierKind, CallbackDisposition, CallbackFact, DependencyAnalysis,
    DependencyBase, DependencyPath, DependencySegment, DependencyStats, EscapeFact, EscapeKind,
    InstructionLocation, ReadFact, WriteFact, analyze_dependencies, verify_dependencies,
};
pub use optimize::{
    ConstantPropagation, ConstantPropagationOptions, ConstantPropagationStats, SsaConstantFact,
    ValueConstantFact, analyze_constants, apply_constant_folding, verify_constants,
};
pub use regions::{
    ReactiveRegion, RegionAnalysis, RegionInstructionRange, RegionStats, analyze_regions,
    materialize_regions, verify_regions,
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
pub use structurize::{
    StateMachineFallback, StructuredConstruct, StructuredConstructKind, StructuredLoopKind,
    StructuredSwitchArm, StructurizeAnalysis, StructurizeFallbackReason, StructurizeStats,
    structurize_cfg, verify_structurized_cfg,
};
