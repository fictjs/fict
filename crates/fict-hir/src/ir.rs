use crate::{
    BindingId, BlockId, FileId, FunctionId, GlobalId, JavaScriptString, JsxTemplate, LiteralValue,
    LocalId, Origin, RegionId, ScopeId, SsaName, SyntaxFragment, SyntaxFragmentId, TemplateId,
    ValueId,
};

/// Lexical scope category produced by frontend semantic analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ScopeKind {
    /// ECMAScript module or script scope.
    Module,
    /// Function body scope.
    Function,
    /// Function parameter environment.
    Parameters,
    /// Lexical block scope.
    Block,
    /// Class body scope.
    Class,
    /// Class static block scope.
    ClassStaticBlock,
    /// Catch clause scope.
    Catch,
    /// Dynamic `with` environment, retained for fail-closed diagnostics.
    With,
}

/// One semantic scope independent of frontend arena lifetimes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirScope {
    /// Request-local identity.
    pub id: ScopeId,
    /// Lexical parent, absent only for the file root.
    pub parent: Option<ScopeId>,
    /// Scope category.
    pub kind: ScopeKind,
    /// Source provenance.
    pub origin: Origin,
}

/// Frontend-unresolved identifier whose runtime identity belongs to the host/global environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirGlobal {
    /// Request-local interned identity.
    pub id: GlobalId,
    /// Exact identifier spelling used by runtime lookup.
    pub name: String,
    /// First structured place reference used to intern this identity.
    pub origin: Origin,
}

/// Runtime binding category after TypeScript erasure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BindingKind {
    /// `var` binding.
    Var,
    /// `let` binding.
    Let,
    /// `const` binding.
    Const,
    /// Function parameter.
    Parameter,
    /// Function declaration or named expression binding.
    Function,
    /// Class declaration or named expression binding.
    Class,
    /// Runtime import binding.
    Import,
    /// Namespace binding created by TypeScript lowering.
    Namespace,
    /// Catch clause binding.
    Catch,
    /// Resolved global binding.
    Global,
    /// Compiler-generated binding.
    Synthetic,
}

/// Imported symbol shape.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ImportedName {
    /// Default import.
    Default,
    /// Namespace import.
    Namespace,
    /// TypeScript `import binding = require("module")`, callable as the CommonJS default while
    /// also exposing the module namespace's static members.
    ImportEquals,
    /// Named import using the exported spelling.
    Named(String),
}

/// Runtime/type role of an import binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ImportKind {
    /// Runtime value import.
    Value,
    /// Type-only import retained as a frontend fact but absent from runtime HIR.
    TypeOnly,
}

/// Reactive value semantics recovered from authoritative module metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ImportedReactiveKind {
    /// Imported signal accessor.
    Signal,
    /// Imported memo accessor.
    Memo,
    /// Imported deep reactive store.
    Store,
}

/// One statically addressable reactive member below an imported namespace value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportedReactiveMember {
    /// Static property path relative to the imported namespace binding.
    pub path: Vec<String>,
    /// Runtime representation at this path.
    pub kind: ImportedReactiveKind,
}

/// Resolved imported member semantics for one projected place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportedReactiveMemberMatch {
    /// Index in [`ImportBinding::reactive_members`].
    pub member_index: usize,
    /// Number of place projections that form the accessor or store value.
    pub accessor_depth: usize,
    /// Runtime representation at the matched path.
    pub kind: ImportedReactiveKind,
}

/// One named reactive property in an imported hook return shape.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportedReactiveProperty {
    /// Runtime property key.
    pub key: String,
    /// Runtime representation stored at the property.
    pub kind: ImportedReactiveKind,
}

/// Property collection selected from imported hook metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ImportedHookPropertyCollection {
    /// Object property metadata.
    Object,
    /// Tuple/array index metadata.
    Array,
}

/// Resolved reactive property in an imported hook return shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportedHookPropertyMatch {
    /// Object or array metadata collection.
    pub collection: ImportedHookPropertyCollection,
    /// Index in the selected sorted property collection.
    pub property_index: usize,
    /// Runtime representation stored at the property.
    pub kind: ImportedReactiveKind,
}

/// Reactive shape returned by an imported hook.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportedHookReturn {
    /// Hook directly returns an accessor or store.
    pub direct_accessor: Option<ImportedReactiveKind>,
    /// Sorted reactive object properties.
    pub object_properties: Vec<ImportedReactiveProperty>,
    /// Sorted reactive tuple/array properties keyed by canonical indexes.
    pub array_properties: Vec<ImportedReactiveProperty>,
}

/// One hook exported below an imported namespace value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportedHookMember {
    /// Static path from the imported namespace root to the hook export.
    pub path: Vec<String>,
    /// Reactive shape returned by the hook.
    pub return_shape: ImportedHookReturn,
}

impl ImportedHookReturn {
    /// Resolve one statically known return property.
    #[must_use]
    pub fn resolve_property(&self, projection: &Projection) -> Option<ImportedHookPropertyMatch> {
        let (key, first, second) = match projection {
            Projection::StaticProperty { name, .. } => (
                name.as_str(),
                ImportedHookPropertyCollection::Object,
                ImportedHookPropertyCollection::Array,
            ),
            Projection::Index { index, .. } => {
                return self
                    .resolve_property_in(&index.to_string(), ImportedHookPropertyCollection::Array)
                    .or_else(|| {
                        self.resolve_property_in(
                            &index.to_string(),
                            ImportedHookPropertyCollection::Object,
                        )
                    });
            }
            Projection::ComputedProperty { .. } => return None,
        };
        self.resolve_property_in(key, first)
            .or_else(|| self.resolve_property_in(key, second))
    }

    fn resolve_property_in(
        &self,
        key: &str,
        collection: ImportedHookPropertyCollection,
    ) -> Option<ImportedHookPropertyMatch> {
        let properties = match collection {
            ImportedHookPropertyCollection::Object => &self.object_properties,
            ImportedHookPropertyCollection::Array => &self.array_properties,
        };
        let property_index = properties
            .binary_search_by(|property| property.key.as_str().cmp(key))
            .ok()?;
        Some(ImportedHookPropertyMatch {
            collection,
            property_index,
            kind: properties[property_index].kind,
        })
    }
}

/// Module and exported-symbol identity for an import binding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportBinding {
    /// Exact source specifier.
    pub source: String,
    /// Exported symbol shape.
    pub imported: ImportedName,
    /// Runtime/type role.
    pub kind: ImportKind,
    /// Authoritative cross-module reactive semantics, when supplied by the graph host.
    pub reactive: Option<ImportedReactiveKind>,
    /// Sorted static reactive paths below an imported namespace value.
    pub reactive_members: Vec<ImportedReactiveMember>,
    /// Reactive return shape when this direct import is an exported hook.
    pub hook_return: Option<ImportedHookReturn>,
    /// Sorted static hook paths below an imported namespace value.
    pub hook_members: Vec<ImportedHookMember>,
}

/// Semantic binding. `display_name` is never an identity key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    /// Request-local semantic identity.
    pub id: BindingId,
    /// Declaring scope.
    pub scope: ScopeId,
    /// Binding category.
    pub kind: BindingKind,
    /// Source spelling for diagnostics and later name allocation only.
    pub display_name: String,
    /// Import identity when this binding came from an import.
    pub import: Option<ImportBinding>,
    /// Source provenance.
    pub origin: Origin,
}

/// Source declaration category represented by a HIR declaration instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DeclarationKind {
    /// `var` declaration.
    Var,
    /// `let` declaration.
    Let,
    /// `const` declaration.
    Const,
    /// Function declaration.
    Function,
    /// Class declaration.
    Class,
    /// Function parameter initialization.
    Parameter,
    /// Catch parameter initialization.
    Catch,
    /// Runtime import initialization.
    Import,
    /// Compiler-generated local initialization.
    Generated,
}

/// Function-local storage role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LocalKind {
    /// User-authored local storage.
    User,
    /// Parameter storage.
    Parameter,
    /// Storage captured from an outer function.
    Capture,
    /// Compiler-generated temporary.
    Temporary,
}

/// Function-local storage location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirLocal {
    /// Function-local identity. It is not derived from `debug_name`.
    pub id: LocalId,
    /// Semantic binding for user-authored storage, if any.
    pub binding: Option<BindingId>,
    /// Lexical scope containing the storage.
    pub scope: ScopeId,
    /// Storage role.
    pub kind: LocalKind,
    /// Declaration category.
    pub declaration_kind: DeclarationKind,
    /// Optional display hint used only by diagnostics and name allocation.
    pub debug_name: Option<String>,
    /// Source provenance.
    pub origin: Origin,
}

/// Function category used by reactive analysis and emission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FunctionKind {
    /// Synthetic file/module body.
    Module,
    /// Ordinary JavaScript function.
    Plain,
    /// Fict component.
    Component,
    /// Fict hook.
    Hook,
    /// Callback selected by a configured reactive-scope host.
    ReactiveScope,
}

/// Syntax flags that change function execution semantics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FunctionFlags {
    /// Async function.
    pub is_async: bool,
    /// Generator function.
    pub is_generator: bool,
    /// Arrow function source form.
    pub is_arrow: bool,
    /// Memoization explicitly disabled for this function.
    pub no_memo: bool,
    /// Function has an authoritative pure annotation or directive.
    pub pure: bool,
}

/// Function parameter tied to both semantic and storage identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirParameter {
    /// Parameter storage location.
    pub local: LocalId,
    /// Semantic parameter binding for a simple identifier, when one exists.
    pub binding: Option<BindingId>,
    /// Adapter-owned source pattern for destructuring/default/rest shape.
    pub pattern: SyntaxFragmentId,
    /// Optional whole-parameter default expression.
    pub default_value: Option<Origin>,
    /// Statically modeled top-level object properties for safe component-prop lowering.
    pub object_properties: Option<Vec<HirObjectParameterProperty>>,
    /// Optional top-level rest binding for reactive props lowering.
    pub object_rest: Option<HirObjectParameterRest>,
    /// Source provenance.
    pub origin: Origin,
}

/// One simple property in a binding-aware object parameter pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirObjectParameterProperty {
    /// Static property path read from the incoming object.
    pub path: Vec<String>,
    /// Semantic local binding introduced by the property pattern.
    pub binding: BindingId,
    /// Whether reads use a reactive accessor or a plain callable/value snapshot.
    pub mode: HirObjectParameterMode,
    /// Ordered nullish checks required before this binding is initialized.
    pub checks: Vec<HirObjectParameterCheck>,
    /// Exact read references that must become accessor calls.
    pub references: Vec<Origin>,
    /// Optional property-default expression evaluated at component invocation.
    pub default_value: Option<Origin>,
    /// Source provenance of the property declaration.
    pub origin: Origin,
}

/// Lowering mode for one destructured component prop binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HirObjectParameterMode {
    Accessor,
    Value,
    Mutable,
}

/// Eager object check required by a nested destructuring pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirObjectParameterCheck {
    pub path: Vec<String>,
    pub origin: Origin,
}

/// Top-level rest binding and its statically excluded property names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirObjectParameterRest {
    pub binding: BindingId,
    pub excluded: Vec<String>,
    pub origin: Origin,
}

/// Origin of a value identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueKind {
    /// Function parameter value.
    Parameter(LocalId),
    /// Result defined by exactly one non-phi instruction.
    InstructionResult,
    /// Structural SSA definition.
    Ssa(SsaName),
    /// Literal constant.
    Literal(LiteralValue),
    /// Function value.
    Function(FunctionId),
    /// Value materialized from adapter-owned syntax.
    SyntaxFragment(SyntaxFragmentId),
}

/// Evaluated value in a function-local value arena.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirValue {
    /// Function-local identity.
    pub id: ValueId,
    /// Definition category.
    pub kind: ValueKind,
    /// Source provenance.
    pub origin: Origin,
}

/// Base storage identity of an assignable/readable place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PlaceBase {
    /// Pre-SSA local storage.
    Local(LocalId),
    /// SSA-versioned local storage.
    Ssa(SsaName),
    /// Frontend-unresolved host/global identifier.
    Global(GlobalId),
    /// Evaluated object used as the base of a projected read or write.
    ///
    /// This keeps member access such as `makeObject().field` structural without
    /// inventing a name or leaking a frontend expression node into HIR.
    Value(ValueId),
}

/// Projection from a place base to a property or indexed location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Projection {
    /// Static property access such as `.value`.
    StaticProperty {
        /// Property name.
        name: String,
        /// Whether this segment came from optional chaining.
        optional: bool,
    },
    /// Computed property access such as `[key]`.
    ComputedProperty {
        /// Evaluated property key.
        key: ValueId,
        /// Whether this segment came from optional chaining.
        optional: bool,
    },
    /// Canonical non-negative integer index.
    Index {
        /// Array/tuple index.
        index: u32,
        /// Whether this segment came from optional chaining.
        optional: bool,
    },
}

impl ImportBinding {
    /// Resolve the first statically proven reactive namespace prefix of a projected place.
    #[must_use]
    pub fn resolve_reactive_member(
        &self,
        projections: &[Projection],
    ) -> Option<ImportedReactiveMemberMatch> {
        let mut path = Vec::new();
        for projection in projections {
            path.push(match projection {
                Projection::StaticProperty { name, .. } => name.clone(),
                Projection::Index { index, .. } => index.to_string(),
                Projection::ComputedProperty { .. } => break,
            });
        }
        self.resolve_reactive_member_path(&path)
    }

    /// Resolve the first reactive prefix in a canonical static property path.
    #[must_use]
    pub fn resolve_reactive_member_path(
        &self,
        path: &[String],
    ) -> Option<ImportedReactiveMemberMatch> {
        for index in 0..path.len() {
            let prefix = &path[..=index];
            if let Ok(member_index) = self
                .reactive_members
                .binary_search_by(|member| member.path.as_slice().cmp(prefix))
            {
                return Some(ImportedReactiveMemberMatch {
                    member_index,
                    accessor_depth: index.saturating_add(1),
                    kind: self.reactive_members[member_index].kind,
                });
            }
        }
        None
    }

    /// Resolve an exact statically known hook path below an imported namespace value.
    #[must_use]
    pub fn resolve_hook_member(&self, projections: &[Projection]) -> Option<&ImportedHookReturn> {
        let path: Option<Vec<_>> = projections
            .iter()
            .map(|projection| match projection {
                Projection::StaticProperty { name, .. } => Some(name.clone()),
                Projection::Index { index, .. } => Some(index.to_string()),
                Projection::ComputedProperty { .. } => None,
            })
            .collect();
        let path = path?;
        self.resolve_hook_member_path(&path)
    }

    /// Resolve an exact canonical hook path below an imported namespace value.
    #[must_use]
    pub fn resolve_hook_member_path(&self, path: &[String]) -> Option<&ImportedHookReturn> {
        let member_index = self
            .hook_members
            .binary_search_by(|member| member.path.as_slice().cmp(path))
            .ok()?;
        Some(&self.hook_members[member_index].return_shape)
    }
}

/// Assignable/readable location with structural identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    /// Root local, SSA identity, unresolved global, or evaluated object value.
    pub base: PlaceBase,
    /// Property/index path in evaluation order.
    pub projections: Vec<Projection>,
}

impl Place {
    /// Construct an unprojected local place.
    #[must_use]
    pub const fn local(local: LocalId) -> Self {
        Self {
            base: PlaceBase::Local(local),
            projections: Vec::new(),
        }
    }

    /// Return whether this place directly names local storage.
    #[must_use]
    pub fn is_local(&self) -> bool {
        self.projections.is_empty() && matches!(self.base, PlaceBase::Local(_) | PlaceBase::Ssa(_))
    }
}

/// Purity classification used by conservative optimizer rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Purity {
    /// Proven pure under JavaScript evaluation semantics.
    Pure,
    /// Proven effectful.
    Impure,
    /// Insufficient evidence; must be treated conservatively.
    Unknown,
}

/// Mutation effect visible to subsequent analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MutationEffect {
    /// No mutation.
    None,
    /// Mutation proven local and unobservable outside the current analysis unit.
    Local,
    /// Observable source or host mutation.
    Observable,
    /// Unknown mutation behavior; must invalidate conservatively.
    Unknown,
}

/// When an instruction must be evaluated relative to its source host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EvaluationMode {
    /// Evaluation occurs immediately in source order.
    Eager,
    /// Evaluation belongs to a deferred callback or lazy region.
    Deferred,
}

/// Explicit semantic facts attached to every HIR instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstructionSemantics {
    /// Purity proof state.
    pub purity: Purity,
    /// Mutation visibility.
    pub mutation: MutationEffect,
    /// Eager or deferred evaluation.
    pub evaluation: EvaluationMode,
    /// Whether evaluation can throw or invoke an abrupt host completion.
    pub may_throw: bool,
}

impl InstructionSemantics {
    /// Semantics for a proven pure, eager, non-throwing operation.
    pub const PURE_EAGER: Self = Self {
        purity: Purity::Pure,
        mutation: MutationEffect::None,
        evaluation: EvaluationMode::Eager,
        may_throw: false,
    };

    /// Conservative semantics for an operation whose host behavior is unknown.
    pub const CONSERVATIVE_EAGER: Self = Self {
        purity: Purity::Unknown,
        mutation: MutationEffect::Unknown,
        evaluation: EvaluationMode::Eager,
        may_throw: true,
    };

    /// Return whether mutation is known to be externally observable.
    #[must_use]
    pub const fn has_observable_mutation(self) -> bool {
        matches!(
            self.mutation,
            MutationEffect::Observable | MutationEffect::Unknown
        )
    }
}

/// Unary JavaScript operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UnaryOperator {
    /// Unary plus.
    Plus,
    /// Unary minus.
    Minus,
    /// Logical negation.
    Not,
    /// Bitwise negation.
    BitNot,
    /// `typeof`.
    TypeOf,
    /// `void`.
    Void,
}

/// Value read directly from the current JavaScript execution context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ContextValueKind {
    /// Current `this` binding, including lexical arrow-function capture semantics.
    This,
    /// Constructor target exposed through `new.target`.
    NewTarget,
    /// Per-module metadata object exposed through `import.meta`.
    ImportMeta,
}

/// Reference or value targeted by JavaScript's `delete` operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteTarget {
    /// Resolved binding or property reference. Property projections are deleted without reading
    /// their current value first.
    Place(Place),
    /// Identifier without a frontend-resolved lexical binding. The host/global environment may
    /// still provide a deletable binding at runtime.
    UnresolvedIdentifier(String),
    /// Non-reference expression that is evaluated for effects before `delete` returns `true`.
    Value(ValueId),
}

/// Binary or logical JavaScript operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BinaryOperator {
    /// Addition or string concatenation.
    Add,
    /// Subtraction.
    Subtract,
    /// Multiplication.
    Multiply,
    /// Division.
    Divide,
    /// Remainder.
    Remainder,
    /// Exponentiation.
    Exponent,
    /// Loose equality.
    Equal,
    /// Loose inequality.
    NotEqual,
    /// Strict equality.
    StrictEqual,
    /// Strict inequality.
    StrictNotEqual,
    /// Less than.
    LessThan,
    /// Less than or equal.
    LessThanOrEqual,
    /// Greater than.
    GreaterThan,
    /// Greater than or equal.
    GreaterThanOrEqual,
    /// Left shift.
    ShiftLeft,
    /// Signed right shift.
    ShiftRight,
    /// Unsigned right shift.
    ShiftRightUnsigned,
    /// Bitwise OR.
    BitOr,
    /// Bitwise XOR.
    BitXor,
    /// Bitwise AND.
    BitAnd,
    /// Property membership.
    In,
    /// Prototype membership.
    InstanceOf,
    /// Short-circuit logical AND.
    LogicalAnd,
    /// Short-circuit logical OR.
    LogicalOr,
    /// Nullish coalescing.
    NullishCoalescing,
}

/// Compound assignment operator for a read-write place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CompoundAssignmentOperator {
    /// `+=`.
    Add,
    /// `-=`.
    Subtract,
    /// `*=`.
    Multiply,
    /// `/=`.
    Divide,
    /// `%=`.
    Remainder,
    /// `**=`.
    Exponent,
    /// `<<=`.
    ShiftLeft,
    /// `>>=`.
    ShiftRight,
    /// `>>>=`.
    ShiftRightUnsigned,
    /// `|=`.
    BitOr,
    /// `^=`.
    BitXor,
    /// `&=`.
    BitAnd,
    /// `&&=`.
    LogicalAnd,
    /// `||=`.
    LogicalOr,
    /// `??=`.
    NullishCoalescing,
}

/// Increment/decrement operator for a read-write place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum UpdateOperator {
    /// `++`.
    Increment,
    /// `--`.
    Decrement,
}

/// Property key of an object literal entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyKey {
    /// Static identifier or string key.
    Static(String),
    /// Canonical non-negative integer key.
    Index(u32),
    /// Computed key value.
    Computed(ValueId),
}

/// Object property syntax category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectPropertyKind {
    /// Ordinary initialized property.
    Init,
    /// Method definition.
    Method,
    /// Getter definition.
    Get,
    /// Setter definition.
    Set,
}

/// Object literal entry in source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectEntry {
    /// Property or method.
    Property {
        /// Property key.
        key: PropertyKey,
        /// Property value or function value.
        value: ValueId,
        /// Property category.
        kind: ObjectPropertyKind,
        /// Whether identifier shorthand was authored.
        shorthand: bool,
        /// Whether this is the special non-computed `__proto__` prototype setter.
        ///
        /// This is distinct from a computed or shorthand `__proto__` data property.
        prototype_setter: bool,
        /// Source provenance.
        origin: Origin,
    },
    /// Spread entry.
    Spread {
        /// Spread input.
        value: ValueId,
        /// Source provenance.
        origin: Origin,
    },
}

/// Array literal entry in source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArrayElement {
    /// Sparse-array hole.
    Hole(Origin),
    /// Ordinary element value.
    Value(ValueId),
    /// Spread element value.
    Spread {
        /// Spread input.
        value: ValueId,
        /// Source provenance.
        origin: Origin,
    },
}

/// Argument passed to a call or constructor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallArgument {
    /// Argument value.
    pub value: ValueId,
    /// Whether the value is spread.
    pub spread: bool,
}

/// Fict macro semantics confirmed from import and binding identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FictMacroKind {
    /// State creation macro.
    State,
    /// Effect registration macro.
    Effect,
    /// Derived memo macro.
    Memo,
}

/// Binding-resolved runtime reactive call whose value needs compiler tracking but whose call is
/// preserved. Unlike [`FictMacroKind`], these functions have real runtime implementations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveCallKind {
    /// Deep proxy returned by `$store`.
    Store,
    /// Async resource factory returned by `resource`.
    Resource,
    /// Keyed boolean accessor factory returned by `createSelector`.
    Selector,
}

/// Configured reactive callback category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReactiveScopeKind {
    /// User-configured direct-call host.
    Configured,
    /// Component render callback.
    ComponentRender,
    /// Hook callback.
    HookCallback,
    /// Effect callback.
    EffectCallback,
    /// Memo callback.
    MemoCallback,
}

/// Binding-aware reactive callback host classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReactiveScopeHost {
    /// Resolved callee binding.
    pub callee: BindingId,
    /// Zero-based callback argument position.
    pub callback_index: u16,
    /// Host category.
    pub kind: ReactiveScopeKind,
}

/// Semantic classification of a call host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallHost {
    /// Host cannot be proven and must be handled conservatively.
    Unknown,
    /// Resolved direct callee binding.
    Binding(BindingId),
    /// Known nested HIR function.
    Function(FunctionId),
    /// Configured or inferred reactive callback host.
    ReactiveScope(ReactiveScopeHost),
}

/// HIR call facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallInstruction {
    /// Evaluated callee.
    pub callee: ValueId,
    /// Property reference used to obtain the callee, when this is a method call.
    ///
    /// Retaining the reference preserves the receiver/`this` identity and optional member-chain
    /// semantics without re-evaluating its base or computed keys. Direct value calls keep this
    /// absent.
    pub callee_reference: Option<Place>,
    /// Arguments in evaluation order.
    pub arguments: Vec<CallArgument>,
    /// Host classification derived from semantic binding identity.
    pub host: CallHost,
    /// Confirmed Fict macro kind, if any.
    pub macro_kind: Option<FictMacroKind>,
    /// Confirmed runtime reactive creator kind, if any.
    pub reactive_kind: Option<ReactiveCallKind>,
    /// Whether the call itself is optional.
    pub optional: bool,
}

/// One static segment in a tagged template object's cooked and raw arrays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaggedTemplateQuasi {
    /// Cooked JavaScript string as exact UTF-16 code units.
    ///
    /// This is absent when the source segment contains an escape sequence that is only legal in
    /// a tagged template. UTF-16 retains lone surrogates that a Rust [`String`] cannot represent.
    pub cooked: Option<JavaScriptString>,
    /// Raw template text as exposed through `template.raw`.
    pub raw: String,
}

/// Runtime loading phase selected by a dynamic import expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ImportPhase {
    /// Ordinary `import(specifier)` evaluation.
    Evaluation,
    /// Source-phase `import.source(specifier)` evaluation.
    Source,
    /// Deferred-phase `import.defer(specifier)` evaluation.
    Defer,
}

/// JavaScript enumeration protocol used by a structured iteration loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IterationKind {
    /// Enumerate the enumerable string keys of an object (`for ... in`).
    In,
    /// Consume a synchronous iterator (`for ... of`).
    Of,
    /// Consume an async or sync iterator with per-step awaiting (`for await ... of`).
    AwaitOf,
}

/// One direct local write performed by an adapter-owned assignment pattern.
///
/// Multiple entries may name the same local because JavaScript patterns can assign the same
/// binding more than once. SSA treats the containing instruction as the final definition while
/// output lowering uses every source origin to preserve the authored write order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HirPatternWrite {
    /// Directly assigned local storage.
    pub local: LocalId,
    /// Exact identifier target occurrence inside the retained pattern.
    pub origin: Origin,
}

/// One operation in a basic block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HirInstructionKind {
    /// Declare storage and optionally initialize it.
    Declare {
        /// Declared storage.
        local: LocalId,
        /// Source declaration category.
        declaration_kind: DeclarationKind,
        /// Initial value, if present.
        initializer: Option<ValueId>,
    },
    /// Read a local or projected place.
    Read {
        /// Read location.
        place: Place,
    },
    /// Plain assignment to a place.
    ///
    /// An authored assignment expression defines an instruction result equal to `value`;
    /// declaration-initialization bookkeeping may use the same instruction without a result.
    Write {
        /// Written location.
        place: Place,
        /// Assigned value.
        value: ValueId,
    },
    /// Compound assignment or update that reads and writes the same place.
    ReadWrite {
        /// Read and written location.
        place: Place,
        /// Compound assignment operator, absent for increment/decrement.
        compound: Option<CompoundAssignmentOperator>,
        /// Right operand for compound assignment.
        value: Option<ValueId>,
        /// Update operator, absent for compound assignment.
        update: Option<UpdateOperator>,
        /// Whether an update operator is prefix form.
        prefix: bool,
    },
    /// Bind the value produced by one successful enumeration step.
    ///
    /// The exact declaration/assignment pattern remains adapter-owned while `targets` exposes
    /// every directly written local to SSA and reactive analysis.
    Iteration {
        /// Enumeration protocol used by the containing loop.
        kind: IterationKind,
        /// Once-evaluated object or iterable consumed by this step.
        source: ValueId,
        /// Exact binding or assignment pattern.
        pattern: SyntaxFragmentId,
        /// Direct local writes performed by the pattern in source order.
        targets: Vec<LocalId>,
    },
    /// Apply an object or array assignment pattern and return its right-hand-side value.
    ///
    /// The adapter owns computed keys, defaults, rest elements, member targets, and iterator
    /// protocol details. `writes` exposes every direct local target occurrence to SSA and
    /// reactive output lowering without embedding an OXC node in core HIR.
    PatternAssignment {
        /// Once-evaluated right-hand-side value. This is also the JavaScript expression result.
        value: ValueId,
        /// Exact object or array assignment pattern.
        pattern: SyntaxFragmentId,
        /// Direct local target occurrences in authored order. Repeated locals are retained.
        writes: Vec<HirPatternWrite>,
    },
    /// Materialize a literal value.
    Literal(LiteralValue),
    /// Evaluate `typeof` for a name without a frontend-resolved lexical binding.
    ///
    /// This is distinct from [`Self::Unary`] because evaluating an unresolved identifier as an
    /// ordinary input would incorrectly introduce a throwing reference read before `typeof` gets
    /// its special unresolvable-reference behavior.
    UnresolvedTypeof {
        /// Normalized identifier name used for host/global environment lookup.
        identifier: String,
    },
    /// Read a value supplied by the current execution context without a lexical binding input.
    Context {
        /// Context slot selected by the authored expression.
        kind: ContextValueKind,
    },
    /// Apply JavaScript reference-aware deletion semantics.
    Delete {
        /// Reference or ordinary value selected by the operand syntax.
        target: DeleteTarget,
    },
    /// Apply a unary operator.
    Unary {
        /// Operator.
        operator: UnaryOperator,
        /// Operand.
        argument: ValueId,
    },
    /// Apply a binary or logical operator.
    Binary {
        /// Operator.
        operator: BinaryOperator,
        /// Left operand.
        left: ValueId,
        /// Right operand.
        right: ValueId,
    },
    /// Select exactly one lazily evaluated branch from a conditional expression.
    Conditional {
        /// Eager condition value.
        test: ValueId,
        /// Value produced by the truthy branch.
        consequent: ValueId,
        /// Value produced by the falsy branch.
        alternate: ValueId,
    },
    /// Evaluate comma-separated expressions from left to right and return the final value.
    Sequence {
        /// Values in authored evaluation order. A valid sequence contains at least two values.
        values: Vec<ValueId>,
    },
    /// Build an untagged template literal with interleaved string coercions.
    TemplateLiteral {
        /// Cooked string segments. There is exactly one more quasi than expression.
        quasis: Vec<JavaScriptString>,
        /// Substitution values in authored coercion order.
        expressions: Vec<ValueId>,
    },
    /// Invoke a tag with a per-site cached template object and authored substitution values.
    TaggedTemplate {
        /// Evaluated tag expression.
        tag: ValueId,
        /// Property reference used to obtain a method tag, preserving its receiver identity and
        /// evaluated base/key values. Direct value tags keep this absent.
        tag_reference: Option<Place>,
        /// Static template segments. There is exactly one more quasi than substitution.
        quasis: Vec<TaggedTemplateQuasi>,
        /// Substitution values passed without string coercion, in authored order.
        substitutions: Vec<ValueId>,
        /// Binding-aware invocation host classification.
        host: CallHost,
    },
    /// Request a module through the host's dynamic import pipeline.
    DynamicImport {
        /// Module specifier value, converted to a string after `options` is evaluated.
        specifier: ValueId,
        /// Optional import-options object expression.
        options: Option<ValueId>,
        /// Requested runtime loading phase.
        phase: ImportPhase,
    },
    /// Invoke a function or method.
    Call(CallInstruction),
    /// Construct a value with `new`.
    New {
        /// Evaluated constructor.
        callee: ValueId,
        /// Arguments in evaluation order.
        arguments: Vec<CallArgument>,
    },
    /// Materialize an array literal.
    Array {
        /// Elements including holes and spreads.
        elements: Vec<ArrayElement>,
    },
    /// Materialize an object literal.
    Object {
        /// Entries in source order.
        entries: Vec<ObjectEntry>,
    },
    /// Materialize a nested function value.
    Function {
        /// Nested function identity.
        function: FunctionId,
    },
    /// Materialize a JSX template.
    Jsx {
        /// Template identity.
        template: TemplateId,
    },
    /// Await a value.
    Await {
        /// Awaited input.
        value: ValueId,
    },
    /// Yield a value or delegate to an iterator.
    Yield {
        /// Yielded value, absent for bare `yield`.
        value: Option<ValueId>,
        /// Whether this is `yield*`.
        delegate: bool,
    },
    /// Merge SSA definitions at a control-flow join.
    Phi {
        /// Newly defined SSA identity.
        target: SsaName,
        /// Predecessor and incoming SSA identity pairs.
        sources: Vec<(BlockId, SsaName)>,
    },
    /// Evaluate legal syntax retained and owned by the frontend adapter.
    SyntaxFragment {
        /// Adapter-owned fragment.
        fragment: SyntaxFragmentId,
        /// Explicit dynamic inputs in source evaluation order.
        inputs: Vec<ValueId>,
    },
    /// Preserve a source `debugger` statement.
    Debugger,
}

/// HIR instruction with optional result and explicit semantic effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirInstruction {
    /// Result value, absent for operations that produce no usable value.
    pub result: Option<ValueId>,
    /// Operation.
    pub kind: HirInstructionKind,
    /// Purity, mutation, evaluation, and abrupt-completion facts.
    pub semantics: InstructionSemantics,
    /// Source provenance.
    pub origin: Origin,
}

/// Switch branch target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchCase {
    /// Case test value, absent for `default`.
    pub test: Option<ValueId>,
    /// Target block.
    pub target: BlockId,
    /// Source provenance.
    pub origin: Origin,
}

/// Complete control-flow terminator for a basic block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminatorKind {
    /// Return from the current function.
    Return {
        /// Returned value, absent for bare return.
        value: Option<ValueId>,
    },
    /// Throw an exception value.
    Throw {
        /// Thrown value.
        value: ValueId,
    },
    /// Unconditional control-flow edge.
    Goto {
        /// Successor block.
        target: BlockId,
    },
    /// Conditional control-flow split.
    Branch {
        /// Test value.
        test: ValueId,
        /// Truthy successor.
        consequent: BlockId,
        /// Falsy successor.
        alternate: BlockId,
    },
    /// Enumerate an object's keys and enter `body` for every successful step.
    ForIn {
        /// Once-evaluated object expression.
        object: ValueId,
        /// Per-iteration body entry.
        body: BlockId,
        /// Normal exhaustion or abrupt-break continuation.
        exit: BlockId,
    },
    /// Consume a sync or async iterator and enter `body` for every successful step.
    ForOf {
        /// Once-evaluated iterable expression.
        iterable: ValueId,
        /// Whether each iterator step is awaited.
        r#await: bool,
        /// Per-iteration body entry.
        body: BlockId,
        /// Normal exhaustion or abrupt-break continuation.
        exit: BlockId,
    },
    /// Multi-way switch.
    Switch {
        /// Discriminant value.
        discriminant: ValueId,
        /// Cases in source order, with at most one default.
        cases: Vec<SwitchCase>,
    },
    /// Structured exception edge retained until CFG exception modeling.
    Try {
        /// Try-body entry.
        body: BlockId,
        /// Catch-body entry, if any.
        catch: Option<BlockId>,
        /// Finally-body entry, if any.
        finally: Option<BlockId>,
        /// Normal continuation after the construct.
        continuation: BlockId,
    },
    /// Deliberately unreachable block end.
    Unreachable,
}

/// Terminator and provenance. Every block has exactly one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirTerminator {
    /// Control-flow operation.
    pub kind: TerminatorKind,
    /// Source provenance.
    pub origin: Origin,
}

/// Structured source construct associated with lowered CFG blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuredSourceKind {
    /// Lexical source block.
    LexicalBlock,
    /// `if` statement or conditional expression.
    Conditional,
    /// `switch` statement.
    Switch,
    /// `while` loop.
    WhileLoop,
    /// `do ... while` loop.
    DoWhileLoop,
    /// Classic `for` loop.
    ForLoop,
    /// `for ... of` loop.
    ForOfLoop,
    /// `for await ... of` loop.
    ForAwaitOfLoop,
    /// `for ... in` loop.
    ForInLoop,
    /// `try` statement.
    Try,
    /// `catch` clause.
    Catch,
    /// `finally` clause.
    Finally,
    /// Labeled statement. Labels are control-flow labels, not binding identity.
    Labeled(String),
}

/// One source-order switch clause retained for structured recovery after case tests are lowered to
/// ordinary CFG branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StructuredSwitchCaseHint {
    /// Block that evaluates and compares the case expression, absent for `default`.
    pub test: Option<BlockId>,
    /// Clause body entry used both for direct selection and source-order fallthrough.
    pub body: BlockId,
    /// Source provenance for the complete clause.
    pub origin: Origin,
}

/// Read-only source-shape hint used by structurization and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuredSourceHint {
    /// Source construct category.
    pub kind: StructuredSourceKind,
    /// Normal exit block when the source construct has one.
    pub exit: Option<BlockId>,
    /// Source-order switch clauses. Non-switch hints keep this empty.
    pub switch_cases: Vec<StructuredSwitchCaseHint>,
    /// Source provenance.
    pub origin: Origin,
}

/// Basic block with instructions and one complete terminator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirBlock {
    /// Function-local block identity.
    pub id: BlockId,
    /// Lexical scope active at block entry.
    pub scope: ScopeId,
    /// Instructions in evaluation order.
    pub instructions: Vec<HirInstruction>,
    /// Complete block terminator.
    pub terminator: HirTerminator,
    /// Optional structured source shape.
    pub source_hint: Option<StructuredSourceHint>,
    /// Source provenance for the block.
    pub origin: Origin,
}

/// One function and its function-local arenas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirFunction {
    /// Request-local function identity.
    pub id: FunctionId,
    /// Semantic function binding, absent for anonymous and module functions.
    pub binding: Option<BindingId>,
    /// Function body scope.
    pub scope: ScopeId,
    /// Reactive classification.
    pub kind: FunctionKind,
    /// Execution flags.
    pub flags: FunctionFlags,
    /// Parameters in source order.
    pub parameters: Vec<HirParameter>,
    /// Function-local storage arena.
    pub locals: Vec<HirLocal>,
    /// Function-local value arena.
    pub values: Vec<HirValue>,
    /// Basic blocks in deterministic creation order.
    pub blocks: Vec<HirBlock>,
    /// Entry block.
    pub entry: BlockId,
    /// Reactive regions assigned by later analysis.
    pub regions: Vec<RegionId>,
    /// Source provenance.
    pub origin: Origin,
}

/// Complete OXC-independent HIR for one source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HirFile {
    /// Request-local file identity.
    pub id: FileId,
    /// UTF-8 source byte length used to validate all source spans.
    pub source_len: u32,
    /// Synthetic module/script function.
    pub root_function: FunctionId,
    /// Semantic scopes in deterministic ID order.
    pub scopes: Vec<HirScope>,
    /// Semantic bindings in deterministic ID order.
    pub bindings: Vec<Binding>,
    /// Frontend-unresolved host/global names in first structured-reference order.
    pub globals: Vec<HirGlobal>,
    /// Functions in deterministic ID order.
    pub functions: Vec<HirFunction>,
    /// JSX templates in deterministic ID order.
    pub templates: Vec<JsxTemplate>,
    /// Adapter-owned syntax summaries in deterministic ID order.
    pub syntax_fragments: Vec<SyntaxFragment>,
}

#[cfg(test)]
mod tests {
    use fict_diagnostics::SourceSpan;

    use crate::{LocalId, Origin, SsaName, SsaVersion};

    use super::{
        Binding, BindingKind, EvaluationMode, InstructionSemantics, MutationEffect, Place,
        PlaceBase, Projection, Purity,
    };
    use crate::{BindingId, ScopeId};

    #[test]
    fn display_names_do_not_define_binding_or_place_identity() {
        let origin = Origin::source(SourceSpan::new(0, 5).expect("valid span"));
        let first = Binding {
            id: BindingId::new(1),
            scope: ScopeId::new(0),
            kind: BindingKind::Let,
            display_name: "value".into(),
            import: None,
            origin,
        };
        let shadow = Binding {
            id: BindingId::new(2),
            scope: ScopeId::new(1),
            kind: BindingKind::Let,
            display_name: "value".into(),
            import: None,
            origin,
        };
        let place = Place {
            base: PlaceBase::Ssa(SsaName::new(LocalId::new(3), SsaVersion::new(1))),
            projections: vec![Projection::StaticProperty {
                name: "value".into(),
                optional: false,
            }],
        };

        assert_ne!(first.id, shadow.id);
        assert_eq!(first.display_name, shadow.display_name);
        assert!(!place.is_local());

        let computed_base = Place {
            base: PlaceBase::Value(crate::ValueId::new(8)),
            projections: vec![Projection::StaticProperty {
                name: "field".into(),
                optional: false,
            }],
        };
        assert!(!computed_base.is_local());
    }

    #[test]
    fn conservative_semantics_are_observable_and_eager() {
        let semantics = InstructionSemantics::CONSERVATIVE_EAGER;
        assert_eq!(semantics.purity, Purity::Unknown);
        assert_eq!(semantics.mutation, MutationEffect::Unknown);
        assert_eq!(semantics.evaluation, EvaluationMode::Eager);
        assert!(semantics.has_observable_mutation());
    }
}
