use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};
use fict_hir::{
    ArrayElement, ContextValueKind, FictMacroKind, FunctionId, FunctionKind, HirFile,
    HirInstructionKind, LocalKind, ObjectEntry, PlaceBase, PropertyKey, ReactiveCallKind, SsaName,
    ValueId,
};

use crate::{
    AliasAnalysis, DependencyAnalysis, DependencyBase, DependencyPath, DependencySegment,
    EscapeKind, InstructionLocation, SsaAnalysis, SsaDefinitionKind, SsaDefinitionLocation,
    verify_aliases, verify_dependencies, verify_ssa,
};

/// Coarse runtime value category used by shape-sensitive optimizations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ShapeKind {
    /// Insufficient evidence.
    Unknown,
    /// Primitive/literal scalar.
    Primitive,
    /// Object-like key/value container.
    Object,
    /// JavaScript array with observable length/sparsity.
    Array,
    /// Function value.
    Function,
    /// Signal/memo-like reactive value.
    Reactive,
}

/// Proven origin of a shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ShapeSource {
    /// Initial local storage without a value proof.
    Entry,
    /// Function parameter.
    Parameter,
    /// Literal scalar.
    Literal(ValueId),
    /// String produced by an untagged template literal.
    TemplateLiteral(ValueId),
    /// String produced by `typeof` for a frontend-unresolved name.
    UnresolvedTypeof(ValueId),
    /// Value read from the current JavaScript execution context.
    ContextValue(ValueId, ContextValueKind),
    /// Boolean result of a JavaScript `delete` operation.
    Delete(ValueId),
    /// Promise object returned by a dynamic import request.
    DynamicImport(ValueId),
    /// Object literal.
    ObjectLiteral(ValueId),
    /// Array literal.
    ArrayLiteral(ValueId),
    /// Nested function value.
    Function(FunctionId),
    /// Unknown call/constructor/syntax result.
    UnknownOperation,
    /// Fict state or memo macro.
    ReactiveMacro(FictMacroKind),
    /// Binding-resolved runtime store/resource/selector call.
    RuntimeReactive(ReactiveCallKind),
    /// Direct alias of another SSA definition.
    Alias(SsaName),
    /// Join of multiple control-flow definitions.
    Phi,
}

/// Static object/array key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ShapeKey {
    /// Property spelling.
    Static(String),
    /// Canonical array/object index.
    Index(u32),
}

/// Conservative object/array/value shape lattice element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValueShape {
    /// Coarse category.
    pub kind: ShapeKind,
    /// Best known source.
    pub source: ShapeSource,
    /// Statically present/observed keys.
    pub known_keys: Vec<ShapeKey>,
    /// Keys mutated through this value or any proven alias.
    pub mutable_keys: Vec<ShapeKey>,
    /// Whether `known_keys` is a complete own-key set.
    pub complete_key_set: bool,
    /// Runtime-computed property access occurred.
    pub dynamic_access: bool,
    /// A spread prevents a closed key proof.
    pub has_spread: bool,
    /// Value or alias escapes its ordinary scope.
    pub escapes: bool,
    /// Exact array length including holes, when known.
    pub array_length: Option<u32>,
}

/// Shape assigned to one SSA definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeFact {
    /// SSA definition.
    pub name: SsaName,
    /// Shape lattice state.
    pub shape: ValueShape,
}

/// Property access category retained for shape/explain consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PropertyAccessKind {
    /// Read dependency.
    Read,
    /// Mutation dependency.
    Write,
}

/// One property access tied to its HIR location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyAccessFact {
    /// Structural path.
    pub path: DependencyPath,
    /// Read or write.
    pub kind: PropertyAccessKind,
    /// Instruction location.
    pub location: InstructionLocation,
}

/// Shape pass statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShapeStats {
    /// SSA shape facts.
    pub shapes: u32,
    /// Property accesses.
    pub property_accesses: u32,
    /// Shapes marked escaping.
    pub escaping_shapes: u32,
    /// Shapes with dynamic access.
    pub dynamic_shapes: u32,
    /// Lattice fixed-point sweeps.
    pub fixed_point_iterations: u32,
}

/// Complete shape analysis for one function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeAnalysis {
    /// One shape for every SSA definition, sorted by structural name.
    pub shapes: Vec<ShapeFact>,
    /// Read/write property accesses in deterministic order.
    pub property_accesses: Vec<PropertyAccessFact>,
    /// Pass statistics.
    pub stats: ShapeStats,
}

/// Analyze object/array/reactive shapes and propagate alias mutation/escape facts.
pub fn analyze_shapes(
    file: &HirFile,
    function_id: FunctionId,
    ssa: &SsaAnalysis,
    dependencies: &DependencyAnalysis,
    aliases: &AliasAnalysis,
) -> Result<ShapeAnalysis, DiagnosticBundle> {
    let Some(function) = file.functions.get(function_id.as_usize()) else {
        return Err(DiagnosticBundle::new(vec![shape_error(
            "FICT-SHAPE-FUNCTION",
            "shape analysis function is outside the HIR arena",
        )]));
    };
    verify_ssa(function, ssa)?;
    verify_dependencies(file, function_id, ssa, dependencies)?;
    verify_aliases(function, ssa, aliases)?;

    let definition_names: Vec<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    let mut shapes: BTreeMap<SsaName, Option<ValueShape>> = definition_names
        .iter()
        .copied()
        .map(|name| (name, None))
        .collect();
    for definition in &ssa.definitions {
        if definition.kind == SsaDefinitionKind::Entry
            || definition.kind == SsaDefinitionKind::Parameter
        {
            let local = &function.locals[definition.name.local.as_usize()];
            let parameter_object =
                local.kind == LocalKind::Parameter && function.kind == FunctionKind::Component;
            shapes.insert(
                definition.name,
                Some(ValueShape {
                    kind: if parameter_object {
                        ShapeKind::Object
                    } else {
                        ShapeKind::Unknown
                    },
                    source: if local.kind == LocalKind::Parameter {
                        ShapeSource::Parameter
                    } else {
                        ShapeSource::Entry
                    },
                    known_keys: Vec::new(),
                    mutable_keys: Vec::new(),
                    complete_key_set: false,
                    dynamic_access: false,
                    has_spread: false,
                    escapes: false,
                    array_length: None,
                }),
            );
        }
    }

    let mut structural_values = BTreeMap::new();
    let mut read_sources = BTreeMap::new();
    let mut value_sources = BTreeMap::new();
    let mut assigned_values = BTreeMap::new();
    let definitions_by_location: BTreeMap<_, _> = ssa
        .definitions
        .iter()
        .filter_map(|definition| match definition.location {
            SsaDefinitionLocation::Instruction { block, instruction } => {
                Some(((block, instruction, definition.name.local), definition.name))
            }
            SsaDefinitionLocation::Entry | SsaDefinitionLocation::Phi(_) => None,
        })
        .collect();
    for block in &function.blocks {
        for (instruction_index, instruction) in block.instructions.iter().enumerate() {
            if let Some(result) = instruction.result {
                if let Some(shape) = structural_value_shape(result, instruction) {
                    structural_values.insert(result, shape);
                }
                if let HirInstructionKind::Sequence { values } = &instruction.kind
                    && let Some(value) = values.last()
                {
                    value_sources.insert(result, *value);
                }
                if matches!(instruction.kind, HirInstructionKind::Read { .. })
                    && let Some([path]) = dependencies
                        .value_dependencies
                        .get(result.as_usize())
                        .map(Vec::as_slice)
                    && path.segments.is_empty()
                    && let DependencyBase::Ssa(source) = path.base
                {
                    read_sources.insert(result, source);
                }
            }
            if let HirInstructionKind::Iteration { targets, .. } = &instruction.kind {
                for local in targets {
                    if let Some(target) = definitions_by_location.get(&(
                        block.id,
                        count_u32(instruction_index),
                        *local,
                    )) {
                        assigned_values.insert(*target, None);
                    }
                }
                continue;
            }
            let (local, initializer) = match &instruction.kind {
                HirInstructionKind::Declare {
                    local, initializer, ..
                } => (*local, *initializer),
                HirInstructionKind::Write { place, value } if place.is_local() => {
                    let Some(local) = place_local(place.base) else {
                        continue;
                    };
                    (local, Some(*value))
                }
                HirInstructionKind::ReadWrite { place, .. } if place.is_local() => {
                    let Some(local) = place_local(place.base) else {
                        continue;
                    };
                    (local, None)
                }
                _ => continue,
            };
            if let Some(target) =
                definitions_by_location.get(&(block.id, count_u32(instruction_index), local))
            {
                assigned_values.insert(*target, initializer);
            }
        }
    }

    let alias_sources: BTreeMap<_, _> = aliases
        .edges
        .iter()
        .map(|edge| (edge.alias, edge.source))
        .collect();
    let maximum_iterations = function
        .values
        .len()
        .saturating_add(ssa.definitions.len())
        .saturating_add(2);
    let mut iterations = 0_usize;
    loop {
        iterations = iterations.saturating_add(1);
        if iterations > maximum_iterations {
            return Err(DiagnosticBundle::new(vec![shape_error(
                "FICT-SHAPE-FIXED-POINT",
                "shape propagation exceeded its deterministic iteration limit",
            )]));
        }
        let previous = shapes.clone();
        let mut changed = false;
        for definition in &ssa.definitions {
            let next = if let Some(source) = alias_sources.get(&definition.name) {
                previous.get(source).cloned().flatten().map(|mut shape| {
                    shape.source = ShapeSource::Alias(*source);
                    shape
                })
            } else if definition.kind == SsaDefinitionKind::Phi {
                ssa.phis
                    .iter()
                    .find(|phi| phi.target == definition.name)
                    .and_then(|phi| {
                        let incoming: Option<Vec<_>> = phi
                            .sources
                            .iter()
                            .map(|(_, source)| previous.get(source).cloned().flatten())
                            .collect();
                        incoming.map(|incoming| join_many(&incoming, ShapeSource::Phi))
                    })
            } else if let Some(value) = assigned_values.get(&definition.name).copied().flatten() {
                value_shape(
                    value,
                    &structural_values,
                    &read_sources,
                    &value_sources,
                    &previous,
                )
            } else if assigned_values.contains_key(&definition.name) {
                Some(unknown_shape(ShapeSource::UnknownOperation))
            } else {
                previous.get(&definition.name).cloned().flatten()
            };
            if next != previous.get(&definition.name).cloned().flatten() {
                shapes.insert(definition.name, next);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let members_by_name: BTreeMap<_, _> = aliases
        .classes
        .iter()
        .flat_map(|class| {
            class
                .members
                .iter()
                .copied()
                .map(|member| (member, class.members.clone()))
        })
        .collect();
    let mut property_accesses: Vec<_> = dependencies
        .reads
        .iter()
        .filter(|read| !read.path.segments.is_empty())
        .map(|read| PropertyAccessFact {
            path: read.path.clone(),
            kind: PropertyAccessKind::Read,
            location: read.location,
        })
        .chain(
            dependencies
                .writes
                .iter()
                .filter(|write| !write.path.segments.is_empty())
                .map(|write| PropertyAccessFact {
                    path: write.path.clone(),
                    kind: PropertyAccessKind::Write,
                    location: write.location,
                }),
        )
        .collect();
    property_accesses.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.path.cmp(&right.path))
    });
    for access in &property_accesses {
        let DependencyBase::Ssa(name) = access.path.base else {
            continue;
        };
        let affected = members_by_name
            .get(&name)
            .cloned()
            .unwrap_or_else(|| vec![name]);
        for member in affected {
            let Some(shape) = shapes.get_mut(&member).and_then(Option::as_mut) else {
                continue;
            };
            if access.path.is_dynamic() {
                shape.dynamic_access = true;
                shape.complete_key_set = false;
                if access.kind == PropertyAccessKind::Write && shape.kind == ShapeKind::Array {
                    shape.array_length = None;
                }
            }
            if access.kind == PropertyAccessKind::Write
                && let Some(key) = access.path.segments.first().and_then(static_shape_key)
            {
                insert_sorted(&mut shape.known_keys, key.clone());
                insert_sorted(&mut shape.mutable_keys, key.clone());
                if shape.kind == ShapeKind::Array
                    && let ShapeKey::Index(index) = key
                    && let Some(length) = shape.array_length
                {
                    shape.array_length = Some(length.max(index.saturating_add(1)));
                }
            }
        }
    }
    for escape in &dependencies.escapes {
        if matches!(escape.kind, EscapeKind::DeferredCapture) {
            continue;
        }
        let DependencyBase::Ssa(name) = escape.path.base else {
            continue;
        };
        let affected = members_by_name
            .get(&name)
            .cloned()
            .unwrap_or_else(|| vec![name]);
        for member in affected {
            if let Some(shape) = shapes.get_mut(&member).and_then(Option::as_mut) {
                shape.escapes = true;
            }
        }
    }

    let shape_facts: Vec<_> = shapes
        .into_iter()
        .map(|(name, shape)| ShapeFact {
            name,
            shape: shape.unwrap_or_else(|| unknown_shape(ShapeSource::UnknownOperation)),
        })
        .collect();
    let stats = ShapeStats {
        shapes: count_u32(shape_facts.len()),
        property_accesses: count_u32(property_accesses.len()),
        escaping_shapes: count_u32(shape_facts.iter().filter(|fact| fact.shape.escapes).count()),
        dynamic_shapes: count_u32(
            shape_facts
                .iter()
                .filter(|fact| fact.shape.dynamic_access)
                .count(),
        ),
        fixed_point_iterations: count_u32(iterations),
    };
    let analysis = ShapeAnalysis {
        shapes: shape_facts,
        property_accesses,
        stats,
    };
    verify_shapes(function, ssa, aliases, &analysis)?;
    Ok(analysis)
}

/// Verify shape partition, lattice invariants, alias propagation, and stats.
pub fn verify_shapes(
    function: &fict_hir::HirFunction,
    ssa: &SsaAnalysis,
    aliases: &AliasAnalysis,
    analysis: &ShapeAnalysis,
) -> Result<(), DiagnosticBundle> {
    let mut diagnostics = DiagnosticBundle::default();
    let definitions: BTreeSet<_> = ssa
        .definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    let shape_names: BTreeSet<_> = analysis.shapes.iter().map(|fact| fact.name).collect();
    if shape_names != definitions || shape_names.len() != analysis.shapes.len() {
        diagnostics.push(shape_error(
            "FICT-SHAPE-ARENA",
            "shape facts must contain every SSA definition exactly once",
        ));
    }
    for fact in &analysis.shapes {
        let shape = &fact.shape;
        if shape.known_keys.windows(2).any(|pair| pair[0] >= pair[1])
            || shape.mutable_keys.windows(2).any(|pair| pair[0] >= pair[1])
        {
            diagnostics.push(shape_error(
                "FICT-SHAPE-KEYS",
                "shape keys must be sorted and unique",
            ));
        }
        if shape
            .mutable_keys
            .iter()
            .any(|key| !shape.known_keys.contains(key))
        {
            diagnostics.push(shape_error(
                "FICT-SHAPE-MUTATION",
                "mutable shape keys must also be known keys",
            ));
        }
        if shape.complete_key_set && (shape.dynamic_access || shape.has_spread) {
            diagnostics.push(shape_error(
                "FICT-SHAPE-COMPLETE",
                "dynamic/spread shapes cannot claim a complete key set",
            ));
        }
        if shape.array_length.is_some() && shape.kind != ShapeKind::Array {
            diagnostics.push(shape_error(
                "FICT-SHAPE-ARRAY",
                "only array shapes may carry an exact length",
            ));
        }
    }
    let shape_by_name: BTreeMap<_, _> = analysis
        .shapes
        .iter()
        .map(|fact| (fact.name, &fact.shape))
        .collect();
    for class in &aliases.classes {
        let mut comparable = None;
        for member in &class.members {
            let Some(shape) = shape_by_name.get(member) else {
                continue;
            };
            let signature = (
                shape.kind,
                &shape.known_keys,
                &shape.mutable_keys,
                shape.complete_key_set,
                shape.dynamic_access,
                shape.has_spread,
                shape.escapes,
                shape.array_length,
            );
            if comparable
                .as_ref()
                .is_some_and(|previous| previous != &signature)
            {
                diagnostics.push(shape_error(
                    "FICT-SHAPE-ALIAS",
                    "members of one alias class must share shape state",
                ));
                break;
            }
            comparable = Some(signature);
        }
    }
    for access in &analysis.property_accesses {
        if access.path.segments.is_empty()
            || function
                .blocks
                .get(access.location.block.as_usize())
                .is_none_or(|block| {
                    access.location.instruction as usize >= block.instructions.len()
                })
        {
            diagnostics.push(shape_error(
                "FICT-SHAPE-ACCESS",
                "property access must reference a projected path at a valid instruction",
            ));
        }
    }
    if analysis.stats.shapes != count_u32(analysis.shapes.len())
        || analysis.stats.property_accesses != count_u32(analysis.property_accesses.len())
        || analysis.stats.escaping_shapes
            != count_u32(
                analysis
                    .shapes
                    .iter()
                    .filter(|fact| fact.shape.escapes)
                    .count(),
            )
        || analysis.stats.dynamic_shapes
            != count_u32(
                analysis
                    .shapes
                    .iter()
                    .filter(|fact| fact.shape.dynamic_access)
                    .count(),
            )
    {
        diagnostics.push(shape_error(
            "FICT-SHAPE-STATS",
            "shape stats do not match result arenas",
        ));
    }
    if diagnostics.is_empty() {
        Ok(())
    } else {
        Err(diagnostics)
    }
}

fn structural_value_shape(
    value: ValueId,
    instruction: &fict_hir::HirInstruction,
) -> Option<ValueShape> {
    let shape = match &instruction.kind {
        HirInstructionKind::Literal(_) => ValueShape {
            kind: ShapeKind::Primitive,
            source: ShapeSource::Literal(value),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: true,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::TemplateLiteral { .. } => ValueShape {
            kind: ShapeKind::Primitive,
            source: ShapeSource::TemplateLiteral(value),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: true,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::UnresolvedTypeof { .. } => ValueShape {
            kind: ShapeKind::Primitive,
            source: ShapeSource::UnresolvedTypeof(value),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: true,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::Context {
            kind: ContextValueKind::ImportMeta,
        } => ValueShape {
            kind: ShapeKind::Object,
            source: ShapeSource::ContextValue(value, ContextValueKind::ImportMeta),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: false,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::Context { kind } => {
            unknown_shape(ShapeSource::ContextValue(value, *kind))
        }
        HirInstructionKind::Delete { .. } => ValueShape {
            kind: ShapeKind::Primitive,
            source: ShapeSource::Delete(value),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: true,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::DynamicImport { .. } => ValueShape {
            kind: ShapeKind::Object,
            source: ShapeSource::DynamicImport(value),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: false,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::Object { entries } => {
            let mut known_keys = Vec::new();
            let mut dynamic_access = false;
            let mut has_spread = false;
            for entry in entries {
                match entry {
                    ObjectEntry::Property {
                        key,
                        prototype_setter,
                        ..
                    } => {
                        if *prototype_setter {
                            continue;
                        }
                        match key {
                            PropertyKey::Static(key) => {
                                insert_sorted(&mut known_keys, ShapeKey::Static(key.clone()));
                            }
                            PropertyKey::Index(index) => {
                                insert_sorted(&mut known_keys, ShapeKey::Index(*index));
                            }
                            PropertyKey::Computed(_) => dynamic_access = true,
                        }
                    }
                    ObjectEntry::Spread { .. } => has_spread = true,
                }
            }
            ValueShape {
                kind: ShapeKind::Object,
                source: ShapeSource::ObjectLiteral(value),
                known_keys,
                mutable_keys: Vec::new(),
                complete_key_set: !dynamic_access && !has_spread,
                dynamic_access,
                has_spread,
                escapes: false,
                array_length: None,
            }
        }
        HirInstructionKind::Array { elements } => {
            let mut known_keys = Vec::new();
            let mut has_spread = false;
            for (index, element) in elements.iter().enumerate() {
                match element {
                    ArrayElement::Hole(_) => {}
                    ArrayElement::Value(_) => {
                        insert_sorted(&mut known_keys, ShapeKey::Index(count_u32(index)));
                    }
                    ArrayElement::Spread { .. } => has_spread = true,
                }
            }
            ValueShape {
                kind: ShapeKind::Array,
                source: ShapeSource::ArrayLiteral(value),
                known_keys,
                mutable_keys: Vec::new(),
                complete_key_set: !has_spread,
                dynamic_access: false,
                has_spread,
                escapes: false,
                array_length: (!has_spread).then(|| count_u32(elements.len())),
            }
        }
        HirInstructionKind::Function { function } => ValueShape {
            kind: ShapeKind::Function,
            source: ShapeSource::Function(*function),
            known_keys: Vec::new(),
            mutable_keys: Vec::new(),
            complete_key_set: true,
            dynamic_access: false,
            has_spread: false,
            escapes: false,
            array_length: None,
        },
        HirInstructionKind::Call(call) => {
            if let Some(kind @ (FictMacroKind::State | FictMacroKind::Memo)) = call.macro_kind {
                ValueShape {
                    kind: ShapeKind::Reactive,
                    source: ShapeSource::ReactiveMacro(kind),
                    known_keys: Vec::new(),
                    mutable_keys: Vec::new(),
                    complete_key_set: false,
                    dynamic_access: false,
                    has_spread: false,
                    escapes: false,
                    array_length: None,
                }
            } else if let Some(kind) = call.reactive_kind {
                ValueShape {
                    kind: ShapeKind::Reactive,
                    source: ShapeSource::RuntimeReactive(kind),
                    known_keys: Vec::new(),
                    mutable_keys: Vec::new(),
                    complete_key_set: false,
                    dynamic_access: false,
                    has_spread: false,
                    escapes: false,
                    array_length: None,
                }
            } else {
                unknown_shape(ShapeSource::UnknownOperation)
            }
        }
        HirInstructionKind::TaggedTemplate { .. }
        | HirInstructionKind::New { .. }
        | HirInstructionKind::Jsx { .. }
        | HirInstructionKind::SyntaxFragment { .. } => unknown_shape(ShapeSource::UnknownOperation),
        HirInstructionKind::Declare { .. }
        | HirInstructionKind::Read { .. }
        | HirInstructionKind::Write { .. }
        | HirInstructionKind::ReadWrite { .. }
        | HirInstructionKind::Iteration { .. }
        | HirInstructionKind::Unary { .. }
        | HirInstructionKind::Binary { .. }
        | HirInstructionKind::Conditional { .. }
        | HirInstructionKind::Sequence { .. }
        | HirInstructionKind::Await { .. }
        | HirInstructionKind::Yield { .. }
        | HirInstructionKind::Phi { .. }
        | HirInstructionKind::Debugger => return None,
    };
    Some(shape)
}

fn value_shape(
    mut value: ValueId,
    structural: &BTreeMap<ValueId, ValueShape>,
    reads: &BTreeMap<ValueId, SsaName>,
    value_sources: &BTreeMap<ValueId, ValueId>,
    shapes: &BTreeMap<SsaName, Option<ValueShape>>,
) -> Option<ValueShape> {
    let mut visited = BTreeSet::new();
    while let Some(source) = value_sources.get(&value).copied() {
        if !visited.insert(value) {
            return None;
        }
        value = source;
    }
    structural.get(&value).cloned().or_else(|| {
        reads
            .get(&value)
            .and_then(|source| shapes.get(source).cloned().flatten())
    })
}

fn join_many(shapes: &[ValueShape], source: ShapeSource) -> ValueShape {
    let mut result = shapes
        .first()
        .cloned()
        .unwrap_or_else(|| unknown_shape(source));
    result.source = source;
    for shape in shapes.iter().skip(1) {
        let previous_keys = result.known_keys.clone();
        result.kind = if result.kind == shape.kind {
            result.kind
        } else {
            ShapeKind::Unknown
        };
        for key in &shape.known_keys {
            insert_sorted(&mut result.known_keys, key.clone());
        }
        for key in &shape.mutable_keys {
            insert_sorted(&mut result.mutable_keys, key.clone());
        }
        result.complete_key_set &= shape.complete_key_set && previous_keys == shape.known_keys;
        result.dynamic_access |= shape.dynamic_access;
        result.has_spread |= shape.has_spread;
        result.escapes |= shape.escapes;
        result.array_length = if result.array_length == shape.array_length {
            result.array_length
        } else {
            None
        };
    }
    result
}

fn unknown_shape(source: ShapeSource) -> ValueShape {
    ValueShape {
        kind: ShapeKind::Unknown,
        source,
        known_keys: Vec::new(),
        mutable_keys: Vec::new(),
        complete_key_set: false,
        dynamic_access: false,
        has_spread: false,
        escapes: false,
        array_length: None,
    }
}

fn static_shape_key(segment: &DependencySegment) -> Option<ShapeKey> {
    match segment {
        DependencySegment::Static { name, .. } => Some(ShapeKey::Static(name.clone())),
        DependencySegment::Index { index, .. } => Some(ShapeKey::Index(*index)),
        DependencySegment::Dynamic { .. } => None,
    }
}

fn insert_sorted<T: Ord>(values: &mut Vec<T>, value: T) {
    match values.binary_search(&value) {
        Ok(_) => {}
        Err(index) => values.insert(index, value),
    }
}

fn place_local(base: PlaceBase) -> Option<fict_hir::LocalId> {
    match base {
        PlaceBase::Local(local) => Some(local),
        PlaceBase::Ssa(name) => Some(name.local),
        PlaceBase::Value(_) => None,
    }
}

fn shape_error(code: &'static str, message: impl Into<String>) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("shape diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_guarantee_class(GuaranteeClass::Internal)
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
