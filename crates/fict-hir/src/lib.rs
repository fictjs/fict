#![forbid(unsafe_code)]

//! Typed, OXC-independent high-level intermediate representation for Fict.

mod ids;
mod ir;
mod jsx;
mod origin;
mod printer;
mod syntax;
mod verify;

pub use fict_diagnostics::SourceSpan;
pub use ids::{
    BindingId, BlockId, FileId, FunctionId, LocalId, RegionId, ScopeId, SsaName, SsaVersion,
    SyntaxFragmentId, TemplateId, ValueId,
};
pub use ir::{
    ArrayElement, BinaryOperator, Binding, BindingKind, CallArgument, CallHost, CallInstruction,
    CompoundAssignmentOperator, DeclarationKind, EvaluationMode, FictMacroKind, FunctionFlags,
    FunctionKind, HirBlock, HirFile, HirFunction, HirInstruction, HirInstructionKind, HirLocal,
    HirParameter, HirScope, HirTerminator, HirValue, ImportBinding, ImportKind, ImportedName,
    InstructionSemantics, LocalKind, MutationEffect, ObjectEntry, ObjectPropertyKind, Place,
    PlaceBase, Projection, PropertyKey, Purity, ReactiveCallKind, ReactiveScopeHost,
    ReactiveScopeKind, ScopeKind, StructuredSourceHint, StructuredSourceKind, SwitchCase,
    TerminatorKind, UnaryOperator, UpdateOperator, ValueKind,
};
pub use jsx::{
    JsxAttribute, JsxAttributeValue, JsxChild, JsxElement, JsxElementName, JsxExpressionKind,
    JsxListExpression, JsxListReceiver, JsxNode, JsxTemplate,
};
pub use origin::{DesugaringKind, GeneratedOrigin, Origin, OriginKind};
pub use printer::print_hir;
pub use syntax::{
    LiteralValue, NumberLiteral, PatternSummary, SyntaxFragment, SyntaxFragmentKind, SyntaxSummary,
};
pub use verify::verify_hir;
