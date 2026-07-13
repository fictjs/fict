use crate::{
    BindingId, BlockId, FileId, FunctionId, JsxTemplate, LocalId, Origin, ScopeId, SsaName,
    SyntaxFragment, SyntaxFragmentId, TemplateId, ValueId,
};
use crate::{LiteralValue, RegionId};

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

/// Module and exported-symbol identity for an import binding.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ImportBinding {
    /// Exact source specifier.
    pub source: String,
    /// Exported symbol shape.
    pub imported: ImportedName,
    /// Runtime/type role.
    pub kind: ImportKind,
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

/// Assignable/readable location with structural identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    /// Root local, SSA identity, or evaluated object value.
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
        self.projections.is_empty()
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
    /// `delete`.
    Delete,
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
    /// Materialize a literal value.
    Literal(LiteralValue),
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
