use std::collections::{BTreeMap, BTreeSet, VecDeque};
#[rustfmt::skip] use oxc::{allocator::Vec as ArenaVec, ast::ast::{ObjectPropertyKind as OxcObjectPropertyKind, PropertyKey as OxcPropertyKey, *}, ast_visit::{Visit, walk::*}, semantic::Scoping, span::{GetSpan, Span}, syntax::{operator::{AssignmentOperator as OxcAssignmentOperator, UnaryOperator as OxcUnaryOperator}, scope::ScopeFlags, symbol::SymbolId}};
#[rustfmt::skip]
use super::{PlannedPlaceBase, StaticAliasPath, class_guaranteed_returned_object, class_preserves_instance_prototype, direct_array_push_call_receiver, direct_mutating_array_call_receiver, identifier_symbol, planned_assignment_target_place, planned_expression_place, planned_simple_assignment_target_place, prototype_sensitive_invalidation_paths, static_alias_invalidation_path, static_alias_path_from_place, static_alias_source_path, static_from_entries_pairs, static_json_replacer_global_item, static_member_name, unwrap_transparent_call_expression};
pub(super) struct ExecutionStateFacts {
    pub(super) discarded_invocation_spans: BTreeSet<(u32, u32)>,
    pub(super) unexecuted_body_spans: BTreeSet<(u32, u32)>,
    pub(super) unexecuted_callable_spans: BTreeSet<(u32, u32)>,
    pub(super) unexecuted_callable_paths: BTreeSet<StaticAliasPath>,
    pub(super) merely_observed_callable_paths: BTreeSet<StaticAliasPath>,
    pub(super) returned_callable_spans: BTreeSet<(u32, u32)>,
    pub(super) precisely_advanced_generator_paths: BTreeSet<StaticAliasPath>,
    pub(super) precise_generator_advance_indices: BTreeMap<(u32, u32), usize>,
}
pub(super) fn analyze_execution_state<'ast>(
    scoping: &Scoping,
    known_arrays: &BTreeSet<SymbolId>,
    exclusive_json_replacer_arrays: &BTreeSet<SymbolId>,
    program: &Program<'ast>,
) -> ExecutionStateFacts {
    let mut collector = ExecutionStateCollector::new(
        scoping,
        known_arrays,
        exclusive_json_replacer_arrays,
        program.source_type.is_module(),
    );
    collector.visit_program(program);
    collector.finish()
}

#[derive(Default)]
struct ReturnedCallableDefinition {
    spans: BTreeSet<(u32, u32)>,
    value_sources: BTreeSet<StaticAliasPath>,
    result_sources: BTreeSet<StaticAliasPath>,
}

struct ReturnedCallableDefinitionCollector<'semantic> {
    scoping: &'semantic Scoping,
    definition: ReturnedCallableDefinition,
}

impl<'semantic> ReturnedCallableDefinitionCollector<'semantic> {
    fn new(scoping: &'semantic Scoping) -> Self {
        Self {
            scoping,
            definition: ReturnedCallableDefinition::default(),
        }
    }

    fn collect_expression(&mut self, expression: &Expression<'_>) {
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                self.definition
                    .spans
                    .insert((function.span.start, function.span.end));
            }
            Expression::ArrowFunctionExpression(function) => {
                self.definition
                    .spans
                    .insert((function.span.start, function.span.end));
            }
            Expression::ConditionalExpression(expression) => {
                self.collect_expression(&expression.consequent);
                self.collect_expression(&expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.collect_expression(&expression.left);
                self.collect_expression(&expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.collect_expression(expression);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.collect_expression(&expression.right);
            }
            Expression::CallExpression(call) => {
                let bound = match unwrap_transparent_call_expression(&call.callee) {
                    Expression::StaticMemberExpression(member)
                        if member.property.name == "bind" =>
                    {
                        Some(&member.object)
                    }
                    Expression::ComputedMemberExpression(member)
                        if static_member_name(&member.expression).as_deref() == Some("bind") =>
                    {
                        Some(&member.object)
                    }
                    _ => None,
                };
                if let Some(bound) = bound {
                    self.collect_expression(bound);
                } else if let Some(source) = static_alias_source_path(self.scoping, &call.callee) {
                    self.definition.result_sources.insert(source);
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property) => {
                            if matches!(
                                property.value.get_inner_expression(),
                                Expression::ObjectExpression(_) | Expression::ArrayExpression(_)
                            ) {
                                self.collect_expression(&property.value);
                            }
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread) => {
                            self.collect_expression(&spread.argument);
                        }
                    }
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.collect_expression(&spread.argument);
                        }
                        element
                            if matches!(
                                element.to_expression().get_inner_expression(),
                                Expression::ObjectExpression(_) | Expression::ArrayExpression(_)
                            ) =>
                        {
                            self.collect_expression(element.to_expression());
                        }
                        _ => {}
                    }
                }
            }
            _ => {
                if let Some(source) = static_alias_source_path(self.scoping, expression) {
                    self.definition.value_sources.insert(source);
                }
            }
        }
    }
}

impl<'a> Visit<'a> for ReturnedCallableDefinitionCollector<'_> {
    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.collect_expression(argument);
        }
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_class(&mut self, _class: &Class<'a>) {}
}

struct ReturnedGeneratorBodyCollector<'semantic> {
    scoping: &'semantic Scoping,
    spans: BTreeSet<GeneratorBodySpan>,
    sources: BTreeSet<StaticAliasPath>,
}

impl<'semantic> ReturnedGeneratorBodyCollector<'semantic> {
    fn new(scoping: &'semantic Scoping) -> Self {
        Self {
            scoping,
            spans: BTreeSet::new(),
            sources: BTreeSet::new(),
        }
    }

    fn collect_expression(&mut self, expression: &Expression<'_>) {
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                if let Some(body) = ExecutionStateCollector::generator_body_span(function) {
                    self.spans.insert(body);
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.collect_expression(&expression.consequent);
                self.collect_expression(&expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.collect_expression(&expression.left);
                self.collect_expression(&expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.collect_expression(expression);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.collect_expression(&expression.right);
            }
            Expression::CallExpression(call) => {
                let bound = match unwrap_transparent_call_expression(&call.callee) {
                    Expression::StaticMemberExpression(member)
                        if member.property.name == "bind" =>
                    {
                        Some(&member.object)
                    }
                    Expression::ComputedMemberExpression(member)
                        if static_member_name(&member.expression).as_deref() == Some("bind") =>
                    {
                        Some(&member.object)
                    }
                    _ => None,
                };
                if let Some(bound) = bound {
                    self.collect_expression(bound);
                } else if let Some(source) = static_alias_source_path(self.scoping, &call.callee) {
                    self.sources.insert(source);
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property) => {
                            if matches!(
                                property.value.get_inner_expression(),
                                Expression::ObjectExpression(_) | Expression::ArrayExpression(_)
                            ) {
                                self.collect_expression(&property.value);
                            }
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread) => {
                            self.collect_expression(&spread.argument);
                        }
                    }
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.collect_expression(&spread.argument);
                        }
                        element
                            if matches!(
                                element.to_expression().get_inner_expression(),
                                Expression::ObjectExpression(_) | Expression::ArrayExpression(_)
                            ) =>
                        {
                            self.collect_expression(element.to_expression());
                        }
                        _ => {}
                    }
                }
            }
            _ => {
                if let Some(source) = static_alias_source_path(self.scoping, expression) {
                    self.sources.insert(source);
                }
            }
        }
    }
}

impl<'a> Visit<'a> for ReturnedGeneratorBodyCollector<'_> {
    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.collect_expression(argument);
        }
    }

    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {}

    fn visit_class(&mut self, _class: &Class<'a>) {}
}

struct ForwardedCallableRead {
    source: StaticAliasPath,
    source_span: (u32, u32),
    target: StaticAliasPath,
    method_guard: Option<GeneratorMethodGuard>,
    parameter_offset: Option<usize>,
}
struct GeneratorBodyArgumentRead {
    source: StaticAliasPath,
    source_span: (u32, u32),
    body_spans: BTreeSet<GeneratorBodySpan>,
    method_guard: Option<GeneratorMethodGuard>,
}
struct CompositeGuardedRead {
    source: StaticAliasPath,
    source_span: (u32, u32),
    target: Option<StaticAliasPath>,
    method_guards: Vec<GeneratorMethodGuard>,
    terminal_alias: Option<TerminalAliasGuard>,
}

#[derive(Clone)]
struct NonConsumingParameters {
    fixed: BTreeMap<usize, bool>,
    safe_tail_start: Option<usize>,
}

impl NonConsumingParameters {
    fn returned(&self, index: usize) -> Option<bool> {
        self.fixed.get(&index).copied().or_else(|| {
            self.safe_tail_start
                .is_some_and(|start| index >= start)
                .then_some(false)
        })
    }

    fn shifted(&self, offset: usize) -> Self {
        Self {
            fixed: self
                .fixed
                .iter()
                .filter_map(|(index, returned)| {
                    index.checked_sub(offset).map(|index| (index, *returned))
                })
                .collect(),
            safe_tail_start: self
                .safe_tail_start
                .map(|start| start.saturating_sub(offset)),
        }
    }

    fn intersect(&self, alternate: &Self) -> Self {
        let safe_tail_start = self
            .safe_tail_start
            .zip(alternate.safe_tail_start)
            .map(|(left, right)| left.max(right));
        let indices = self
            .fixed
            .keys()
            .chain(alternate.fixed.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        let fixed = indices
            .into_iter()
            .filter_map(|index| {
                let returned = self.returned(index)? | alternate.returned(index)?;
                (!safe_tail_start.is_some_and(|start| index >= start)).then_some((index, returned))
            })
            .collect();
        Self {
            fixed,
            safe_tail_start,
        }
    }

    fn all_non_consuming(&self, result_discarded: bool) -> bool {
        let Some(tail_start) = self.safe_tail_start else {
            return false;
        };
        (0..tail_start).all(|index| {
            self.returned(index)
                .is_some_and(|returned| !returned || result_discarded)
        })
    }
}

#[derive(Clone)]
struct TerminalAliasGuard {
    aliases: Vec<StaticAliasPath>,
    method: &'static str,
}
enum PendingCallableArgumentValue {
    Reference {
        source: StaticAliasPath,
        source_span: (u32, u32),
    },
    Invocations(PendingDiscardedInvocations),
}
enum PendingNonExecutingAction {
    CallableRead {
        source: StaticAliasPath,
        source_span: (u32, u32),
        method_guard: Option<GeneratorMethodGuard>,
    },
    BodySpan {
        body_span: GeneratorBodySpan,
        method_guard: Option<GeneratorMethodGuard>,
    },
}

#[derive(Default)]
struct PendingDiscardedInvocations {
    invocation_spans: BTreeSet<(u32, u32)>,
    nonexecuting_actions: Vec<PendingNonExecutingAction>,
}

struct RetainedInvocationSpans {
    target: StaticAliasPath,
    invocation_spans: BTreeSet<(u32, u32)>,
}
#[derive(Clone, Copy)]
enum PendingParameterSelection {
    Index(usize),
    All,
}

#[derive(Clone)]
enum PendingParameterSource {
    Local {
        source: StaticAliasPath,
        parameter_offset: usize,
        method_guards: Vec<GeneratorMethodGuard>,
    },
    Inline {
        parameters: NonConsumingParameters,
        parameter_offset: usize,
        method_guards: Vec<GeneratorMethodGuard>,
    },
}

#[derive(Clone, Copy)]
enum PendingInvocationParameters<'a> {
    Local(&'a StaticAliasPath),
    Inline(&'a NonConsumingParameters),
    Sources(&'a [PendingParameterSource]),
}
struct PendingCallableArgumentRead {
    value: PendingCallableArgumentValue,
    parameter_sources: Option<Vec<PendingParameterSource>>,
    parameter_selection: PendingParameterSelection,
    result_discarded: bool,
    method_guard: Option<GeneratorMethodGuard>,
}
struct GuardedLocalNonConsumingParameters {
    target: StaticAliasPath,
    parameters: NonConsumingParameters,
    method_guards: Vec<GeneratorMethodGuard>,
}
struct DirectInlineBoundParameters {
    source_parameters: NonConsumingParameters,
    parameters: NonConsumingParameters,
    guard: GeneratorMethodGuard,
    method_guards: Vec<GeneratorMethodGuard>,
}
struct InitialGeneratorNextArgumentRead {
    source: StaticAliasPath,
    source_span: (u32, u32),
    iterator: StaticAliasPath,
    iterator_span: (u32, u32),
}
struct DirectGeneratorAdvance {
    source: StaticAliasPath,
    source_span: (u32, u32),
    call_span: (u32, u32),
    method_guard: GeneratorMethodGuard,
}

struct NonConsumingParameterCollector<'semantic> {
    scoping: &'semantic Scoping,
    parameter_indices: BTreeMap<SymbolId, usize>,
    returned: BTreeSet<usize>,
    unsafe_uses: BTreeSet<usize>,
    discarded_invocation_callees: BTreeSet<(u32, u32)>,
    dynamic_arguments: bool,
    nested_function_depth: usize,
}

impl NonConsumingParameterCollector<'_> {
    fn direct_parameter_index(&self, expression: &Expression<'_>) -> Option<usize> {
        let Expression::Identifier(identifier) = unwrap_transparent_call_expression(expression)
        else {
            return None;
        };
        let symbol = identifier
            .reference_id
            .get()
            .and_then(|reference| self.scoping.get_reference(reference).symbol_id())?;
        self.parameter_indices.get(&symbol).copied()
    }

    fn is_direct_eval_callee(&self, expression: &Expression<'_>) -> bool {
        match expression {
            Expression::Identifier(_) => static_alias_source_path(self.scoping, expression)
                .is_some_and(|path| path == StaticAliasPath::unresolved_global("eval".to_string())),
            Expression::ParenthesizedExpression(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            Expression::TSAsExpression(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            Expression::TSSatisfiesExpression(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            Expression::TSTypeAssertion(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            Expression::TSNonNullExpression(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            Expression::TSInstantiationExpression(expression) => {
                self.is_direct_eval_callee(&expression.expression)
            }
            _ => false,
        }
    }

    fn direct_parameter_invocation(
        &self,
        expression: &Expression<'_>,
    ) -> Option<(usize, (u32, u32))> {
        let Expression::CallExpression(call) = expression.get_inner_expression() else {
            return None;
        };
        let index = self.direct_parameter_index(&call.callee)?;
        let Expression::Identifier(identifier) = unwrap_transparent_call_expression(&call.callee)
        else {
            return None;
        };
        Some((index, (identifier.span.start, identifier.span.end)))
    }

    fn record_parameter_invocation(&mut self, expression: &Expression<'_>, returned: bool) -> bool {
        let Some((index, callee_span)) = self.direct_parameter_invocation(expression) else {
            return false;
        };
        self.discarded_invocation_callees.insert(callee_span);
        if returned {
            self.returned.insert(index);
        }
        true
    }
}

impl<'a> Visit<'a> for NonConsumingParameterCollector<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.is_direct_eval_callee(&call.callee) {
            self.dynamic_arguments = true;
            self.unsafe_uses
                .extend(self.parameter_indices.values().copied());
        }
        walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        if self
            .discarded_invocation_callees
            .contains(&(identifier.span.start, identifier.span.end))
        {
            return;
        }
        let Some(reference) = identifier
            .reference_id
            .get()
            .map(|reference| self.scoping.get_reference(reference))
        else {
            return;
        };
        if identifier.name == "arguments" && reference.symbol_id().is_none() {
            self.dynamic_arguments = true;
            self.unsafe_uses
                .extend(self.parameter_indices.values().copied());
        }
        let Some(index) = reference
            .symbol_id()
            .and_then(|symbol| self.parameter_indices.get(&symbol))
            .copied()
        else {
            return;
        };
        self.unsafe_uses.insert(index);
    }

    fn visit_expression_statement(&mut self, statement: &ExpressionStatement<'a>) {
        if self.nested_function_depth == 0 {
            self.record_parameter_invocation(&statement.expression, false);
        }
        walk_expression_statement(self, statement);
    }

    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if self.nested_function_depth == 0 && expression.operator == OxcUnaryOperator::Void {
            if self.direct_parameter_index(&expression.argument).is_some() {
                return;
            }
            self.record_parameter_invocation(&expression.argument, false);
        }
        oxc::ast_visit::walk::walk_unary_expression(self, expression);
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if self.nested_function_depth == 0
            && let Some(index) = statement
                .argument
                .as_ref()
                .and_then(|argument| self.direct_parameter_index(argument))
        {
            self.returned.insert(index);
            return;
        }
        if self.nested_function_depth == 0
            && statement
                .argument
                .as_ref()
                .is_some_and(|argument| self.record_parameter_invocation(argument, true))
        {
            walk_return_statement(self, statement);
            return;
        }
        walk_return_statement(self, statement);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        self.nested_function_depth += 1;
        walk_function(self, function, flags);
        self.nested_function_depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        self.nested_function_depth += 1;
        walk_arrow_function_expression(self, function);
        self.nested_function_depth -= 1;
    }
}

#[derive(Clone)]
struct GeneratorMethodGuard {
    source: Option<StaticAliasPath>,
    owner: StaticAliasPath,
    method: &'static str,
}
struct StoredStaticFromEntriesValues {
    source: StaticAliasPath,
    source_span: (u32, u32),
    values: BTreeMap<String, StaticAliasPath>,
}
struct StoredObjectEntriesRoundTrip {
    container: StaticAliasPath,
    container_span: (u32, u32),
    source: StaticAliasPath,
}
enum ObjectDestructuringCandidate<'a> {
    Expression(&'a Expression<'a>),
    Stored {
        source: StaticAliasPath,
        source_span: (u32, u32),
    },
}
enum EitherAssignmentBinding<'a, 'ast> {
    Identifier(&'a IdentifierReference<'ast>),
    Target(&'a AssignmentTargetMaybeDefault<'ast>),
}
enum GeneratorBindForwarding {
    Source {
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: GeneratorMethodGuard,
    },
    Inline {
        body_span: GeneratorBodySpan,
        guard: GeneratorMethodGuard,
    },
}
#[derive(Clone, Copy)]
enum RetainedCallableReadKind {
    Bind,
    Container,
    GeneratorInvocation,
}

type GeneratorBodySpan = (u32, u32);
type InstanceGeneratorBodies = BTreeMap<String, BTreeSet<GeneratorBodySpan>>;
struct ExecutionStateCollector<'semantic> {
    scoping: &'semantic Scoping,
    known_arrays: &'semantic BTreeSet<SymbolId>,
    exclusive_json_replacer_arrays: &'semantic BTreeSet<SymbolId>,
    strict_program: bool,
    binding_reads: BTreeMap<SymbolId, BTreeSet<(u32, u32)>>,
    callable_targets_by_span: BTreeMap<(u32, u32), BTreeSet<StaticAliasPath>>,
    returned_callable_definitions_by_span: BTreeMap<(u32, u32), ReturnedCallableDefinition>,
    returned_callable_result_forwardings: Vec<(StaticAliasPath, StaticAliasPath)>,
    read_callable_owner_spans: BTreeMap<(u32, u32), Vec<(u32, u32)>>,
    callable_owner_spans: Vec<(u32, u32)>,
    function_depth: usize,
    direct_callable_reads: BTreeMap<StaticAliasPath, BTreeSet<(u32, u32)>>,
    discarded_invocation_reads: BTreeMap<StaticAliasPath, BTreeSet<(u32, u32)>>,
    discarded_value_reads: BTreeMap<StaticAliasPath, BTreeSet<(u32, u32)>>,
    merely_observed_value_reads: BTreeMap<StaticAliasPath, BTreeSet<(u32, u32)>>,
    forwarded_callable_reads: Vec<ForwardedCallableRead>,
    retained_callable_reads: Vec<ForwardedCallableRead>,
    generator_argument_reads: Vec<ForwardedCallableRead>,
    generator_body_argument_reads: Vec<GeneratorBodyArgumentRead>,
    assigned_generator_result_reads: Vec<ForwardedCallableRead>,
    generator_result_reads: Vec<ForwardedCallableRead>,
    terminal_method_alias_reads: Vec<ForwardedCallableRead>,
    local_non_consuming_parameters: BTreeMap<StaticAliasPath, NonConsumingParameters>,
    guarded_local_non_consuming_parameters: Vec<GuardedLocalNonConsumingParameters>,
    pending_callable_argument_reads: Vec<PendingCallableArgumentRead>,
    initial_generator_next_argument_reads: Vec<InitialGeneratorNextArgumentRead>,
    direct_generator_advances: Vec<DirectGeneratorAdvance>,
    forwarding_targets: BTreeSet<StaticAliasPath>,
    generator_body_targets: Vec<(GeneratorBodySpan, StaticAliasPath)>,
    returned_generator_body_spans: BTreeMap<StaticAliasPath, BTreeSet<GeneratorBodySpan>>,
    generator_callable_targets: BTreeSet<StaticAliasPath>,
    non_generator_callable_targets: BTreeSet<StaticAliasPath>,
    class_instance_generator_bodies: BTreeMap<StaticAliasPath, InstanceGeneratorBodies>,
    instance_generator_bodies: BTreeMap<StaticAliasPath, InstanceGeneratorBodies>,
    member_invalidated: BTreeSet<StaticAliasPath>,
    escaped_callable_paths: BTreeSet<StaticAliasPath>,
    guarded_generator_targets: Vec<(StaticAliasPath, GeneratorMethodGuard)>,
    guarded_discarded_invocation_reads: Vec<(StaticAliasPath, (u32, u32), GeneratorMethodGuard)>,
    composite_guarded_reads: Vec<CompositeGuardedRead>,
    non_escaping_callable_reads: BTreeSet<(StaticAliasPath, (u32, u32))>,
    guarded_unexecuted_body_spans: Vec<(GeneratorBodySpan, GeneratorMethodGuard)>,
    directly_unexecuted_body_spans: BTreeSet<(u32, u32)>,
    retained_invocation_spans: Vec<RetainedInvocationSpans>,
    discarded_invocation_spans: BTreeSet<(u32, u32)>,
    non_retaining_object_value_enumeration_calls: BTreeSet<(u32, u32)>,
    explicitly_merely_observed_callable_paths: BTreeSet<StaticAliasPath>,
    static_from_entries_sources: BTreeMap<StaticAliasPath, BTreeMap<String, StaticAliasPath>>,
    static_object_entries_sources: BTreeMap<StaticAliasPath, StaticAliasPath>,
    static_json_replacer_arrays: BTreeMap<StaticAliasPath, usize>,
    non_consuming_json_replacer_pushes: BTreeMap<(u32, u32), GeneratorMethodGuard>,
    json_serialized_value_paths: BTreeSet<StaticAliasPath>,
    directly_unexecuted_callable_spans: BTreeSet<(u32, u32)>,
}

impl<'semantic> ExecutionStateCollector<'semantic> {
    fn new(
        scoping: &'semantic Scoping,
        known_arrays: &'semantic BTreeSet<SymbolId>,
        exclusive_json_replacer_arrays: &'semantic BTreeSet<SymbolId>,
        strict_program: bool,
    ) -> Self {
        Self {
            scoping,
            known_arrays,
            exclusive_json_replacer_arrays,
            strict_program,
            binding_reads: BTreeMap::new(),
            callable_targets_by_span: BTreeMap::new(),
            returned_callable_definitions_by_span: BTreeMap::new(),
            returned_callable_result_forwardings: Vec::new(),
            read_callable_owner_spans: BTreeMap::new(),
            callable_owner_spans: Vec::new(),
            function_depth: 0,
            direct_callable_reads: BTreeMap::new(),
            discarded_invocation_reads: BTreeMap::new(),
            discarded_value_reads: BTreeMap::new(),
            merely_observed_value_reads: BTreeMap::new(),
            forwarded_callable_reads: Vec::new(),
            retained_callable_reads: Vec::new(),
            generator_argument_reads: Vec::new(),
            generator_body_argument_reads: Vec::new(),
            assigned_generator_result_reads: Vec::new(),
            generator_result_reads: Vec::new(),
            terminal_method_alias_reads: Vec::new(),
            local_non_consuming_parameters: BTreeMap::new(),
            guarded_local_non_consuming_parameters: Vec::new(),
            pending_callable_argument_reads: Vec::new(),
            initial_generator_next_argument_reads: Vec::new(),
            direct_generator_advances: Vec::new(),
            forwarding_targets: BTreeSet::new(),
            generator_body_targets: Vec::new(),
            returned_generator_body_spans: BTreeMap::new(),
            generator_callable_targets: BTreeSet::new(),
            non_generator_callable_targets: BTreeSet::new(),
            class_instance_generator_bodies: BTreeMap::new(),
            instance_generator_bodies: BTreeMap::new(),
            member_invalidated: BTreeSet::new(),
            escaped_callable_paths: BTreeSet::new(),
            guarded_generator_targets: Vec::new(),
            guarded_discarded_invocation_reads: Vec::new(),
            composite_guarded_reads: Vec::new(),
            non_escaping_callable_reads: BTreeSet::new(),
            guarded_unexecuted_body_spans: Vec::new(),
            directly_unexecuted_body_spans: BTreeSet::new(),
            retained_invocation_spans: Vec::new(),
            discarded_invocation_spans: BTreeSet::new(),
            non_retaining_object_value_enumeration_calls: BTreeSet::new(),
            explicitly_merely_observed_callable_paths: BTreeSet::new(),
            static_from_entries_sources: BTreeMap::new(),
            static_object_entries_sources: BTreeMap::new(),
            static_json_replacer_arrays: BTreeMap::new(),
            non_consuming_json_replacer_pushes: BTreeMap::new(),
            json_serialized_value_paths: BTreeSet::new(),
            directly_unexecuted_callable_spans: BTreeSet::new(),
        }
    }

    fn callable_reference(
        &self,
        expression: &Expression<'_>,
    ) -> Option<(StaticAliasPath, (u32, u32))> {
        if let Some(path) = static_alias_source_path(self.scoping, expression) {
            return Some((path, Self::root_identifier_span(expression)?));
        }
        let expression = unwrap_transparent_call_expression(expression);
        let place = planned_expression_place(self.scoping, expression)?;
        let path = static_alias_path_from_place(&place, true)?;
        let span = place.root_reference_span?;
        Some((path, (span.start(), span.end())))
    }

    fn record_callable_target_span(&mut self, target: StaticAliasPath, span: Span) {
        self.callable_targets_by_span
            .entry((span.start, span.end))
            .or_default()
            .insert(target);
    }

    fn record_merely_observed_value_read(
        &mut self,
        source: StaticAliasPath,
        source_span: (u32, u32),
    ) {
        self.discarded_value_reads
            .entry(source.clone())
            .or_default()
            .insert(source_span);
        self.merely_observed_value_reads
            .entry(source)
            .or_default()
            .insert(source_span);
    }

    fn replace_callable_path_prefix(
        path: &StaticAliasPath,
        source: &StaticAliasPath,
        target: &StaticAliasPath,
    ) -> Option<StaticAliasPath> {
        if !path.starts_with(source) {
            return None;
        }
        let mut forwarded = target.clone();
        forwarded
            .properties
            .extend_from_slice(&path.properties[source.properties.len()..]);
        forwarded.element_wildcard |= path.element_wildcard;
        Some(forwarded.canonicalized())
    }

    fn read_is_owned_by_merely_observed_callable(
        &self,
        span: &(u32, u32),
        merely_observed: &BTreeSet<StaticAliasPath>,
    ) -> bool {
        self.read_callable_owner_spans
            .get(span)
            .into_iter()
            .flatten()
            .any(|owner| {
                self.callable_targets_by_span
                    .get(owner)
                    .is_some_and(|targets| {
                        !targets.is_empty()
                            && targets
                                .iter()
                                .all(|target| merely_observed.contains(target))
                    })
            })
    }

    fn record_returned_callable_definition(
        &mut self,
        span: Span,
        definition: ReturnedCallableDefinition,
    ) {
        if definition.spans.is_empty()
            && definition.value_sources.is_empty()
            && definition.result_sources.is_empty()
        {
            return;
        }
        self.returned_callable_definitions_by_span
            .insert((span.start, span.end), definition);
    }

    fn returned_callable_definition_from_function(
        &self,
        function: &Function<'_>,
    ) -> Option<ReturnedCallableDefinition> {
        if function.generator || function.r#async {
            return None;
        }
        let body = function.body.as_ref()?;
        let mut collector = ReturnedCallableDefinitionCollector::new(self.scoping);
        collector.visit_function_body(body);
        Some(collector.definition)
    }

    fn returned_callable_definition_from_arrow(
        &self,
        function: &ArrowFunctionExpression<'_>,
    ) -> Option<ReturnedCallableDefinition> {
        if function.r#async {
            return None;
        }
        let mut collector = ReturnedCallableDefinitionCollector::new(self.scoping);
        if let Some(expression) = function.get_expression() {
            collector.collect_expression(expression);
        } else {
            collector.visit_function_body(&function.body);
        }
        Some(collector.definition)
    }

    fn callable_invocation_source(&self, call: &CallExpression<'_>) -> Option<StaticAliasPath> {
        let reflect_apply = StaticAliasPath::unresolved_global("Reflect".to_string())
            .with_property("apply".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect_apply)
        {
            return call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|target| static_alias_source_path(self.scoping, target));
        }
        match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member)
                if matches!(member.property.name.as_str(), "call" | "apply") =>
            {
                static_alias_source_path(self.scoping, &member.object)
            }
            Expression::ComputedMemberExpression(member)
                if static_member_name(&member.expression)
                    .is_some_and(|method| matches!(method.as_str(), "call" | "apply")) =>
            {
                static_alias_source_path(self.scoping, &member.object)
            }
            _ => static_alias_source_path(self.scoping, &call.callee),
        }
    }

    fn collect_returned_callable_result_sources(
        &self,
        expression: &Expression<'_>,
        sources: &mut BTreeSet<StaticAliasPath>,
    ) {
        match expression.get_inner_expression() {
            Expression::CallExpression(call) => {
                let bound = match unwrap_transparent_call_expression(&call.callee) {
                    Expression::StaticMemberExpression(member)
                        if member.property.name == "bind" =>
                    {
                        Some(&member.object)
                    }
                    Expression::ComputedMemberExpression(member)
                        if static_member_name(&member.expression).as_deref() == Some("bind") =>
                    {
                        Some(&member.object)
                    }
                    _ => None,
                };
                if let Some(bound) = bound {
                    self.collect_returned_callable_result_sources(bound, sources);
                } else if let Some(source) = self.callable_invocation_source(call) {
                    sources.insert(source);
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.collect_returned_callable_result_sources(&expression.consequent, sources);
                self.collect_returned_callable_result_sources(&expression.alternate, sources);
            }
            Expression::LogicalExpression(expression) => {
                self.collect_returned_callable_result_sources(&expression.left, sources);
                self.collect_returned_callable_result_sources(&expression.right, sources);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.collect_returned_callable_result_sources(expression, sources);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.collect_returned_callable_result_sources(&expression.right, sources);
            }
            _ => {}
        }
    }

    fn record_returned_callable_result_initializer(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let mut sources = BTreeSet::new();
        self.collect_returned_callable_result_sources(initializer, &mut sources);
        self.returned_callable_result_forwardings
            .extend(sources.into_iter().map(|source| (target.clone(), source)));
    }

    fn propagate_callable_target_spans(
        &mut self,
        trusted_method_forwardings: &[bool],
    ) -> (BTreeSet<StaticAliasPath>, BTreeSet<(u32, u32)>) {
        let mut spans_by_target = BTreeMap::<StaticAliasPath, BTreeSet<(u32, u32)>>::new();
        for (span, targets) in &self.callable_targets_by_span {
            for target in targets {
                spans_by_target
                    .entry(target.clone())
                    .or_default()
                    .insert(*span);
            }
        }
        let mut returned_spans_by_callable = BTreeMap::<_, BTreeSet<_>>::new();
        loop {
            let mut changed = false;
            for (index, forwarding) in self.forwarded_callable_reads.iter().enumerate() {
                if !trusted_method_forwardings[index] {
                    continue;
                }
                let forwardings = spans_by_target
                    .iter()
                    .filter_map(|(source, spans)| {
                        Self::replace_callable_path_prefix(
                            source,
                            &forwarding.source,
                            &forwarding.target,
                        )
                        .map(|target| (target, spans.clone()))
                    })
                    .collect::<Vec<_>>();
                for (target, spans) in forwardings {
                    let target_spans = spans_by_target.entry(target).or_default();
                    let before = target_spans.len();
                    target_spans.extend(spans);
                    changed |= target_spans.len() != before;
                }
            }
            for (span, definition) in &self.returned_callable_definitions_by_span {
                let mut returned = definition.spans.clone();
                for source in &definition.value_sources {
                    returned.extend(
                        spans_by_target
                            .iter()
                            .filter(|(target, _)| target.starts_with(source))
                            .flat_map(|(_, spans)| spans.iter().copied()),
                    );
                }
                for source in &definition.result_sources {
                    for source_span in spans_by_target.get(source).into_iter().flatten() {
                        returned.extend(
                            returned_spans_by_callable
                                .get(source_span)
                                .into_iter()
                                .flatten()
                                .copied(),
                        );
                    }
                }
                let target_spans = returned_spans_by_callable.entry(*span).or_default();
                let before = target_spans.len();
                target_spans.extend(returned);
                changed |= target_spans.len() != before;
            }
            for (target, source) in &self.returned_callable_result_forwardings {
                let mut returned = BTreeSet::new();
                for source_span in spans_by_target.get(source).into_iter().flatten() {
                    returned.extend(
                        returned_spans_by_callable
                            .get(source_span)
                            .into_iter()
                            .flatten()
                            .copied(),
                    );
                }
                let target_spans = spans_by_target.entry(target.clone()).or_default();
                let before = target_spans.len();
                target_spans.extend(returned);
                changed |= target_spans.len() != before;
            }
            if !changed {
                break;
            }
        }
        for (target, spans) in &spans_by_target {
            for span in spans {
                self.callable_targets_by_span
                    .entry(*span)
                    .or_default()
                    .insert(target.clone());
            }
        }
        let mut returned_callable_spans = returned_spans_by_callable
            .into_values()
            .flatten()
            .collect::<BTreeSet<_>>();
        loop {
            let mut additions = BTreeSet::new();
            for (target, invocation_spans) in self
                .direct_callable_reads
                .iter()
                .chain(&self.discarded_invocation_reads)
            {
                let owned_by_returned_callable = invocation_spans.iter().any(|invocation_span| {
                    self.read_callable_owner_spans
                        .iter()
                        .any(|(read_span, owners)| {
                            invocation_span.0 <= read_span.0
                                && read_span.1 <= invocation_span.1
                                && owners
                                    .iter()
                                    .any(|owner| returned_callable_spans.contains(owner))
                        })
                });
                if owned_by_returned_callable {
                    additions.extend(spans_by_target.get(target).into_iter().flatten().copied());
                }
            }
            let before = returned_callable_spans.len();
            returned_callable_spans.extend(additions);
            if returned_callable_spans.len() == before {
                break;
            }
        }
        (
            spans_by_target.into_keys().collect(),
            returned_callable_spans,
        )
    }

    fn generator_bind_target_forwardings(
        &self,
        expression: &Expression<'_>,
    ) -> Option<Vec<GeneratorBindForwarding>> {
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                let mut forwardings =
                    self.generator_bind_target_forwardings(&expression.consequent)?;
                forwardings.extend(self.generator_bind_target_forwardings(&expression.alternate)?);
                return Some(forwardings);
            }
            Expression::LogicalExpression(expression) => {
                let mut forwardings = self.generator_bind_target_forwardings(&expression.left)?;
                forwardings.extend(self.generator_bind_target_forwardings(&expression.right)?);
                return Some(forwardings);
            }
            Expression::SequenceExpression(expression) => {
                return self.generator_bind_target_forwardings(expression.expressions.last()?);
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                return self.generator_bind_target_forwardings(&expression.right);
            }
            _ => {}
        }
        let owner = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        if let Some((source, source_span)) = self.callable_reference(expression) {
            return Some(vec![GeneratorBindForwarding::Source {
                guard: GeneratorMethodGuard {
                    source: Some(source.clone()),
                    owner,
                    method: "bind",
                },
                source,
                source_span,
            }]);
        }
        let Expression::FunctionExpression(function) = expression.get_inner_expression() else {
            return None;
        };
        Some(vec![GeneratorBindForwarding::Inline {
            body_span: Self::generator_body_span(function)?,
            guard: GeneratorMethodGuard {
                source: None,
                owner,
                method: "bind",
            },
        }])
    }

    fn generator_bind_forwardings(
        &self,
        expression: &Expression<'_>,
    ) -> Option<Vec<GeneratorBindForwarding>> {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return None,
            },
            _ => return None,
        };
        let object = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) if member.property.name == "bind" => {
                &member.object
            }
            Expression::ComputedMemberExpression(member)
                if static_member_name(&member.expression).as_deref() == Some("bind") =>
            {
                &member.object
            }
            _ => return None,
        };
        self.generator_bind_target_forwardings(object)
    }

    fn record_escaped_callable_path(&mut self, expression: &Expression<'_>) {
        if let Some((path, _)) = self.callable_reference(expression) {
            self.escaped_callable_paths.insert(path);
        }
    }

    fn root_identifier_span(expression: &Expression<'_>) -> Option<(u32, u32)> {
        match unwrap_transparent_call_expression(expression) {
            Expression::Identifier(identifier) => {
                Some((identifier.span.start, identifier.span.end))
            }
            Expression::StaticMemberExpression(member) => {
                Self::root_identifier_span(&member.object)
            }
            Expression::ComputedMemberExpression(member) => {
                Self::root_identifier_span(&member.object)
            }
            Expression::PrivateFieldExpression(member) => {
                Self::root_identifier_span(&member.object)
            }
            _ => None,
        }
    }

    fn assignment_target_path(
        &self,
        assignment: &AssignmentExpression<'_>,
    ) -> Option<StaticAliasPath> {
        if assignment.operator != OxcAssignmentOperator::Assign {
            return None;
        }
        planned_assignment_target_place(self.scoping, &assignment.left)
            .as_ref()
            .and_then(static_alias_invalidation_path)
    }

    fn assignment_callable_target(&self, callee: &Expression<'_>) -> Option<StaticAliasPath> {
        let Expression::AssignmentExpression(assignment) = callee.get_inner_expression() else {
            return None;
        };
        self.assignment_target_path(assignment)
    }

    fn immediate_callable_value<'a, 'ast>(
        expression: &'a Expression<'ast>,
    ) -> &'a Expression<'ast> {
        match expression.get_inner_expression() {
            Expression::AssignmentExpression(assignment)
                if assignment.operator == OxcAssignmentOperator::Assign =>
            {
                &assignment.right
            }
            _ => expression,
        }
    }

    fn callable_resolves_to_path(
        &self,
        expression: &Expression<'_>,
        expected: &StaticAliasPath,
    ) -> bool {
        let Some((mut current, _)) = self.callable_reference(expression) else {
            return false;
        };
        let mut visited = BTreeSet::new();
        loop {
            if current == *expected {
                return true;
            }
            if !visited.insert(current.clone())
                || !self.is_immutable_local_callable_target(&current)
            {
                return false;
            }
            let Some(source) = self.sole_forwarded_callable_source(&current) else {
                return false;
            };
            current = source.clone();
        }
    }

    fn assignment_invocation_target(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(StaticAliasPath, Option<GeneratorMethodGuard>, usize)> {
        if let Some(source) = self.assignment_callable_target(&call.callee) {
            return Some((source, None, 0));
        }
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            let source = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|source| self.assignment_callable_target(source))?;
            return Some((
                source,
                Some(GeneratorMethodGuard {
                    source: None,
                    owner: reflect,
                    method: "apply",
                }),
                1,
            ));
        }
        let (source, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.to_string())
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, static_member_name(&member.expression)?)
            }
            _ => return None,
        };
        let method = match method.as_str() {
            "call" => "call",
            "apply" => "apply",
            _ => return None,
        };
        let source = self.assignment_callable_target(source)?;
        Some((
            source.clone(),
            Some(GeneratorMethodGuard {
                source: Some(source),
                owner: StaticAliasPath::unresolved_global("Function".to_string())
                    .with_property("prototype".to_string()),
                method,
            }),
            0,
        ))
    }

    fn record_assignment_callable_read(&mut self, call: &CallExpression<'_>, discarded: bool) {
        let Some((target, guard, _)) = self.assignment_invocation_target(call) else {
            return;
        };
        let span = (call.span.start, call.span.end);
        self.direct_callable_reads
            .entry(target.clone())
            .or_default()
            .insert(span);
        if discarded {
            if let Some(guard) = guard {
                self.guarded_discarded_invocation_reads
                    .push((target, span, guard));
            } else {
                self.discarded_invocation_reads
                    .entry(target)
                    .or_default()
                    .insert(span);
            }
        }
    }

    fn record_assignment_tagged_read(
        &mut self,
        expression: &TaggedTemplateExpression<'_>,
        discarded: bool,
    ) {
        let Some(target) = self.assignment_callable_target(&expression.tag) else {
            return;
        };
        let span = (expression.span.start, expression.span.end);
        self.direct_callable_reads
            .entry(target.clone())
            .or_default()
            .insert(span);
        if discarded {
            self.discarded_invocation_reads
                .entry(target)
                .or_default()
                .insert(span);
        }
    }

    fn generator_body_span(function: &Function<'_>) -> Option<(u32, u32)> {
        function
            .generator
            .then_some(function.body.as_ref())
            .flatten()
            .map(|body| (body.span.start, body.span.end))
    }

    fn resolve_returned_generator_bodies(
        &self,
        collector: ReturnedGeneratorBodyCollector<'_>,
    ) -> BTreeSet<GeneratorBodySpan> {
        let mut spans = collector.spans;
        for source in collector.sources {
            if let Some(returned) = self.returned_generator_body_spans.get(&source) {
                spans.extend(returned.iter().copied());
            }
            spans.extend(
                self.generator_body_targets
                    .iter()
                    .filter_map(|(span, target)| (target == &source).then_some(*span)),
            );
        }
        spans
    }

    fn returned_generator_bodies_from_function(
        &self,
        function: &Function<'_>,
    ) -> BTreeSet<GeneratorBodySpan> {
        if function.generator || function.r#async {
            return BTreeSet::new();
        }
        let Some(body) = &function.body else {
            return BTreeSet::new();
        };
        let mut collector = ReturnedGeneratorBodyCollector::new(self.scoping);
        collector.visit_function_body(body);
        self.resolve_returned_generator_bodies(collector)
    }

    fn returned_generator_bodies_from_arrow(
        &self,
        function: &ArrowFunctionExpression<'_>,
    ) -> BTreeSet<GeneratorBodySpan> {
        if function.r#async {
            return BTreeSet::new();
        }
        let mut collector = ReturnedGeneratorBodyCollector::new(self.scoping);
        if let Some(expression) = function.get_expression() {
            collector.collect_expression(expression);
        } else {
            collector.visit_function_body(&function.body);
        }
        self.resolve_returned_generator_bodies(collector)
    }

    fn record_returned_generator_factory_initializer(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let spans = match initializer.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                self.returned_generator_bodies_from_function(function)
            }
            Expression::ArrowFunctionExpression(function) => {
                self.returned_generator_bodies_from_arrow(function)
            }
            _ => return,
        };
        if !spans.is_empty() {
            self.returned_generator_body_spans
                .insert(target.clone(), spans);
        }
    }

    fn analyze_local_non_consuming_parameters(
        &self,
        parameters: &FormalParameters<'_>,
        body: &FunctionBody<'_>,
        concise_return: Option<&Expression<'_>>,
        has_own_arguments: bool,
        strict_function: bool,
    ) -> Option<NonConsumingParameters> {
        if parameters.rest.is_some() {
            return None;
        }
        let mut parameter_indices = BTreeMap::new();
        for (index, parameter) in parameters.items.iter().enumerate() {
            if parameter.initializer.is_some()
                || parameter.optional
                || !parameter.decorators.is_empty()
                || parameter.accessibility.is_some()
                || parameter.readonly
                || parameter.r#override
            {
                return None;
            }
            let BindingPattern::BindingIdentifier(binding) = &parameter.pattern else {
                return None;
            };
            parameter_indices.insert(binding.symbol_id.get()?, index);
        }
        let mut collector = NonConsumingParameterCollector {
            scoping: self.scoping,
            parameter_indices: parameter_indices.clone(),
            returned: BTreeSet::new(),
            unsafe_uses: BTreeSet::new(),
            discarded_invocation_callees: BTreeSet::new(),
            dynamic_arguments: false,
            nested_function_depth: 0,
        };
        if let Some(returned) = concise_return {
            if let Some(index) = collector.direct_parameter_index(returned) {
                collector.returned.insert(index);
            } else {
                collector.record_parameter_invocation(returned, true);
                collector.visit_expression(returned);
            }
        } else {
            collector.visit_function_body(body);
        }
        Some(NonConsumingParameters {
            fixed: parameter_indices
                .into_values()
                .filter(|index| !collector.unsafe_uses.contains(index))
                .map(|index| (index, collector.returned.contains(&index)))
                .collect(),
            safe_tail_start: (!has_own_arguments
                || (strict_function && !collector.dynamic_arguments))
                .then_some(parameters.items.len()),
        })
    }

    fn local_non_consuming_parameters(
        &self,
        function: &Function<'_>,
    ) -> Option<NonConsumingParameters> {
        if function.generator || function.r#async {
            return None;
        }
        self.analyze_local_non_consuming_parameters(
            &function.params,
            function.body.as_ref()?,
            None,
            true,
            self.strict_program,
        )
    }

    fn local_non_consuming_arrow_parameters(
        &self,
        function: &ArrowFunctionExpression<'_>,
    ) -> Option<NonConsumingParameters> {
        if function.r#async {
            return None;
        }
        self.analyze_local_non_consuming_parameters(
            &function.params,
            &function.body,
            function.get_expression(),
            false,
            self.strict_program,
        )
    }

    fn local_non_consuming_class_parameters(
        &self,
        class: &Class<'_>,
    ) -> Option<NonConsumingParameters> {
        if !class.decorators.is_empty() {
            return None;
        }
        let constructor = class.body.body.iter().find_map(|element| {
            let ClassElement::MethodDefinition(method) = element else {
                return None;
            };
            (method.kind == MethodDefinitionKind::Constructor).then_some(method)
        });
        let Some(constructor) = constructor else {
            return class
                .super_class
                .is_none()
                .then_some(NonConsumingParameters {
                    fixed: BTreeMap::new(),
                    safe_tail_start: Some(0),
                });
        };
        if !constructor.decorators.is_empty() {
            return None;
        }
        self.analyze_local_non_consuming_parameters(
            &constructor.value.params,
            constructor.value.body.as_ref()?,
            None,
            true,
            true,
        )
    }

    fn inline_non_consuming_parameters(
        &self,
        expression: &Expression<'_>,
    ) -> Option<NonConsumingParameters> {
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                self.local_non_consuming_parameters(function)
            }
            Expression::ArrowFunctionExpression(function) => {
                self.local_non_consuming_arrow_parameters(function)
            }
            Expression::ConditionalExpression(expression) => Some(
                self.inline_non_consuming_parameters(&expression.consequent)?
                    .intersect(&self.inline_non_consuming_parameters(&expression.alternate)?),
            ),
            Expression::LogicalExpression(expression) => Some(
                self.inline_non_consuming_parameters(&expression.left)?
                    .intersect(&self.inline_non_consuming_parameters(&expression.right)?),
            ),
            Expression::SequenceExpression(expression) => {
                self.inline_non_consuming_parameters(expression.expressions.last()?)
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.inline_non_consuming_parameters(&expression.right)
            }
            _ => None,
        }
    }

    fn pending_parameter_sources(
        &self,
        expression: &Expression<'_>,
        construct: bool,
    ) -> Option<Vec<PendingParameterSource>> {
        if let Some((source, _)) = self.callable_reference(expression) {
            return Some(vec![PendingParameterSource::Local {
                source,
                parameter_offset: 0,
                method_guards: Vec::new(),
            }]);
        }
        let inline = match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                self.local_non_consuming_parameters(function)
            }
            Expression::ArrowFunctionExpression(function) if !construct => {
                self.local_non_consuming_arrow_parameters(function)
            }
            Expression::ClassExpression(class) if construct => {
                self.local_non_consuming_class_parameters(class.as_ref())
            }
            _ => None,
        };
        if let Some(parameters) = inline {
            return Some(vec![PendingParameterSource::Inline {
                parameters,
                parameter_offset: 0,
                method_guards: Vec::new(),
            }]);
        }
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                let mut sources =
                    self.pending_parameter_sources(&expression.consequent, construct)?;
                sources.extend(self.pending_parameter_sources(&expression.alternate, construct)?);
                Some(sources)
            }
            Expression::LogicalExpression(expression) => {
                let mut sources = self.pending_parameter_sources(&expression.left, construct)?;
                sources.extend(self.pending_parameter_sources(&expression.right, construct)?);
                Some(sources)
            }
            Expression::SequenceExpression(expression) => {
                self.pending_parameter_sources(expression.expressions.last()?, construct)
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.pending_parameter_sources(&expression.right, construct)
            }
            _ => None,
        }
    }

    fn pending_bound_parameter_sources(
        &self,
        expression: &Expression<'_>,
        construct: bool,
    ) -> Option<Vec<PendingParameterSource>> {
        if let Some((parameters, method_guards)) =
            self.inline_bound_non_consuming_parameters(expression)
        {
            return Some(vec![PendingParameterSource::Inline {
                parameters,
                parameter_offset: 0,
                method_guards,
            }]);
        }
        if let Some(forwardings) = self.generator_bind_forwardings(expression)
            && let Some(parameter_offset) = Self::fixed_bound_parameter_count(expression)
        {
            let sources = forwardings
                .into_iter()
                .map(|forwarding| match forwarding {
                    GeneratorBindForwarding::Source { source, guard, .. } => {
                        Some(PendingParameterSource::Local {
                            source,
                            parameter_offset,
                            method_guards: vec![guard],
                        })
                    }
                    GeneratorBindForwarding::Inline { .. } => None,
                })
                .collect::<Option<Vec<_>>>();
            if let Some(sources) = sources {
                return Some(sources);
            }
        }
        if construct {
            let call = match expression.get_inner_expression() {
                Expression::CallExpression(call) => Some(call.as_ref()),
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::CallExpression(call) => Some(call.as_ref()),
                    _ => None,
                },
                _ => None,
            };
            if let Some(call) = call {
                let source = match unwrap_transparent_call_expression(&call.callee) {
                    Expression::StaticMemberExpression(member)
                        if member.property.name == "bind" =>
                    {
                        Some(&member.object)
                    }
                    Expression::ComputedMemberExpression(member)
                        if static_member_name(&member.expression).as_deref() == Some("bind") =>
                    {
                        Some(&member.object)
                    }
                    _ => None,
                };
                if let Some(Expression::ClassExpression(class)) =
                    source.map(Expression::get_inner_expression)
                    && let Some(parameter_offset) = Self::fixed_bound_parameter_count(expression)
                    && let Some(parameters) =
                        self.local_non_consuming_class_parameters(class.as_ref())
                {
                    return Some(vec![PendingParameterSource::Inline {
                        parameters: parameters.shifted(parameter_offset),
                        parameter_offset: 0,
                        method_guards: vec![GeneratorMethodGuard {
                            source: None,
                            owner: StaticAliasPath::unresolved_global("Function".to_string())
                                .with_property("prototype".to_string()),
                            method: "bind",
                        }],
                    }]);
                }
            }
        }
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                let mut sources =
                    self.pending_bound_parameter_sources(&expression.consequent, construct)?;
                sources.extend(
                    self.pending_bound_parameter_sources(&expression.alternate, construct)?,
                );
                Some(sources)
            }
            Expression::LogicalExpression(expression) => {
                let mut sources =
                    self.pending_bound_parameter_sources(&expression.left, construct)?;
                sources.extend(self.pending_bound_parameter_sources(&expression.right, construct)?);
                Some(sources)
            }
            Expression::SequenceExpression(expression) => {
                self.pending_bound_parameter_sources(expression.expressions.last()?, construct)
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.pending_bound_parameter_sources(&expression.right, construct)
            }
            _ => None,
        }
    }

    fn direct_inline_bound_non_consuming_parameters(
        &self,
        expression: &Expression<'_>,
    ) -> Option<DirectInlineBoundParameters> {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return None,
            },
            _ => return None,
        };
        self.direct_inline_bound_call_parameters(call)
    }

    fn direct_inline_bound_call_parameters(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<DirectInlineBoundParameters> {
        let source = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) if member.property.name == "bind" => {
                &member.object
            }
            Expression::ComputedMemberExpression(member)
                if static_member_name(&member.expression).as_deref() == Some("bind") =>
            {
                &member.object
            }
            _ => return None,
        };
        let (source_parameters, mut method_guards) = self
            .inline_non_consuming_parameters(source)
            .map(|parameters| (parameters, Vec::new()))
            .or_else(|| self.inline_bound_non_consuming_parameters(source))?;
        if call
            .arguments
            .iter()
            .any(|argument| argument.as_expression().is_none())
        {
            return None;
        }
        let offset = call.arguments.len().saturating_sub(1);
        let parameters = source_parameters.shifted(offset);
        let guard = GeneratorMethodGuard {
            source: None,
            owner: StaticAliasPath::unresolved_global("Function".to_string())
                .with_property("prototype".to_string()),
            method: "bind",
        };
        method_guards.push(guard.clone());
        Some(DirectInlineBoundParameters {
            source_parameters,
            parameters,
            guard,
            method_guards,
        })
    }

    fn inline_bound_non_consuming_parameters(
        &self,
        expression: &Expression<'_>,
    ) -> Option<(NonConsumingParameters, Vec<GeneratorMethodGuard>)> {
        if let Some(bound) = self.direct_inline_bound_non_consuming_parameters(expression) {
            return Some((bound.parameters, bound.method_guards));
        }
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                let (parameters, mut guards) =
                    self.inline_bound_non_consuming_parameters(&expression.consequent)?;
                let (alternate, alternate_guards) =
                    self.inline_bound_non_consuming_parameters(&expression.alternate)?;
                guards.extend(alternate_guards);
                Some((parameters.intersect(&alternate), guards))
            }
            Expression::LogicalExpression(expression) => {
                let (parameters, mut guards) =
                    self.inline_bound_non_consuming_parameters(&expression.left)?;
                let (alternate, alternate_guards) =
                    self.inline_bound_non_consuming_parameters(&expression.right)?;
                guards.extend(alternate_guards);
                Some((parameters.intersect(&alternate), guards))
            }
            Expression::SequenceExpression(expression) => {
                self.inline_bound_non_consuming_parameters(expression.expressions.last()?)
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.inline_bound_non_consuming_parameters(&expression.right)
            }
            _ => None,
        }
    }

    fn generator_body_spans_for_target(
        &self,
        target: &StaticAliasPath,
    ) -> BTreeSet<GeneratorBodySpan> {
        fn collect(
            collector: &ExecutionStateCollector<'_>,
            target: &StaticAliasPath,
            visited: &mut BTreeSet<StaticAliasPath>,
            bodies: &mut BTreeSet<GeneratorBodySpan>,
        ) {
            if !visited.insert(target.clone()) {
                return;
            }
            bodies.extend(
                collector
                    .generator_body_targets
                    .iter()
                    .filter_map(|(span, candidate)| (candidate == target).then_some(*span)),
            );
            for forwarding in &collector.forwarded_callable_reads {
                if forwarding.target == *target {
                    collect(collector, &forwarding.source, visited, bodies);
                }
            }
        }

        let mut bodies = BTreeSet::new();
        collect(self, target, &mut BTreeSet::new(), &mut bodies);
        bodies
    }

    fn constructed_instance_callable_reference(
        &self,
        expression: &Expression<'_>,
    ) -> Option<(StaticAliasPath, (u32, u32))> {
        let (object, name) = match expression.get_inner_expression() {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.to_string())
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, static_member_name(&member.expression)?)
            }
            _ => return None,
        };
        let Expression::NewExpression(instance) = object.get_inner_expression() else {
            return None;
        };
        let (class, source_span) = self.callable_reference(&instance.callee)?;
        Some((
            class
                .with_property("prototype".to_string())
                .with_property(name),
            source_span,
        ))
    }

    fn record_class_generator_bodies(&mut self, target: &StaticAliasPath, class: &Class<'_>) {
        if !class.decorators.is_empty() {
            return;
        }
        for element in &class.body.body {
            match element {
                ClassElement::MethodDefinition(method)
                    if method.kind == MethodDefinitionKind::Method
                        && method.decorators.is_empty()
                        && !matches!(&method.key, OxcPropertyKey::PrivateIdentifier(_)) =>
                {
                    let Some(name) = method.key.static_name() else {
                        continue;
                    };
                    let method_target = if method.r#static {
                        target.clone()
                    } else {
                        target.clone().with_property("prototype".to_string())
                    }
                    .with_property(name.into_owned());
                    self.record_callable_target_span(method_target.clone(), method.value.span);
                    if let Some(span) = Self::generator_body_span(&method.value) {
                        self.generator_callable_targets
                            .insert(method_target.clone());
                        self.generator_body_targets.push((span, method_target));
                    } else {
                        self.non_generator_callable_targets.insert(method_target);
                    }
                }
                ClassElement::PropertyDefinition(property)
                    if property.decorators.is_empty()
                        && !matches!(&property.key, OxcPropertyKey::PrivateIdentifier(_)) =>
                {
                    let (Some(name), Some(value)) = (property.key.static_name(), &property.value)
                    else {
                        continue;
                    };
                    if !matches!(
                        value.get_inner_expression(),
                        Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_)
                    ) {
                        continue;
                    }
                    let method_target = if property.r#static {
                        target.clone()
                    } else {
                        target.clone().with_property("prototype".to_string())
                    }
                    .with_property(name.into_owned());
                    self.record_forwarded_callable(method_target, value);
                }
                _ => {}
            }
        }
        let replacement_object = class_guaranteed_returned_object(class);
        if !class_preserves_instance_prototype(class) && replacement_object.is_none() {
            self.class_instance_generator_bodies.remove(target);
            return;
        }
        let inherited_bodies = replacement_object
            .is_none()
            .then(|| {
                class.super_class.as_ref().and_then(|super_class| {
                    let source = static_alias_source_path(self.scoping, super_class)?;
                    let source_span = Self::root_identifier_span(super_class)?;
                    let bodies = self
                        .class_instance_generator_bodies
                        .get(&source)
                        .cloned()
                        .unwrap_or_default();
                    Some((source, source_span, bodies))
                })
            })
            .flatten();
        let mut instance_bodies = inherited_bodies
            .as_ref()
            .map(|(_, _, bodies)| bodies.clone())
            .unwrap_or_default();
        if let Some(object) = replacement_object {
            for property in &object.properties {
                let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                    continue;
                };
                let Some(name) = property.key.static_name() else {
                    continue;
                };
                let name = name.into_owned();
                let target_method = target
                    .clone()
                    .with_property("prototype".to_string())
                    .with_property(name.clone());
                self.record_forwarded_callable(target_method.clone(), &property.value);
                let bodies = self.generator_body_spans_for_target(&target_method);
                instance_bodies.insert(name, bodies);
            }
        } else {
            for element in &class.body.body {
                match element {
                    ClassElement::MethodDefinition(method)
                        if !method.r#static
                            && !matches!(&method.key, OxcPropertyKey::PrivateIdentifier(_)) =>
                    {
                        let Some(name) = method.key.static_name() else {
                            instance_bodies.clear();
                            continue;
                        };
                        let name = name.into_owned();
                        if method.kind == MethodDefinitionKind::Method
                            && method.decorators.is_empty()
                            && let Some(span) = Self::generator_body_span(&method.value)
                        {
                            instance_bodies.insert(name, BTreeSet::from([span]));
                        } else {
                            instance_bodies.remove(&name);
                        }
                    }
                    ClassElement::PropertyDefinition(property)
                        if !property.r#static
                            && !matches!(&property.key, OxcPropertyKey::PrivateIdentifier(_)) =>
                    {
                        let Some(name) = property.key.static_name() else {
                            instance_bodies.clear();
                            continue;
                        };
                        let name = name.into_owned();
                        let body = property.value.as_ref().and_then(|value| {
                            match value.get_inner_expression() {
                                Expression::FunctionExpression(function) => {
                                    Self::generator_body_span(function)
                                }
                                _ => None,
                            }
                        });
                        if property.decorators.is_empty()
                            && let Some(body) = body
                        {
                            instance_bodies.insert(name, BTreeSet::from([body]));
                        } else {
                            instance_bodies.remove(&name);
                        }
                    }
                    _ => {}
                }
            }
        }
        for (name, bodies) in &instance_bodies {
            if replacement_object.is_some() {
                continue;
            }
            let target_method = target
                .clone()
                .with_property("prototype".to_string())
                .with_property(name.clone());
            self.generator_callable_targets
                .insert(target_method.clone());
            self.generator_body_targets
                .extend(bodies.iter().map(|body| (*body, target_method.clone())));
            if let Some((source, source_span, inherited)) = &inherited_bodies
                && inherited.get(name) == Some(bodies)
            {
                self.forwarded_callable_reads.push(ForwardedCallableRead {
                    source: source
                        .clone()
                        .with_property("prototype".to_string())
                        .with_property(name.clone()),
                    source_span: *source_span,
                    target: target_method,
                    method_guard: None,
                    parameter_offset: None,
                });
            }
        }
        self.class_instance_generator_bodies
            .insert(target.clone(), instance_bodies);
    }

    fn record_constructed_class_generator_bodies(
        &mut self,
        target: StaticAliasPath,
        expression: &NewExpression<'_>,
    ) {
        let Some((class, source_span)) = self.callable_reference(&expression.callee) else {
            return;
        };
        let prototype = class.clone().with_property("prototype".to_string());
        let callable_paths = self
            .callable_targets_by_span
            .values()
            .flatten()
            .filter(|path| {
                path.starts_with(&prototype) && path.properties.len() > prototype.properties.len()
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        for source in callable_paths {
            let mut instance_method = target.clone();
            instance_method
                .properties
                .extend_from_slice(&source.properties[prototype.properties.len()..]);
            self.forwarding_targets.insert(instance_method.clone());
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source,
                source_span,
                target: instance_method,
                method_guard: None,
                parameter_offset: None,
            });
        }
        let bodies = self
            .class_instance_generator_bodies
            .get(&class)
            .cloned()
            .unwrap_or_default();
        for (name, spans) in &bodies {
            let source = class
                .clone()
                .with_property("prototype".to_string())
                .with_property(name.clone());
            let instance_method = target.clone().with_property(name.clone());
            self.generator_callable_targets
                .insert(instance_method.clone());
            self.generator_body_targets
                .extend(spans.iter().map(|span| (*span, instance_method.clone())));
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source,
                source_span,
                target: instance_method,
                method_guard: None,
                parameter_offset: None,
            });
        }
        self.instance_generator_bodies.insert(target, bodies);
    }

    fn record_forwarded_instance_generator_bodies(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let Some((source, source_span)) = self.callable_reference(initializer) else {
            return;
        };
        let bodies = self
            .instance_generator_bodies
            .get(&source)
            .cloned()
            .unwrap_or_default();
        for (name, spans) in &bodies {
            let source_method = source.clone().with_property(name.clone());
            let target_method = target.clone().with_property(name.clone());
            self.generator_body_targets
                .extend(spans.iter().map(|span| (*span, target_method.clone())));
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source: source_method,
                source_span,
                target: target_method,
                method_guard: None,
                parameter_offset: None,
            });
        }
        self.instance_generator_bodies.insert(target, bodies);
    }

    fn record_forwarded_class_generator_bodies(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let Some((source, source_span)) = self.callable_reference(initializer) else {
            return;
        };
        let bodies = self
            .class_instance_generator_bodies
            .get(&source)
            .cloned()
            .unwrap_or_default();
        for (name, spans) in &bodies {
            let source_method = source
                .clone()
                .with_property("prototype".to_string())
                .with_property(name.clone());
            let target_method = target
                .clone()
                .with_property("prototype".to_string())
                .with_property(name.clone());
            self.generator_callable_targets
                .insert(target_method.clone());
            self.generator_body_targets
                .extend(spans.iter().map(|span| (*span, target_method.clone())));
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source: source_method,
                source_span,
                target: target_method,
                method_guard: None,
                parameter_offset: None,
            });
        }
        self.class_instance_generator_bodies.insert(target, bodies);
    }

    fn record_guarded_nonexecuting_callable(
        &mut self,
        expression: &Expression<'_>,
        owner: &StaticAliasPath,
        method: &'static str,
        check_source_method: bool,
    ) -> bool {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            self.guarded_discarded_invocation_reads.push((
                source.clone(),
                source_span,
                GeneratorMethodGuard {
                    source: check_source_method.then_some(source),
                    owner: owner.clone(),
                    method,
                },
            ));
            return true;
        }
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                let Some(body_span) = Self::generator_body_span(function) else {
                    return false;
                };
                self.guarded_unexecuted_body_spans.push((
                    body_span,
                    GeneratorMethodGuard {
                        source: None,
                        owner: owner.clone(),
                        method,
                    },
                ));
                true
            }
            Expression::ConditionalExpression(expression) => {
                let consequent = self.record_guarded_nonexecuting_callable(
                    &expression.consequent,
                    owner,
                    method,
                    check_source_method,
                );
                let alternate = self.record_guarded_nonexecuting_callable(
                    &expression.alternate,
                    owner,
                    method,
                    check_source_method,
                );
                consequent || alternate
            }
            Expression::LogicalExpression(expression) => {
                let left = self.record_guarded_nonexecuting_callable(
                    &expression.left,
                    owner,
                    method,
                    check_source_method,
                );
                let right = self.record_guarded_nonexecuting_callable(
                    &expression.right,
                    owner,
                    method,
                    check_source_method,
                );
                left || right
            }
            Expression::SequenceExpression(expression) => {
                expression.expressions.last().is_some_and(|expression| {
                    self.record_guarded_nonexecuting_callable(
                        expression,
                        owner,
                        method,
                        check_source_method,
                    )
                })
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_guarded_nonexecuting_callable(
                    &expression.right,
                    owner,
                    method,
                    check_source_method,
                )
            }
            _ => false,
        }
    }

    fn record_nonexecuting_indirect_call(&mut self, call: &CallExpression<'_>) -> bool {
        if call.optional {
            return false;
        }
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            return call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .is_some_and(|target| {
                    self.record_guarded_nonexecuting_callable(target, &reflect, "apply", false)
                });
        }
        let (object, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) if !member.optional => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) if !member.optional => {
                let Some(method) = static_member_name(&member.expression) else {
                    return false;
                };
                let method = match method.as_str() {
                    "call" => "call",
                    "apply" => "apply",
                    _ => return false,
                };
                (&member.object, method)
            }
            _ => return false,
        };
        let method = match method {
            "call" => "call",
            "apply" => "apply",
            _ => return false,
        };
        let function_prototype = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        self.record_guarded_nonexecuting_callable(object, &function_prototype, method, true)
    }

    fn record_generator_result_source(
        &mut self,
        target: StaticAliasPath,
        expression: &Expression<'_>,
        method: Option<(&StaticAliasPath, &'static str, bool)>,
    ) -> bool {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            let method_guard =
                method.map(
                    |(owner, method, check_source_method)| GeneratorMethodGuard {
                        source: check_source_method.then_some(source.clone()),
                        owner: owner.clone(),
                        method,
                    },
                );
            self.generator_result_reads.push(ForwardedCallableRead {
                source,
                source_span,
                target,
                method_guard,
                parameter_offset: None,
            });
            return true;
        }
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                let Some(body_span) = Self::generator_body_span(function) else {
                    return false;
                };
                self.generator_body_targets
                    .push((body_span, target.clone()));
                if let Some((owner, method, _)) = method {
                    self.guarded_generator_targets.push((
                        target,
                        GeneratorMethodGuard {
                            source: None,
                            owner: owner.clone(),
                            method,
                        },
                    ));
                }
                true
            }
            Expression::ConditionalExpression(expression) => {
                let consequent = self.record_generator_result_source(
                    target.clone(),
                    &expression.consequent,
                    method,
                );
                let alternate =
                    self.record_generator_result_source(target, &expression.alternate, method);
                consequent || alternate
            }
            Expression::LogicalExpression(expression) => {
                let left =
                    self.record_generator_result_source(target.clone(), &expression.left, method);
                let right = self.record_generator_result_source(target, &expression.right, method);
                left || right
            }
            Expression::SequenceExpression(expression) => {
                expression.expressions.last().is_some_and(|expression| {
                    self.record_generator_result_source(target, expression, method)
                })
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_generator_result_source(target, &expression.right, method)
            }
            _ => false,
        }
    }

    fn collect_retained_callable_sources(
        &self,
        expression: &Expression<'_>,
        sources: &mut Vec<(StaticAliasPath, (u32, u32))>,
    ) {
        if let Some(source) = self.callable_reference(expression) {
            sources.push(source);
            return;
        }
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                self.collect_retained_callable_sources(&expression.consequent, sources);
                self.collect_retained_callable_sources(&expression.alternate, sources);
            }
            Expression::LogicalExpression(expression) => {
                self.collect_retained_callable_sources(&expression.left, sources);
                self.collect_retained_callable_sources(&expression.right, sources);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.collect_retained_callable_sources(expression, sources);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.collect_retained_callable_sources(&expression.right, sources);
            }
            Expression::ArrayExpression(expression) => {
                for element in &expression.elements {
                    if matches!(
                        element,
                        ArrayExpressionElement::Elision(_)
                            | ArrayExpressionElement::SpreadElement(_)
                    ) {
                        continue;
                    }
                    self.collect_retained_callable_sources(element.to_expression(), sources);
                }
            }
            Expression::ObjectExpression(expression) => {
                for property in &expression.properties {
                    let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    self.collect_retained_callable_sources(&property.value, sources);
                }
            }
            _ => {}
        }
    }

    fn record_retained_callable_source(
        &mut self,
        target: StaticAliasPath,
        expression: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
        kind: RetainedCallableReadKind,
    ) -> bool {
        let mut sources = Vec::new();
        self.collect_retained_callable_sources(expression, &mut sources);
        let found = !sources.is_empty();
        for (source, source_span) in sources {
            let read = ForwardedCallableRead {
                source,
                source_span,
                target: target.clone(),
                method_guard: guard.cloned(),
                parameter_offset: None,
            };
            match kind {
                RetainedCallableReadKind::Bind | RetainedCallableReadKind::Container => {
                    self.retained_callable_reads.push(read);
                }
                RetainedCallableReadKind::GeneratorInvocation => {
                    self.generator_argument_reads.push(read);
                }
            }
        }
        found
    }

    fn record_retained_generator_body_source(
        &mut self,
        body_spans: &BTreeSet<GeneratorBodySpan>,
        expression: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        let mut sources = Vec::new();
        self.collect_retained_callable_sources(expression, &mut sources);
        self.generator_body_argument_reads
            .extend(
                sources
                    .into_iter()
                    .map(|(source, source_span)| GeneratorBodyArgumentRead {
                        source,
                        source_span,
                        body_spans: body_spans.clone(),
                        method_guard: guard.cloned(),
                    }),
            );
    }

    fn collect_inline_generator_body_spans(
        expression: &Expression<'_>,
        body_spans: &mut BTreeSet<GeneratorBodySpan>,
    ) -> bool {
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                let Some(span) = Self::generator_body_span(function) else {
                    return false;
                };
                body_spans.insert(span);
                true
            }
            Expression::ConditionalExpression(expression) => {
                let consequent =
                    Self::collect_inline_generator_body_spans(&expression.consequent, body_spans);
                let alternate =
                    Self::collect_inline_generator_body_spans(&expression.alternate, body_spans);
                consequent && alternate
            }
            Expression::LogicalExpression(expression) => {
                let left = Self::collect_inline_generator_body_spans(&expression.left, body_spans);
                let right =
                    Self::collect_inline_generator_body_spans(&expression.right, body_spans);
                left && right
            }
            Expression::SequenceExpression(expression) => {
                expression.expressions.last().is_some_and(|expression| {
                    Self::collect_inline_generator_body_spans(expression, body_spans)
                })
            }
            Expression::StaticMemberExpression(expression) => {
                Self::collect_inline_object_member_generator_body_spans(
                    &expression.object,
                    expression.property.name.as_str(),
                    body_spans,
                )
            }
            Expression::ComputedMemberExpression(expression) => {
                static_member_name(&expression.expression).is_some_and(|name| {
                    Self::collect_inline_object_member_generator_body_spans(
                        &expression.object,
                        &name,
                        body_spans,
                    )
                })
            }
            _ => false,
        }
    }

    fn collect_inline_object_member_generator_body_spans(
        expression: &Expression<'_>,
        member: &str,
        body_spans: &mut BTreeSet<GeneratorBodySpan>,
    ) -> bool {
        let Expression::ObjectExpression(object) = expression.get_inner_expression() else {
            return false;
        };
        let mut selected = None;
        for property in &object.properties {
            let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                return false;
            };
            let Some(name) = property.key.static_name() else {
                return false;
            };
            if name != member {
                continue;
            }
            let mut candidate = BTreeSet::new();
            selected = Self::collect_inline_generator_body_spans(&property.value, &mut candidate)
                .then_some(candidate);
        }
        let Some(selected) = selected else {
            return false;
        };
        body_spans.extend(selected);
        true
    }

    fn collect_static_container_generator_body_spans(
        &mut self,
        expression: &Expression<'_>,
        array_iterator_guarded: bool,
        body_spans: &mut BTreeSet<GeneratorBodySpan>,
        guarded_body_spans: &mut BTreeSet<GeneratorBodySpan>,
    ) {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            if array_iterator_guarded {
                self.guarded_discarded_invocation_reads.push((
                    source,
                    source_span,
                    Self::array_iterator_guard(),
                ));
            } else {
                self.record_merely_observed_value_read(source, source_span);
            }
            return;
        }
        let record = |span, body_spans: &mut BTreeSet<_>, guarded_body_spans: &mut BTreeSet<_>| {
            if array_iterator_guarded {
                guarded_body_spans.insert(span);
            } else {
                body_spans.insert(span);
            }
        };
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                if let Some(span) = Self::generator_body_span(function) {
                    record(span, body_spans, guarded_body_spans);
                }
            }
            Expression::CallExpression(_) | Expression::TaggedTemplateExpression(_) => {
                let Some(pending) = self.pending_discarded_invocations(expression) else {
                    return;
                };
                if !array_iterator_guarded {
                    self.record_discarded_invocations(pending);
                    return;
                }
                for action in pending.nonexecuting_actions {
                    match action {
                        PendingNonExecutingAction::CallableRead {
                            source,
                            source_span,
                            method_guard: None,
                        } => self.guarded_discarded_invocation_reads.push((
                            source,
                            source_span,
                            Self::array_iterator_guard(),
                        )),
                        PendingNonExecutingAction::BodySpan {
                            body_span,
                            method_guard: None,
                        } => {
                            guarded_body_spans.insert(body_span);
                        }
                        PendingNonExecutingAction::CallableRead {
                            method_guard: Some(_),
                            ..
                        }
                        | PendingNonExecutingAction::BodySpan {
                            method_guard: Some(_),
                            ..
                        } => {}
                    }
                }
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            if matches!(
                                spread.argument.get_inner_expression(),
                                Expression::ArrayExpression(_)
                            ) {
                                self.collect_static_container_generator_body_spans(
                                    &spread.argument,
                                    true,
                                    body_spans,
                                    guarded_body_spans,
                                );
                            }
                        }
                        _ => self.collect_static_container_generator_body_spans(
                            element.to_expression(),
                            array_iterator_guarded,
                            body_spans,
                            guarded_body_spans,
                        ),
                    }
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property) => {
                            self.collect_static_container_generator_body_spans(
                                &property.value,
                                array_iterator_guarded,
                                body_spans,
                                guarded_body_spans,
                            );
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread)
                            if matches!(
                                spread.argument.get_inner_expression(),
                                Expression::ArrayExpression(_) | Expression::ObjectExpression(_)
                            ) =>
                        {
                            self.collect_static_container_generator_body_spans(
                                &spread.argument,
                                array_iterator_guarded,
                                body_spans,
                                guarded_body_spans,
                            );
                        }
                        OxcObjectPropertyKind::SpreadProperty(_) => {}
                    }
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.collect_static_container_generator_body_spans(
                    &expression.consequent,
                    array_iterator_guarded,
                    body_spans,
                    guarded_body_spans,
                );
                self.collect_static_container_generator_body_spans(
                    &expression.alternate,
                    array_iterator_guarded,
                    body_spans,
                    guarded_body_spans,
                );
            }
            Expression::LogicalExpression(expression) => {
                self.collect_static_container_generator_body_spans(
                    &expression.left,
                    array_iterator_guarded,
                    body_spans,
                    guarded_body_spans,
                );
                self.collect_static_container_generator_body_spans(
                    &expression.right,
                    array_iterator_guarded,
                    body_spans,
                    guarded_body_spans,
                );
            }
            Expression::SequenceExpression(expression) => {
                if let Some(value) = expression.expressions.last() {
                    self.collect_static_container_generator_body_spans(
                        value,
                        array_iterator_guarded,
                        body_spans,
                        guarded_body_spans,
                    );
                }
            }
            _ => {}
        }
    }

    fn collect_discarded_spread_generator_body_spans(
        &mut self,
        expression: &Expression<'_>,
        body_spans: &mut BTreeSet<GeneratorBodySpan>,
        guarded_body_spans: &mut BTreeSet<GeneratorBodySpan>,
    ) {
        match expression.get_inner_expression() {
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            if matches!(
                                spread.argument.get_inner_expression(),
                                Expression::ArrayExpression(_)
                            ) {
                                self.collect_static_container_generator_body_spans(
                                    &spread.argument,
                                    true,
                                    body_spans,
                                    guarded_body_spans,
                                );
                            }
                        }
                        _ => self.collect_discarded_spread_generator_body_spans(
                            element.to_expression(),
                            body_spans,
                            guarded_body_spans,
                        ),
                    }
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property) => {
                            self.collect_discarded_spread_generator_body_spans(
                                &property.value,
                                body_spans,
                                guarded_body_spans,
                            );
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread)
                            if matches!(
                                spread.argument.get_inner_expression(),
                                Expression::ArrayExpression(_) | Expression::ObjectExpression(_)
                            ) =>
                        {
                            self.collect_static_container_generator_body_spans(
                                &spread.argument,
                                false,
                                body_spans,
                                guarded_body_spans,
                            );
                        }
                        OxcObjectPropertyKind::SpreadProperty(_) => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn array_iterator_guard() -> GeneratorMethodGuard {
        GeneratorMethodGuard {
            source: None,
            owner: StaticAliasPath::unresolved_global("Array".to_string())
                .with_property("prototype".to_string()),
            method: "[Symbol.iterator]",
        }
    }

    fn record_static_container_generator_values(
        &mut self,
        expression: &Expression<'_>,
        array_iterator_guarded: bool,
    ) {
        let mut body_spans = BTreeSet::new();
        let mut guarded_body_spans = BTreeSet::new();
        self.collect_static_container_generator_body_spans(
            expression,
            array_iterator_guarded,
            &mut body_spans,
            &mut guarded_body_spans,
        );
        self.directly_unexecuted_body_spans.extend(body_spans);
        self.guarded_unexecuted_body_spans.extend(
            guarded_body_spans
                .into_iter()
                .map(|span| (span, Self::array_iterator_guard())),
        );
    }

    fn record_retained_bind_arguments(
        &mut self,
        target: &StaticAliasPath,
        expression: &Expression<'_>,
        guard: &GeneratorMethodGuard,
    ) {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return,
            },
            _ => return,
        };
        for argument in &call.arguments {
            if let Some(argument) = argument.as_expression() {
                self.record_retained_callable_source(
                    target.clone(),
                    argument,
                    Some(guard),
                    RetainedCallableReadKind::Bind,
                );
            } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument
                && matches!(
                    spread.argument.get_inner_expression(),
                    Expression::ArrayExpression(_)
                )
            {
                self.record_retained_callable_source(
                    target.clone(),
                    &spread.argument,
                    Some(guard),
                    RetainedCallableReadKind::Bind,
                );
            }
        }
    }

    fn fixed_bound_parameter_count(expression: &Expression<'_>) -> Option<usize> {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return None,
            },
            _ => return None,
        };
        call.arguments
            .iter()
            .all(|argument| argument.as_expression().is_some())
            .then(|| call.arguments.len().saturating_sub(1))
    }

    fn record_pending_bound_arguments(
        &mut self,
        source: &StaticAliasPath,
        expression: &Expression<'_>,
        guard: &GeneratorMethodGuard,
    ) {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return,
            },
            _ => return,
        };
        for (parameter_index, argument) in call
            .arguments
            .iter()
            .take_while(|argument| argument.as_expression().is_some())
            .skip(1)
            .enumerate()
        {
            self.record_pending_callable_argument(
                argument.as_expression().expect("ordinary bind argument"),
                Some(source),
                None,
                parameter_index,
                false,
                Some(guard),
            );
        }
    }

    fn record_inline_bind_reads(
        &mut self,
        target: Option<&StaticAliasPath>,
        expression: &Expression<'_>,
    ) {
        if let Some(bound) = self.direct_inline_bound_non_consuming_parameters(expression) {
            let call = match expression.get_inner_expression() {
                Expression::CallExpression(call) => call.as_ref(),
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::CallExpression(call) => call.as_ref(),
                    _ => return,
                },
                _ => return,
            };
            for (parameter_index, argument) in call.arguments.iter().skip(1).enumerate() {
                self.record_pending_callable_argument(
                    argument.as_expression().expect("ordinary bind argument"),
                    None,
                    Some(&bound.source_parameters),
                    parameter_index,
                    false,
                    Some(&bound.guard),
                );
            }
            if let Some(target) = target {
                self.record_retained_bind_arguments(target, expression, &bound.guard);
            }
            return;
        }
        match expression.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                self.record_inline_bind_reads(target, &expression.consequent);
                self.record_inline_bind_reads(target, &expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.record_inline_bind_reads(target, &expression.left);
                self.record_inline_bind_reads(target, &expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.record_inline_bind_reads(target, expression);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_inline_bind_reads(target, &expression.right);
            }
            _ => {}
        }
    }

    fn record_discarded_bind(&mut self, expression: &Expression<'_>) -> bool {
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return false,
            },
            _ => return false,
        };
        let object = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) if member.property.name == "bind" => {
                &member.object
            }
            Expression::ComputedMemberExpression(member)
                if static_member_name(&member.expression).as_deref() == Some("bind") =>
            {
                &member.object
            }
            _ => return false,
        };
        let owner = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        let (receiver, body_span, guard) =
            if let Some((source, source_span)) = self.callable_reference(object) {
                (
                    Some((source.clone(), source_span)),
                    None,
                    GeneratorMethodGuard {
                        source: Some(source),
                        owner,
                        method: "bind",
                    },
                )
            } else if let Expression::FunctionExpression(function) = object.get_inner_expression() {
                (
                    None,
                    Self::generator_body_span(function),
                    GeneratorMethodGuard {
                        source: None,
                        owner,
                        method: "bind",
                    },
                )
            } else {
                return false;
            };
        if let Some((source, source_span)) = receiver {
            self.guarded_discarded_invocation_reads
                .push((source, source_span, guard.clone()));
        }
        if let Some(body_span) = body_span {
            self.guarded_unexecuted_body_spans
                .push((body_span, guard.clone()));
        }
        let mut retained_sources = Vec::new();
        for argument in &call.arguments {
            if let Some(argument) = argument.as_expression() {
                self.collect_retained_callable_sources(argument, &mut retained_sources);
            } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument
                && matches!(
                    spread.argument.get_inner_expression(),
                    Expression::ArrayExpression(_)
                )
            {
                self.collect_retained_callable_sources(&spread.argument, &mut retained_sources);
            }
        }
        self.guarded_discarded_invocation_reads.extend(
            retained_sources
                .into_iter()
                .map(|(source, source_span)| (source, source_span, guard.clone())),
        );
        true
    }

    fn generator_invocation_target(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(StaticAliasPath, Option<GeneratorMethodGuard>, usize)> {
        if let Some(target) = self.assignment_invocation_target(call) {
            return Some(target);
        }
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            let source = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|source| self.callable_reference(source))?
                .0;
            return Some((
                source,
                Some(GeneratorMethodGuard {
                    source: None,
                    owner: reflect,
                    method: "apply",
                }),
                1,
            ));
        }
        let (source, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, Some(member.property.name.to_string()))
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, static_member_name(&member.expression))
            }
            _ => (&call.callee, None),
        };
        let method = match method.as_deref() {
            Some("call") => "call",
            Some("apply") => "apply",
            _ => {
                return self
                    .callable_reference(&call.callee)
                    .map(|(source, _)| (source, None, 0));
            }
        };
        let source = self.callable_reference(source)?.0;
        let function_prototype = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        Some((
            source.clone(),
            Some(GeneratorMethodGuard {
                source: Some(source),
                owner: function_prototype,
                method,
            }),
            0,
        ))
    }

    fn inline_generator_invocation_target(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(
        BTreeSet<GeneratorBodySpan>,
        Option<GeneratorMethodGuard>,
        usize,
    )> {
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            let target = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())?;
            let mut body_spans = BTreeSet::new();
            if !Self::collect_inline_generator_body_spans(target, &mut body_spans) {
                return None;
            }
            return Some((
                body_spans,
                Some(GeneratorMethodGuard {
                    source: None,
                    owner: reflect,
                    method: "apply",
                }),
                1,
            ));
        }
        let (source, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, Some(member.property.name.to_string()))
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, static_member_name(&member.expression))
            }
            _ => (&call.callee, None),
        };
        let guard = match method.as_deref() {
            Some("call") => Some("call"),
            Some("apply") => Some("apply"),
            Some(_) => return None,
            None => None,
        };
        let mut body_spans = BTreeSet::new();
        if !Self::collect_inline_generator_body_spans(source, &mut body_spans) {
            return None;
        }
        let guard = guard.map(|method| GeneratorMethodGuard {
            source: None,
            owner: StaticAliasPath::unresolved_global("Function".to_string())
                .with_property("prototype".to_string()),
            method,
        });
        Some((body_spans, guard, 0))
    }

    fn record_generator_invocation_arguments(&mut self, call: &CallExpression<'_>) {
        let path_target = self.generator_invocation_target(call);
        let body_target = path_target
            .is_none()
            .then(|| self.inline_generator_invocation_target(call))
            .flatten();
        let skip = path_target
            .as_ref()
            .map(|(_, _, skip)| *skip)
            .or_else(|| body_target.as_ref().map(|(_, _, skip)| *skip));
        let Some(skip) = skip else {
            return;
        };
        for argument in call.arguments.iter().skip(skip) {
            if let Some(argument) = argument.as_expression() {
                if let Some((target, guard, _)) = &path_target {
                    self.record_retained_callable_source(
                        target.clone(),
                        argument,
                        guard.as_ref(),
                        RetainedCallableReadKind::GeneratorInvocation,
                    );
                } else if let Some((body_spans, guard, _)) = &body_target {
                    self.record_retained_generator_body_source(
                        body_spans,
                        argument,
                        guard.as_ref(),
                    );
                }
            } else if let oxc::ast::ast::Argument::SpreadElement(spread) = argument
                && matches!(
                    spread.argument.get_inner_expression(),
                    Expression::ArrayExpression(_)
                )
            {
                if let Some((target, guard, _)) = &path_target {
                    self.record_retained_callable_source(
                        target.clone(),
                        &spread.argument,
                        guard.as_ref(),
                        RetainedCallableReadKind::GeneratorInvocation,
                    );
                } else if let Some((body_spans, guard, _)) = &body_target {
                    self.record_retained_generator_body_source(
                        body_spans,
                        &spread.argument,
                        guard.as_ref(),
                    );
                }
            }
        }
    }

    fn collect_pending_nonexecuting_callable(
        &self,
        expression: &Expression<'_>,
        method: Option<(&StaticAliasPath, &'static str, bool)>,
        actions: &mut Vec<PendingNonExecutingAction>,
    ) -> bool {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            let method_guard =
                method.map(
                    |(owner, method, check_source_method)| GeneratorMethodGuard {
                        source: check_source_method.then_some(source.clone()),
                        owner: owner.clone(),
                        method,
                    },
                );
            actions.push(PendingNonExecutingAction::CallableRead {
                source,
                source_span,
                method_guard,
            });
            return true;
        }
        if method.is_none()
            && let Some((source, source_span)) =
                self.constructed_instance_callable_reference(expression)
        {
            actions.push(PendingNonExecutingAction::CallableRead {
                source,
                source_span,
                method_guard: None,
            });
            return true;
        }
        match expression.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                let Some(body_span) = Self::generator_body_span(function) else {
                    return false;
                };
                let method_guard = method.map(|(owner, method, _)| GeneratorMethodGuard {
                    source: None,
                    owner: owner.clone(),
                    method,
                });
                actions.push(PendingNonExecutingAction::BodySpan {
                    body_span,
                    method_guard,
                });
                true
            }
            Expression::ConditionalExpression(expression) => {
                let consequent = self.collect_pending_nonexecuting_callable(
                    &expression.consequent,
                    method,
                    actions,
                );
                let alternate = self.collect_pending_nonexecuting_callable(
                    &expression.alternate,
                    method,
                    actions,
                );
                consequent || alternate
            }
            Expression::LogicalExpression(expression) => {
                let left =
                    self.collect_pending_nonexecuting_callable(&expression.left, method, actions);
                let right =
                    self.collect_pending_nonexecuting_callable(&expression.right, method, actions);
                left || right
            }
            Expression::SequenceExpression(expression) => {
                expression.expressions.last().is_some_and(|expression| {
                    self.collect_pending_nonexecuting_callable(expression, method, actions)
                })
            }
            _ => false,
        }
    }

    fn collect_pending_discarded_call(
        &self,
        call: &CallExpression<'_>,
        pending: &mut PendingDiscardedInvocations,
    ) {
        let invocation_span = (call.span.start, call.span.end);
        pending.invocation_spans.insert(invocation_span);
        if let Some((source, method_guard, _)) = self.assignment_invocation_target(call) {
            pending
                .nonexecuting_actions
                .push(PendingNonExecutingAction::CallableRead {
                    source,
                    source_span: invocation_span,
                    method_guard,
                });
            return;
        }
        if !call.optional {
            let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
            if static_alias_source_path(self.scoping, &call.callee)
                .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
                && let Some(target) = call
                    .arguments
                    .first()
                    .and_then(|argument| argument.as_expression())
                && self.collect_pending_nonexecuting_callable(
                    target,
                    Some((&reflect, "apply", false)),
                    &mut pending.nonexecuting_actions,
                )
            {
                return;
            }
            let indirect = match unwrap_transparent_call_expression(&call.callee) {
                Expression::StaticMemberExpression(member) if !member.optional => {
                    match member.property.name.as_str() {
                        "call" => Some((&member.object, "call")),
                        "apply" => Some((&member.object, "apply")),
                        _ => None,
                    }
                }
                Expression::ComputedMemberExpression(member) if !member.optional => {
                    static_member_name(&member.expression).and_then(|method| {
                        match method.as_str() {
                            "call" => Some((&member.object, "call")),
                            "apply" => Some((&member.object, "apply")),
                            _ => None,
                        }
                    })
                }
                _ => None,
            };
            if let Some((target, method @ ("call" | "apply"))) = indirect {
                let function_prototype = StaticAliasPath::unresolved_global("Function".to_string())
                    .with_property("prototype".to_string());
                if self.collect_pending_nonexecuting_callable(
                    target,
                    Some((&function_prototype, method, true)),
                    &mut pending.nonexecuting_actions,
                ) {
                    return;
                }
            }
        }
        self.collect_pending_nonexecuting_callable(
            &call.callee,
            None,
            &mut pending.nonexecuting_actions,
        );
    }

    fn pending_discarded_invocations(
        &self,
        expression: &Expression<'_>,
    ) -> Option<PendingDiscardedInvocations> {
        fn collect(
            collector: &ExecutionStateCollector<'_>,
            expression: &Expression<'_>,
            pending: &mut PendingDiscardedInvocations,
        ) {
            match expression.get_inner_expression() {
                Expression::CallExpression(call) => {
                    collector.collect_pending_discarded_call(call, pending);
                }
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::CallExpression(call) => {
                        collector.collect_pending_discarded_call(call, pending);
                    }
                    ChainElement::StaticMemberExpression(member) => {
                        collect(collector, &member.object, pending);
                    }
                    ChainElement::ComputedMemberExpression(member) => {
                        collect(collector, &member.object, pending);
                    }
                    ChainElement::PrivateFieldExpression(member) => {
                        collect(collector, &member.object, pending);
                    }
                    ChainElement::TSNonNullExpression(_) => {}
                },
                Expression::TaggedTemplateExpression(tagged) => {
                    let invocation_span = (tagged.span.start, tagged.span.end);
                    pending.invocation_spans.insert(invocation_span);
                    if let Some(source) = collector.assignment_callable_target(&tagged.tag) {
                        pending.nonexecuting_actions.push(
                            PendingNonExecutingAction::CallableRead {
                                source,
                                source_span: invocation_span,
                                method_guard: None,
                            },
                        );
                    } else {
                        collector.collect_pending_nonexecuting_callable(
                            &tagged.tag,
                            None,
                            &mut pending.nonexecuting_actions,
                        );
                    }
                }
                Expression::ConditionalExpression(expression) => {
                    collect(collector, &expression.consequent, pending);
                    collect(collector, &expression.alternate, pending);
                }
                Expression::LogicalExpression(expression) => {
                    collect(collector, &expression.left, pending);
                    collect(collector, &expression.right, pending);
                }
                Expression::SequenceExpression(expression) => {
                    if let Some(expression) = expression.expressions.last() {
                        collect(collector, expression, pending);
                    }
                }
                Expression::StaticMemberExpression(expression) => {
                    collect(collector, &expression.object, pending);
                }
                Expression::ComputedMemberExpression(expression) => {
                    collect(collector, &expression.object, pending);
                }
                Expression::PrivateFieldExpression(expression) => {
                    collect(collector, &expression.object, pending);
                }
                Expression::ArrayExpression(expression) => {
                    for element in &expression.elements {
                        if matches!(
                            element,
                            ArrayExpressionElement::Elision(_)
                                | ArrayExpressionElement::SpreadElement(_)
                        ) {
                            continue;
                        }
                        collect(collector, element.to_expression(), pending);
                    }
                }
                Expression::ObjectExpression(expression) => {
                    for property in &expression.properties {
                        let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                            continue;
                        };
                        collect(collector, &property.value, pending);
                    }
                }
                _ => {
                    collector.collect_pending_nonexecuting_callable(
                        expression,
                        None,
                        &mut pending.nonexecuting_actions,
                    );
                }
            }
        }

        let mut pending = PendingDiscardedInvocations::default();
        collect(self, expression, &mut pending);
        (!pending.invocation_spans.is_empty() || !pending.nonexecuting_actions.is_empty())
            .then_some(pending)
    }

    fn record_nonexecuting_actions(&mut self, actions: Vec<PendingNonExecutingAction>) {
        for action in actions {
            match action {
                PendingNonExecutingAction::CallableRead {
                    source,
                    source_span,
                    method_guard: Some(method_guard),
                } => self.guarded_discarded_invocation_reads.push((
                    source,
                    source_span,
                    method_guard,
                )),
                PendingNonExecutingAction::CallableRead {
                    source,
                    source_span,
                    method_guard: None,
                } => {
                    self.discarded_invocation_reads
                        .entry(source)
                        .or_default()
                        .insert(source_span);
                }
                PendingNonExecutingAction::BodySpan {
                    body_span,
                    method_guard: Some(method_guard),
                } => self
                    .guarded_unexecuted_body_spans
                    .push((body_span, method_guard)),
                PendingNonExecutingAction::BodySpan {
                    body_span,
                    method_guard: None,
                } => {
                    self.directly_unexecuted_body_spans.insert(body_span);
                }
            }
        }
    }

    fn record_discarded_invocations(&mut self, pending: PendingDiscardedInvocations) {
        self.discarded_invocation_spans
            .extend(pending.invocation_spans);
        self.record_nonexecuting_actions(pending.nonexecuting_actions);
    }

    fn record_retained_invocations(
        &mut self,
        target: StaticAliasPath,
        expression: &Expression<'_>,
    ) {
        let Some(pending) = self.pending_discarded_invocations(expression) else {
            return;
        };
        if pending.nonexecuting_actions.is_empty() {
            return;
        }
        for action in pending.nonexecuting_actions {
            match action {
                PendingNonExecutingAction::CallableRead {
                    source,
                    source_span,
                    method_guard,
                } => self.generator_result_reads.push(ForwardedCallableRead {
                    source,
                    source_span,
                    target: target.clone(),
                    method_guard,
                    parameter_offset: None,
                }),
                PendingNonExecutingAction::BodySpan {
                    body_span,
                    method_guard,
                } => {
                    if self.generator_body_targets.iter().any(
                        |(candidate_span, candidate_target)| {
                            *candidate_span == body_span
                                && candidate_target != &target
                                && candidate_target.starts_with(&target)
                        },
                    ) {
                        continue;
                    }
                    self.generator_body_targets
                        .push((body_span, target.clone()));
                    if let Some(method_guard) = method_guard {
                        self.guarded_generator_targets
                            .push((target.clone(), method_guard));
                    }
                }
            }
        }
        self.retained_invocation_spans
            .push(RetainedInvocationSpans {
                target,
                invocation_spans: pending.invocation_spans,
            });
    }

    fn record_pending_callable_argument(
        &mut self,
        expression: &Expression<'_>,
        callee: Option<&StaticAliasPath>,
        inline_parameters: Option<&NonConsumingParameters>,
        parameter_index: usize,
        result_discarded: bool,
        method_guard: Option<&GeneratorMethodGuard>,
    ) {
        let parameter_sources = inline_parameters
            .map(|parameters| {
                vec![PendingParameterSource::Inline {
                    parameters: parameters.clone(),
                    parameter_offset: 0,
                    method_guards: Vec::new(),
                }]
            })
            .or_else(|| {
                callee.map(|callee| {
                    vec![PendingParameterSource::Local {
                        source: callee.clone(),
                        parameter_offset: 0,
                        method_guards: Vec::new(),
                    }]
                })
            });
        self.record_pending_callable_value(
            expression,
            parameter_sources.as_deref(),
            PendingParameterSelection::Index(parameter_index),
            result_discarded,
            method_guard,
        );
    }

    fn record_pending_callable_argument_sources(
        &mut self,
        expression: &Expression<'_>,
        parameter_sources: &[PendingParameterSource],
        parameter_index: usize,
        result_discarded: bool,
        method_guard: Option<&GeneratorMethodGuard>,
    ) {
        self.record_pending_callable_value(
            expression,
            Some(parameter_sources),
            PendingParameterSelection::Index(parameter_index),
            result_discarded,
            method_guard,
        );
    }

    fn record_pending_callable_argument_list(
        &mut self,
        expression: &Expression<'_>,
        callee: Option<&StaticAliasPath>,
        inline_parameters: Option<&NonConsumingParameters>,
        result_discarded: bool,
        method_guard: Option<&GeneratorMethodGuard>,
    ) {
        match expression.get_inner_expression() {
            Expression::ArrayExpression(expression) => {
                for element in &expression.elements {
                    if matches!(
                        element,
                        ArrayExpressionElement::Elision(_)
                            | ArrayExpressionElement::SpreadElement(_)
                    ) {
                        continue;
                    }
                    self.record_pending_callable_argument_list(
                        element.to_expression(),
                        callee,
                        inline_parameters,
                        result_discarded,
                        method_guard,
                    );
                }
            }
            Expression::ObjectExpression(expression) => {
                for property in &expression.properties {
                    let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    self.record_pending_callable_argument_list(
                        &property.value,
                        callee,
                        inline_parameters,
                        result_discarded,
                        method_guard,
                    );
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.record_pending_callable_argument_list(
                    &expression.consequent,
                    callee,
                    inline_parameters,
                    result_discarded,
                    method_guard,
                );
                self.record_pending_callable_argument_list(
                    &expression.alternate,
                    callee,
                    inline_parameters,
                    result_discarded,
                    method_guard,
                );
            }
            Expression::LogicalExpression(expression) => {
                self.record_pending_callable_argument_list(
                    &expression.left,
                    callee,
                    inline_parameters,
                    result_discarded,
                    method_guard,
                );
                self.record_pending_callable_argument_list(
                    &expression.right,
                    callee,
                    inline_parameters,
                    result_discarded,
                    method_guard,
                );
            }
            Expression::SequenceExpression(expression) => {
                if let Some(expression) = expression.expressions.last() {
                    self.record_pending_callable_argument_list(
                        expression,
                        callee,
                        inline_parameters,
                        result_discarded,
                        method_guard,
                    );
                }
            }
            _ => {
                let parameter_sources = inline_parameters
                    .map(|parameters| {
                        vec![PendingParameterSource::Inline {
                            parameters: parameters.clone(),
                            parameter_offset: 0,
                            method_guards: Vec::new(),
                        }]
                    })
                    .or_else(|| {
                        callee.map(|callee| {
                            vec![PendingParameterSource::Local {
                                source: callee.clone(),
                                parameter_offset: 0,
                                method_guards: Vec::new(),
                            }]
                        })
                    });
                self.record_pending_callable_value(
                    expression,
                    parameter_sources.as_deref(),
                    PendingParameterSelection::All,
                    result_discarded,
                    method_guard,
                );
            }
        }
    }

    fn record_pending_callable_value(
        &mut self,
        expression: &Expression<'_>,
        parameter_sources: Option<&[PendingParameterSource]>,
        parameter_selection: PendingParameterSelection,
        result_discarded: bool,
        method_guard: Option<&GeneratorMethodGuard>,
    ) {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            if self
                .retained_callable_reads
                .iter()
                .any(|retained| retained.source == source && retained.source_span == source_span)
                || self.generator_argument_reads.iter().any(|retained| {
                    retained.source == source
                        && retained.source_span == source_span
                        && retained.source == retained.target
                })
                || self
                    .non_escaping_callable_reads
                    .contains(&(source.clone(), source_span))
                || self
                    .initial_generator_next_argument_reads
                    .iter()
                    .any(|read| read.source == source && read.source_span == source_span)
            {
                return;
            }
            self.pending_callable_argument_reads
                .push(PendingCallableArgumentRead {
                    value: PendingCallableArgumentValue::Reference {
                        source,
                        source_span,
                    },
                    parameter_sources: parameter_sources.map(<[_]>::to_vec),
                    parameter_selection,
                    result_discarded,
                    method_guard: method_guard.cloned(),
                });
            return;
        }
        let nested = match expression.get_inner_expression() {
            Expression::ArrayExpression(expression) => expression
                .elements
                .iter()
                .filter_map(|element| match element {
                    ArrayExpressionElement::Elision(_)
                    | ArrayExpressionElement::SpreadElement(_) => None,
                    _ => Some(element.to_expression()),
                })
                .collect::<Vec<_>>(),
            Expression::ObjectExpression(expression) => expression
                .properties
                .iter()
                .filter_map(|property| match property {
                    OxcObjectPropertyKind::ObjectProperty(property) => Some(&property.value),
                    OxcObjectPropertyKind::SpreadProperty(_) => None,
                })
                .collect::<Vec<_>>(),
            Expression::ConditionalExpression(expression) => {
                vec![&expression.consequent, &expression.alternate]
            }
            Expression::LogicalExpression(expression) => {
                vec![&expression.left, &expression.right]
            }
            Expression::SequenceExpression(expression) => {
                expression.expressions.last().into_iter().collect()
            }
            Expression::AssignmentExpression(_) => return,
            _ => Vec::new(),
        };
        if !nested.is_empty() {
            for expression in nested {
                self.record_pending_callable_value(
                    expression,
                    parameter_sources,
                    parameter_selection,
                    result_discarded,
                    method_guard,
                );
            }
            return;
        }
        let Some(pending) = self.pending_discarded_invocations(expression) else {
            return;
        };
        self.pending_callable_argument_reads
            .push(PendingCallableArgumentRead {
                value: PendingCallableArgumentValue::Invocations(pending),
                parameter_sources: parameter_sources.map(<[_]>::to_vec),
                parameter_selection,
                result_discarded,
                method_guard: method_guard.cloned(),
            });
    }

    fn inline_indirect_callable_target(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(NonConsumingParameters, GeneratorMethodGuard, usize)> {
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            let parameters = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|target| self.inline_non_consuming_parameters(target))?;
            return Some((
                parameters,
                GeneratorMethodGuard {
                    source: None,
                    owner: reflect,
                    method: "apply",
                },
                1,
            ));
        }
        let (target, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => match member.property.name.as_str() {
                "call" => (&member.object, "call"),
                "apply" => (&member.object, "apply"),
                _ => return None,
            },
            Expression::ComputedMemberExpression(member) => {
                let method = match static_member_name(&member.expression)?.as_str() {
                    "call" => "call",
                    "apply" => "apply",
                    _ => return None,
                };
                (&member.object, method)
            }
            _ => return None,
        };
        Some((
            self.inline_non_consuming_parameters(target)?,
            GeneratorMethodGuard {
                source: None,
                owner: StaticAliasPath::unresolved_global("Function".to_string())
                    .with_property("prototype".to_string()),
                method,
            },
            0,
        ))
    }

    fn pending_indirect_parameter_sources(
        &self,
        target: &Expression<'_>,
        method: &'static str,
    ) -> Option<Vec<PendingParameterSource>> {
        match target.get_inner_expression() {
            Expression::ConditionalExpression(expression) => {
                let mut sources =
                    self.pending_indirect_parameter_sources(&expression.consequent, method)?;
                sources.extend(
                    self.pending_indirect_parameter_sources(&expression.alternate, method)?,
                );
                return Some(sources);
            }
            Expression::LogicalExpression(expression) => {
                let mut sources =
                    self.pending_indirect_parameter_sources(&expression.left, method)?;
                sources.extend(self.pending_indirect_parameter_sources(&expression.right, method)?);
                return Some(sources);
            }
            Expression::SequenceExpression(expression) => {
                return self
                    .pending_indirect_parameter_sources(expression.expressions.last()?, method);
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                return self.pending_indirect_parameter_sources(&expression.right, method);
            }
            _ => {}
        }
        let guard = GeneratorMethodGuard {
            source: self.callable_reference(target).map(|(source, _)| source),
            owner: StaticAliasPath::unresolved_global("Function".to_string())
                .with_property("prototype".to_string()),
            method,
        };
        let mut sources = self
            .pending_bound_parameter_sources(target, false)
            .or_else(|| self.pending_parameter_sources(target, false))?;
        for source in &mut sources {
            match source {
                PendingParameterSource::Local { method_guards, .. }
                | PendingParameterSource::Inline { method_guards, .. } => {
                    method_guards.push(guard.clone());
                }
            }
        }
        Some(sources)
    }

    fn composite_indirect_callable_target(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(Vec<PendingParameterSource>, GeneratorMethodGuard, usize)> {
        let (target, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let method = static_member_name(&member.expression)?;
                let method = match method.as_str() {
                    "call" => "call",
                    "apply" => "apply",
                    _ => return None,
                };
                (&member.object, method)
            }
            _ => return None,
        };
        let method = match method {
            "call" => "call",
            "apply" => "apply",
            _ => return None,
        };
        let owner = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        Some((
            self.pending_indirect_parameter_sources(target, method)?,
            GeneratorMethodGuard {
                source: None,
                owner,
                method,
            },
            0,
        ))
    }

    fn record_pending_indirect_callable_arguments(
        &mut self,
        call: &CallExpression<'_>,
        parameters: PendingInvocationParameters<'_>,
        guard: &GeneratorMethodGuard,
        receiver_index: usize,
        result_discarded: bool,
    ) {
        if let Some(receiver) = call
            .arguments
            .get(receiver_index)
            .and_then(|argument| argument.as_expression())
        {
            self.record_pending_callable_argument(receiver, None, None, 0, false, None);
        }
        if guard.method == "call" {
            for (parameter_index, argument) in call
                .arguments
                .iter()
                .skip(receiver_index + 1)
                .take_while(|argument| argument.as_expression().is_some())
                .enumerate()
            {
                let argument = argument.as_expression().expect("ordinary call argument");
                match parameters {
                    PendingInvocationParameters::Local(callee) => self
                        .record_pending_callable_argument(
                            argument,
                            Some(callee),
                            None,
                            parameter_index,
                            result_discarded,
                            Some(guard),
                        ),
                    PendingInvocationParameters::Inline(inline_parameters) => self
                        .record_pending_callable_argument(
                            argument,
                            None,
                            Some(inline_parameters),
                            parameter_index,
                            result_discarded,
                            Some(guard),
                        ),
                    PendingInvocationParameters::Sources(parameter_sources) => self
                        .record_pending_callable_argument_sources(
                            argument,
                            parameter_sources,
                            parameter_index,
                            result_discarded,
                            Some(guard),
                        ),
                }
            }
        } else if let Some(argument_list) = call
            .arguments
            .get(receiver_index + 1)
            .and_then(|argument| argument.as_expression())
        {
            let (callee, inline_parameters, parameter_sources) = match parameters {
                PendingInvocationParameters::Local(callee) => (Some(callee), None, None),
                PendingInvocationParameters::Inline(parameters) => (None, Some(parameters), None),
                PendingInvocationParameters::Sources(sources) => (None, None, Some(sources)),
            };
            self.record_pending_indirect_argument_list(
                argument_list,
                callee,
                inline_parameters,
                parameter_sources,
                result_discarded,
                guard,
            );
        }
    }

    fn record_pending_indirect_argument_list(
        &mut self,
        argument_list: &Expression<'_>,
        callee: Option<&StaticAliasPath>,
        inline_parameters: Option<&NonConsumingParameters>,
        parameter_sources: Option<&[PendingParameterSource]>,
        result_discarded: bool,
        guard: &GeneratorMethodGuard,
    ) {
        let Expression::ArrayExpression(arguments) = argument_list.get_inner_expression() else {
            if let Some(parameter_sources) = parameter_sources {
                self.record_pending_callable_value(
                    argument_list,
                    Some(parameter_sources),
                    PendingParameterSelection::All,
                    result_discarded,
                    Some(guard),
                );
            } else {
                self.record_pending_callable_argument_list(
                    argument_list,
                    callee,
                    inline_parameters,
                    result_discarded,
                    Some(guard),
                );
            }
            return;
        };
        let mut stable_parameter_positions = true;
        for (parameter_index, argument) in arguments.elements.iter().enumerate() {
            match argument {
                ArrayExpressionElement::Elision(_) => {}
                ArrayExpressionElement::SpreadElement(_) => {
                    stable_parameter_positions = false;
                }
                _ if stable_parameter_positions => {
                    if let Some(parameter_sources) = parameter_sources {
                        self.record_pending_callable_argument_sources(
                            argument.to_expression(),
                            parameter_sources,
                            parameter_index,
                            result_discarded,
                            Some(guard),
                        );
                    } else {
                        self.record_pending_callable_argument(
                            argument.to_expression(),
                            callee,
                            inline_parameters,
                            parameter_index,
                            result_discarded,
                            Some(guard),
                        );
                    }
                }
                _ => self.record_escaped_callable_path(argument.to_expression()),
            }
        }
    }

    fn record_pending_reflect_apply_arguments(
        &mut self,
        call: &CallExpression<'_>,
        result_discarded: bool,
    ) -> bool {
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        let apply = reflect.clone().with_property("apply".to_string());
        if !self.callable_resolves_to_path(Self::immediate_callable_value(&call.callee), &apply) {
            return false;
        }
        let Some(target) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return true;
        };
        let target = Self::immediate_callable_value(target);
        let callee = self.callable_reference(target).map(|(callee, _)| callee);
        let inline_parameters = callee
            .is_none()
            .then(|| self.inline_non_consuming_parameters(target))
            .flatten();
        let parameter_sources = (callee.is_none() && inline_parameters.is_none())
            .then(|| {
                self.pending_bound_parameter_sources(target, false)
                    .or_else(|| self.pending_parameter_sources(target, false))
            })
            .flatten();
        if let Some(receiver) = call
            .arguments
            .get(1)
            .and_then(|argument| argument.as_expression())
        {
            self.record_pending_callable_argument(receiver, None, None, 0, false, None);
        }
        let Some(argument_list) = call
            .arguments
            .get(2)
            .and_then(|argument| argument.as_expression())
        else {
            return true;
        };
        let guard = GeneratorMethodGuard {
            source: None,
            owner: reflect,
            method: "apply",
        };
        self.record_pending_indirect_argument_list(
            argument_list,
            callee.as_ref(),
            inline_parameters.as_ref(),
            parameter_sources.as_deref(),
            result_discarded,
            &guard,
        );
        true
    }

    fn record_pending_reflect_construct_arguments(
        &mut self,
        call: &CallExpression<'_>,
        result_discarded: bool,
    ) -> bool {
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        let construct = reflect.clone().with_property("construct".to_string());
        if !self.callable_resolves_to_path(Self::immediate_callable_value(&call.callee), &construct)
        {
            return false;
        }
        let Some(target) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return true;
        };
        let target = Self::immediate_callable_value(target);
        let callee = self.callable_reference(target).map(|(callee, _)| callee);
        let inline_parameters = if callee.is_some() {
            None
        } else {
            match target.get_inner_expression() {
                Expression::ClassExpression(class) => {
                    self.local_non_consuming_class_parameters(class.as_ref())
                }
                _ => self.inline_non_consuming_parameters(target),
            }
        };
        let parameter_sources = (callee.is_none() && inline_parameters.is_none())
            .then(|| {
                self.pending_bound_parameter_sources(target, true)
                    .or_else(|| self.pending_parameter_sources(target, true))
            })
            .flatten();
        let Some(argument_list) = call
            .arguments
            .get(1)
            .and_then(|argument| argument.as_expression())
        else {
            return true;
        };
        let guard = GeneratorMethodGuard {
            source: None,
            owner: reflect,
            method: "construct",
        };
        self.record_pending_indirect_argument_list(
            argument_list,
            callee.as_ref(),
            inline_parameters.as_ref(),
            parameter_sources.as_deref(),
            result_discarded,
            &guard,
        );
        true
    }

    fn object_value_enumeration_method(&self, call: &CallExpression<'_>) -> Option<&'static str> {
        let object = StaticAliasPath::unresolved_global("Object".to_string());
        ["values", "entries"].into_iter().find(|method| {
            self.callable_resolves_to_path(
                Self::immediate_callable_value(&call.callee),
                &object.clone().with_property((*method).to_string()),
            ) && self.method_path_is_intact(&object, method)
        })
    }

    fn object_entries_round_trip_source<'a>(
        &self,
        expression: &'a Expression<'a>,
    ) -> Option<(&'a CallExpression<'a>, &'a Expression<'a>)> {
        let Expression::CallExpression(call) = expression.get_inner_expression() else {
            return None;
        };
        if self.object_value_enumeration_method(call) != Some("entries")
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return None;
        }
        let source = call.arguments.first()?.as_expression()?;
        Some((call, source))
    }

    fn is_intact_object_from_entries_call(&self, call: &CallExpression<'_>) -> bool {
        let object = StaticAliasPath::unresolved_global("Object".to_string());
        let array_prototype = StaticAliasPath::unresolved_global("Array".to_string())
            .with_property("prototype".to_string());
        self.callable_resolves_to_path(
            Self::immediate_callable_value(&call.callee),
            &object.clone().with_property("fromEntries".to_string()),
        ) && self.method_path_is_intact(&object, "fromEntries")
            && self.method_path_is_intact(&array_prototype, "[Symbol.iterator]")
    }

    fn record_static_from_entries_source(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let Some(entries) = static_from_entries_pairs(initializer) else {
            return;
        };
        let mut values = BTreeMap::new();
        for (index, (property, value)) in entries.into_iter().enumerate() {
            let snapshot = StaticAliasPath::dynamic_this(value.span())
                .with_property(format!("stored-from-entries-value-{index}"));
            self.record_callable_initializer(snapshot.clone(), value);
            values.insert(property, snapshot);
        }
        self.static_from_entries_sources
            .insert(target.clone(), values);
    }

    fn stored_static_from_entries_values(
        &self,
        expression: &Expression<'_>,
    ) -> Option<StoredStaticFromEntriesValues> {
        let (source, source_span) = self.callable_reference(expression)?;
        if !self.method_path_is_intact(&source, "") {
            return None;
        }
        self.related_callable_paths(&source)
            .into_iter()
            .find_map(|candidate| {
                (self.is_immutable_local_callable_target(&candidate)
                    && self.method_path_is_intact(&candidate, ""))
                .then(|| {
                    self.static_from_entries_sources
                        .get(&candidate)
                        .cloned()
                        .map(|values| StoredStaticFromEntriesValues {
                            source: candidate,
                            source_span,
                            values,
                        })
                })
                .flatten()
            })
    }

    fn record_static_object_entries_source(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let Some((call, source)) = self.object_entries_round_trip_source(initializer) else {
            return;
        };
        let snapshot = StaticAliasPath::dynamic_this(call.span)
            .with_property("stored-object-entries-source".to_string());
        self.record_callable_initializer(snapshot.clone(), source);
        self.static_object_entries_sources
            .insert(target.clone(), snapshot);
    }

    fn stored_object_entries_round_trip(
        &self,
        expression: &Expression<'_>,
    ) -> Option<StoredObjectEntriesRoundTrip> {
        let (container, container_span) = self.callable_reference(expression)?;
        if !self.method_path_is_intact(&container, "") {
            return None;
        }
        self.related_callable_paths(&container)
            .into_iter()
            .find_map(|candidate| {
                (self.is_immutable_local_callable_target(&candidate)
                    && self.method_path_is_intact(&candidate, ""))
                .then(|| {
                    self.static_object_entries_sources
                        .get(&candidate)
                        .cloned()
                        .map(|source| StoredObjectEntriesRoundTrip {
                            container: candidate,
                            container_span,
                            source,
                        })
                })
                .flatten()
            })
    }

    fn property_descriptor_method(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<(&'static str, &'static str)> {
        for (owner, method) in [
            ("Object", "getOwnPropertyDescriptor"),
            ("Object", "getOwnPropertyDescriptors"),
            ("Reflect", "getOwnPropertyDescriptor"),
        ] {
            let owner_path = StaticAliasPath::unresolved_global(owner.to_string());
            if self.callable_resolves_to_path(
                Self::immediate_callable_value(&call.callee),
                &owner_path.clone().with_property(method.to_string()),
            ) && self.method_path_is_intact(&owner_path, method)
            {
                return Some((owner, method));
            }
        }
        None
    }

    fn record_discarded_inline_enumerated_value(
        &mut self,
        target: StaticAliasPath,
        expression: &Expression<'_>,
    ) {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            self.record_merely_observed_value_read(source, source_span);
            return;
        }
        match expression.get_inner_expression() {
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => {
                self.explicitly_merely_observed_callable_paths
                    .insert(target);
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        OxcObjectPropertyKind::ObjectProperty(property)
                            if property.kind == PropertyKind::Init =>
                        {
                            let Some(name) = property.key.static_name() else {
                                continue;
                            };
                            self.record_discarded_inline_enumerated_value(
                                target.clone().with_property(name.into_owned()),
                                &property.value,
                            );
                        }
                        OxcObjectPropertyKind::SpreadProperty(spread) => {
                            self.record_discarded_enumerated_value(&spread.argument);
                        }
                        OxcObjectPropertyKind::ObjectProperty(_) => {}
                    }
                }
            }
            Expression::ArrayExpression(array) => {
                for (index, element) in array.elements.iter().enumerate() {
                    match element {
                        ArrayExpressionElement::Elision(_) => {}
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.record_discarded_enumerated_value(&spread.argument);
                        }
                        element => self.record_discarded_inline_enumerated_value(
                            target.clone().with_property(index.to_string()),
                            element.to_expression(),
                        ),
                    }
                }
            }
            Expression::ConditionalExpression(expression) => {
                self.record_discarded_inline_enumerated_value(
                    target.clone(),
                    &expression.consequent,
                );
                self.record_discarded_inline_enumerated_value(target, &expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.record_discarded_inline_enumerated_value(target.clone(), &expression.left);
                self.record_discarded_inline_enumerated_value(target, &expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(value) = expression.expressions.last() {
                    self.record_discarded_inline_enumerated_value(target, value);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_discarded_inline_enumerated_value(target, &expression.right);
            }
            _ => {}
        }
    }

    fn record_discarded_enumerated_value(&mut self, expression: &Expression<'_>) {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            self.record_merely_observed_value_read(source, source_span);
            return;
        }
        match expression.get_inner_expression() {
            Expression::ObjectExpression(object) => {
                let target = StaticAliasPath::dynamic_this(object.span);
                self.record_discarded_inline_enumerated_value(target, expression);
            }
            Expression::ArrayExpression(array) => {
                let target = StaticAliasPath::dynamic_this(array.span);
                self.record_discarded_inline_enumerated_value(target, expression);
            }
            Expression::ConditionalExpression(expression) => {
                self.record_discarded_enumerated_value(&expression.consequent);
                self.record_discarded_enumerated_value(&expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.record_discarded_enumerated_value(&expression.left);
                self.record_discarded_enumerated_value(&expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(value) = expression.expressions.last() {
                    self.record_discarded_enumerated_value(value);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_discarded_enumerated_value(&expression.right);
            }
            _ => self.record_discarded_value_read(expression),
        }
    }

    fn record_discarded_object_value_enumeration(&mut self, call: &CallExpression<'_>) -> bool {
        if self.object_value_enumeration_method(call).is_none()
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        if let Some(source) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        {
            self.record_discarded_enumerated_value(source);
        }
        for argument in call.arguments.iter().skip(1) {
            self.record_discarded_expression(
                argument
                    .as_expression()
                    .expect("enumeration spread arguments were rejected"),
            );
        }
        true
    }

    fn record_property_descriptor_arguments(
        &mut self,
        call: &CallExpression<'_>,
        result_discarded: bool,
    ) -> bool {
        let Some((_, method)) = self.property_descriptor_method(call) else {
            return false;
        };
        if call
            .arguments
            .iter()
            .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let Some(source) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return true;
        };
        if method == "getOwnPropertyDescriptor"
            && call
                .arguments
                .get(1)
                .and_then(|argument| argument.as_expression())
                .is_some_and(|property| static_member_name(property).is_none())
        {
            return false;
        }
        // Reading a descriptor preserves data/accessor function identities without invoking
        // them. The alias collector activates a selected function only when the returned
        // descriptor field is subsequently called.
        self.record_discarded_enumerated_value(source);
        for (index, argument) in call.arguments.iter().enumerate().skip(1) {
            let argument = argument
                .as_expression()
                .expect("descriptor spread arguments were rejected");
            if method == "getOwnPropertyDescriptor" && index == 1 {
                // ToPropertyKey may execute user-defined coercion hooks.
                self.record_pending_callable_argument(
                    argument,
                    None,
                    None,
                    index,
                    result_discarded,
                    None,
                );
            } else {
                // Surplus arguments are evaluated but ignored by the builtin.
                self.record_discarded_expression(argument);
            }
        }
        true
    }

    fn record_object_from_entries_arguments(&mut self, call: &CallExpression<'_>) -> bool {
        if !self.is_intact_object_from_entries_call(call)
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let Some(source) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return false;
        };
        if let Some(values) = static_from_entries_pairs(source) {
            for (_, value) in values {
                self.record_discarded_enumerated_value(value);
            }
            let Expression::ArrayExpression(entries) = source.get_inner_expression() else {
                unreachable!("static fromEntries pairs require an array expression");
            };
            for entry in &entries.elements {
                let Expression::ArrayExpression(entry) =
                    entry.to_expression().get_inner_expression()
                else {
                    unreachable!("static fromEntries pairs require array entries");
                };
                for item in entry.elements.iter().skip(2) {
                    if !matches!(item, ArrayExpressionElement::Elision(_)) {
                        self.record_discarded_expression(item.to_expression());
                    }
                }
            }
        } else if let Some(stored) = self.stored_static_from_entries_values(source) {
            self.record_merely_observed_value_read(stored.source, stored.source_span);
        } else if let Some(stored) = self.stored_object_entries_round_trip(source) {
            self.record_merely_observed_value_read(stored.container, stored.container_span);
        } else if let Some((enumeration, source)) = self.object_entries_round_trip_source(source) {
            self.record_discarded_enumerated_value(source);
            self.non_retaining_object_value_enumeration_calls
                .insert((enumeration.span.start, enumeration.span.end));
            for argument in enumeration.arguments.iter().skip(1) {
                self.record_discarded_expression(
                    argument
                        .as_expression()
                        .expect("Object.entries spread arguments were rejected"),
                );
            }
        } else {
            return false;
        }
        for argument in call.arguments.iter().skip(1) {
            self.record_discarded_expression(
                argument
                    .as_expression()
                    .expect("fromEntries spread arguments were rejected"),
            );
        }
        true
    }

    fn record_json_serialized_value(&mut self, expression: &Expression<'_>) {
        if let Some((source, source_span)) = self.callable_reference(expression) {
            self.json_serialized_value_paths.insert(source.clone());
            self.record_merely_observed_value_read(source, source_span);
            return;
        }
        match expression.get_inner_expression() {
            Expression::ObjectExpression(object) => {
                let target = StaticAliasPath::dynamic_this(object.span);
                self.json_serialized_value_paths.insert(target.clone());
                self.record_discarded_inline_enumerated_value(target, expression);
            }
            Expression::ArrayExpression(array) => {
                let target = StaticAliasPath::dynamic_this(array.span);
                self.json_serialized_value_paths.insert(target.clone());
                self.record_discarded_inline_enumerated_value(target, expression);
            }
            Expression::ConditionalExpression(expression) => {
                self.record_json_serialized_value(&expression.consequent);
                self.record_json_serialized_value(&expression.alternate);
            }
            Expression::LogicalExpression(expression) => {
                self.record_json_serialized_value(&expression.left);
                self.record_json_serialized_value(&expression.right);
            }
            Expression::SequenceExpression(expression) => {
                if let Some(value) = expression.expressions.last() {
                    self.record_json_serialized_value(value);
                }
            }
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_json_serialized_value(&expression.right);
            }
            Expression::FunctionExpression(function) => {
                self.directly_unexecuted_callable_spans
                    .insert((function.span.start, function.span.end));
            }
            Expression::ArrowFunctionExpression(function) => {
                self.directly_unexecuted_callable_spans
                    .insert((function.span.start, function.span.end));
            }
            _ => self.record_discarded_value_read(expression),
        }
    }

    fn json_replacer_item_is_non_coercive(&self, expression: &Expression<'_>) -> bool {
        match expression.get_inner_expression() {
            Expression::NullLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::RegExpLiteral(_)
            | Expression::FunctionExpression(_)
            | Expression::ArrowFunctionExpression(_)
            | Expression::ClassExpression(_)
            | Expression::ObjectExpression(_)
            | Expression::ArrayExpression(_) => true,
            Expression::ConditionalExpression(expression) => {
                self.json_replacer_item_is_non_coercive(&expression.consequent)
                    && self.json_replacer_item_is_non_coercive(&expression.alternate)
            }
            Expression::LogicalExpression(expression) => {
                self.json_replacer_item_is_non_coercive(&expression.left)
                    && self.json_replacer_item_is_non_coercive(&expression.right)
            }
            Expression::SequenceExpression(expression) => expression
                .expressions
                .last()
                .is_some_and(|value| self.json_replacer_item_is_non_coercive(value)),
            Expression::AssignmentExpression(expression)
                if expression.operator == OxcAssignmentOperator::Assign =>
            {
                self.json_replacer_item_is_non_coercive(&expression.right)
            }
            _ => self
                .callable_reference(expression)
                .is_some_and(|(source, _)| {
                    static_json_replacer_global_item(&source).is_some()
                        || (self.callable_property_is_known(&source)
                            && self.method_path_is_intact(&source, ""))
                }),
        }
    }

    fn inline_json_replacer_array_is_non_coercive(&self, expression: &Expression<'_>) -> bool {
        let Expression::ArrayExpression(array) = expression.get_inner_expression() else {
            return false;
        };
        array.elements.iter().all(|element| match element {
            ArrayExpressionElement::Elision(_) | ArrayExpressionElement::SpreadElement(_) => false,
            element => self.json_replacer_item_is_non_coercive(element.to_expression()),
        })
    }

    fn record_static_json_replacer_array(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        if self.inline_json_replacer_array_is_non_coercive(initializer)
            && let Expression::ArrayExpression(array) = initializer.get_inner_expression()
        {
            self.static_json_replacer_arrays
                .insert(target.clone(), array.elements.len());
        }
    }

    fn record_static_json_replacer_array_mutation(&mut self, call: &CallExpression<'_>) {
        let Some(receiver) = direct_mutating_array_call_receiver(call) else {
            return;
        };
        let Some((source, source_span)) = self.callable_reference(receiver) else {
            return;
        };
        let related = self.related_callable_paths(&source);
        let tracked = self
            .static_json_replacer_arrays
            .keys()
            .filter(|target| related.iter().any(|source| source.overlaps(target)))
            .cloned()
            .collect::<Vec<_>>();
        let safe_push = (|| {
            let [target] = tracked.as_slice() else {
                return None;
            };
            let root = source.binding_root()?;
            if source != StaticAliasPath::root(root)
                || !self.exclusive_json_replacer_arrays.contains(&root)
                || direct_array_push_call_receiver(call).is_none()
            {
                return None;
            }
            let arguments = call
                .arguments
                .iter()
                .map(|argument| argument.as_expression())
                .collect::<Option<Vec<_>>>()?;
            if !arguments
                .iter()
                .all(|argument| self.json_replacer_item_is_non_coercive(argument))
            {
                return None;
            }
            if ["Array", "Object"].into_iter().any(|constructor| {
                !self.method_path_is_intact(
                    &StaticAliasPath::unresolved_global(constructor.to_string())
                        .with_property("prototype".to_string()),
                    "",
                )
            }) {
                return None;
            }
            let guard = GeneratorMethodGuard {
                source: Some(source.clone()),
                owner: StaticAliasPath::unresolved_global("Array".to_string())
                    .with_property("prototype".to_string()),
                method: "push",
            };
            if !self.method_guard_is_intact(&guard) {
                return None;
            }
            let length = *self.static_json_replacer_arrays.get(target)?;
            let new_length = length.checked_add(arguments.len())?;
            Some((target.clone(), length, new_length, arguments, guard))
        })();
        if let Some((target, length, new_length, arguments, guard)) = safe_push {
            self.record_merely_observed_value_read(source, source_span);
            for (offset, argument) in arguments.into_iter().enumerate() {
                self.record_callable_initializer(
                    target.clone().with_property((length + offset).to_string()),
                    argument,
                );
            }
            self.static_json_replacer_arrays.insert(target, new_length);
            self.non_consuming_json_replacer_pushes
                .insert((call.span.start, call.span.end), guard);
            return;
        }
        self.static_json_replacer_arrays
            .retain(|target, _| !related.iter().any(|source| source.overlaps(target)));
    }

    fn json_replacer_is_non_coercive_array(&self, expression: &Expression<'_>) -> bool {
        if self.inline_json_replacer_array_is_non_coercive(expression) {
            return true;
        }
        let Some((source, _)) = self.callable_reference(expression) else {
            return false;
        };
        self.method_path_is_intact(&source, "")
            && self
                .related_callable_paths(&source)
                .into_iter()
                .any(|candidate| {
                    self.is_immutable_local_callable_target(&candidate)
                        && self.method_path_is_intact(&candidate, "")
                        && self.static_json_replacer_arrays.contains_key(&candidate)
                })
    }

    fn is_known_array_value(&self, expression: &Expression<'_>) -> bool {
        match expression.get_inner_expression() {
            Expression::ArrayExpression(_) => true,
            Expression::Identifier(identifier) => identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
                .is_some_and(|symbol| self.known_arrays.contains(&symbol)),
            _ => false,
        }
    }

    fn json_replacer_is_definitely_generator(&self, expression: &Expression<'_>) -> bool {
        if let Expression::FunctionExpression(function) = expression.get_inner_expression() {
            return function.generator;
        }
        let Some((source, _)) = self.callable_reference(expression) else {
            return false;
        };
        let candidates = self
            .related_callable_paths(&source)
            .into_iter()
            .filter(|candidate| {
                self.generator_callable_targets.contains(candidate)
                    || self.non_generator_callable_targets.contains(candidate)
            })
            .collect::<Vec<_>>();
        !candidates.is_empty()
            && candidates.iter().all(|candidate| {
                self.generator_callable_targets.contains(candidate)
                    && !self.non_generator_callable_targets.contains(candidate)
            })
    }

    fn record_json_stringify_arguments(
        &mut self,
        call: &CallExpression<'_>,
        result_discarded: bool,
    ) -> bool {
        let json = StaticAliasPath::unresolved_global("JSON".to_string());
        if !self.callable_resolves_to_path(
            Self::immediate_callable_value(&call.callee),
            &json.clone().with_property("stringify".to_string()),
        ) || !self.method_path_is_intact(&json, "stringify")
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let replacer_is_array = call
            .arguments
            .get(1)
            .and_then(|argument| argument.as_expression())
            .is_some_and(|argument| self.json_replacer_is_non_coercive_array(argument));
        let replacer_is_generator = call
            .arguments
            .get(1)
            .and_then(|argument| argument.as_expression())
            .is_some_and(|argument| self.json_replacer_is_definitely_generator(argument));
        let mut fixed = BTreeMap::from([(0, false), (2, false)]);
        if replacer_is_array {
            fixed.insert(1, false);
        }
        let parameters = NonConsumingParameters {
            fixed,
            safe_tail_start: Some(3),
        };
        for (index, argument) in call.arguments.iter().enumerate() {
            let argument = argument
                .as_expression()
                .expect("JSON.stringify spread arguments were rejected");
            if index == 0 || (index == 1 && replacer_is_array) {
                self.record_json_serialized_value(argument);
            }
            if index == 1 && replacer_is_generator {
                self.record_nonexecuting_callable(argument);
            }
            self.record_pending_callable_argument(
                argument,
                None,
                Some(&parameters),
                index,
                result_discarded,
                None,
            );
        }
        true
    }

    fn record_null_prototype_array_arguments(
        &mut self,
        call: &CallExpression<'_>,
        result_discarded: bool,
    ) -> bool {
        if call.arguments.len() < 2
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let Some(target) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return false;
        };
        if !self.is_known_array_value(target)
            || !call
                .arguments
                .get(1)
                .and_then(|argument| argument.as_expression())
                .is_some_and(|prototype| {
                    matches!(prototype.get_inner_expression(), Expression::NullLiteral(_))
                })
        {
            return false;
        }
        let Some((owner, returns_target)) = [
            (
                StaticAliasPath::unresolved_global("Object".to_string()),
                true,
            ),
            (
                StaticAliasPath::unresolved_global("Reflect".to_string()),
                false,
            ),
        ]
        .into_iter()
        .find(|(owner, _)| {
            self.callable_resolves_to_path(
                Self::immediate_callable_value(&call.callee),
                &owner.clone().with_property("setPrototypeOf".to_string()),
            ) && self.method_path_is_intact(owner, "setPrototypeOf")
        }) else {
            return false;
        };
        let parameters = NonConsumingParameters {
            fixed: BTreeMap::from([(0, returns_target), (1, false)]),
            safe_tail_start: Some(2),
        };
        let guard = GeneratorMethodGuard {
            source: None,
            owner,
            method: "setPrototypeOf",
        };
        for (index, argument) in call.arguments.iter().enumerate() {
            let argument = argument
                .as_expression()
                .expect("proved setPrototypeOf arguments are not spread");
            if index == 0 && (!returns_target || result_discarded) {
                self.record_discarded_enumerated_value(argument);
                continue;
            }
            self.record_pending_callable_argument(
                argument,
                None,
                Some(&parameters),
                index,
                result_discarded,
                Some(&guard),
            );
        }
        true
    }

    fn discarded_builtin_callback_result_guard(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<GeneratorMethodGuard> {
        let (receiver, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.to_string())
            }
            Expression::ComputedMemberExpression(member) => {
                (&member.object, static_member_name(&member.expression)?)
            }
            _ => return None,
        };
        if method != "forEach" {
            return None;
        }
        let known_array = match receiver.get_inner_expression() {
            Expression::ArrayExpression(_) => true,
            Expression::Identifier(identifier) => identifier
                .reference_id
                .get()
                .and_then(|reference| self.scoping.get_reference(reference).symbol_id())
                .is_some_and(|symbol| self.known_arrays.contains(&symbol)),
            _ => false,
        };
        known_array.then(|| GeneratorMethodGuard {
            source: self.callable_reference(receiver).map(|(source, _)| source),
            owner: StaticAliasPath::unresolved_global("Array".to_string())
                .with_property("prototype".to_string()),
            method: "forEach",
        })
    }

    fn record_discarded_callback_argument(
        &mut self,
        expression: &Expression<'_>,
        guard: &GeneratorMethodGuard,
    ) {
        let parameters = NonConsumingParameters {
            fixed: BTreeMap::from([(0, false)]),
            safe_tail_start: Some(1),
        };
        self.record_pending_callable_argument(
            expression,
            None,
            Some(&parameters),
            0,
            false,
            Some(guard),
        );
    }

    fn record_pending_callable_arguments(&mut self, call: &CallExpression<'_>) {
        let result_discarded = self
            .discarded_invocation_spans
            .contains(&(call.span.start, call.span.end));
        if self
            .non_retaining_object_value_enumeration_calls
            .contains(&(call.span.start, call.span.end))
        {
            return;
        }
        if self.record_json_stringify_arguments(call, result_discarded) {
            return;
        }
        if self.record_null_prototype_array_arguments(call, result_discarded) {
            return;
        }
        if self.record_object_from_entries_arguments(call) {
            return;
        }
        if self.record_property_descriptor_arguments(call, result_discarded) {
            return;
        }
        if let Some(guard) = self
            .non_consuming_json_replacer_pushes
            .get(&(call.span.start, call.span.end))
            .cloned()
        {
            let parameters = NonConsumingParameters {
                fixed: BTreeMap::new(),
                safe_tail_start: Some(0),
            };
            for (index, argument) in call.arguments.iter().enumerate() {
                self.record_pending_callable_argument(
                    argument
                        .as_expression()
                        .expect("proved JSON replacer push arguments are not spread"),
                    None,
                    Some(&parameters),
                    index,
                    result_discarded,
                    Some(&guard),
                );
            }
            return;
        }
        if result_discarded && self.record_discarded_object_value_enumeration(call) {
            return;
        }
        let discarded_callback_guard = self.discarded_builtin_callback_result_guard(call);
        if self.record_pending_reflect_construct_arguments(call, result_discarded) {
            return;
        }
        if self.record_pending_reflect_apply_arguments(call, result_discarded) {
            return;
        }
        if let Some((callee, Some(guard), receiver_index)) = self.generator_invocation_target(call)
            && matches!(guard.method, "call" | "apply")
        {
            self.record_pending_indirect_callable_arguments(
                call,
                PendingInvocationParameters::Local(&callee),
                &guard,
                receiver_index,
                result_discarded,
            );
            return;
        }
        if let Some((parameters, guard, receiver_index)) =
            self.inline_indirect_callable_target(call)
        {
            self.record_pending_indirect_callable_arguments(
                call,
                PendingInvocationParameters::Inline(&parameters),
                &guard,
                receiver_index,
                result_discarded,
            );
            return;
        }
        if let Some((parameter_sources, guard, receiver_index)) =
            self.composite_indirect_callable_target(call)
        {
            self.record_pending_indirect_callable_arguments(
                call,
                PendingInvocationParameters::Sources(&parameter_sources),
                &guard,
                receiver_index,
                result_discarded,
            );
            return;
        }
        if let Some(bound) = self.direct_inline_bound_call_parameters(call) {
            if result_discarded {
                for argument in &call.arguments {
                    let Some((source, source_span)) = argument
                        .as_expression()
                        .and_then(|argument| self.callable_reference(argument))
                    else {
                        continue;
                    };
                    self.guarded_discarded_invocation_reads.push((
                        source.clone(),
                        source_span,
                        bound.guard.clone(),
                    ));
                    self.non_escaping_callable_reads
                        .insert((source, source_span));
                }
                return;
            }
            if let Some(receiver) = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
            {
                self.record_pending_callable_argument(receiver, None, None, 0, false, None);
            }
            for (parameter_index, argument) in call.arguments.iter().skip(1).enumerate() {
                self.record_pending_callable_argument(
                    argument.as_expression().expect("ordinary bind argument"),
                    None,
                    Some(&bound.source_parameters),
                    parameter_index,
                    false,
                    Some(&bound.guard),
                );
            }
            return;
        }
        if let Some((parameters, method_guards)) =
            self.inline_bound_non_consuming_parameters(&call.callee)
            && let Some(guard) = method_guards.first()
        {
            for (parameter_index, argument) in call
                .arguments
                .iter()
                .take_while(|argument| argument.as_expression().is_some())
                .enumerate()
            {
                self.record_pending_callable_argument(
                    argument.as_expression().expect("ordinary call argument"),
                    None,
                    Some(&parameters),
                    parameter_index,
                    result_discarded,
                    Some(guard),
                );
            }
            return;
        }
        let callee_value = Self::immediate_callable_value(&call.callee);
        if let Some(parameter_sources) = self.pending_bound_parameter_sources(callee_value, false) {
            for (parameter_index, argument) in call
                .arguments
                .iter()
                .take_while(|argument| argument.as_expression().is_some())
                .enumerate()
            {
                self.record_pending_callable_argument_sources(
                    argument.as_expression().expect("ordinary call argument"),
                    &parameter_sources,
                    parameter_index,
                    result_discarded,
                    None,
                );
            }
            return;
        }
        let callee = self
            .callable_reference(callee_value)
            .map(|(callee, _)| callee);
        let inline_parameters = callee
            .is_none()
            .then(|| self.inline_non_consuming_parameters(callee_value))
            .flatten();
        let parameter_sources = (callee.is_none() && inline_parameters.is_none())
            .then(|| self.pending_parameter_sources(callee_value, false))
            .flatten();
        for (parameter_index, argument) in call
            .arguments
            .iter()
            .take_while(|argument| argument.as_expression().is_some())
            .enumerate()
        {
            let argument = argument.as_expression().expect("ordinary call argument");
            if parameter_index == 0
                && let Some(guard) = discarded_callback_guard.as_ref()
            {
                self.record_discarded_callback_argument(argument, guard);
                continue;
            }
            if let Some(parameter_sources) = parameter_sources.as_deref() {
                self.record_pending_callable_argument_sources(
                    argument,
                    parameter_sources,
                    parameter_index,
                    result_discarded,
                    None,
                );
            } else {
                self.record_pending_callable_argument(
                    argument,
                    callee.as_ref(),
                    inline_parameters.as_ref(),
                    parameter_index,
                    result_discarded,
                    None,
                );
            }
        }
    }

    fn record_pending_tagged_arguments(&mut self, tagged: &TaggedTemplateExpression<'_>) {
        let result_discarded = self
            .discarded_invocation_spans
            .contains(&(tagged.span.start, tagged.span.end));
        let tag_value = Self::immediate_callable_value(&tagged.tag);
        let callee = self.callable_reference(tag_value).map(|(callee, _)| callee);
        let inline_parameters = callee
            .is_none()
            .then(|| self.inline_non_consuming_parameters(tag_value))
            .flatten();
        let parameter_sources = (callee.is_none() && inline_parameters.is_none())
            .then(|| {
                self.pending_bound_parameter_sources(tag_value, false)
                    .or_else(|| self.pending_parameter_sources(tag_value, false))
            })
            .flatten();
        for (index, substitution) in tagged.quasi.expressions.iter().enumerate() {
            if let Some(parameter_sources) = parameter_sources.as_deref() {
                self.record_pending_callable_argument_sources(
                    substitution,
                    parameter_sources,
                    index + 1,
                    result_discarded,
                    None,
                );
            } else {
                self.record_pending_callable_argument(
                    substitution,
                    callee.as_ref(),
                    inline_parameters.as_ref(),
                    index + 1,
                    result_discarded,
                    None,
                );
            }
        }
    }

    fn record_pending_constructor_arguments(&mut self, constructor: &NewExpression<'_>) {
        let result_discarded = self
            .discarded_invocation_spans
            .contains(&(constructor.span.start, constructor.span.end));
        let callee_value = Self::immediate_callable_value(&constructor.callee);
        let callee = self
            .callable_reference(callee_value)
            .map(|(callee, _)| callee);
        let inline_parameters = if callee.is_some() {
            None
        } else {
            match callee_value.get_inner_expression() {
                Expression::ClassExpression(class) => {
                    self.local_non_consuming_class_parameters(class.as_ref())
                }
                _ => self.inline_non_consuming_parameters(callee_value),
            }
        };
        let parameter_sources = (callee.is_none() && inline_parameters.is_none())
            .then(|| {
                self.pending_bound_parameter_sources(callee_value, true)
                    .or_else(|| self.pending_parameter_sources(callee_value, true))
            })
            .flatten();
        let mut stable_parameter_positions = true;
        for (index, argument) in constructor.arguments.iter().enumerate() {
            let Some(argument) = argument.as_expression() else {
                stable_parameter_positions = false;
                continue;
            };
            if stable_parameter_positions {
                if let Some(parameter_sources) = parameter_sources.as_deref() {
                    self.record_pending_callable_argument_sources(
                        argument,
                        parameter_sources,
                        index,
                        result_discarded,
                        None,
                    );
                } else {
                    self.record_pending_callable_argument(
                        argument,
                        callee.as_ref(),
                        inline_parameters.as_ref(),
                        index,
                        result_discarded,
                        None,
                    );
                }
            } else {
                self.record_escaped_callable_path(argument);
            }
        }
    }

    fn record_terminal_generator_method_read(&mut self, call: &CallExpression<'_>) {
        let (source, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.to_string())
            }
            Expression::ComputedMemberExpression(member) => {
                let Some(method) = static_member_name(&member.expression) else {
                    return;
                };
                (&member.object, method)
            }
            _ => return,
        };
        let method = match method.as_str() {
            "return" => "return",
            "throw" => "throw",
            _ => return,
        };
        let Some((source, source_span)) = self.callable_reference(source) else {
            return;
        };
        let guard = GeneratorMethodGuard {
            source: None,
            owner: source.clone(),
            method,
        };
        self.guarded_discarded_invocation_reads
            .push((source.clone(), source_span, guard.clone()));
        for argument in &call.arguments {
            let Some(argument) = argument.as_expression() else {
                continue;
            };
            let Some((argument_source, argument_span)) = self.callable_reference(argument) else {
                continue;
            };
            if argument_source != source {
                continue;
            }
            self.guarded_discarded_invocation_reads.push((
                argument_source.clone(),
                argument_span,
                guard.clone(),
            ));
            self.non_escaping_callable_reads
                .insert((argument_source, argument_span));
        }
    }

    fn terminal_generator_method_reference(
        &self,
        expression: &Expression<'_>,
    ) -> Option<(StaticAliasPath, (u32, u32), StaticAliasPath, &'static str)> {
        let (source, method) = match unwrap_transparent_call_expression(expression) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let method = static_member_name(&member.expression)?;
                let method = match method.as_str() {
                    "return" => "return",
                    "throw" => "throw",
                    _ => return None,
                };
                let (source, source_span) = self.callable_reference(&member.object)?;
                let method_path = source.clone().with_property(method.to_string());
                return Some((source, source_span, method_path, method));
            }
            _ => return None,
        };
        let method = match method {
            "return" => "return",
            "throw" => "throw",
            _ => return None,
        };
        let (source, source_span) = self.callable_reference(source)?;
        let method_path = source.clone().with_property(method.to_string());
        Some((source, source_span, method_path, method))
    }

    fn direct_call_statement<'node, 'ast>(
        statement: &'node Statement<'ast>,
    ) -> Option<&'node CallExpression<'ast>> {
        let Statement::ExpressionStatement(statement) = statement else {
            return None;
        };
        let Expression::CallExpression(call) = statement.expression.get_inner_expression() else {
            return None;
        };
        Some(call)
    }

    fn direct_generator_method_call(
        &self,
        call: &CallExpression<'_>,
        expected_method: &str,
    ) -> Option<(StaticAliasPath, (u32, u32))> {
        if call.optional {
            return None;
        }
        let object = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member)
                if !member.optional && member.property.name == expected_method =>
            {
                &member.object
            }
            Expression::ComputedMemberExpression(member)
                if !member.optional
                    && static_member_name(&member.expression).as_deref()
                        == Some(expected_method) =>
            {
                &member.object
            }
            _ => return None,
        };
        self.callable_reference(object)
    }

    fn record_initial_generator_next_arguments(&mut self, call: &CallExpression<'_>) {
        let Some((iterator, iterator_span)) = self.direct_generator_method_call(call, "next")
        else {
            return;
        };
        for argument in &call.arguments {
            let Some(argument) = argument.as_expression() else {
                continue;
            };
            let Some((source, source_span)) = self.callable_reference(argument) else {
                continue;
            };
            self.initial_generator_next_argument_reads
                .push(InitialGeneratorNextArgumentRead {
                    source,
                    source_span,
                    iterator: iterator.clone(),
                    iterator_span,
                });
        }
    }

    fn terminal_throw_argument_guards(
        &self,
        call: &CallExpression<'_>,
    ) -> Option<Vec<GeneratorMethodGuard>> {
        if call.arguments.is_empty() {
            return Some(Vec::new());
        }
        let [argument] = call.arguments.as_slice() else {
            return None;
        };
        let Expression::NewExpression(error) = argument.as_expression()?.get_inner_expression()
        else {
            return None;
        };
        let error_constructor = StaticAliasPath::unresolved_global("Error".to_string());
        if !error.arguments.is_empty()
            || static_alias_source_path(self.scoping, &error.callee)
                != Some(error_constructor.clone())
        {
            return None;
        }
        Some(vec![GeneratorMethodGuard {
            source: None,
            owner: error_constructor,
            method: "prototype",
        }])
    }

    fn definite_terminal_statement(
        &self,
        statement: &Statement<'_>,
    ) -> Option<(StaticAliasPath, Vec<GeneratorMethodGuard>)> {
        if let Some(call) = Self::direct_call_statement(statement) {
            let (source, _) = self.direct_generator_method_call(call, "return")?;
            if !call.arguments.is_empty() {
                return None;
            }
            return Some((
                source.clone(),
                vec![GeneratorMethodGuard {
                    source: None,
                    owner: source,
                    method: "return",
                }],
            ));
        }
        let Statement::TryStatement(statement) = statement else {
            return None;
        };
        let handler = statement.handler.as_ref()?;
        if statement.finalizer.is_some()
            || !handler.body.body.is_empty()
            || statement.block.body.len() != 1
        {
            return None;
        }
        let call = Self::direct_call_statement(&statement.block.body[0])?;
        let (source, _) = self.direct_generator_method_call(call, "throw")?;
        let mut guards = self.terminal_throw_argument_guards(call)?;
        guards.push(GeneratorMethodGuard {
            source: None,
            owner: source.clone(),
            method: "throw",
        });
        Some((source, guards))
    }

    fn record_terminal_before_advance_reads(&mut self, statements: &ArenaVec<'_, Statement<'_>>) {
        for pair in statements.windows(2) {
            let Some((source, mut method_guards)) = self.definite_terminal_statement(&pair[0])
            else {
                continue;
            };
            let Some(call) = Self::direct_call_statement(&pair[1]) else {
                continue;
            };
            if !call.arguments.is_empty() {
                continue;
            }
            let Some((advanced, source_span)) = self.direct_generator_method_call(call, "next")
            else {
                continue;
            };
            if advanced != source {
                continue;
            }
            method_guards.push(GeneratorMethodGuard {
                source: None,
                owner: source.clone(),
                method: "next",
            });
            self.composite_guarded_reads.push(CompositeGuardedRead {
                source,
                source_span,
                target: None,
                method_guards,
                terminal_alias: None,
            });
        }
    }

    fn record_direct_generator_advance(&mut self, call: &CallExpression<'_>) {
        let Some((source, source_span)) = self.direct_generator_method_call(call, "next") else {
            return;
        };
        self.direct_generator_advances.push(DirectGeneratorAdvance {
            method_guard: GeneratorMethodGuard {
                source: None,
                owner: source.clone(),
                method: "next",
            },
            source,
            source_span,
            call_span: (call.span.start, call.span.end),
        });
    }

    fn record_indirect_terminal_generator_method_read(&mut self, call: &CallExpression<'_>) {
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        let completion_reads;
        let (source, source_span, receiver, receiver_span, guards, target_argument) =
            if static_alias_source_path(self.scoping, &call.callee)
                .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
            {
                let Some(target) = call
                    .arguments
                    .first()
                    .and_then(|argument| argument.as_expression())
                else {
                    return;
                };
                let Some(receiver_expression) = call
                    .arguments
                    .get(1)
                    .and_then(|argument| argument.as_expression())
                else {
                    return;
                };
                let Some((source, source_span, _, method)) =
                    self.terminal_generator_method_reference(target)
                else {
                    return;
                };
                let Some((receiver, receiver_span)) = self.callable_reference(receiver_expression)
                else {
                    return;
                };
                if receiver != source {
                    return;
                }
                let Some(target_argument) = self.callable_reference(target) else {
                    return;
                };
                completion_reads = call
                    .arguments
                    .get(2)
                    .and_then(|argument| argument.as_expression())
                    .map(|arguments| self.direct_array_source_reads(arguments, &source))
                    .unwrap_or_default();
                (
                    source.clone(),
                    source_span,
                    receiver,
                    receiver_span,
                    vec![
                        GeneratorMethodGuard {
                            source: None,
                            owner: source,
                            method,
                        },
                        GeneratorMethodGuard {
                            source: None,
                            owner: reflect,
                            method: "apply",
                        },
                    ],
                    Some(target_argument),
                )
            } else {
                let (target, indirect_method) =
                    match unwrap_transparent_call_expression(&call.callee) {
                        Expression::StaticMemberExpression(member) => {
                            let indirect_method = match member.property.name.as_str() {
                                "call" => "call",
                                "apply" => "apply",
                                _ => return,
                            };
                            (&member.object, indirect_method)
                        }
                        Expression::ComputedMemberExpression(member) => {
                            let indirect_method =
                                match static_member_name(&member.expression).as_deref() {
                                    Some("call") => "call",
                                    Some("apply") => "apply",
                                    _ => return,
                                };
                            (&member.object, indirect_method)
                        }
                        _ => return,
                    };
                let Some((source, source_span, method_path, method)) =
                    self.terminal_generator_method_reference(target)
                else {
                    return;
                };
                let Some((receiver, receiver_span)) = call
                    .arguments
                    .first()
                    .and_then(|argument| argument.as_expression())
                    .and_then(|receiver| self.callable_reference(receiver))
                else {
                    return;
                };
                if receiver != source {
                    return;
                }
                completion_reads = if indirect_method == "call" {
                    call.arguments
                        .iter()
                        .skip(1)
                        .filter_map(|argument| argument.as_expression())
                        .filter_map(|argument| self.callable_reference(argument))
                        .filter(|(argument_source, _)| *argument_source == source)
                        .collect()
                } else {
                    call.arguments
                        .get(1)
                        .and_then(|argument| argument.as_expression())
                        .map(|arguments| self.direct_array_source_reads(arguments, &source))
                        .unwrap_or_default()
                };
                (
                    source.clone(),
                    source_span,
                    receiver,
                    receiver_span,
                    vec![
                        GeneratorMethodGuard {
                            source: None,
                            owner: source,
                            method,
                        },
                        GeneratorMethodGuard {
                            source: Some(method_path),
                            owner: StaticAliasPath::unresolved_global("Function".to_string())
                                .with_property("prototype".to_string()),
                            method: indirect_method,
                        },
                    ],
                    None,
                )
            };
        self.composite_guarded_reads.push(CompositeGuardedRead {
            source: source.clone(),
            source_span,
            target: None,
            method_guards: guards.clone(),
            terminal_alias: None,
        });
        self.composite_guarded_reads.push(CompositeGuardedRead {
            source,
            source_span: receiver_span,
            target: None,
            method_guards: guards.clone(),
            terminal_alias: None,
        });
        self.non_escaping_callable_reads
            .insert((receiver, receiver_span));
        if let Some(target_argument) = target_argument {
            self.non_escaping_callable_reads.insert(target_argument);
        }
        for (completion_source, completion_span) in completion_reads {
            self.composite_guarded_reads.push(CompositeGuardedRead {
                source: completion_source.clone(),
                source_span: completion_span,
                target: None,
                method_guards: guards.clone(),
                terminal_alias: None,
            });
            self.non_escaping_callable_reads
                .insert((completion_source, completion_span));
        }
    }

    fn direct_array_source_reads(
        &self,
        expression: &Expression<'_>,
        source: &StaticAliasPath,
    ) -> Vec<(StaticAliasPath, (u32, u32))> {
        let Expression::ArrayExpression(array) = expression.get_inner_expression() else {
            return Vec::new();
        };
        array
            .elements
            .iter()
            .filter_map(|element| match element {
                ArrayExpressionElement::Elision(_) | ArrayExpressionElement::SpreadElement(_) => {
                    None
                }
                _ => self.callable_reference(element.to_expression()),
            })
            .filter(|(argument_source, _)| argument_source == source)
            .collect()
    }

    fn record_terminal_generator_method_alias(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        let Some((source, source_span, _, method)) =
            self.terminal_generator_method_reference(initializer)
        else {
            return;
        };
        self.terminal_method_alias_reads
            .push(ForwardedCallableRead {
                source: source.clone(),
                source_span,
                target,
                method_guard: Some(GeneratorMethodGuard {
                    source: None,
                    owner: source,
                    method,
                }),
                parameter_offset: None,
            });
    }

    fn sole_forwarded_callable_source(&self, target: &StaticAliasPath) -> Option<&StaticAliasPath> {
        let mut reads = self
            .forwarded_callable_reads
            .iter()
            .filter(|read| read.target == *target);
        let read = reads.next()?;
        (reads.next().is_none() && read.method_guard.is_none()).then_some(&read.source)
    }

    fn sole_terminal_method_alias_read(
        &self,
        target: &StaticAliasPath,
    ) -> Option<&ForwardedCallableRead> {
        let mut reads = self
            .terminal_method_alias_reads
            .iter()
            .filter(|read| read.target == *target);
        let read = reads.next()?;
        reads.next().is_none().then_some(read)
    }

    fn terminal_method_alias_source(
        &self,
        target: &StaticAliasPath,
    ) -> Option<(
        StaticAliasPath,
        (u32, u32),
        GeneratorMethodGuard,
        TerminalAliasGuard,
    )> {
        let mut current = target.clone();
        let mut aliases = Vec::new();
        let mut visited = BTreeSet::new();
        loop {
            if !visited.insert(current.clone())
                || self.non_generator_callable_targets.contains(&current)
            {
                return None;
            }
            aliases.push(current.clone());
            if self
                .terminal_method_alias_reads
                .iter()
                .any(|read| read.target == current)
            {
                let read = self.sole_terminal_method_alias_read(&current)?;
                let method_guard = read.method_guard.clone()?;
                return Some((
                    read.source.clone(),
                    read.source_span,
                    method_guard.clone(),
                    TerminalAliasGuard {
                        aliases,
                        method: method_guard.method,
                    },
                ));
            }
            current = self.sole_forwarded_callable_source(&current)?.clone();
        }
    }

    fn record_indirect_terminal_method_alias_read(&mut self, call: &CallExpression<'_>) {
        let Some((alias, Some(indirect_guard), receiver_index)) =
            self.generator_invocation_target(call)
        else {
            return;
        };
        if !matches!(indirect_guard.method, "call" | "apply") {
            return;
        }
        let Some((receiver, receiver_span)) = call
            .arguments
            .get(receiver_index)
            .and_then(|argument| argument.as_expression())
            .and_then(|receiver| self.callable_reference(receiver))
        else {
            return;
        };
        let Some((source, source_span, terminal_guard, alias_guard)) =
            self.terminal_method_alias_source(&alias)
        else {
            return;
        };
        if receiver != source {
            return;
        }
        let indirect_method = indirect_guard.method;
        let method_guards = vec![terminal_guard, indirect_guard];
        for read_span in [source_span, receiver_span] {
            self.composite_guarded_reads.push(CompositeGuardedRead {
                source: source.clone(),
                source_span: read_span,
                target: None,
                method_guards: method_guards.clone(),
                terminal_alias: Some(alias_guard.clone()),
            });
        }
        self.non_escaping_callable_reads
            .insert((receiver, receiver_span));
        if receiver_index == 1
            && let Some(target_argument) = call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .and_then(|target| self.callable_reference(target))
        {
            self.non_escaping_callable_reads.insert(target_argument);
        }
        let completion_reads = match indirect_method {
            "call" => call
                .arguments
                .iter()
                .skip(receiver_index + 1)
                .filter_map(|argument| argument.as_expression())
                .filter_map(|argument| self.callable_reference(argument))
                .filter(|(argument_source, _)| *argument_source == source)
                .collect(),
            _ => call
                .arguments
                .get(receiver_index + 1)
                .and_then(|argument| argument.as_expression())
                .map(|arguments| self.direct_array_source_reads(arguments, &source))
                .unwrap_or_default(),
        };
        for (completion_source, completion_span) in completion_reads {
            self.composite_guarded_reads.push(CompositeGuardedRead {
                source: completion_source.clone(),
                source_span: completion_span,
                target: None,
                method_guards: method_guards.clone(),
                terminal_alias: Some(alias_guard.clone()),
            });
            self.non_escaping_callable_reads
                .insert((completion_source, completion_span));
        }
    }

    fn record_bound_terminal_generator_method_read(
        &mut self,
        target: Option<StaticAliasPath>,
        initializer: &Expression<'_>,
        invocation: Option<&CallExpression<'_>>,
    ) {
        let bind_call = match initializer.get_inner_expression() {
            Expression::CallExpression(call) => call.as_ref(),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => call.as_ref(),
                _ => return,
            },
            _ => return,
        };
        if invocation.is_some() && bind_call.optional {
            return;
        }
        let object = match unwrap_transparent_call_expression(&bind_call.callee) {
            Expression::StaticMemberExpression(member)
                if member.property.name == "bind"
                    && invocation.is_none_or(|_| !member.optional) =>
            {
                &member.object
            }
            Expression::ComputedMemberExpression(member)
                if static_member_name(&member.expression).as_deref() == Some("bind")
                    && invocation.is_none_or(|_| !member.optional) =>
            {
                &member.object
            }
            _ => return,
        };
        let Some((source, source_span, method_path, method)) =
            self.terminal_generator_method_reference(object)
        else {
            return;
        };
        let Some((receiver, receiver_span)) = bind_call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
            .and_then(|receiver| self.callable_reference(receiver))
        else {
            return;
        };
        if receiver != source {
            return;
        }
        let method_guards = vec![
            GeneratorMethodGuard {
                source: None,
                owner: source.clone(),
                method,
            },
            GeneratorMethodGuard {
                source: Some(method_path),
                owner: StaticAliasPath::unresolved_global("Function".to_string())
                    .with_property("prototype".to_string()),
                method: "bind",
            },
        ];
        let completion_reads = bind_call
            .arguments
            .iter()
            .skip(1)
            .chain(
                invocation
                    .into_iter()
                    .flat_map(|call| call.arguments.iter()),
            )
            .filter_map(|argument| argument.as_expression())
            .filter_map(|argument| self.callable_reference(argument))
            .filter(|(argument_source, _)| *argument_source == source)
            .collect::<Vec<_>>();
        self.composite_guarded_reads.push(CompositeGuardedRead {
            source: source.clone(),
            source_span,
            target: target.clone(),
            method_guards: method_guards.clone(),
            terminal_alias: None,
        });
        self.composite_guarded_reads.push(CompositeGuardedRead {
            source,
            source_span: receiver_span,
            target: target.clone(),
            method_guards: method_guards.clone(),
            terminal_alias: None,
        });
        self.non_escaping_callable_reads
            .insert((receiver, receiver_span));
        for (completion_source, completion_span) in completion_reads {
            self.composite_guarded_reads.push(CompositeGuardedRead {
                source: completion_source.clone(),
                source_span: completion_span,
                target: target.clone(),
                method_guards: method_guards.clone(),
                terminal_alias: None,
            });
            self.non_escaping_callable_reads
                .insert((completion_source, completion_span));
        }
    }

    fn record_bound_terminal_generator_method_alias(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        self.record_bound_terminal_generator_method_read(Some(target), initializer, None);
    }

    fn record_immediate_bound_terminal_generator_method_read(&mut self, call: &CallExpression<'_>) {
        if !call.optional {
            self.record_bound_terminal_generator_method_read(None, &call.callee, Some(call));
        }
    }

    fn record_generator_result_forwarding(
        &mut self,
        target: StaticAliasPath,
        call: &CallExpression<'_>,
    ) -> bool {
        if let Some((source, method_guard, _)) = self.assignment_invocation_target(call) {
            self.assigned_generator_result_reads
                .push(ForwardedCallableRead {
                    source,
                    source_span: (call.span.start, call.span.end),
                    target: target.clone(),
                    method_guard,
                    parameter_offset: None,
                });
        }
        let reflect = StaticAliasPath::unresolved_global("Reflect".to_string());
        if static_alias_source_path(self.scoping, &call.callee)
            .is_some_and(|callee| callee == reflect.with_property("apply".to_string()))
        {
            return call
                .arguments
                .first()
                .and_then(|argument| argument.as_expression())
                .is_some_and(|source| {
                    self.record_generator_result_source(
                        target,
                        source,
                        Some((&reflect, "apply", false)),
                    )
                });
        }
        let (source, method) = match unwrap_transparent_call_expression(&call.callee) {
            Expression::StaticMemberExpression(member) => {
                (&member.object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let Some(method) = static_member_name(&member.expression) else {
                    return false;
                };
                let method = match method.as_str() {
                    "call" => "call",
                    "apply" => "apply",
                    _ => {
                        return self.record_generator_result_source(target, &call.callee, None);
                    }
                };
                (&member.object, method)
            }
            _ => return self.record_generator_result_source(target, &call.callee, None),
        };
        let method = match method {
            "call" => "call",
            "apply" => "apply",
            _ => return self.record_generator_result_source(target, &call.callee, None),
        };
        let function_prototype = StaticAliasPath::unresolved_global("Function".to_string())
            .with_property("prototype".to_string());
        self.record_generator_result_source(
            target,
            source,
            Some((&function_prototype, method, true)),
        )
    }

    fn record_returned_generator_callable(
        &mut self,
        target: StaticAliasPath,
        call: &CallExpression<'_>,
    ) -> bool {
        let Some(source) = static_alias_source_path(self.scoping, &call.callee) else {
            return false;
        };
        let Some(body_spans) = self.returned_generator_body_spans.get(&source).cloned() else {
            return false;
        };
        if body_spans.is_empty() {
            return false;
        }
        self.generator_callable_targets.insert(target.clone());
        self.generator_body_targets.extend(
            body_spans
                .into_iter()
                .map(|body_span| (body_span, target.clone())),
        );
        true
    }

    fn record_local_non_consuming_initializer(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        if !self.is_immutable_local_callable_target(target) {
            return;
        }
        if let Some((parameters, method_guards)) =
            self.inline_bound_non_consuming_parameters(initializer)
        {
            self.record_inline_bind_reads(Some(target), initializer);
            self.guarded_local_non_consuming_parameters
                .push(GuardedLocalNonConsumingParameters {
                    target: target.clone(),
                    parameters,
                    method_guards,
                });
            return;
        }
        let parameters = match initializer.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                self.local_non_consuming_parameters(function)
            }
            Expression::ArrowFunctionExpression(function) => {
                self.local_non_consuming_arrow_parameters(function)
            }
            Expression::ClassExpression(class) => self.local_non_consuming_class_parameters(class),
            _ => return,
        };
        if let Some(parameters) = parameters {
            self.local_non_consuming_parameters
                .insert(target.clone(), parameters);
        }
    }

    fn is_immutable_local_callable_target(&self, target: &StaticAliasPath) -> bool {
        target.binding_root().is_some_and(|root| {
            *target == StaticAliasPath::root(root)
                && !self
                    .scoping
                    .get_resolved_references(root)
                    .any(|reference| reference.is_write())
        })
    }

    fn propagate_local_non_consuming_parameters(&mut self) {
        loop {
            let mut additions = Vec::new();
            let targets = self
                .forwarded_callable_reads
                .iter()
                .map(|read| read.target.clone())
                .collect::<BTreeSet<_>>();
            for target in targets {
                if self.local_non_consuming_parameters.contains_key(&target)
                    || !self.is_immutable_local_callable_target(&target)
                {
                    continue;
                }
                let dependencies = self
                    .forwarded_callable_reads
                    .iter()
                    .filter(|read| read.target == target)
                    .collect::<Vec<_>>();
                if dependencies.is_empty() {
                    continue;
                }
                let forwarded_parameters = |read: &ForwardedCallableRead| {
                    if read
                        .method_guard
                        .as_ref()
                        .is_some_and(|guard| !self.method_guard_is_intact(guard))
                    {
                        return None;
                    }
                    let offset = read.parameter_offset?;
                    Some(
                        self.local_non_consuming_parameters
                            .get(&read.source)?
                            .shifted(offset),
                    )
                };
                let Some(mut parameters) = dependencies
                    .first()
                    .and_then(|read| forwarded_parameters(read))
                else {
                    continue;
                };
                let mut complete = true;
                for dependency in dependencies.iter().skip(1) {
                    let Some(source_parameters) = forwarded_parameters(dependency) else {
                        complete = false;
                        break;
                    };
                    parameters = parameters.intersect(&source_parameters);
                }
                if complete {
                    additions.push((target, parameters));
                }
            }
            if additions.is_empty() {
                break;
            }
            self.local_non_consuming_parameters.extend(additions);
        }
    }

    fn has_retained_callable_container(expression: &Expression<'_>) -> bool {
        match expression.get_inner_expression() {
            Expression::ArrayExpression(_) | Expression::ObjectExpression(_) => true,
            Expression::ConditionalExpression(expression) => {
                Self::has_retained_callable_container(&expression.consequent)
                    || Self::has_retained_callable_container(&expression.alternate)
            }
            Expression::LogicalExpression(expression) => {
                Self::has_retained_callable_container(&expression.left)
                    || Self::has_retained_callable_container(&expression.right)
            }
            Expression::SequenceExpression(expression) => expression
                .expressions
                .last()
                .is_some_and(Self::has_retained_callable_container),
            _ => false,
        }
    }

    fn has_nonadvancing_member_value(expression: &Expression<'_>) -> bool {
        match expression.get_inner_expression() {
            Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::PrivateFieldExpression(_) => true,
            Expression::ChainExpression(chain) => matches!(
                &chain.expression,
                ChainElement::StaticMemberExpression(_)
                    | ChainElement::ComputedMemberExpression(_)
                    | ChainElement::PrivateFieldExpression(_)
            ),
            Expression::ConditionalExpression(expression) => {
                Self::has_nonadvancing_member_value(&expression.consequent)
                    || Self::has_nonadvancing_member_value(&expression.alternate)
            }
            Expression::LogicalExpression(expression) => {
                Self::has_nonadvancing_member_value(&expression.left)
                    || Self::has_nonadvancing_member_value(&expression.right)
            }
            Expression::SequenceExpression(expression) => expression
                .expressions
                .last()
                .is_some_and(Self::has_nonadvancing_member_value),
            _ => false,
        }
    }

    fn record_object_generator_bodies(
        &mut self,
        target: &StaticAliasPath,
        object: &oxc::ast::ast::ObjectExpression<'_>,
    ) -> bool {
        let mut properties = BTreeMap::new();
        let mut direct_body_spans = BTreeSet::new();
        for property in &object.properties {
            let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                return false;
            };
            let Some(name) = property.key.static_name() else {
                return false;
            };
            if let Expression::FunctionExpression(function) = property.value.get_inner_expression()
                && let Some(body_span) = Self::generator_body_span(function)
            {
                direct_body_spans.insert(body_span);
            }
            properties.insert(
                name.into_owned(),
                (&property.value, property.kind == PropertyKind::Init),
            );
        }
        let exact_container = properties
            .values()
            .all(|(value, _)| !Self::has_retained_callable_container(value));
        let mut instance_bodies = BTreeMap::new();
        let mut reachable_body_spans = BTreeSet::new();
        for (name, (value, callable_value)) in properties {
            let method = target.clone().with_property(name.clone());
            if callable_value {
                self.record_callable_initializer(method.clone(), value);
            }
            let body_spans = self.generator_body_spans_for_target(&method);
            reachable_body_spans.extend(&body_spans);
            if !body_spans.is_empty() {
                instance_bodies.insert(name, body_spans);
            }
        }
        self.directly_unexecuted_body_spans
            .extend(direct_body_spans.difference(&reachable_body_spans).copied());
        self.instance_generator_bodies
            .insert(target.clone(), instance_bodies);
        exact_container
    }

    fn record_array_callable_values(
        &mut self,
        target: &StaticAliasPath,
        array: &ArrayExpression<'_>,
    ) {
        if array
            .elements
            .iter()
            .any(|element| matches!(element, ArrayExpressionElement::SpreadElement(_)))
        {
            return;
        }
        for (index, value) in array.elements.iter().enumerate() {
            if matches!(value, ArrayExpressionElement::Elision(_)) {
                continue;
            }
            self.record_callable_initializer(
                target.clone().with_property(index.to_string()),
                value.to_expression(),
            );
        }
    }

    fn record_callable_initializer(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
    ) {
        self.record_static_json_replacer_array(&target, initializer);
        self.record_static_from_entries_source(&target, initializer);
        self.record_static_object_entries_source(&target, initializer);
        self.record_returned_callable_result_initializer(&target, initializer);
        self.record_returned_generator_factory_initializer(&target, initializer);
        self.record_local_non_consuming_initializer(&target, initializer);
        self.record_terminal_generator_method_alias(target.clone(), initializer);
        self.record_bound_terminal_generator_method_alias(target.clone(), initializer);
        let exact_object = match initializer.get_inner_expression() {
            Expression::ObjectExpression(object) => {
                self.record_object_generator_bodies(&target, object)
            }
            Expression::ArrayExpression(array) => {
                self.record_array_callable_values(&target, array);
                false
            }
            _ => false,
        };
        let retained_container = Self::has_retained_callable_container(initializer);
        if retained_container && !exact_object {
            self.record_retained_callable_source(
                target.clone(),
                initializer,
                None,
                RetainedCallableReadKind::Container,
            );
        }
        if (retained_container && !exact_object) || Self::has_nonadvancing_member_value(initializer)
        {
            self.record_retained_invocations(target.clone(), initializer);
        }
        if self.record_object_from_entries_result_initializer(&target, initializer)
            || self.record_property_descriptor_result_initializer(&target, initializer)
        {
            self.non_generator_callable_targets.insert(target.clone());
        } else {
            self.record_forwarded_callable(target.clone(), initializer);
        }
        if let Expression::NewExpression(expression) = initializer.get_inner_expression() {
            self.record_constructed_class_generator_bodies(target, expression);
        } else {
            self.record_forwarded_class_generator_bodies(target.clone(), initializer);
            self.record_forwarded_instance_generator_bodies(target, initializer);
        }
    }

    fn record_object_from_entries_result_initializer(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) -> bool {
        let Expression::CallExpression(call) = initializer.get_inner_expression() else {
            return false;
        };
        if !self.is_intact_object_from_entries_call(call)
            || call
                .arguments
                .iter()
                .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let Some(source) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
        else {
            return false;
        };
        if let Some(entries) = static_from_entries_pairs(source) {
            let mut values = BTreeMap::new();
            for (property, value) in entries {
                values.insert(property, value);
            }
            for (property, value) in values {
                self.record_callable_initializer(target.clone().with_property(property), value);
            }
            return true;
        }
        if let Some(stored) = self.stored_static_from_entries_values(source) {
            let guard = Self::stored_array_iterator_guard(&stored.source);
            for (property, value) in stored.values {
                self.record_callable_path_initializer(
                    target.clone().with_property(property),
                    value,
                    stored.source_span,
                    Some(&guard),
                );
            }
            return true;
        }
        if let Some(stored) = self.stored_object_entries_round_trip(source) {
            self.record_callable_path_initializer(
                target.clone(),
                stored.source,
                stored.container_span,
                None,
            );
            return true;
        }
        let Some((_, enumerated)) = self.object_entries_round_trip_source(source) else {
            return false;
        };
        if let Some((source, source_span)) = self.callable_reference(enumerated) {
            self.record_callable_path_initializer(target.clone(), source, source_span, None);
        } else {
            self.record_callable_initializer(target.clone(), enumerated);
        }
        true
    }

    fn record_property_descriptor_result_initializer(
        &mut self,
        target: &StaticAliasPath,
        initializer: &Expression<'_>,
    ) -> bool {
        let Expression::CallExpression(call) = initializer.get_inner_expression() else {
            return false;
        };
        let Some((owner, method)) = self.property_descriptor_method(call) else {
            return false;
        };
        if call
            .arguments
            .iter()
            .any(|argument| argument.as_expression().is_none())
        {
            return false;
        }
        let Some((source, source_span)) = call
            .arguments
            .first()
            .and_then(|argument| argument.as_expression())
            .and_then(|source| self.callable_reference(source))
        else {
            return false;
        };
        let properties = if method == "getOwnPropertyDescriptor" {
            let property = call
                .arguments
                .get(1)
                .and_then(|argument| argument.as_expression())
                .map(static_member_name)
                .unwrap_or_else(|| Some("undefined".to_string()));
            let Some(property) = property else {
                return false;
            };
            BTreeSet::from([property])
        } else {
            self.known_callable_child_properties(&source)
        };
        let guard = GeneratorMethodGuard {
            source: None,
            owner: StaticAliasPath::unresolved_global(owner.to_string()),
            method,
        };
        for property in properties {
            let source = source.clone().with_property(property.clone());
            let descriptor = if method == "getOwnPropertyDescriptor" {
                target.clone()
            } else {
                target.clone().with_property(property)
            };
            for field in ["value", "get", "set"] {
                self.record_callable_path_initializer(
                    descriptor.clone().with_property(field.to_string()),
                    source.clone(),
                    source_span,
                    Some(&guard),
                );
            }
        }
        true
    }

    fn record_guarded_callable_initializer(
        &mut self,
        target: StaticAliasPath,
        initializer: &Expression<'_>,
        guard: &GeneratorMethodGuard,
    ) {
        self.forwarding_targets.insert(target.clone());
        if let Some((source, source_span)) = self.callable_reference(initializer) {
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source,
                source_span,
                target,
                method_guard: Some(guard.clone()),
                parameter_offset: None,
            });
            return;
        }
        match initializer.get_inner_expression() {
            Expression::FunctionExpression(function) => {
                let Some(body_span) = Self::generator_body_span(function) else {
                    self.non_generator_callable_targets.insert(target);
                    return;
                };
                self.generator_callable_targets.insert(target.clone());
                self.generator_body_targets
                    .push((body_span, target.clone()));
                self.guarded_generator_targets.push((target, guard.clone()));
            }
            Expression::CallExpression(call)
                if self.record_generator_result_forwarding(target.clone(), call) =>
            {
                self.non_generator_callable_targets.insert(target.clone());
                self.guarded_generator_targets.push((target, guard.clone()));
            }
            _ => {}
        }
    }

    fn record_callable_path_initializer(
        &mut self,
        target: StaticAliasPath,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) {
        self.forwarding_targets.insert(target.clone());
        self.forwarded_callable_reads.push(ForwardedCallableRead {
            source,
            source_span,
            target,
            method_guard: guard.cloned(),
            parameter_offset: Some(0),
        });
    }

    fn stored_array_iterator_guard(source: &StaticAliasPath) -> GeneratorMethodGuard {
        GeneratorMethodGuard {
            source: Some(source.clone()),
            owner: StaticAliasPath::unresolved_global("Array".to_string())
                .with_property("prototype".to_string()),
            method: "[Symbol.iterator]",
        }
    }

    fn record_stored_array_binding_destructuring(
        &mut self,
        pattern: &ArrayPattern<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.binding_callable_container_target(&rest.argument) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let guard = Self::stored_array_iterator_guard(&source);
        for (index, binding) in pattern.elements.iter().enumerate() {
            let Some(binding) = binding else {
                continue;
            };
            if matches!(binding, BindingPattern::AssignmentPattern(_))
                || !self.record_stored_binding_destructuring(
                    binding,
                    source.clone().with_property(index.to_string()),
                    source_span,
                    Some(&guard),
                )
            {
                return false;
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                let Ok(index) = property.parse::<usize>() else {
                    continue;
                };
                if index < pattern.elements.len() {
                    continue;
                }
                self.record_callable_path_initializer(
                    rest_target
                        .clone()
                        .with_property((index - pattern.elements.len()).to_string()),
                    source.clone().with_property(property),
                    source_span,
                    Some(&guard),
                );
            }
        }
        true
    }

    fn record_trailing_stored_array_binding_destructuring(
        &mut self,
        pattern: &ArrayPattern<'_>,
        initializer: &ArrayExpression<'_>,
        spread_index: usize,
        source: StaticAliasPath,
        source_span: (u32, u32),
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.binding_callable_container_target(&rest.argument) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let outer_guard = Self::array_iterator_guard();
        let spread_guard = Self::stored_array_iterator_guard(&source);
        for (index, binding) in pattern.elements.iter().enumerate() {
            let Some(binding) = binding else {
                if index < spread_index
                    && let Some(value) = initializer.elements.get(index)
                    && !matches!(value, ArrayExpressionElement::Elision(_))
                {
                    self.record_static_container_generator_values(value.to_expression(), true);
                }
                continue;
            };
            if index < spread_index {
                let Some(value) = initializer.elements.get(index) else {
                    self.record_missing_destructured_callable_initializer(
                        binding,
                        Some(&outer_guard),
                    );
                    continue;
                };
                if matches!(value, ArrayExpressionElement::Elision(_)) {
                    self.record_missing_destructured_callable_initializer(
                        binding,
                        Some(&outer_guard),
                    );
                } else {
                    self.record_destructured_callable_initializers(
                        binding,
                        value.to_expression(),
                        Some(&outer_guard),
                    );
                }
            } else if matches!(binding, BindingPattern::AssignmentPattern(_))
                || !self.record_stored_binding_destructuring(
                    binding,
                    source
                        .clone()
                        .with_property((index - spread_index).to_string()),
                    source_span,
                    Some(&spread_guard),
                )
            {
                return false;
            }
        }
        for value in initializer
            .elements
            .iter()
            .take(spread_index)
            .skip(pattern.elements.len())
            .enumerate()
        {
            let (rest_index, value) = value;
            if matches!(value, ArrayExpressionElement::Elision(_)) {
                continue;
            }
            if let Some(rest_target) = &rest_target {
                self.record_callable_container_property(
                    rest_target,
                    rest_index.to_string(),
                    value.to_expression(),
                    Some(&outer_guard),
                );
            } else {
                self.record_static_container_generator_values(value.to_expression(), true);
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                let Ok(index) = property.parse::<usize>() else {
                    continue;
                };
                let output_index = spread_index + index;
                if output_index < pattern.elements.len() {
                    continue;
                }
                self.record_callable_path_initializer(
                    rest_target
                        .clone()
                        .with_property((output_index - pattern.elements.len()).to_string()),
                    source.clone().with_property(property),
                    source_span,
                    Some(&spread_guard),
                );
            }
        }
        true
    }

    fn record_stored_object_binding_destructuring(
        &mut self,
        pattern: &ObjectPattern<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            if guard.is_some() {
                return false;
            }
            let Some(target) = self.binding_callable_container_target(&rest.argument) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let mut selected = BTreeSet::new();
        for property in &pattern.properties {
            let Some(name) = property.key.static_name() else {
                return false;
            };
            selected.insert(name.to_string());
            let source = source.clone().with_property(name.into_owned());
            let property_guard = Self::stored_object_property_guard(&source);
            if matches!(&property.value, BindingPattern::AssignmentPattern(_))
                || !self.record_stored_binding_destructuring(
                    &property.value,
                    source,
                    source_span,
                    guard.or(Some(&property_guard)),
                )
            {
                return false;
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                if selected.contains(&property) {
                    continue;
                }
                let property_source = source.clone().with_property(property.clone());
                let property_guard = Self::stored_object_property_guard(&property_source);
                self.record_callable_path_initializer(
                    rest_target.clone().with_property(property),
                    property_source,
                    source_span,
                    Some(&property_guard),
                );
            }
        }
        true
    }

    fn record_stored_binding_destructuring(
        &mut self,
        pattern: &BindingPattern<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        match pattern {
            BindingPattern::BindingIdentifier(binding) => {
                let Some(target) = binding.symbol_id.get().map(StaticAliasPath::root) else {
                    return false;
                };
                self.record_callable_path_initializer(target, source, source_span, guard);
            }
            BindingPattern::ArrayPattern(pattern) => {
                if !self.record_stored_array_binding_destructuring(pattern, source, source_span) {
                    return false;
                }
            }
            BindingPattern::ObjectPattern(pattern) => {
                if !self.record_stored_object_binding_destructuring(
                    pattern,
                    source,
                    source_span,
                    guard,
                ) {
                    return false;
                }
            }
            BindingPattern::AssignmentPattern(_) => return false,
        }
        true
    }

    fn destructuring_value_is_undefined(&self, expression: &Expression<'_>) -> Option<bool> {
        let expression = expression.get_inner_expression();
        if matches!(
            expression,
            Expression::UnaryExpression(unary) if unary.operator == OxcUnaryOperator::Void
        ) || static_alias_source_path(self.scoping, expression)
            .is_some_and(|path| path == StaticAliasPath::unresolved_global("undefined".to_string()))
        {
            return Some(true);
        }
        matches!(
            expression,
            Expression::NullLiteral(_)
                | Expression::BooleanLiteral(_)
                | Expression::NumericLiteral(_)
                | Expression::BigIntLiteral(_)
                | Expression::StringLiteral(_)
                | Expression::RegExpLiteral(_)
                | Expression::TemplateLiteral(_)
                | Expression::ArrayExpression(_)
                | Expression::ObjectExpression(_)
                | Expression::FunctionExpression(_)
                | Expression::ArrowFunctionExpression(_)
                | Expression::ClassExpression(_)
                | Expression::NewExpression(_)
                | Expression::ThisExpression(_)
                | Expression::MetaProperty(_)
        )
        .then_some(false)
    }

    fn select_destructuring_default<'a>(
        &self,
        initializer: Option<&'a Expression<'a>>,
        default: &'a Expression<'a>,
    ) -> Option<(&'a Expression<'a>, bool)> {
        let Some(initializer) = initializer else {
            return Some((default, true));
        };
        match self.destructuring_value_is_undefined(initializer) {
            Some(true) => Some((default, true)),
            Some(false) => Some((initializer, false)),
            None => None,
        }
    }

    fn record_missing_destructured_callable_initializer(
        &mut self,
        pattern: &BindingPattern<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        if let BindingPattern::AssignmentPattern(default) = pattern {
            self.record_destructured_callable_initializers(&default.left, &default.right, guard);
        }
    }

    fn binding_callable_container_target(
        &mut self,
        pattern: &BindingPattern<'_>,
    ) -> Option<StaticAliasPath> {
        let BindingPattern::BindingIdentifier(binding) = pattern else {
            return None;
        };
        let target = binding.symbol_id.get().map(StaticAliasPath::root)?;
        self.forwarding_targets.insert(target.clone());
        self.non_generator_callable_targets.insert(target.clone());
        Some(target)
    }

    fn record_callable_container_property(
        &mut self,
        container: &StaticAliasPath,
        property: String,
        initializer: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        let target = container.clone().with_property(property);
        if let Some(guard) = guard {
            self.record_guarded_callable_initializer(target, initializer, guard);
        } else {
            self.record_callable_initializer(target, initializer);
        }
    }

    fn collect_static_array_destructuring_values<'a>(
        initializer: &'a ArrayExpression<'a>,
        values: &mut Vec<Option<&'a Expression<'a>>>,
    ) -> bool {
        for element in &initializer.elements {
            match element {
                ArrayExpressionElement::Elision(_) => values.push(None),
                ArrayExpressionElement::SpreadElement(spread) => {
                    let Expression::ArrayExpression(spread) =
                        spread.argument.get_inner_expression()
                    else {
                        return false;
                    };
                    if !Self::collect_static_array_destructuring_values(spread, values) {
                        return false;
                    }
                }
                _ => values.push(Some(element.to_expression())),
            }
        }
        true
    }

    fn trailing_stored_array_spread(
        &self,
        initializer: &ArrayExpression<'_>,
    ) -> Option<(usize, StaticAliasPath, (u32, u32))> {
        let (spread_index, last) = initializer
            .elements
            .len()
            .checked_sub(1)
            .and_then(|index| {
                initializer
                    .elements
                    .get(index)
                    .map(|element| (index, element))
            })?;
        if initializer.elements[..spread_index]
            .iter()
            .any(|element| matches!(element, ArrayExpressionElement::SpreadElement(_)))
        {
            return None;
        }
        let ArrayExpressionElement::SpreadElement(spread) = last else {
            return None;
        };
        self.callable_reference(&spread.argument)
            .map(|(source, source_span)| (spread_index, source, source_span))
    }

    fn collect_static_object_destructuring_values<'a>(
        &mut self,
        initializer: &'a ObjectExpression<'a>,
        guard: Option<&GeneratorMethodGuard>,
        values: &mut BTreeMap<String, &'a Expression<'a>>,
    ) -> bool {
        for property in &initializer.properties {
            let property = match property {
                OxcObjectPropertyKind::ObjectProperty(property) => property,
                OxcObjectPropertyKind::SpreadProperty(spread) => {
                    let Expression::ObjectExpression(spread) =
                        spread.argument.get_inner_expression()
                    else {
                        return false;
                    };
                    if !self.collect_static_object_destructuring_values(spread, guard, values) {
                        return false;
                    }
                    continue;
                }
            };
            if property.kind != PropertyKind::Init {
                return false;
            }
            let Some(name) = property.key.static_name() else {
                return false;
            };
            if name == "__proto__" {
                return false;
            }
            if let Some(previous) = values.insert(name.into_owned(), &property.value) {
                self.record_static_container_generator_values(previous, guard.is_some());
            }
        }
        true
    }

    fn object_has_stored_spread(initializer: &ObjectExpression<'_>) -> bool {
        initializer.properties.iter().any(|property| {
            let OxcObjectPropertyKind::SpreadProperty(spread) = property else {
                return false;
            };
            match spread.argument.get_inner_expression() {
                Expression::ObjectExpression(object) => Self::object_has_stored_spread(object),
                _ => true,
            }
        })
    }

    fn sole_stored_object_spread(
        &self,
        initializer: &ObjectExpression<'_>,
    ) -> Option<(StaticAliasPath, (u32, u32))> {
        let [OxcObjectPropertyKind::SpreadProperty(spread)] = initializer.properties.as_slice()
        else {
            return None;
        };
        self.callable_reference(&spread.argument)
    }

    fn callable_property_is_known(&self, source: &StaticAliasPath) -> bool {
        self.related_callable_paths(source).iter().any(|source| {
            self.generator_callable_targets.contains(source)
                || self.non_generator_callable_targets.contains(source)
                || self.forwarding_targets.contains(source)
        })
    }

    fn known_callable_child_properties(&self, source: &StaticAliasPath) -> BTreeSet<String> {
        self.generator_callable_targets
            .iter()
            .chain(self.non_generator_callable_targets.iter())
            .chain(self.forwarding_targets.iter())
            .flat_map(|candidate| self.related_callable_paths(candidate))
            .filter(|candidate| {
                candidate.starts_with(source)
                    && candidate.properties.len() == source.properties.len() + 1
                    && !candidate.element_wildcard
            })
            .map(|candidate| candidate.properties[source.properties.len()].clone())
            .collect()
    }

    fn discard_object_destructuring_candidates<'a>(
        &mut self,
        candidates: impl IntoIterator<Item = ObjectDestructuringCandidate<'a>>,
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        for candidate in candidates {
            match candidate {
                ObjectDestructuringCandidate::Expression(expression) => {
                    if let Some(guard) = guard {
                        if !self.record_guarded_nonexecuting_callable(
                            expression,
                            &guard.owner,
                            guard.method,
                            guard.source.is_some(),
                        ) {
                            return false;
                        }
                    } else {
                        self.record_static_container_generator_values(expression, false);
                    }
                }
                ObjectDestructuringCandidate::Stored {
                    source,
                    source_span,
                } => {
                    if let Some(guard) = guard {
                        self.guarded_discarded_invocation_reads.push((
                            source,
                            source_span,
                            guard.clone(),
                        ));
                    } else {
                        self.record_merely_observed_value_read(source, source_span);
                    }
                }
            }
        }
        true
    }

    fn collect_object_destructuring_candidates<'a>(
        &mut self,
        initializer: &'a ObjectExpression<'a>,
        property_name: &str,
        guard: Option<&GeneratorMethodGuard>,
        candidates: &mut Vec<ObjectDestructuringCandidate<'a>>,
    ) -> Option<bool> {
        let mut definitely_present = false;
        for property in &initializer.properties {
            match property {
                OxcObjectPropertyKind::ObjectProperty(property) => {
                    if property.kind != PropertyKind::Init {
                        return None;
                    }
                    let name = property.key.static_name()?;
                    if name == "__proto__" {
                        return None;
                    }
                    if name != property_name {
                        continue;
                    }
                    if !self
                        .discard_object_destructuring_candidates(std::mem::take(candidates), guard)
                    {
                        return None;
                    }
                    candidates.push(ObjectDestructuringCandidate::Expression(&property.value));
                    definitely_present = true;
                }
                OxcObjectPropertyKind::SpreadProperty(spread) => {
                    if let Expression::ObjectExpression(object) =
                        spread.argument.get_inner_expression()
                    {
                        if Self::object_has_stored_spread(object) {
                            return None;
                        }
                        let mut spread_candidates = Vec::new();
                        let spread_definitely_present = self
                            .collect_object_destructuring_candidates(
                                object,
                                property_name,
                                guard,
                                &mut spread_candidates,
                            )?;
                        if spread_definitely_present {
                            if !self.discard_object_destructuring_candidates(
                                std::mem::take(candidates),
                                guard,
                            ) {
                                return None;
                            }
                            definitely_present = true;
                        }
                        candidates.extend(spread_candidates);
                        continue;
                    }
                    let (source, source_span) = self.callable_reference(&spread.argument)?;
                    let source = source.with_property(property_name.to_string());
                    if self.callable_property_is_known(&source) {
                        let property_guard = Self::stored_object_property_guard(&source);
                        if !self.discard_object_destructuring_candidates(
                            std::mem::take(candidates),
                            Some(&property_guard),
                        ) {
                            return None;
                        }
                        definitely_present = true;
                    }
                    candidates.push(ObjectDestructuringCandidate::Stored {
                        source,
                        source_span,
                    });
                }
            }
        }
        Some(definitely_present)
    }

    fn stored_object_property_guard(source: &StaticAliasPath) -> GeneratorMethodGuard {
        GeneratorMethodGuard {
            source: None,
            owner: source.clone(),
            method: "",
        }
    }

    fn record_mixed_object_binding_destructuring(
        &mut self,
        pattern: &ObjectPattern<'_>,
        initializer: &ObjectExpression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        let rest = if let Some(rest) = &pattern.rest {
            if guard.is_some() {
                return false;
            }
            let Some((source, source_span)) = self.sole_stored_object_spread(initializer) else {
                return false;
            };
            let Some(target) = self.binding_callable_container_target(&rest.argument) else {
                return false;
            };
            Some((target, source, source_span))
        } else {
            None
        };
        let mut selected = BTreeSet::new();
        for property in &pattern.properties {
            if matches!(&property.value, BindingPattern::AssignmentPattern(_)) {
                return false;
            }
            let Some(name) = property.key.static_name() else {
                return false;
            };
            selected.insert(name.to_string());
            let mut candidates = Vec::new();
            if self
                .collect_object_destructuring_candidates(initializer, &name, guard, &mut candidates)
                .is_none()
                || candidates.is_empty()
            {
                return false;
            }
            for candidate in candidates {
                match candidate {
                    ObjectDestructuringCandidate::Expression(initializer) => self
                        .record_destructured_callable_initializers(
                            &property.value,
                            initializer,
                            guard,
                        ),
                    ObjectDestructuringCandidate::Stored {
                        source,
                        source_span,
                    } => {
                        if guard.is_some() {
                            return false;
                        }
                        let property_guard = Self::stored_object_property_guard(&source);
                        if !self.record_stored_binding_destructuring(
                            &property.value,
                            source,
                            source_span,
                            Some(&property_guard),
                        ) {
                            return false;
                        }
                    }
                }
            }
        }
        if let Some((target, source, source_span)) = rest {
            for property in self.known_callable_child_properties(&source) {
                if selected.contains(&property) {
                    continue;
                }
                let property_source = source.clone().with_property(property.clone());
                let property_guard = Self::stored_object_property_guard(&property_source);
                self.record_callable_path_initializer(
                    target.clone().with_property(property),
                    property_source,
                    source_span,
                    Some(&property_guard),
                );
            }
        }
        true
    }

    fn record_destructured_callable_initializers(
        &mut self,
        pattern: &BindingPattern<'_>,
        initializer: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        let stored_source = matches!(
            (pattern, initializer.get_inner_expression()),
            (BindingPattern::ArrayPattern(_), expression)
                if !matches!(expression, Expression::ArrayExpression(_))
        ) || matches!(
            (pattern, initializer.get_inner_expression()),
            (BindingPattern::ObjectPattern(_), expression)
                if !matches!(expression, Expression::ObjectExpression(_))
        );
        if stored_source {
            if let Some((source, source_span)) = self.callable_reference(initializer) {
                self.record_stored_binding_destructuring(pattern, source, source_span, guard);
            }
            return;
        }
        match pattern {
            BindingPattern::BindingIdentifier(binding) => {
                let Some(target) = binding.symbol_id.get().map(StaticAliasPath::root) else {
                    return;
                };
                if let Some(guard) = guard {
                    self.record_guarded_callable_initializer(target, initializer, guard);
                } else {
                    self.record_callable_initializer(target, initializer);
                }
            }
            BindingPattern::ArrayPattern(pattern) => {
                let Expression::ArrayExpression(initializer) = initializer.get_inner_expression()
                else {
                    return;
                };
                if let Some((spread_index, source, source_span)) =
                    self.trailing_stored_array_spread(initializer)
                {
                    self.record_trailing_stored_array_binding_destructuring(
                        pattern,
                        initializer,
                        spread_index,
                        source,
                        source_span,
                    );
                    return;
                }
                let mut values = Vec::new();
                if !Self::collect_static_array_destructuring_values(initializer, &mut values) {
                    return;
                }
                let guard = Self::array_iterator_guard();
                let rest_target = if let Some(rest) = &pattern.rest {
                    let Some(target) = self.binding_callable_container_target(&rest.argument)
                    else {
                        return;
                    };
                    Some(target)
                } else {
                    None
                };
                for (index, value) in values.iter().enumerate() {
                    let Some(value) = *value else {
                        if let Some(binding) = pattern.elements.get(index).and_then(Option::as_ref)
                        {
                            self.record_missing_destructured_callable_initializer(
                                binding,
                                Some(&guard),
                            );
                        }
                        continue;
                    };
                    let Some(binding) = pattern.elements.get(index).and_then(Option::as_ref) else {
                        if index >= pattern.elements.len()
                            && let Some(rest_target) = &rest_target
                        {
                            self.record_callable_container_property(
                                rest_target,
                                (index - pattern.elements.len()).to_string(),
                                value,
                                Some(&guard),
                            );
                        } else {
                            self.record_static_container_generator_values(value, true);
                        }
                        continue;
                    };
                    self.record_destructured_callable_initializers(binding, value, Some(&guard));
                }
                for binding in pattern.elements.iter().skip(values.len()).flatten() {
                    self.record_missing_destructured_callable_initializer(binding, Some(&guard));
                }
            }
            BindingPattern::ObjectPattern(pattern) => {
                let Expression::ObjectExpression(initializer) = initializer.get_inner_expression()
                else {
                    return;
                };
                if Self::object_has_stored_spread(initializer) {
                    self.record_mixed_object_binding_destructuring(pattern, initializer, guard);
                    return;
                }
                let rest_target = if let Some(rest) = &pattern.rest {
                    let Some(target) = self.binding_callable_container_target(&rest.argument)
                    else {
                        return;
                    };
                    Some(target)
                } else {
                    None
                };
                let mut values = BTreeMap::new();
                if !self.collect_static_object_destructuring_values(initializer, guard, &mut values)
                {
                    return;
                }
                let mut selected = BTreeSet::new();
                for property in &pattern.properties {
                    let Some(name) = property.key.static_name() else {
                        return;
                    };
                    selected.insert(name.to_string());
                    if let Some(value) = values.get(name.as_ref()) {
                        self.record_destructured_callable_initializers(
                            &property.value,
                            value,
                            guard,
                        );
                    } else {
                        self.record_missing_destructured_callable_initializer(
                            &property.value,
                            guard,
                        );
                    }
                }
                for (name, value) in values {
                    if !selected.contains(&name) {
                        if let Some(rest_target) = &rest_target {
                            self.record_callable_container_property(
                                rest_target,
                                name,
                                value,
                                guard,
                            );
                        } else {
                            self.record_static_container_generator_values(value, guard.is_some());
                        }
                    }
                }
            }
            BindingPattern::AssignmentPattern(default) => {
                if let Some((initializer, selected_default)) =
                    self.select_destructuring_default(Some(initializer), &default.right)
                {
                    if !selected_default {
                        self.record_static_container_generator_values(
                            &default.right,
                            guard.is_some(),
                        );
                    }
                    self.record_destructured_callable_initializers(
                        &default.left,
                        initializer,
                        guard,
                    );
                }
            }
        }
    }

    fn record_assignment_target_callable_initializer(
        &mut self,
        target: &AssignmentTarget<'_>,
        initializer: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        match target {
            AssignmentTarget::ArrayAssignmentTarget(pattern) => {
                self.record_destructured_array_assignment_callable_initializers(
                    pattern,
                    initializer,
                );
            }
            AssignmentTarget::ObjectAssignmentTarget(pattern) => {
                self.record_destructured_object_assignment_callable_initializers(
                    pattern,
                    initializer,
                    guard,
                );
            }
            _ => {
                let Some(target) = self.assignment_callable_target_path(target) else {
                    return;
                };
                if let Some(guard) = guard {
                    self.record_guarded_callable_initializer(target, initializer, guard);
                } else {
                    self.record_callable_initializer(target, initializer);
                }
            }
        }
    }

    fn assignment_callable_target_path(
        &mut self,
        target: &AssignmentTarget<'_>,
    ) -> Option<StaticAliasPath> {
        let place = planned_assignment_target_place(self.scoping, target)?;
        let target = static_alias_invalidation_path(&place)?;
        if !place.projections.is_empty()
            || matches!(place.base, PlannedPlaceBase::UnresolvedGlobal { .. })
        {
            self.member_invalidated
                .extend(prototype_sensitive_invalidation_paths(&target));
        }
        if let Some(span) = place.root_reference_span {
            self.discarded_invocation_reads
                .entry(target.clone())
                .or_default()
                .insert((span.start(), span.end()));
        }
        Some(target)
    }

    fn assignment_callable_container_target(
        &mut self,
        target: &AssignmentTarget<'_>,
    ) -> Option<StaticAliasPath> {
        let target = self.assignment_callable_target_path(target)?;
        self.forwarding_targets.insert(target.clone());
        self.non_generator_callable_targets.insert(target.clone());
        Some(target)
    }

    fn record_stored_assignment_identifier(
        &mut self,
        binding: &IdentifierReference<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        let Some(symbol) = identifier_symbol(self.scoping, binding) else {
            return false;
        };
        let target = StaticAliasPath::root(symbol);
        self.discarded_invocation_reads
            .entry(target.clone())
            .or_default()
            .insert((binding.span.start, binding.span.end));
        self.record_callable_path_initializer(target, source, source_span, guard);
        true
    }

    fn record_stored_assignment_maybe_default_destructuring(
        &mut self,
        target: &AssignmentTargetMaybeDefault<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        if matches!(
            target,
            AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(_)
        ) {
            return false;
        }
        target.as_assignment_target().is_some_and(|target| {
            self.record_stored_assignment_destructuring(target, source, source_span, guard)
        })
    }

    fn record_stored_array_assignment_destructuring(
        &mut self,
        pattern: &ArrayAssignmentTarget<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let guard = Self::stored_array_iterator_guard(&source);
        for (index, target) in pattern.elements.iter().enumerate() {
            let Some(target) = target else {
                continue;
            };
            if !self.record_stored_assignment_maybe_default_destructuring(
                target,
                source.clone().with_property(index.to_string()),
                source_span,
                Some(&guard),
            ) {
                return false;
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                let Ok(index) = property.parse::<usize>() else {
                    continue;
                };
                if index < pattern.elements.len() {
                    continue;
                }
                self.record_callable_path_initializer(
                    rest_target
                        .clone()
                        .with_property((index - pattern.elements.len()).to_string()),
                    source.clone().with_property(property),
                    source_span,
                    Some(&guard),
                );
            }
        }
        true
    }

    fn record_trailing_stored_array_assignment_destructuring(
        &mut self,
        pattern: &ArrayAssignmentTarget<'_>,
        initializer: &ArrayExpression<'_>,
        spread_index: usize,
        source: StaticAliasPath,
        source_span: (u32, u32),
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let outer_guard = Self::array_iterator_guard();
        let spread_guard = Self::stored_array_iterator_guard(&source);
        for (index, target) in pattern.elements.iter().enumerate() {
            let Some(target) = target else {
                if index < spread_index
                    && let Some(value) = initializer.elements.get(index)
                    && !matches!(value, ArrayExpressionElement::Elision(_))
                {
                    self.record_static_container_generator_values(value.to_expression(), true);
                }
                continue;
            };
            if index < spread_index {
                let initializer = initializer.elements.get(index).and_then(|value| {
                    (!matches!(value, ArrayExpressionElement::Elision(_)))
                        .then(|| value.to_expression())
                });
                self.record_assignment_maybe_default_callable_initializer(
                    target,
                    initializer,
                    Some(&outer_guard),
                );
            } else if !self.record_stored_assignment_maybe_default_destructuring(
                target,
                source
                    .clone()
                    .with_property((index - spread_index).to_string()),
                source_span,
                Some(&spread_guard),
            ) {
                return false;
            }
        }
        for value in initializer
            .elements
            .iter()
            .take(spread_index)
            .skip(pattern.elements.len())
            .enumerate()
        {
            let (rest_index, value) = value;
            if matches!(value, ArrayExpressionElement::Elision(_)) {
                continue;
            }
            if let Some(rest_target) = &rest_target {
                self.record_callable_container_property(
                    rest_target,
                    rest_index.to_string(),
                    value.to_expression(),
                    Some(&outer_guard),
                );
            } else {
                self.record_static_container_generator_values(value.to_expression(), true);
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                let Ok(index) = property.parse::<usize>() else {
                    continue;
                };
                let output_index = spread_index + index;
                if output_index < pattern.elements.len() {
                    continue;
                }
                self.record_callable_path_initializer(
                    rest_target
                        .clone()
                        .with_property((output_index - pattern.elements.len()).to_string()),
                    source.clone().with_property(property),
                    source_span,
                    Some(&spread_guard),
                );
            }
        }
        true
    }

    fn record_stored_object_assignment_destructuring(
        &mut self,
        pattern: &ObjectAssignmentTarget<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        let rest_target = if let Some(rest) = &pattern.rest {
            if guard.is_some() {
                return false;
            }
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return false;
            };
            Some(target)
        } else {
            None
        };
        let mut selected = BTreeSet::new();
        for property in &pattern.properties {
            match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                    selected.insert(property.binding.name.to_string());
                    let property_source = source
                        .clone()
                        .with_property(property.binding.name.to_string());
                    let property_guard = Self::stored_object_property_guard(&property_source);
                    if property.init.is_some()
                        || !self.record_stored_assignment_identifier(
                            &property.binding,
                            property_source,
                            source_span,
                            guard.or(Some(&property_guard)),
                        )
                    {
                        return false;
                    }
                }
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    let Some(name) = property.name.static_name() else {
                        return false;
                    };
                    selected.insert(name.to_string());
                    let property_source = source.clone().with_property(name.into_owned());
                    let property_guard = Self::stored_object_property_guard(&property_source);
                    if !self.record_stored_assignment_maybe_default_destructuring(
                        &property.binding,
                        property_source,
                        source_span,
                        guard.or(Some(&property_guard)),
                    ) {
                        return false;
                    }
                }
            }
        }
        if let Some(rest_target) = &rest_target {
            for property in self.known_callable_child_properties(&source) {
                if selected.contains(&property) {
                    continue;
                }
                let property_source = source.clone().with_property(property.clone());
                let property_guard = Self::stored_object_property_guard(&property_source);
                self.record_callable_path_initializer(
                    rest_target.clone().with_property(property),
                    property_source,
                    source_span,
                    Some(&property_guard),
                );
            }
        }
        true
    }

    fn record_mixed_object_assignment_destructuring(
        &mut self,
        pattern: &ObjectAssignmentTarget<'_>,
        initializer: &ObjectExpression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        let rest = if let Some(rest) = &pattern.rest {
            if guard.is_some() {
                return false;
            }
            let Some((source, source_span)) = self.sole_stored_object_spread(initializer) else {
                return false;
            };
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return false;
            };
            Some((target, source, source_span))
        } else {
            None
        };
        let mut selected = BTreeSet::new();
        for property in &pattern.properties {
            let (name, binding) = match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                    if property.init.is_some() {
                        return false;
                    }
                    (
                        property.binding.name.to_string(),
                        EitherAssignmentBinding::Identifier(&property.binding),
                    )
                }
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    if matches!(
                        &property.binding,
                        AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(_)
                    ) {
                        return false;
                    }
                    let Some(name) = property.name.static_name() else {
                        return false;
                    };
                    (
                        name.into_owned(),
                        EitherAssignmentBinding::Target(&property.binding),
                    )
                }
            };
            selected.insert(name.clone());
            let mut candidates = Vec::new();
            if self
                .collect_object_destructuring_candidates(initializer, &name, guard, &mut candidates)
                .is_none()
                || candidates.is_empty()
            {
                return false;
            }
            for candidate in candidates {
                match (&binding, candidate) {
                    (
                        EitherAssignmentBinding::Identifier(binding),
                        ObjectDestructuringCandidate::Expression(initializer),
                    ) => {
                        let Some(symbol) = identifier_symbol(self.scoping, binding) else {
                            return false;
                        };
                        let target = StaticAliasPath::root(symbol);
                        self.discarded_invocation_reads
                            .entry(target.clone())
                            .or_default()
                            .insert((binding.span.start, binding.span.end));
                        if let Some(guard) = guard {
                            self.record_guarded_callable_initializer(target, initializer, guard);
                        } else {
                            self.record_callable_initializer(target, initializer);
                        }
                    }
                    (
                        EitherAssignmentBinding::Target(binding),
                        ObjectDestructuringCandidate::Expression(initializer),
                    ) => self.record_assignment_maybe_default_callable_initializer(
                        binding,
                        Some(initializer),
                        guard,
                    ),
                    (
                        EitherAssignmentBinding::Identifier(binding),
                        ObjectDestructuringCandidate::Stored {
                            source,
                            source_span,
                        },
                    ) => {
                        if guard.is_some() {
                            return false;
                        }
                        let property_guard = Self::stored_object_property_guard(&source);
                        if !self.record_stored_assignment_identifier(
                            binding,
                            source,
                            source_span,
                            Some(&property_guard),
                        ) {
                            return false;
                        }
                    }
                    (
                        EitherAssignmentBinding::Target(binding),
                        ObjectDestructuringCandidate::Stored {
                            source,
                            source_span,
                        },
                    ) => {
                        if guard.is_some() {
                            return false;
                        }
                        let property_guard = Self::stored_object_property_guard(&source);
                        if !self.record_stored_assignment_maybe_default_destructuring(
                            binding,
                            source,
                            source_span,
                            Some(&property_guard),
                        ) {
                            return false;
                        }
                    }
                }
            }
        }
        if let Some((target, source, source_span)) = rest {
            for property in self.known_callable_child_properties(&source) {
                if selected.contains(&property) {
                    continue;
                }
                let property_source = source.clone().with_property(property.clone());
                let property_guard = Self::stored_object_property_guard(&property_source);
                self.record_callable_path_initializer(
                    target.clone().with_property(property),
                    property_source,
                    source_span,
                    Some(&property_guard),
                );
            }
        }
        true
    }

    fn record_stored_assignment_destructuring(
        &mut self,
        target: &AssignmentTarget<'_>,
        source: StaticAliasPath,
        source_span: (u32, u32),
        guard: Option<&GeneratorMethodGuard>,
    ) -> bool {
        match target {
            AssignmentTarget::ArrayAssignmentTarget(pattern) => {
                if !self.record_stored_array_assignment_destructuring(pattern, source, source_span)
                {
                    return false;
                }
            }
            AssignmentTarget::ObjectAssignmentTarget(pattern) => {
                if !self.record_stored_object_assignment_destructuring(
                    pattern,
                    source,
                    source_span,
                    guard,
                ) {
                    return false;
                }
            }
            _ => {
                let Some(target) = self.assignment_callable_target_path(target) else {
                    return false;
                };
                self.record_callable_path_initializer(target, source, source_span, guard);
            }
        }
        true
    }

    fn record_assignment_maybe_default_callable_initializer(
        &mut self,
        target: &AssignmentTargetMaybeDefault<'_>,
        initializer: Option<&Expression<'_>>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        if let AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(default) = target {
            if let Some((initializer, selected_default)) =
                self.select_destructuring_default(initializer, &default.init)
            {
                if !selected_default {
                    self.record_static_container_generator_values(&default.init, guard.is_some());
                }
                self.record_assignment_target_callable_initializer(
                    &default.binding,
                    initializer,
                    guard,
                );
            }
        } else if let Some(initializer) = initializer
            && let Some(target) = target.as_assignment_target()
        {
            self.record_assignment_target_callable_initializer(target, initializer, guard);
        }
    }

    fn record_destructured_array_assignment_callable_initializers(
        &mut self,
        pattern: &ArrayAssignmentTarget<'_>,
        initializer: &Expression<'_>,
    ) {
        let Expression::ArrayExpression(initializer) = initializer.get_inner_expression() else {
            if let Some((source, source_span)) = self.callable_reference(initializer) {
                self.record_stored_array_assignment_destructuring(pattern, source, source_span);
            }
            return;
        };
        if let Some((spread_index, source, source_span)) =
            self.trailing_stored_array_spread(initializer)
        {
            self.record_trailing_stored_array_assignment_destructuring(
                pattern,
                initializer,
                spread_index,
                source,
                source_span,
            );
            return;
        }
        let mut values = Vec::new();
        if !Self::collect_static_array_destructuring_values(initializer, &mut values) {
            return;
        }
        let guard = Self::array_iterator_guard();
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return;
            };
            Some(target)
        } else {
            None
        };
        for (index, value) in values.iter().enumerate() {
            let Some(value) = *value else {
                if let Some(target) = pattern.elements.get(index).and_then(Option::as_ref) {
                    self.record_assignment_maybe_default_callable_initializer(
                        target,
                        None,
                        Some(&guard),
                    );
                }
                continue;
            };
            let Some(target) = pattern.elements.get(index).and_then(Option::as_ref) else {
                if index >= pattern.elements.len()
                    && let Some(rest_target) = &rest_target
                {
                    self.record_callable_container_property(
                        rest_target,
                        (index - pattern.elements.len()).to_string(),
                        value,
                        Some(&guard),
                    );
                } else {
                    self.record_static_container_generator_values(value, true);
                }
                continue;
            };
            self.record_assignment_maybe_default_callable_initializer(
                target,
                Some(value),
                Some(&guard),
            );
        }
        for target in pattern.elements.iter().skip(values.len()).flatten() {
            self.record_assignment_maybe_default_callable_initializer(target, None, Some(&guard));
        }
    }

    fn record_destructured_object_assignment_callable_initializers(
        &mut self,
        pattern: &ObjectAssignmentTarget<'_>,
        initializer: &Expression<'_>,
        guard: Option<&GeneratorMethodGuard>,
    ) {
        let Expression::ObjectExpression(initializer) = initializer.get_inner_expression() else {
            if let Some((source, source_span)) = self.callable_reference(initializer) {
                self.record_stored_object_assignment_destructuring(
                    pattern,
                    source,
                    source_span,
                    guard,
                );
            }
            return;
        };
        if Self::object_has_stored_spread(initializer) {
            self.record_mixed_object_assignment_destructuring(pattern, initializer, guard);
            return;
        }
        let rest_target = if let Some(rest) = &pattern.rest {
            let Some(target) = self.assignment_callable_container_target(&rest.target) else {
                return;
            };
            Some(target)
        } else {
            None
        };
        let mut values = BTreeMap::new();
        if !self.collect_static_object_destructuring_values(initializer, guard, &mut values) {
            return;
        }
        let mut selected = BTreeSet::new();
        for property in &pattern.properties {
            match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                    let name = property.binding.name.to_string();
                    selected.insert(name.clone());
                    let initializer = if let Some(default) = &property.init {
                        self.select_destructuring_default(values.get(&name).copied(), default)
                            .map(|(initializer, selected_default)| {
                                if !selected_default {
                                    self.record_static_container_generator_values(
                                        default,
                                        guard.is_some(),
                                    );
                                }
                                initializer
                            })
                    } else {
                        values.get(&name).copied()
                    };
                    let Some(initializer) = initializer else {
                        continue;
                    };
                    let Some(symbol) = identifier_symbol(self.scoping, &property.binding) else {
                        continue;
                    };
                    let target = StaticAliasPath::root(symbol);
                    self.discarded_invocation_reads
                        .entry(target.clone())
                        .or_default()
                        .insert((property.binding.span.start, property.binding.span.end));
                    if let Some(guard) = guard {
                        self.record_guarded_callable_initializer(target, initializer, guard);
                    } else {
                        self.record_callable_initializer(target, initializer);
                    }
                }
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    let Some(name) = property.name.static_name() else {
                        return;
                    };
                    selected.insert(name.to_string());
                    self.record_assignment_maybe_default_callable_initializer(
                        &property.binding,
                        values.get(name.as_ref()).copied(),
                        guard,
                    );
                }
            }
        }
        for (name, value) in values {
            if !selected.contains(&name) {
                if let Some(rest_target) = &rest_target {
                    self.record_callable_container_property(rest_target, name, value, guard);
                } else {
                    self.record_static_container_generator_values(value, guard.is_some());
                }
            }
        }
    }

    fn record_nonexecuting_callable(&mut self, expression: &Expression<'_>) {
        if let Some((path, span)) = self.callable_reference(expression) {
            self.discarded_invocation_reads
                .entry(path)
                .or_default()
                .insert(span);
            return;
        }
        if let Some((path, span)) = self.constructed_instance_callable_reference(expression) {
            self.discarded_invocation_reads
                .entry(path)
                .or_default()
                .insert(span);
            return;
        }
        let mut body_spans = BTreeSet::new();
        if Self::collect_inline_generator_body_spans(expression, &mut body_spans) {
            self.directly_unexecuted_body_spans.extend(body_spans);
            return;
        }
        match expression {
            Expression::FunctionExpression(function) => {
                if let Some(span) = Self::generator_body_span(function) {
                    self.directly_unexecuted_body_spans.insert(span);
                }
            }
            Expression::ConditionalExpression(conditional) => {
                self.record_nonexecuting_callable(&conditional.consequent);
                self.record_nonexecuting_callable(&conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.record_nonexecuting_callable(&logical.left);
                self.record_nonexecuting_callable(&logical.right);
            }
            Expression::ParenthesizedExpression(parenthesized) => {
                self.record_nonexecuting_callable(&parenthesized.expression);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(last) = sequence.expressions.last() {
                    self.record_nonexecuting_callable(last);
                }
            }
            Expression::TSAsExpression(expression) => {
                self.record_nonexecuting_callable(&expression.expression);
            }
            Expression::TSSatisfiesExpression(expression) => {
                self.record_nonexecuting_callable(&expression.expression);
            }
            Expression::TSTypeAssertion(expression) => {
                self.record_nonexecuting_callable(&expression.expression);
            }
            Expression::TSNonNullExpression(expression) => {
                self.record_nonexecuting_callable(&expression.expression);
            }
            Expression::TSInstantiationExpression(expression) => {
                self.record_nonexecuting_callable(&expression.expression);
            }
            _ => {}
        }
    }

    fn record_discarded_value_read(&mut self, expression: &Expression<'_>) {
        if let Some((path, span)) = self.callable_reference(expression) {
            self.record_merely_observed_value_read(path, span);
            return;
        }
        match expression {
            Expression::ConditionalExpression(conditional) => {
                self.record_discarded_value_read(&conditional.consequent);
                self.record_discarded_value_read(&conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.record_discarded_value_read(&logical.left);
                self.record_discarded_value_read(&logical.right);
            }
            Expression::ParenthesizedExpression(parenthesized) => {
                self.record_discarded_value_read(&parenthesized.expression);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(last) = sequence.expressions.last() {
                    self.record_discarded_value_read(last);
                }
            }
            Expression::TSAsExpression(expression) => {
                self.record_discarded_value_read(&expression.expression);
            }
            Expression::TSSatisfiesExpression(expression) => {
                self.record_discarded_value_read(&expression.expression);
            }
            Expression::TSTypeAssertion(expression) => {
                self.record_discarded_value_read(&expression.expression);
            }
            Expression::TSNonNullExpression(expression) => {
                self.record_discarded_value_read(&expression.expression);
            }
            Expression::TSInstantiationExpression(expression) => {
                self.record_discarded_value_read(&expression.expression);
            }
            Expression::ArrayExpression(expression) => {
                for element in &expression.elements {
                    if matches!(
                        element,
                        ArrayExpressionElement::Elision(_)
                            | ArrayExpressionElement::SpreadElement(_)
                    ) {
                        continue;
                    }
                    self.record_discarded_value_read(element.to_expression());
                }
            }
            Expression::ObjectExpression(expression) => {
                for property in &expression.properties {
                    let OxcObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    self.record_discarded_value_read(&property.value);
                }
            }
            _ => {}
        }
    }

    fn record_discarded_expression(&mut self, expression: &Expression<'_>) {
        match expression {
            Expression::CallExpression(call) => {
                self.discarded_invocation_spans
                    .insert((call.span.start, call.span.end));
                self.record_assignment_callable_read(call, true);
                if !self.record_discarded_bind(expression)
                    && !self.record_nonexecuting_indirect_call(call)
                {
                    self.record_nonexecuting_callable(&call.callee);
                }
            }
            Expression::TaggedTemplateExpression(tagged) => {
                self.discarded_invocation_spans
                    .insert((tagged.span.start, tagged.span.end));
                self.record_assignment_tagged_read(tagged, true);
                self.record_nonexecuting_callable(&tagged.tag);
            }
            Expression::NewExpression(expression) => {
                self.discarded_invocation_spans
                    .insert((expression.span.start, expression.span.end));
                self.record_nonexecuting_callable(&expression.callee);
            }
            Expression::StaticMemberExpression(expression) => {
                self.record_discarded_expression(&expression.object);
            }
            Expression::ComputedMemberExpression(expression) => {
                self.record_discarded_expression(&expression.object);
            }
            Expression::PrivateFieldExpression(expression) => {
                self.record_discarded_expression(&expression.object);
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => {
                    self.discarded_invocation_spans
                        .insert((call.span.start, call.span.end));
                    self.record_assignment_callable_read(call, true);
                    if !self.record_discarded_bind(expression)
                        && !self.record_nonexecuting_indirect_call(call)
                    {
                        self.record_nonexecuting_callable(&call.callee);
                    }
                }
                ChainElement::StaticMemberExpression(member) => {
                    self.record_discarded_expression(&member.object);
                }
                ChainElement::ComputedMemberExpression(member) => {
                    self.record_discarded_expression(&member.object);
                }
                ChainElement::PrivateFieldExpression(member) => {
                    self.record_discarded_expression(&member.object);
                }
                ChainElement::TSNonNullExpression(_) => {}
            },
            Expression::ConditionalExpression(conditional) => {
                self.record_discarded_expression(&conditional.consequent);
                self.record_discarded_expression(&conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.record_discarded_expression(&logical.left);
                self.record_discarded_expression(&logical.right);
            }
            Expression::UnaryExpression(unary) => {
                self.record_discarded_expression(&unary.argument);
            }
            Expression::SequenceExpression(sequence) => {
                for expression in &sequence.expressions {
                    self.record_discarded_expression(expression);
                }
            }
            Expression::ParenthesizedExpression(parenthesized) => {
                self.record_discarded_expression(&parenthesized.expression);
            }
            Expression::TSAsExpression(expression) => {
                self.record_discarded_expression(&expression.expression);
            }
            Expression::TSSatisfiesExpression(expression) => {
                self.record_discarded_expression(&expression.expression);
            }
            Expression::TSTypeAssertion(expression) => {
                self.record_discarded_expression(&expression.expression);
            }
            Expression::TSNonNullExpression(expression) => {
                self.record_discarded_expression(&expression.expression);
            }
            Expression::TSInstantiationExpression(expression) => {
                self.record_discarded_expression(&expression.expression);
            }
            _ => {
                let mut spread_body_spans = BTreeSet::new();
                let mut guarded_spread_body_spans = BTreeSet::new();
                self.collect_discarded_spread_generator_body_spans(
                    expression,
                    &mut spread_body_spans,
                    &mut guarded_spread_body_spans,
                );
                self.directly_unexecuted_body_spans
                    .extend(spread_body_spans);
                self.guarded_unexecuted_body_spans.extend(
                    guarded_spread_body_spans
                        .into_iter()
                        .map(|span| (span, Self::array_iterator_guard())),
                );
                if let Some(pending) = self.pending_discarded_invocations(expression) {
                    self.record_discarded_invocations(pending);
                }
                self.record_nonexecuting_callable(expression);
                self.record_discarded_value_read(expression);
            }
        }
    }

    fn record_forwarded_callable(&mut self, target: StaticAliasPath, expression: &Expression<'_>) {
        self.forwarding_targets.insert(target.clone());
        if let Some(forwardings) = self.generator_bind_forwardings(expression) {
            let parameter_offset = Self::fixed_bound_parameter_count(expression);
            for forwarding in forwardings {
                match forwarding {
                    GeneratorBindForwarding::Source {
                        source,
                        source_span,
                        guard,
                    } => {
                        self.record_pending_bound_arguments(&source, expression, &guard);
                        self.record_retained_bind_arguments(&target, expression, &guard);
                        self.forwarded_callable_reads.push(ForwardedCallableRead {
                            source,
                            source_span,
                            target: target.clone(),
                            method_guard: Some(guard),
                            parameter_offset,
                        });
                    }
                    GeneratorBindForwarding::Inline { body_span, guard } => {
                        self.record_retained_bind_arguments(&target, expression, &guard);
                        self.generator_callable_targets.insert(target.clone());
                        self.generator_body_targets
                            .push((body_span, target.clone()));
                        self.guarded_generator_targets.push((target.clone(), guard));
                    }
                }
            }
            return;
        }
        let call = match expression.get_inner_expression() {
            Expression::CallExpression(call) => Some(call.as_ref()),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => Some(call.as_ref()),
                ChainElement::TSNonNullExpression(_)
                | ChainElement::ComputedMemberExpression(_)
                | ChainElement::StaticMemberExpression(_)
                | ChainElement::PrivateFieldExpression(_) => None,
            },
            _ => None,
        };
        if let Some(call) = call {
            if self.record_returned_generator_callable(target.clone(), call) {
                return;
            }
            if self.record_generator_result_forwarding(target.clone(), call) {
                self.non_generator_callable_targets.insert(target);
                return;
            }
        }
        if let Expression::TaggedTemplateExpression(tagged) = expression.get_inner_expression() {
            let recorded = self.record_generator_result_source(target.clone(), &tagged.tag, None);
            if recorded {
                if let Some(source) = self.assignment_callable_target(&tagged.tag) {
                    self.assigned_generator_result_reads
                        .push(ForwardedCallableRead {
                            source,
                            source_span: (tagged.span.start, tagged.span.end),
                            target: target.clone(),
                            method_guard: None,
                            parameter_offset: None,
                        });
                }
                self.non_generator_callable_targets.insert(target);
                return;
            }
        }
        if let Some((source, source_span)) = self.callable_reference(expression) {
            self.forwarded_callable_reads.push(ForwardedCallableRead {
                source,
                source_span,
                target,
                method_guard: None,
                parameter_offset: Some(0),
            });
            return;
        }
        match expression {
            Expression::FunctionExpression(function) => {
                self.record_callable_target_span(target.clone(), function.span);
                if let Some(span) = Self::generator_body_span(function) {
                    self.generator_callable_targets.insert(target.clone());
                    self.generator_body_targets.push((span, target));
                } else {
                    self.non_generator_callable_targets.insert(target);
                }
            }
            Expression::ArrowFunctionExpression(function) => {
                self.record_callable_target_span(target.clone(), function.span);
                self.non_generator_callable_targets.insert(target);
            }
            Expression::ClassExpression(class) => {
                self.non_generator_callable_targets.insert(target.clone());
                self.record_class_generator_bodies(&target, class);
            }
            Expression::ConditionalExpression(conditional) => {
                self.record_forwarded_callable(target.clone(), &conditional.consequent);
                self.record_forwarded_callable(target, &conditional.alternate);
            }
            Expression::LogicalExpression(logical) => {
                self.record_forwarded_callable(target.clone(), &logical.left);
                self.record_forwarded_callable(target, &logical.right);
            }
            Expression::ParenthesizedExpression(parenthesized) => {
                self.record_forwarded_callable(target, &parenthesized.expression);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(last) = sequence.expressions.last() {
                    self.record_forwarded_callable(target, last);
                } else {
                    self.non_generator_callable_targets.insert(target);
                }
            }
            Expression::AssignmentExpression(assignment)
                if assignment.operator == OxcAssignmentOperator::Assign =>
            {
                self.record_forwarded_callable(target, &assignment.right);
            }
            Expression::TSAsExpression(expression) => {
                self.record_forwarded_callable(target, &expression.expression);
            }
            Expression::TSSatisfiesExpression(expression) => {
                self.record_forwarded_callable(target, &expression.expression);
            }
            Expression::TSTypeAssertion(expression) => {
                self.record_forwarded_callable(target, &expression.expression);
            }
            Expression::TSNonNullExpression(expression) => {
                self.record_forwarded_callable(target, &expression.expression);
            }
            Expression::TSInstantiationExpression(expression) => {
                self.record_forwarded_callable(target, &expression.expression);
            }
            _ => {
                self.non_generator_callable_targets.insert(target);
            }
        }
    }

    fn related_callable_paths(&self, initial: &StaticAliasPath) -> BTreeSet<StaticAliasPath> {
        fn replace_prefix(
            path: &StaticAliasPath,
            from: &StaticAliasPath,
            to: &StaticAliasPath,
        ) -> Option<StaticAliasPath> {
            if !path.starts_with(from) {
                return None;
            }
            let mut related = to.clone();
            related
                .properties
                .extend_from_slice(&path.properties[from.properties.len()..]);
            related.element_wildcard |= path.element_wildcard;
            Some(related.canonicalized())
        }

        let mut related = BTreeSet::new();
        let mut pending = VecDeque::from([initial.clone()]);
        while let Some(path) = pending.pop_front() {
            if !related.insert(path.clone()) {
                continue;
            }
            for forwarding in &self.forwarded_callable_reads {
                if forwarding.method_guard.is_some() {
                    continue;
                }
                if let Some(alias) = replace_prefix(&path, &forwarding.source, &forwarding.target) {
                    pending.push_back(alias);
                }
                if let Some(source) = replace_prefix(&path, &forwarding.target, &forwarding.source)
                {
                    pending.push_back(source);
                }
            }
        }
        related
    }

    fn method_path_is_intact(&self, source: &StaticAliasPath, method: &str) -> bool {
        let sources = self.related_callable_paths(source);
        if sources.iter().any(|source| {
            self.escaped_callable_paths
                .iter()
                .any(|escaped| escaped.overlaps(source))
        }) {
            return false;
        }
        sources
            .iter()
            .map(|source| {
                if method.is_empty() {
                    source.clone()
                } else {
                    source.with_property(method.to_string())
                }
            })
            .all(|method| {
                self.member_invalidated
                    .iter()
                    .all(|invalidated| !invalidated.overlaps(&method))
            })
    }

    fn method_guard_is_intact(&self, guard: &GeneratorMethodGuard) -> bool {
        self.method_path_is_intact(&guard.owner, guard.method)
            && guard
                .source
                .as_ref()
                .is_none_or(|source| self.method_path_is_intact(source, guard.method))
    }

    fn terminal_alias_guard_is_intact(
        &self,
        source: &StaticAliasPath,
        guard: &TerminalAliasGuard,
    ) -> bool {
        let Some(terminal_alias) = guard.aliases.last() else {
            return false;
        };
        if guard
            .aliases
            .iter()
            .any(|alias| self.non_generator_callable_targets.contains(alias))
        {
            return false;
        }
        let Some(terminal_read) = self.sole_terminal_method_alias_read(terminal_alias) else {
            return false;
        };
        if terminal_read.source != *source
            || !terminal_read
                .method_guard
                .as_ref()
                .is_some_and(|method_guard| method_guard.method == guard.method)
        {
            return false;
        }
        let terminal_method = source.clone().with_property(guard.method.to_string());
        if self.sole_forwarded_callable_source(terminal_alias) != Some(&terminal_method) {
            return false;
        }
        guard
            .aliases
            .windows(2)
            .all(|aliases| self.sole_forwarded_callable_source(&aliases[0]) == Some(&aliases[1]))
    }

    fn finish(mut self) -> ExecutionStateFacts {
        for candidate in std::mem::take(&mut self.guarded_local_non_consuming_parameters) {
            if candidate
                .method_guards
                .iter()
                .all(|guard| self.method_guard_is_intact(guard))
            {
                self.local_non_consuming_parameters
                    .insert(candidate.target, candidate.parameters);
            }
        }
        self.propagate_local_non_consuming_parameters();
        for read in std::mem::take(&mut self.pending_callable_argument_reads) {
            let parameters_are_non_consuming =
                |parameters: &NonConsumingParameters, parameter_offset: usize| match read
                    .parameter_selection
                {
                    PendingParameterSelection::Index(index) => index
                        .checked_add(parameter_offset)
                        .and_then(|index| parameters.returned(index))
                        .is_some_and(|returned| !returned || read.result_discarded),
                    PendingParameterSelection::All => parameters
                        .shifted(parameter_offset)
                        .all_non_consuming(read.result_discarded),
                };
            let sources_are_non_consuming =
                read.parameter_sources.as_ref().is_some_and(|sources| {
                    !sources.is_empty()
                        && sources.iter().all(|source| {
                            let (parameters, parameter_offset, method_guards) = match source {
                                PendingParameterSource::Local {
                                    source,
                                    parameter_offset,
                                    method_guards,
                                } => (
                                    self.local_non_consuming_parameters.get(source),
                                    *parameter_offset,
                                    method_guards,
                                ),
                                PendingParameterSource::Inline {
                                    parameters,
                                    parameter_offset,
                                    method_guards,
                                } => (Some(parameters), *parameter_offset, method_guards),
                            };
                            method_guards
                                .iter()
                                .all(|guard| self.method_guard_is_intact(guard))
                                && parameters.is_some_and(|parameters| {
                                    parameters_are_non_consuming(parameters, parameter_offset)
                                })
                        })
                });
            let non_consuming = read
                .method_guard
                .as_ref()
                .is_none_or(|guard| self.method_guard_is_intact(guard))
                && sources_are_non_consuming;
            match read.value {
                PendingCallableArgumentValue::Reference {
                    source,
                    source_span,
                } => {
                    if non_consuming {
                        self.discarded_value_reads
                            .entry(source)
                            .or_default()
                            .insert(source_span);
                    } else {
                        self.escaped_callable_paths.insert(source);
                    }
                }
                PendingCallableArgumentValue::Invocations(pending) if non_consuming => {
                    self.record_discarded_invocations(pending);
                }
                PendingCallableArgumentValue::Invocations(_) => {}
            }
        }
        for read in std::mem::take(&mut self.initial_generator_next_argument_reads) {
            let direct_generator_result = self.generator_result_reads.iter().any(|result| {
                result.target == read.iterator
                    && result.method_guard.is_none()
                    && self.generator_callable_targets.contains(&result.source)
                    && !self.non_generator_callable_targets.contains(&result.source)
            });
            let sole_iterator_read = read
                .iterator
                .binding_root()
                .and_then(|root| self.binding_reads.get(&root))
                .is_some_and(|spans| spans.len() == 1 && spans.contains(&read.iterator_span));
            if direct_generator_result
                && sole_iterator_read
                && self.method_path_is_intact(&read.iterator, "next")
            {
                self.discarded_value_reads
                    .entry(read.source)
                    .or_default()
                    .insert(read.source_span);
            } else {
                self.escaped_callable_paths.insert(read.source);
            }
        }
        let trusted_method_forwardings = self
            .forwarded_callable_reads
            .iter()
            .map(|forwarding| {
                forwarding
                    .method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_generator_result_reads = self
            .generator_result_reads
            .iter()
            .map(|forwarding| {
                forwarding
                    .method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_terminal_method_alias_reads = self
            .terminal_method_alias_reads
            .iter()
            .map(|read| {
                read.method_guard
                    .as_ref()
                    .is_some_and(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_retained_reads = self
            .retained_callable_reads
            .iter()
            .map(|forwarding| {
                forwarding
                    .method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_generator_argument_reads = self
            .generator_argument_reads
            .iter()
            .map(|forwarding| {
                forwarding
                    .method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_generator_body_argument_reads = self
            .generator_body_argument_reads
            .iter()
            .map(|read| {
                read.method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_assigned_generator_result_reads = self
            .assigned_generator_result_reads
            .iter()
            .map(|read| {
                read.method_guard
                    .as_ref()
                    .is_none_or(|guard| self.method_guard_is_intact(guard))
            })
            .collect::<Vec<_>>();
        let trusted_guarded_reads = self
            .guarded_discarded_invocation_reads
            .iter()
            .map(|(_, _, guard)| self.method_guard_is_intact(guard))
            .collect::<Vec<_>>();
        let trusted_composite_guarded_reads = self
            .composite_guarded_reads
            .iter()
            .map(|read| {
                read.method_guards
                    .iter()
                    .all(|guard| self.method_guard_is_intact(guard))
                    && read.terminal_alias.as_ref().is_none_or(|guard| {
                        self.terminal_alias_guard_is_intact(&read.source, guard)
                    })
            })
            .collect::<Vec<_>>();
        let trusted_guarded_body_spans = self
            .guarded_unexecuted_body_spans
            .iter()
            .filter_map(|(span, guard)| self.method_guard_is_intact(guard).then_some(*span))
            .collect::<BTreeSet<_>>();
        let mut forced_executed_targets = self
            .guarded_generator_targets
            .iter()
            .filter_map(|(target, guard)| {
                (!self.method_guard_is_intact(guard)).then_some(target.clone())
            })
            .collect::<BTreeSet<_>>();
        let (propagated_callable_targets, returned_callable_spans) =
            self.propagate_callable_target_spans(&trusted_method_forwardings);
        let mut candidates = self.forwarding_targets.clone();
        candidates.extend(self.non_generator_callable_targets.iter().cloned());
        candidates.extend(propagated_callable_targets);
        candidates.extend(
            self.generator_body_targets
                .iter()
                .map(|(_, target)| target.clone()),
        );
        candidates.extend(
            self.forwarded_callable_reads
                .iter()
                .map(|forwarding| forwarding.source.clone()),
        );
        candidates.extend(
            self.forwarded_callable_reads
                .iter()
                .map(|forwarding| forwarding.target.clone()),
        );
        candidates.extend(
            self.generator_result_reads
                .iter()
                .flat_map(|forwarding| [forwarding.source.clone(), forwarding.target.clone()]),
        );
        candidates.extend(
            self.terminal_method_alias_reads
                .iter()
                .flat_map(|read| [read.source.clone(), read.target.clone()]),
        );
        candidates.extend(
            self.retained_callable_reads
                .iter()
                .flat_map(|forwarding| [forwarding.source.clone(), forwarding.target.clone()]),
        );
        candidates.extend(
            self.generator_argument_reads
                .iter()
                .flat_map(|forwarding| [forwarding.source.clone(), forwarding.target.clone()]),
        );
        candidates.extend(
            self.generator_body_argument_reads
                .iter()
                .map(|read| read.source.clone()),
        );
        candidates.extend(
            self.assigned_generator_result_reads
                .iter()
                .flat_map(|read| [read.source.clone(), read.target.clone()]),
        );
        candidates.extend(self.composite_guarded_reads.iter().flat_map(|read| {
            std::iter::once(read.source.clone()).chain(read.target.iter().cloned())
        }));
        candidates.extend(
            self.explicitly_merely_observed_callable_paths
                .iter()
                .cloned(),
        );
        forced_executed_targets.extend(
            candidates
                .iter()
                .filter(|path| {
                    path.properties
                        .last()
                        .is_some_and(|property| property == "toJSON")
                        && self
                            .json_serialized_value_paths
                            .iter()
                            .any(|source| path.starts_with(source))
                })
                .cloned(),
        );
        let mut targets_by_body = BTreeMap::<_, BTreeSet<_>>::new();
        for (span, target) in &self.generator_body_targets {
            targets_by_body
                .entry(*span)
                .or_default()
                .insert(target.clone());
        }
        let mut definite_generator_callables = BTreeSet::new();
        loop {
            let mut changed = false;
            for path in &candidates {
                if definite_generator_callables.contains(path)
                    || forced_executed_targets.contains(path)
                    || self.non_generator_callable_targets.contains(path)
                {
                    continue;
                }
                let dependencies = self
                    .forwarded_callable_reads
                    .iter()
                    .enumerate()
                    .filter_map(|(index, forwarding)| {
                        Self::replace_callable_path_prefix(
                            path,
                            &forwarding.target,
                            &forwarding.source,
                        )
                        .map(|source| (index, source))
                    })
                    .collect::<Vec<_>>();
                if !self.generator_callable_targets.contains(path) && dependencies.is_empty() {
                    continue;
                }
                if dependencies.iter().all(|(index, source)| {
                    trusted_method_forwardings[*index]
                        && definite_generator_callables.contains(source)
                }) {
                    changed |= definite_generator_callables.insert(path.clone());
                }
            }
            if !changed {
                break;
            }
        }
        let mut merely_observed = candidates
            .iter()
            .filter(|path| {
                path.binding_root().is_some() && !forced_executed_targets.contains(*path)
            })
            .chain(
                self.explicitly_merely_observed_callable_paths
                    .iter()
                    .filter(|path| !forced_executed_targets.contains(*path)),
            )
            .cloned()
            .collect::<BTreeSet<_>>();
        loop {
            let mut rejected = Vec::new();
            for path in &candidates {
                if !merely_observed.contains(path) {
                    continue;
                }
                let Some(root) = path.binding_root() else {
                    continue;
                };
                let all_reads_are_observations =
                    self.binding_reads
                        .get(&root)
                        .into_iter()
                        .flatten()
                        .chain(self.direct_callable_reads.get(path).into_iter().flatten())
                        .all(|span| {
                            self.merely_observed_value_reads.iter().any(
                                |(observed, observed_spans)| {
                                    (observed.starts_with(path) || path.starts_with(observed))
                                        && observed_spans.contains(span)
                                },
                            ) || self.forwarded_callable_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_method_forwardings[index]
                                        && forwarding.source_span == *span
                                        && Self::replace_callable_path_prefix(
                                            path,
                                            &forwarding.source,
                                            &forwarding.target,
                                        )
                                        .is_some_and(|target| merely_observed.contains(&target))
                                },
                            ) || self.retained_callable_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_retained_reads[index]
                                        && forwarding.source.starts_with(path)
                                        && forwarding.source_span == *span
                                        && merely_observed.contains(&forwarding.target)
                                },
                            ) || self
                                .read_is_owned_by_merely_observed_callable(span, &merely_observed)
                        });
                if !all_reads_are_observations {
                    rejected.push(path.clone());
                }
            }
            if rejected.is_empty() {
                break;
            }
            for path in rejected {
                merely_observed.remove(&path);
            }
        }
        let mut unexecuted = BTreeSet::new();
        loop {
            let mut changed = false;
            for path in &candidates {
                if unexecuted.contains(path) || forced_executed_targets.contains(path) {
                    continue;
                }
                let Some(root) = path.binding_root() else {
                    continue;
                };
                let discarded = self.discarded_invocation_reads.get(path);
                let all_reads_are_nonexecuting = self
                    .binding_reads
                    .get(&root)
                    .into_iter()
                    .flatten()
                    .chain(self.direct_callable_reads.get(path).into_iter().flatten())
                    .all(|span| {
                        discarded.is_some_and(|discarded| discarded.contains(span))
                            || self.discarded_value_reads.iter().any(
                                |(observed, observed_spans)| {
                                    (observed.starts_with(path) || path.starts_with(observed))
                                        && observed_spans.contains(span)
                                },
                            )
                            || self
                                .guarded_discarded_invocation_reads
                                .iter()
                                .enumerate()
                                .any(|(index, (source, source_span, _))| {
                                    trusted_guarded_reads[index]
                                        && source == path
                                        && source_span == span
                                })
                            || self.composite_guarded_reads.iter().enumerate().any(
                                |(index, read)| {
                                    trusted_composite_guarded_reads[index]
                                        && read.source == *path
                                        && read.source_span == *span
                                        && read
                                            .target
                                            .as_ref()
                                            .is_none_or(|target| unexecuted.contains(target))
                                },
                            )
                            || self.terminal_method_alias_reads.iter().enumerate().any(
                                |(index, read)| {
                                    trusted_terminal_method_alias_reads[index]
                                        && read.source == *path
                                        && read.source_span == *span
                                        && unexecuted.contains(&read.target)
                                },
                            )
                            || self.forwarded_callable_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_method_forwardings[index]
                                        && forwarding.source == *path
                                        && forwarding.source_span == *span
                                        && unexecuted.contains(&forwarding.target)
                                },
                            )
                            || self.forwarded_callable_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_method_forwardings[index]
                                        && forwarding.source != *path
                                        && forwarding.source.starts_with(path)
                                        && forwarding.source_span == *span
                                        && merely_observed.contains(&forwarding.target)
                                },
                            )
                            || self.retained_callable_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_retained_reads[index]
                                        && forwarding.source.starts_with(path)
                                        && forwarding.source_span == *span
                                        && (merely_observed.contains(&forwarding.target)
                                            || (definite_generator_callables
                                                .contains(&forwarding.target)
                                                && unexecuted.contains(&forwarding.target)))
                                },
                            )
                            || self.generator_argument_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_generator_argument_reads[index]
                                        && forwarding.source.starts_with(path)
                                        && forwarding.source_span == *span
                                        && definite_generator_callables.contains(&forwarding.target)
                                        && (forwarding.source == forwarding.target
                                            || unexecuted.contains(&forwarding.target))
                                },
                            )
                            || self.generator_body_argument_reads.iter().enumerate().any(
                                |(index, read)| {
                                    trusted_generator_body_argument_reads[index]
                                        && read.source.starts_with(path)
                                        && read.source_span == *span
                                        && read.body_spans.iter().all(|body_span| {
                                            self.directly_unexecuted_body_spans.contains(body_span)
                                                || trusted_guarded_body_spans.contains(body_span)
                                                || targets_by_body.get(body_span).is_some_and(
                                                    |targets| {
                                                        targets.iter().all(|target| {
                                                            unexecuted.contains(target)
                                                        })
                                                    },
                                                )
                                        })
                                },
                            )
                            || self.generator_result_reads.iter().enumerate().any(
                                |(index, forwarding)| {
                                    trusted_generator_result_reads[index]
                                        && forwarding.source == *path
                                        && forwarding.source_span == *span
                                        && unexecuted.contains(&forwarding.target)
                                },
                            )
                            || self.assigned_generator_result_reads.iter().enumerate().any(
                                |(index, read)| {
                                    trusted_assigned_generator_result_reads[index]
                                        && read.source == *path
                                        && read.source_span == *span
                                        && definite_generator_callables.contains(&read.source)
                                        && unexecuted.contains(&read.target)
                                },
                            )
                    });
                if all_reads_are_nonexecuting {
                    changed |= unexecuted.insert(path.clone());
                }
            }
            if !changed {
                break;
            }
        }
        let direct_advances = self
            .direct_generator_advances
            .iter()
            .filter(|advance| self.method_guard_is_intact(&advance.method_guard))
            .filter(|advance| {
                !self
                    .composite_guarded_reads
                    .iter()
                    .enumerate()
                    .any(|(index, read)| {
                        trusted_composite_guarded_reads[index]
                            && read.target.is_none()
                            && read.source == advance.source
                            && read.source_span == advance.source_span
                    })
            })
            .collect::<Vec<_>>();
        let mut precisely_advanced_generator_paths = BTreeSet::new();
        let mut precise_generator_advance_indices = BTreeMap::new();
        for target in self
            .generator_result_reads
            .iter()
            .map(|read| read.target.clone())
            .collect::<BTreeSet<_>>()
        {
            if !self.is_immutable_local_callable_target(&target) {
                continue;
            }
            let result_reads = self
                .generator_result_reads
                .iter()
                .enumerate()
                .filter(|(_, read)| read.target == target)
                .collect::<Vec<_>>();
            if result_reads.is_empty()
                || !result_reads.iter().all(|(index, read)| {
                    trusted_generator_result_reads[*index]
                        && definite_generator_callables.contains(&read.source)
                        && !self.non_generator_callable_targets.contains(&read.source)
                })
            {
                continue;
            }
            let advances = direct_advances
                .iter()
                .filter(|advance| advance.source == target)
                .collect::<Vec<_>>();
            if advances.is_empty() {
                continue;
            }
            let Some(root) = target.binding_root() else {
                continue;
            };
            let all_reads_are_direct_advances = self
                .binding_reads
                .get(&root)
                .into_iter()
                .flatten()
                .all(|span| advances.iter().any(|advance| advance.source_span == *span));
            if !all_reads_are_direct_advances {
                continue;
            }
            precisely_advanced_generator_paths.insert(target);
            precise_generator_advance_indices.extend(
                advances
                    .into_iter()
                    .enumerate()
                    .map(|(index, advance)| (advance.call_span, index)),
            );
        }
        for retained in self.retained_invocation_spans {
            if unexecuted.contains(&retained.target) {
                self.discarded_invocation_spans
                    .extend(retained.invocation_spans);
            }
        }
        let mut unexecuted_body_spans = self.directly_unexecuted_body_spans;
        unexecuted_body_spans.extend(trusted_guarded_body_spans);
        unexecuted_body_spans.extend(targets_by_body.into_iter().filter_map(|(span, targets)| {
            targets
                .iter()
                .all(|target| unexecuted.contains(target))
                .then_some(span)
        }));
        ExecutionStateFacts {
            discarded_invocation_spans: self.discarded_invocation_spans,
            unexecuted_body_spans,
            unexecuted_callable_spans: self.directly_unexecuted_callable_spans,
            unexecuted_callable_paths: unexecuted,
            merely_observed_callable_paths: merely_observed,
            returned_callable_spans,
            precisely_advanced_generator_paths,
            precise_generator_advance_indices,
        }
    }
}

impl<'a> Visit<'a> for ExecutionStateCollector<'_> {
    fn visit_statements(&mut self, statements: &ArenaVec<'a, Statement<'a>>) {
        self.record_terminal_before_advance_reads(statements);
        walk_statements(self, statements);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let Some(reference_id) = identifier.reference_id.get() else {
            return;
        };
        let reference = self.scoping.get_reference(reference_id);
        if reference.is_read()
            && let Some(symbol) = reference.symbol_id()
        {
            let span = (identifier.span.start, identifier.span.end);
            self.binding_reads.entry(symbol).or_default().insert(span);
            if !self.callable_owner_spans.is_empty() {
                self.read_callable_owner_spans
                    .insert(span, self.callable_owner_spans.clone());
            }
        }
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let Some(initializer) = &declarator.init {
            if let BindingPattern::BindingIdentifier(binding) = &declarator.id
                && let Some(target_symbol) = binding.symbol_id.get()
            {
                let target = StaticAliasPath::root(target_symbol);
                self.record_callable_initializer(target, initializer);
                if !self
                    .scoping
                    .get_resolved_references(target_symbol)
                    .any(|reference| reference.is_read())
                {
                    self.record_discarded_expression(initializer);
                }
            } else {
                self.record_destructured_callable_initializers(&declarator.id, initializer, None);
            }
        }
        walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if assignment.operator == OxcAssignmentOperator::Assign {
            self.record_assignment_target_callable_initializer(
                &assignment.left,
                &assignment.right,
                None,
            );
        } else if let Some(place) = planned_assignment_target_place(self.scoping, &assignment.left)
            && let Some(target) = static_alias_invalidation_path(&place)
            && (!place.projections.is_empty()
                || matches!(place.base, PlannedPlaceBase::UnresolvedGlobal { .. }))
        {
            self.member_invalidated
                .extend(prototype_sensitive_invalidation_paths(&target));
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, assignment);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        self.record_static_json_replacer_array_mutation(call);
        self.record_assignment_callable_read(call, false);
        self.record_generator_invocation_arguments(call);
        self.record_terminal_generator_method_read(call);
        self.record_indirect_terminal_generator_method_read(call);
        self.record_indirect_terminal_method_alias_read(call);
        self.record_immediate_bound_terminal_generator_method_read(call);
        self.record_initial_generator_next_arguments(call);
        self.record_direct_generator_advance(call);
        self.record_pending_callable_arguments(call);
        walk_call_expression(self, call);
    }

    fn visit_tagged_template_expression(&mut self, expression: &TaggedTemplateExpression<'a>) {
        self.record_assignment_tagged_read(expression, false);
        self.record_pending_tagged_arguments(expression);
        if let Some(target) = self
            .callable_reference(&expression.tag)
            .map(|(target, _)| target)
            .or_else(|| self.assignment_callable_target(&expression.tag))
        {
            for substitution in &expression.quasi.expressions {
                self.record_retained_callable_source(
                    target.clone(),
                    substitution,
                    None,
                    RetainedCallableReadKind::GeneratorInvocation,
                );
            }
        } else {
            let mut body_spans = BTreeSet::new();
            if Self::collect_inline_generator_body_spans(&expression.tag, &mut body_spans) {
                for substitution in &expression.quasi.expressions {
                    self.record_retained_generator_body_source(&body_spans, substitution, None);
                }
            }
        }
        oxc::ast_visit::walk::walk_tagged_template_expression(self, expression);
    }

    fn visit_expression_statement(&mut self, statement: &ExpressionStatement<'a>) {
        self.record_discarded_expression(&statement.expression);
        walk_expression_statement(self, statement);
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'a>) {
        self.record_nonexecuting_callable(&expression.callee);
        self.record_pending_constructor_arguments(expression);
        oxc::ast_visit::walk::walk_new_expression(self, expression);
    }

    fn visit_update_expression(&mut self, expression: &UpdateExpression<'a>) {
        if let Some(place) =
            planned_simple_assignment_target_place(self.scoping, &expression.argument)
            && (!place.projections.is_empty()
                || matches!(place.base, PlannedPlaceBase::UnresolvedGlobal { .. }))
            && let Some(target) = static_alias_invalidation_path(&place)
        {
            self.member_invalidated
                .extend(prototype_sensitive_invalidation_paths(&target));
        }
        oxc::ast_visit::walk::walk_update_expression(self, expression);
    }

    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if expression.operator == OxcUnaryOperator::Delete
            && let Some(place) = planned_expression_place(self.scoping, &expression.argument)
            && (!place.projections.is_empty()
                || matches!(place.base, PlannedPlaceBase::UnresolvedGlobal { .. }))
            && let Some(target) = static_alias_invalidation_path(&place)
        {
            self.member_invalidated
                .extend(prototype_sensitive_invalidation_paths(&target));
        }
        oxc::ast_visit::walk::walk_unary_expression(self, expression);
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        if let Some(argument) = &statement.argument {
            self.record_escaped_callable_path(argument);
        }
        oxc::ast_visit::walk::walk_return_statement(self, statement);
    }

    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let Some(definition) = self.returned_callable_definition_from_function(function) {
            self.record_returned_callable_definition(function.span, definition);
        }
        if function.r#type == FunctionType::FunctionDeclaration
            && !function.generator
            && !function.r#async
            && let Some(target) = function
                .id
                .as_ref()
                .and_then(|identifier| identifier.symbol_id.get())
        {
            let spans = self.returned_generator_bodies_from_function(function);
            if !spans.is_empty() {
                self.returned_generator_body_spans
                    .insert(StaticAliasPath::root(target), spans);
            }
        }
        if function.r#type == FunctionType::FunctionDeclaration
            && !function.generator
            && let Some(target) = function
                .id
                .as_ref()
                .and_then(|identifier| identifier.symbol_id.get())
            && !self
                .scoping
                .get_resolved_references(target)
                .any(|reference| reference.is_write())
            && let Some(parameters) = self.local_non_consuming_parameters(function)
        {
            self.local_non_consuming_parameters
                .insert(StaticAliasPath::root(target), parameters);
        }
        if function.r#type == FunctionType::FunctionDeclaration
            && let Some(target) = function
                .id
                .as_ref()
                .and_then(|identifier| identifier.symbol_id.get())
        {
            let target = StaticAliasPath::root(target);
            self.record_callable_target_span(target.clone(), function.span);
            if let Some(span) = Self::generator_body_span(function) {
                self.generator_callable_targets.insert(target.clone());
                self.generator_body_targets.push((span, target));
            } else {
                self.non_generator_callable_targets.insert(target);
            }
        }
        let deferred = self.function_depth > 0;
        self.function_depth = self.function_depth.saturating_add(1);
        if deferred {
            self.callable_owner_spans
                .push((function.span.start, function.span.end));
        }
        walk_function(self, function, flags);
        if deferred {
            self.callable_owner_spans.pop();
        }
        self.function_depth = self.function_depth.saturating_sub(1);
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        if let Some(definition) = self.returned_callable_definition_from_arrow(function) {
            self.record_returned_callable_definition(function.span, definition);
        }
        let deferred = self.function_depth > 0;
        self.function_depth = self.function_depth.saturating_add(1);
        if deferred {
            self.callable_owner_spans
                .push((function.span.start, function.span.end));
        }
        oxc::ast_visit::walk::walk_arrow_function_expression(self, function);
        if deferred {
            self.callable_owner_spans.pop();
        }
        self.function_depth = self.function_depth.saturating_sub(1);
    }

    fn visit_class(&mut self, class: &Class<'a>) {
        if class.r#type == ClassType::ClassDeclaration
            && let Some(target) = class
                .id
                .as_ref()
                .and_then(|identifier| identifier.symbol_id.get())
        {
            let target = StaticAliasPath::root(target);
            self.record_class_generator_bodies(&target, class);
            if self.is_immutable_local_callable_target(&target)
                && let Some(parameters) = self.local_non_consuming_class_parameters(class)
            {
                self.local_non_consuming_parameters
                    .insert(target, parameters);
            }
        }
        oxc::ast_visit::walk::walk_class(self, class);
    }
}
