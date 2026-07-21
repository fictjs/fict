#![forbid(unsafe_code)]

//! Typed, OXC-independent high-level intermediate representation for Fict.

mod ids;
mod ir;
mod jsx;
mod module;
mod origin;
mod printer;
mod reactive_method;
mod syntax;
mod verify;

pub use fict_diagnostics::SourceSpan;
pub use ids::{
    BindingId, BlockId, FileId, FunctionId, GlobalId, LocalId, RegionId, ScopeId, SsaName,
    SsaVersion, SyntaxFragmentId, TemplateId, ValueId,
};
pub use ir::{
    ArrayElement, BinaryOperator, Binding, BindingKind, CallArgument, CallHost, CallInstruction,
    CompoundAssignmentOperator, ContextValueKind, DeclarationKind, DeleteTarget, EvaluationMode,
    FictMacroKind, FunctionFlags, FunctionKind, HirBlock, HirFile, HirFunction, HirGlobal,
    HirInstruction, HirInstructionKind, HirLocal, HirObjectParameterCheck, HirObjectParameterMode,
    HirObjectParameterProperty, HirObjectParameterRest, HirParameter, HirPatternWrite, HirScope,
    HirTerminator, HirValue, ImportBinding, ImportKind, ImportPhase, ImportedHookMember,
    ImportedHookPropertyCollection, ImportedHookPropertyMatch, ImportedHookReturn, ImportedName,
    ImportedReactiveKind, ImportedReactiveMember, ImportedReactiveMemberMatch,
    ImportedReactiveProperty, InstructionSemantics, IterationKind, LocalKind, MutationEffect,
    ObjectEntry, ObjectPropertyKind, Place, PlaceBase, Projection, PropertyKey, Purity,
    ReactiveCallKind, ReactiveScopeHost, ReactiveScopeKind, ScopeKind, StructuredSourceHint,
    StructuredSourceKind, StructuredSwitchCaseHint, SwitchCase, TaggedTemplateQuasi,
    TerminatorKind, UnaryOperator, UpdateOperator, ValueKind,
};
pub use jsx::{
    JsxAttribute, JsxAttributeValue, JsxChild, JsxElement, JsxElementName, JsxExpressionKind,
    JsxListExpression, JsxListReceiver, JsxNode, JsxTemplate,
};
pub use module::{
    ModuleExport, ModuleLocalExport, ModulePlan, print_module_plan, verify_module_plan,
};
pub use origin::{DesugaringKind, GeneratedOrigin, Origin, OriginKind};
pub use printer::print_hir;
pub use reactive_method::{StateMethodCallSemantics, classify_state_method_call};
pub use syntax::{
    JavaScriptString, LiteralValue, NumberLiteral, PatternSummary, SyntaxFragment,
    SyntaxFragmentKind, SyntaxSummary,
};
pub use verify::verify_hir;
