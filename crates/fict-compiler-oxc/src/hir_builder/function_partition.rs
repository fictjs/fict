//! Partition module facts into function-owned HIR bodies and indexed source ranges.

use super::*;

impl<'source, 'semantic> Builder<'source, 'semantic> {
    pub(super) fn build_function_shells(&mut self) {
        let module_scope = self
            .function_facts
            .first()
            .map_or(ScopeId::new(0), |fact| fact.scope);
        let module_policy = |kind| {
            self.frontend
                .source_facts
                .directives
                .iter()
                .any(|directive| directive.scope == module_scope && directive.kind == kind)
        };
        let module_no_memo = module_policy(FictDirectiveKind::NoMemo);
        let module_pure = module_policy(FictDirectiveKind::Pure);
        for mut fact in self.function_facts.clone() {
            // Program directives are module policy and apply to every function in the file.
            // Function-scoped directives remain local to the exact semantic scope below.
            fact.flags.no_memo |= module_no_memo;
            fact.flags.pure |= module_pure;
            for directive in self
                .frontend
                .source_facts
                .directives
                .iter()
                .filter(|directive| directive.scope == fact.scope)
            {
                match directive.kind {
                    FictDirectiveKind::NoMemo => fact.flags.no_memo = true,
                    FictDirectiveKind::Pure => fact.flags.pure = true,
                    FictDirectiveKind::UseStrict
                    | FictDirectiveKind::UseFictCompiler
                    | FictDirectiveKind::DisableFictCompiler
                    | FictDirectiveKind::Other => {}
                }
            }
            let binding = fact
                .binding
                .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
            let kind = if fact.id == FunctionId::new(0) {
                FunctionKind::Module
            } else {
                classify_named_function(fact.display_name.as_deref())
            };
            let mut locals = Vec::new();
            let mut parameters = Vec::new();
            let mut values = Vec::new();
            let mut direct_parameter_bindings = BTreeSet::new();
            let parameter_bindings: BTreeSet<_> = fact
                .parameters
                .iter()
                .flat_map(|parameter| parameter.bindings.iter())
                .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                .collect();
            for parameter in &fact.parameters {
                let declared_bindings: Vec<_> = parameter
                    .bindings
                    .iter()
                    .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                    .collect();
                let rest_bindings: Vec<_> = parameter
                    .rest_bindings
                    .iter()
                    .filter_map(|symbol| self.symbol_to_binding.get(symbol).copied())
                    .collect();
                let direct_binding = parameter
                    .direct_binding
                    .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
                direct_parameter_bindings.extend(direct_binding);
                let (object_properties, object_rest) = self
                    .lower_object_parameter(parameter)
                    .map_or((None, None), |(properties, rest)| (Some(properties), rest));
                let fragment = self.add_fragment(
                    SyntaxFragmentKind::Pattern,
                    parameter.span,
                    SyntaxSummary {
                        referenced_bindings: Vec::new(),
                        pattern: Some(PatternSummary {
                            property_bindings: Vec::new(),
                            declared_bindings,
                            assigned_bindings: Vec::new(),
                            has_defaults: parameter.has_default,
                            has_rest: parameter.has_rest,
                        }),
                        has_side_effects: parameter.has_default,
                        may_throw: parameter.has_default,
                        ..SyntaxSummary::default()
                    },
                );
                let local = LocalId::new(count_u32(locals.len()));
                let origin = Origin::source(parameter.span);
                locals.push(HirLocal {
                    id: local,
                    binding: direct_binding,
                    scope: fact.scope,
                    kind: LocalKind::Parameter,
                    declaration_kind: DeclarationKind::Parameter,
                    debug_name: direct_binding.and_then(|binding| {
                        self.frontend
                            .bindings
                            .iter()
                            .find(|candidate| {
                                self.old_to_new.get(&candidate.id.index()) == Some(&binding)
                            })
                            .map(|candidate| candidate.display_name.clone())
                    }),
                    origin,
                });
                parameters.push(HirParameter {
                    local,
                    binding: direct_binding,
                    pattern: fragment,
                    rest_bindings,
                    is_rest: parameter.is_rest,
                    default_value: parameter.default_value.map(Origin::source),
                    object_properties,
                    object_rest,
                    origin,
                });
                values.push(HirValue {
                    id: ValueId::new(count_u32(values.len())),
                    kind: ValueKind::Parameter(local),
                    origin,
                });
            }

            let accessor_parameter_bindings: BTreeSet<_> = parameters
                .iter()
                .flat_map(|parameter| parameter.object_properties.iter().flatten())
                .filter(|property| property.mode == HirObjectParameterMode::Accessor)
                .map(|property| property.binding)
                .collect();

            for source_binding in self
                .frontend
                .bindings
                .iter()
                .filter(|binding| binding.is_runtime)
            {
                let hir_binding = self.old_to_new[&source_binding.id.index()];
                if direct_parameter_bindings.contains(&hir_binding)
                    || self.function_owner_for_scope(source_binding.scope) != fact.id
                {
                    continue;
                }
                locals.push(HirLocal {
                    id: LocalId::new(count_u32(locals.len())),
                    binding: Some(hir_binding),
                    scope: source_binding.scope,
                    kind: if accessor_parameter_bindings.contains(&hir_binding) {
                        LocalKind::Parameter
                    } else {
                        LocalKind::User
                    },
                    declaration_kind: if parameter_bindings.contains(&hir_binding) {
                        DeclarationKind::Parameter
                    } else {
                        declaration_kind(source_binding.kind)
                    },
                    debug_name: Some(source_binding.display_name.clone()),
                    origin: Origin::source(source_binding.declaration_span),
                });
            }

            let local_bindings: BTreeSet<_> =
                locals.iter().filter_map(|local| local.binding).collect();
            for captured in self.directly_referenced_bindings(&fact) {
                if local_bindings.contains(&captured) {
                    continue;
                }
                let Some(source_binding) = self.frontend.bindings.iter().find(|binding| {
                    self.old_to_new.get(&binding.id.index()).copied() == Some(captured)
                }) else {
                    continue;
                };
                locals.push(HirLocal {
                    id: LocalId::new(count_u32(locals.len())),
                    binding: Some(captured),
                    scope: fact.scope,
                    kind: LocalKind::Capture,
                    declaration_kind: DeclarationKind::Generated,
                    debug_name: Some(source_binding.display_name.clone()),
                    origin: Origin::source(source_binding.declaration_span),
                });
            }

            let declarations = locals
                .iter()
                .filter(|local| local.kind != LocalKind::Parameter)
                .map(|local| HirInstruction {
                    result: None,
                    kind: HirInstructionKind::Declare {
                        local: local.id,
                        declaration_kind: local.declaration_kind,
                        initializer: None,
                    },
                    semantics: InstructionSemantics::PURE_EAGER,
                    origin: local.origin,
                })
                .collect();

            let origin = Origin::source(fact.span);
            self.functions.push(HirFunction {
                id: fact.id,
                parent: fact.parent,
                binding,
                scope: fact.scope,
                kind,
                flags: fact.flags,
                parameters,
                locals,
                values,
                blocks: vec![HirBlock {
                    id: BlockId::new(0),
                    scope: fact.scope,
                    instructions: declarations,
                    terminator: HirTerminator {
                        kind: TerminatorKind::Return { value: None },
                        origin: Origin::generated(
                            Some(fact.body_span),
                            GeneratedOrigin::ControlFlow,
                        ),
                    },
                    source_hint: None,
                    origin,
                }],
                entry: BlockId::new(0),
                effect_statements: Vec::new(),
                regions: Vec::<RegionId>::new(),
                origin,
            });
        }
    }

    pub(super) fn index_function_owners(&mut self) {
        self.function_children = vec![Vec::new(); self.function_facts.len()];
        for function in &self.function_facts {
            if function.parent != function.id {
                self.function_children[function.parent.as_usize()].push(function.id);
            }
        }
        for children in &mut self.function_children {
            children.sort_by_key(|id| self.function_facts[id.as_usize()].span.start());
        }
        for (symbol, binding) in &self.symbol_to_binding {
            for reference in self.semantic.symbol_references(*symbol) {
                self.source_references.push(ResolvedSourceReference {
                    span: source_span(self.semantic.reference_span(reference)),
                    binding: *binding,
                    is_read: reference.is_read(),
                });
            }
        }
        self.source_references
            .sort_by_key(|reference| (reference.span.start(), reference.binding));

        let mut owners = vec![None; self.frontend.scopes.len()];
        for function in &self.function_facts {
            owners[function.scope.as_usize()] = Some(function.id);
        }
        for index in 0..owners.len() {
            let mut current = index;
            let mut path = Vec::new();
            let owner = loop {
                if let Some(owner) = owners[current] {
                    break owner;
                }
                path.push(current);
                match self.frontend.scopes[current].parent {
                    Some(parent) => current = parent.as_usize(),
                    None => break FunctionId::new(0),
                }
            };
            for scope in path {
                owners[scope] = Some(owner);
            }
        }
        self.function_by_scope = owners
            .into_iter()
            .map(|owner| owner.unwrap_or(FunctionId::new(0)))
            .collect();
        self.function_body_order = self
            .function_facts
            .iter()
            .map(|function| function.id)
            .collect();
        self.function_body_order.sort_by_key(|id| {
            let function = &self.function_facts[id.as_usize()];
            (
                function.body_span.start(),
                std::cmp::Reverse(function.body_span.end()),
                std::cmp::Reverse(id.index()),
            )
        });
    }

    pub(super) fn function_owner_for_scope(&self, scope: ScopeId) -> FunctionId {
        self.function_by_scope
            .get(scope.as_usize())
            .copied()
            .unwrap_or(FunctionId::new(0))
    }

    pub(super) fn populate_function_bodies(
        &mut self,
        calls: &[CallFact],
        variable_declarations: &[VariableDeclarationFact],
        typed_expression_collector: &TypedExpressionCollector<'_>,
        mutation_collector: &MutationCollector<'_>,
        member_reads: &[MemberReadFact],
        jsx_roots: &[JsxFact],
    ) {
        let typed_expressions = typed_expression_collector.facts.as_slice();
        let classes = typed_expression_collector.classes.as_slice();
        let decorators = typed_expression_collector.decorators.as_slice();
        let mutations = mutation_collector.facts.as_slice();
        let pattern_assignments = mutation_collector.pattern_assignments.as_slice();
        let mut reactive_targets: BTreeSet<_> = calls
            .iter()
            .filter(|call| {
                call.binding
                    .and_then(|binding| self.macro_bindings.get(&binding))
                    .is_some_and(|kind| {
                        matches!(
                            kind,
                            FictMacroKind::State | FictMacroKind::Memo | FictMacroKind::Async
                        )
                    })
            })
            .filter_map(|call| call.direct_variable_binding)
            .collect();
        reactive_targets.extend(
            calls
                .iter()
                .filter(|call| {
                    call.binding
                        .and_then(|binding| {
                            self.imported_hook_direct_kind(binding, call.callee_reference.as_ref())
                        })
                        .is_some_and(|kind| {
                            matches!(
                                kind,
                                ImportedReactiveKind::Signal
                                    | ImportedReactiveKind::Memo
                                    | ImportedReactiveKind::Async
                                    | ImportedReactiveKind::AsyncAccessor
                            )
                        })
                })
                .filter_map(|call| call.direct_variable_binding),
        );
        reactive_targets.extend(self.frontend.bindings.iter().filter_map(|binding| {
            let reactive = binding.import.as_ref().and_then(|import| import.reactive)?;
            matches!(
                reactive,
                ImportedReactiveKind::Signal
                    | ImportedReactiveKind::Memo
                    | ImportedReactiveKind::Async
                    | ImportedReactiveKind::AsyncAccessor
            )
            .then(|| self.old_to_new.get(&binding.id.index()).copied())
            .flatten()
        }));
        self.reactive_value_bindings = reactive_targets.clone();
        let mut opaque_patterns: Vec<_> = variable_declarations
            .iter()
            .filter(|declaration| {
                declaration.initializer_span.is_some() && declaration.simple_binding.is_none()
            })
            .map(|declaration| {
                (
                    self.function_owner_for_span(declaration.declarator_span),
                    declaration.pattern_span,
                )
            })
            .collect();
        opaque_patterns.extend(pattern_assignments.iter().map(|assignment| {
            (
                self.function_owner_for_span(assignment.span),
                assignment.pattern_span,
            )
        }));
        let mut accessor_read_suppressions = BTreeSet::new();
        for jsx in jsx_roots {
            collect_reactive_component_accessor_spans(
                &jsx.root,
                &self.symbol_to_binding,
                &reactive_targets,
                &mut accessor_read_suppressions,
            );
        }
        let mut projected_root_suppressions: BTreeSet<_> = member_reads
            .iter()
            .filter_map(|fact| fact.place.root_reference_span)
            .chain(
                mutations
                    .iter()
                    .filter_map(|fact| fact.place.as_ref()?.root_reference_span),
            )
            .chain(pattern_assignments.iter().flat_map(|assignment| {
                assignment
                    .projected_targets
                    .iter()
                    .filter_map(|target| target.place.root_reference_span)
            }))
            .chain(
                typed_expressions
                    .iter()
                    .filter_map(typed_expression_reference_suppression),
            )
            .map(|span| (span.start(), span.end()))
            .collect();
        projected_root_suppressions.extend(
            typed_expression_collector
                .class_self_references
                .iter()
                .copied(),
        );
        let reads = self.collect_reads(
            &reactive_targets,
            &accessor_read_suppressions,
            &projected_root_suppressions,
            &opaque_patterns,
        );
        self.preintern_globals(typed_expressions, mutations, member_reads, &reads);
        let local_mutations =
            self.collect_local_mutations(mutations, &reactive_targets, &opaque_patterns);
        for assignment in pattern_assignments {
            for target in &assignment.projected_targets {
                let reactive = match target.place.base {
                    PlannedPlaceBase::Binding(symbol) => self
                        .symbol_to_binding
                        .get(&symbol)
                        .is_some_and(|binding| reactive_targets.contains(binding)),
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. } => false,
                };
                if reactive {
                    self.report_nested_reactive_mutation(target.span);
                }
            }
        }
        let evaluation_facts: Vec<_> = calls
            .iter()
            .filter(|call| {
                !span_is_within_owned_pattern(call.owner, call.span, &opaque_patterns)
                    || call.reactive_kind.is_some()
                    || call.configured_reactive_scope
                    || call.binding.is_some_and(|binding| {
                        self.macro_bindings.contains_key(&binding)
                            || self.configured_bindings.contains(&binding)
                    })
            })
            .cloned()
            .map(EvaluationFact::Call)
            .chain(jsx_roots.iter().cloned().map(EvaluationFact::Jsx))
            .chain(
                typed_expressions
                    .iter()
                    .filter(|expression| {
                        let owner = self.function_owner_for_span(expression.span);
                        !span_is_within_owned_pattern(owner, expression.span, &opaque_patterns)
                    })
                    .cloned()
                    .map(EvaluationFact::Typed),
            )
            .chain(
                member_reads
                    .iter()
                    .filter(|member| {
                        let owner = self.function_owner_for_span(member.span);
                        !span_is_within_owned_pattern(owner, member.span, &opaque_patterns)
                            || matches!(
                                member.place.base,
                                PlannedPlaceBase::Binding(symbol)
                                    if self
                                        .symbol_to_binding
                                        .get(&symbol)
                                        .is_some_and(|binding| reactive_targets.contains(binding))
                            )
                    })
                    .cloned()
                    .map(EvaluationFact::Member),
            )
            .chain(
                local_mutations
                    .iter()
                    .cloned()
                    .map(EvaluationFact::Mutation),
            )
            .chain(
                pattern_assignments
                    .iter()
                    .cloned()
                    .map(EvaluationFact::PatternAssignment),
            )
            .chain(decorators.iter().copied().map(EvaluationFact::Decorator))
            .chain(classes.iter().cloned().map(EvaluationFact::Class))
            .collect();
        let function_count = self.functions.len();
        let mut evaluations_by_owner: Vec<Vec<EvaluationFact>> = vec![Vec::new(); function_count];
        for event in evaluation_facts {
            let owner = match &event {
                EvaluationFact::Call(call) => call.owner,
                EvaluationFact::Jsx(jsx) => jsx.owner,
                EvaluationFact::Mutation(mutation) => mutation.owner,
                _ => self.function_owner_for_span(event.span()),
            };
            evaluations_by_owner[owner.as_usize()].push(event);
        }
        let mut reads_by_owner = vec![Vec::new(); function_count];
        for read in &reads {
            reads_by_owner[read.owner.as_usize()].push(read);
        }
        let mut declarations_by_owner = vec![Vec::new(); function_count];
        for declaration in variable_declarations {
            declarations_by_owner[self
                .function_owner_for_span(declaration.declarator_span)
                .as_usize()]
            .push(declaration);
        }
        let mut call_argument_functions_by_owner = vec![BTreeSet::new(); function_count];
        for call in calls {
            call_argument_functions_by_owner[call.owner.as_usize()].extend(
                call.arguments
                    .iter()
                    .filter_map(|argument| argument.function),
            );
        }
        let mut nested_by_owner = vec![Vec::new(); function_count];
        for child in &self.function_facts {
            if child.parent != child.id
                && !call_argument_functions_by_owner[child.parent.as_usize()].contains(&child.id)
            {
                nested_by_owner[child.parent.as_usize()].push(child.clone());
            }
        }
        for fact in self.function_facts.clone() {
            let has_structured_control_flow = self.has_structured_control_flow(fact.id);
            let mut inputs = Vec::new();
            for child in &nested_by_owner[fact.id.as_usize()] {
                let value = self.push_value(
                    fact.id,
                    ValueKind::Function(child.id),
                    Origin::source(child.span),
                    HirInstructionKind::Function { function: child.id },
                    InstructionSemantics::PURE_EAGER,
                );
                inputs.push(value);
            }

            for read in &reads_by_owner[fact.id.as_usize()] {
                let block = self.planned_block_for_span(fact.id, read.span);
                let semantics = match read.place.base {
                    PlannedPlaceBase::Binding(_) if read.reactive => reactive_read_semantics(),
                    PlannedPlaceBase::Binding(_) => InstructionSemantics::PURE_EAGER,
                    PlannedPlaceBase::UnresolvedGlobal { .. }
                    | PlannedPlaceBase::Context { .. }
                    | PlannedPlaceBase::Expression { .. } => {
                        InstructionSemantics::CONSERVATIVE_EAGER
                    }
                };
                let Some(place) = self.materialize_planned_place(fact.id, block, &read.place)
                else {
                    continue;
                };
                let value = self.push_value_to_block(
                    fact.id,
                    block,
                    ValueKind::InstructionResult,
                    Origin::source(read.span),
                    HirInstructionKind::Read { place },
                    semantics,
                );
                inputs.push(value);
            }

            let evaluation_facts = &mut evaluations_by_owner[fact.id.as_usize()];
            evaluation_facts.sort_by_key(|event| {
                let span = event.span();
                (span.end(), std::cmp::Reverse(span.start()), event.rank())
            });
            for event in evaluation_facts {
                let value = match event {
                    EvaluationFact::Typed(expression) => {
                        self.materialize_typed_expression(fact.id, expression)
                    }
                    EvaluationFact::Jsx(jsx) => Some(self.materialize_jsx(fact.id, jsx)),
                    EvaluationFact::Call(call) => self.materialize_call(fact.id, call),
                    EvaluationFact::Member(member) => self.materialize_member_read(fact.id, member),
                    EvaluationFact::Mutation(mutation) => {
                        self.materialize_mutation(fact.id, mutation)
                    }
                    EvaluationFact::PatternAssignment(assignment) => {
                        self.materialize_pattern_assignment(fact.id, assignment)
                    }
                    EvaluationFact::Decorator(decorator) => {
                        Some(self.materialize_decorator(fact.id, decorator))
                    }
                    EvaluationFact::Class(class) => Some(self.materialize_class(fact.id, class)),
                };
                inputs.extend(value);
            }

            let owned_declarations = &declarations_by_owner[fact.id.as_usize()];
            let mut declaration_counts = BTreeMap::new();
            for declaration in owned_declarations
                .iter()
                .filter(|declaration| declaration.declaration_kind == DeclarationKind::Var)
            {
                for symbol in &declaration.bindings {
                    *declaration_counts.entry(*symbol).or_insert(0_usize) += 1;
                }
            }
            for declaration in owned_declarations {
                let link_var = declaration.declaration_kind == DeclarationKind::Var
                    && declaration.simple_binding.is_some_and(|symbol| {
                        declaration_counts.get(&symbol) == Some(&1)
                            && self.can_link_var_initializer(fact.id, declaration, symbol)
                    });
                inputs.extend(self.materialize_variable_declaration(
                    fact.id,
                    declaration,
                    link_var,
                ));
            }

            for (_, pattern) in opaque_patterns
                .iter()
                .filter(|(owner, _)| *owner == fact.id)
            {
                self.mark_pattern_children_deferred(fact.id, *pattern);
            }

            if !has_structured_control_flow {
                let body_summary = SyntaxSummary {
                    referenced_bindings: self.referenced_bindings(fact.body_span),
                    has_side_effects: true,
                    may_throw: true,
                    contains_await: fact.flags.is_async,
                    contains_yield: fact.flags.is_generator,
                    contains_jsx: source_slice(self.source, fact.body_span)
                        .is_some_and(|slice| slice.contains('<')),
                    ..SyntaxSummary::default()
                };
                let fragment =
                    self.add_fragment(SyntaxFragmentKind::Statement, fact.body_span, body_summary);
                self.functions[fact.id.as_usize()].blocks[0]
                    .instructions
                    .push(HirInstruction {
                        result: None,
                        kind: HirInstructionKind::SyntaxFragment { fragment, inputs },
                        semantics: InstructionSemantics::CONSERVATIVE_EAGER,
                        origin: Origin::source(fact.body_span),
                    });
                if let [return_fact] = fact.returns.as_slice() {
                    let value = return_fact.value.map(|span| {
                        self.control_expression_value(fact.id, BlockId::new(0), span, true, true)
                    });
                    self.functions[fact.id.as_usize()].blocks[0].terminator = HirTerminator {
                        kind: TerminatorKind::Return { value },
                        origin: Origin::source(return_fact.statement),
                    };
                }
            }
            self.materialize_control_flow_terminators(fact.id);
            self.order_function_instructions(fact.id);
        }
    }

    pub(super) fn collect_reads(
        &self,
        reactive_targets: &BTreeSet<BindingId>,
        suppressions: &BTreeSet<(u32, u32)>,
        projected_root_suppressions: &BTreeSet<(u32, u32)>,
        opaque_patterns: &[(FunctionId, SourceSpan)],
    ) -> Vec<ReadFact> {
        let mut reads = Vec::new();
        for (symbol, binding) in &self.symbol_to_binding {
            for reference in self.semantic.scoping().get_resolved_reference_ids(*symbol) {
                let reference = self.semantic.scoping().get_reference(*reference);
                if !reference.is_read()
                    || reference.is_write()
                    || reference_is_inside_with(self.semantic.scoping(), reference.scope_id())
                {
                    continue;
                }
                let span = source_span(self.semantic.reference_span(reference));
                if projected_root_suppressions.contains(&(span.start(), span.end())) {
                    continue;
                }
                let reactive = reactive_targets.contains(binding);
                let owner = self.function_owner_for_span(span);
                if !reactive && span_is_within_owned_pattern(owner, span, opaque_patterns) {
                    continue;
                }
                if reactive && suppressions.contains(&(span.start(), span.end())) {
                    continue;
                }
                reads.push(ReadFact {
                    owner,
                    place: PlannedPlace {
                        base: PlannedPlaceBase::Binding(*symbol),
                        projections: Vec::new(),
                        root_reference_span: Some(span),
                    },
                    span,
                    reactive,
                });
            }
        }
        for (name, reference_ids) in self.semantic.scoping().root_unresolved_references() {
            for reference_id in reference_ids {
                let reference = self.semantic.scoping().get_reference(*reference_id);
                if !reference.is_read()
                    || reference.is_write()
                    || reference_is_inside_with(self.semantic.scoping(), reference.scope_id())
                {
                    continue;
                }
                let span = source_span(self.semantic.reference_span(reference));
                if projected_root_suppressions.contains(&(span.start(), span.end()))
                    || suppressions.contains(&(span.start(), span.end()))
                {
                    continue;
                }
                let owner = self.function_owner_for_span(span);
                if name == "arguments" && owner != FunctionId::new(0) {
                    continue;
                }
                if span_is_within_owned_pattern(owner, span, opaque_patterns) {
                    continue;
                }
                reads.push(ReadFact {
                    owner,
                    place: PlannedPlace {
                        base: PlannedPlaceBase::UnresolvedGlobal {
                            name: name.to_string(),
                            span,
                        },
                        projections: Vec::new(),
                        root_reference_span: Some(span),
                    },
                    span,
                    reactive: false,
                });
            }
        }
        reads.sort_by_key(|read| (read.span.start(), read.span.end()));
        reads
    }

    pub(super) fn collect_local_mutations(
        &mut self,
        mutations: &[MutationFact],
        reactive_targets: &BTreeSet<BindingId>,
        opaque_patterns: &[(FunctionId, SourceSpan)],
    ) -> Vec<LocalMutationFact> {
        let mut facts = Vec::new();
        for mutation in mutations {
            let binding = mutation
                .symbol
                .and_then(|symbol| self.symbol_to_binding.get(&symbol).copied());
            if mutation.symbol.is_some() && binding.is_none() {
                continue;
            }
            let reactive = binding.is_some_and(|binding| reactive_targets.contains(&binding));
            let owner = self.function_owner_for_span(mutation.span);
            if !reactive && span_is_within_owned_pattern(owner, mutation.span, opaque_patterns) {
                continue;
            }
            if mutation.projected && reactive {
                self.report_nested_reactive_mutation(mutation.span);
            }
            if mutation.projected && mutation.place.is_none() {
                continue;
            }
            let place = mutation.place.clone().or_else(|| {
                mutation.symbol.map(|symbol| PlannedPlace {
                    base: PlannedPlaceBase::Binding(symbol),
                    projections: Vec::new(),
                    root_reference_span: Some(mutation.target_span),
                })
            });
            let Some(place) = place else {
                continue;
            };
            facts.push(LocalMutationFact {
                owner,
                binding,
                place,
                span: mutation.span,
                kind: mutation.kind,
                reactive,
            });
        }
        facts.sort_by_key(|mutation| {
            (
                mutation.span.start(),
                mutation.span.end(),
                mutation.binding.map_or(u32::MAX, BindingId::index),
            )
        });
        facts
    }

    pub(super) fn function_owner_for_span(&self, span: SourceSpan) -> FunctionId {
        let index = self.function_body_order.partition_point(|id| {
            self.function_facts[id.as_usize()].body_span.start() <= span.start()
        });
        let Some(mut id) = index
            .checked_sub(1)
            .map(|index| self.function_body_order[index])
        else {
            return FunctionId::new(0);
        };
        loop {
            let function = &self.function_facts[id.as_usize()];
            if span_contains(function.body_span, span) {
                return id;
            }
            if function.parent == id {
                return FunctionId::new(0);
            }
            id = function.parent;
        }
    }
}
