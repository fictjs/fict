use super::*;
#[derive(Clone)]
struct RewriteMatchState {
    creations: BTreeSet<(u32, u32)>,
    derived_creations: BTreeSet<BindingId>,
    props: BTreeSet<(u32, u32)>,
    prop_reads: BTreeSet<(u32, u32)>,
    reads: BTreeSet<(u32, u32)>,
    mutations: BTreeSet<(u32, u32)>,
    vnodes: BTreeSet<(u32, u32)>,
    components: BTreeSet<(u32, u32)>,
    component_roots: BTreeSet<(u32, u32)>,
    conditional_returns: BTreeSet<(u32, u32)>,
    clones: BTreeSet<(u32, u32)>,
    vnode_shadowed_clones: BTreeSet<(u32, u32)>,
    list_reads: BTreeSet<(u32, u32)>,
}
impl<'a> AstRewriter<'a, '_> {
    pub(super) fn stage_vnode_key(
        &mut self,
        value: Expression<'a>,
        properties: &mut ArenaVec<'a, ObjectPropertyKind<'a>>,
        local: &mut Option<String>,
        span: Span,
    ) -> Expression<'a> {
        if matches!(
            value,
            Expression::StringLiteral(_)
                | Expression::NumericLiteral(_)
                | Expression::BooleanLiteral(_)
                | Expression::NullLiteral(_)
        ) {
            return value;
        }
        let name = local.get_or_insert_with(|| {
            let preferred = format!("__fictVNodeKey_{}", span.start);
            let mut name = preferred.clone();
            let mut suffix = 0;
            while !self.generated_names.insert(name.clone()) {
                suffix += 1;
                name = format!("{preferred}_{suffix}");
            }
            name
        });
        let builder = AstBuilder::new(self.allocator);
        let assignment = Expression::new_assignment_expression(
            span,
            oxc::syntax::operator::AssignmentOperator::Assign,
            AssignmentTarget::new_assignment_target_identifier(
                span,
                self.allocator.alloc_str(name),
                &builder,
            ),
            value,
            &builder,
        );
        let sequence = ArenaVec::from_array_in(
            [assignment, Expression::new_null_literal(span, &builder)],
            &self.allocator,
        );
        properties.push(ObjectPropertyKind::new_spread_property(
            span,
            Expression::new_sequence_expression(span, sequence, &builder),
            &builder,
        ));
        Expression::new_identifier(span, self.allocator.alloc_str(name), &builder)
    }

    pub(super) fn finish_vnode_key(
        &self,
        value: Expression<'a>,
        local: Option<String>,
        span: Span,
    ) -> Expression<'a> {
        let Some(local) = local else { return value };
        let arrow = expression_arrow(
            self.allocator,
            self.allocator.alloc_str(&local),
            value,
            span,
        );
        Expression::new_call_expression(
            span,
            arrow,
            NONE,
            ArenaVec::new_in(&self.allocator),
            false,
            &AstBuilder::new(self.allocator),
        )
    }

    pub(super) fn vnode_identity_needs_getter(
        &self,
        opening: &oxc::ast::ast::JSXOpeningElement<'a>,
    ) -> bool {
        if self.eager_vnode_identity == Some(opening.span) {
            return false;
        }
        self.span_needs_jsx_getter(opening.name.span())
            || opening.attributes.iter().any(|attribute| {
                let JSXAttributeItem::Attribute(attribute) = attribute else {
                    return false;
                };
                matches!(&attribute.name, JSXAttributeName::Identifier(name) if name.name == "key")
                    && jsx_attribute_source_span(&attribute.value).is_some_and(|span| {
                        self.active_list_key_origin != Some((span.start, span.end))
                            && self.span_needs_jsx_getter(span)
                    })
            })
    }

    pub(super) fn append_vnode_site(
        &mut self,
        properties: &mut ArenaVec<'a, ObjectPropertyKind<'a>>,
        span: Span,
    ) {
        let local = self
            .vnode_scope_local
            .get_or_insert_with(|| {
                let mut name = "__fictVNodeScope".to_owned();
                let mut suffix = 0;
                while !self.generated_names.insert(name.clone()) {
                    suffix += 1;
                    name = format!("__fictVNodeScope{suffix}");
                }
                name
            })
            .clone();
        let builder = AstBuilder::new(self.allocator);
        properties.push(self.object_property(
            span,
            "__fictVNodeScope",
            Expression::new_identifier(span, self.allocator.alloc_str(&local), &builder),
        ));
        properties.push(self.object_property(
            span,
            "__fictVNodeSlot",
            Expression::new_numeric_literal(
                span,
                f64::from(span.start),
                None,
                NumberBase::Decimal,
                &builder,
            ),
        ));
    }

    pub(super) fn lower_template_clone(
        &mut self,
        clone: CloneRewrite,
        jsx: Expression<'a>,
        span: Span,
    ) -> Expression<'a> {
        let Some(namespace_helper) = clone.namespace_helper.clone() else {
            let previous = self.active_vnode_reactive_local.clone();
            self.active_vnode_reactive_local
                .clone_from(&clone.reactive_helper);
            let lowered = self.lower_template_clone_optimized(clone, jsx, span);
            self.active_vnode_reactive_local = previous;
            return lowered;
        };
        // Fragment templates are parsed in HTML. Their individual roots must use
        // the VNode namespace resolver when the transparent call-site is foreign.
        let tag_name = if matches!(jsx, Expression::JSXFragment(_)) {
            Some("span".to_owned())
        } else {
            jsx_intrinsic_tag_name(&jsx)
        };
        let Some(tag_name) = tag_name else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-NAMESPACE",
                    "template namespace guard requires an intrinsic JSX root",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(span.start, span.end).expect("ordered JSX span"),
                ),
            );
            return self.lower_template_clone_optimized(clone, jsx, span);
        };
        let Some(expected_namespace) = element_namespace_name(clone.namespace) else {
            self.diagnostics.push(
                emit_error(
                    "FICT-OXC-EMIT-NAMESPACE",
                    "template namespace guard requires a concrete element namespace",
                    GuaranteeClass::Internal,
                )
                .with_primary_span(
                    SourceSpan::new(span.start, span.end).expect("ordered JSX span"),
                ),
            );
            return self.lower_template_clone_optimized(clone, jsx, span);
        };
        let fallback_jsx = jsx.clone_in(self.allocator);
        let base_matches = self.rewrite_match_state();
        let context_snapshot: BTreeMap<_, _> = self
            .context_declarations
            .iter()
            .map(|(location, statement)| (*location, statement.clone_in(self.allocator)))
            .collect();
        let previous_fragment = self.active_fragment_local.clone();
        let previous_reactive = self.active_vnode_reactive_local.clone();
        self.active_fragment_local
            .clone_from(&clone.fragment_helper);
        self.active_vnode_reactive_local
            .clone_from(&clone.reactive_helper);
        self.source_clone_depth += 1;
        self.vnode_depth += 1;
        let fallback = self.lower_jsx_expression(fallback_jsx);
        self.vnode_depth -= 1;
        self.source_clone_depth -= 1;
        self.active_fragment_local = previous_fragment;
        self.active_vnode_reactive_local = previous_reactive.clone();
        let fallback_matches = self.rewrite_match_state();
        let fallback_contexts: Vec<_> = context_snapshot
            .keys()
            .filter(|location| !self.context_declarations.contains_key(location))
            .copied()
            .collect();
        self.restore_rewrite_match_state(base_matches);
        self.context_declarations = context_snapshot;
        self.active_vnode_reactive_local
            .clone_from(&clone.reactive_helper);
        let optimized = self.lower_template_clone_optimized(clone, jsx, span);
        self.active_vnode_reactive_local = previous_reactive;
        self.merge_rewrite_match_state(fallback_matches);
        for location in fallback_contexts {
            self.context_declarations.remove(&location);
        }
        let builder = AstBuilder::new(self.allocator);
        let callee =
            Expression::new_identifier(span, self.allocator.alloc_str(&namespace_helper), &builder);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.extend([
            Argument::from(Expression::new_string_literal(
                span,
                self.allocator.alloc_str(&tag_name),
                None,
                &builder,
            )),
            Argument::from(Expression::new_string_literal(
                span,
                expected_namespace,
                None,
                &builder,
            )),
        ]);
        let condition =
            Expression::new_call_expression(span, callee, NONE, arguments, false, &builder);
        Expression::new_conditional_expression(span, condition, optimized, fallback, &builder)
    }
    fn rewrite_match_state(&self) -> RewriteMatchState {
        RewriteMatchState {
            creations: self.matched_creations.clone(),
            derived_creations: self.matched_derived_creations.clone(),
            props: self.matched_props.clone(),
            prop_reads: self.matched_prop_reads.clone(),
            reads: self.matched_reads.clone(),
            mutations: self.matched_mutations.clone(),
            vnodes: self.matched_vnodes.clone(),
            components: self.matched_components.clone(),
            component_roots: self.matched_component_roots.clone(),
            conditional_returns: self.matched_conditional_returns.clone(),
            clones: self.matched_clones.clone(),
            vnode_shadowed_clones: self.vnode_shadowed_clones.clone(),
            list_reads: self.matched_list_reads.clone(),
        }
    }
    fn restore_rewrite_match_state(&mut self, state: RewriteMatchState) {
        self.matched_creations = state.creations;
        self.matched_derived_creations = state.derived_creations;
        self.matched_props = state.props;
        self.matched_prop_reads = state.prop_reads;
        self.matched_reads = state.reads;
        self.matched_mutations = state.mutations;
        self.matched_vnodes = state.vnodes;
        self.matched_components = state.components;
        self.matched_component_roots = state.component_roots;
        self.matched_conditional_returns = state.conditional_returns;
        self.matched_clones = state.clones;
        self.vnode_shadowed_clones = state.vnode_shadowed_clones;
        self.matched_list_reads = state.list_reads;
    }
    fn merge_rewrite_match_state(&mut self, state: RewriteMatchState) {
        self.matched_creations.extend(state.creations);
        self.matched_derived_creations
            .extend(state.derived_creations);
        self.matched_props.extend(state.props);
        self.matched_prop_reads.extend(state.prop_reads);
        self.matched_reads.extend(state.reads);
        self.matched_mutations.extend(state.mutations);
        self.matched_vnodes.extend(state.vnodes);
        self.matched_components.extend(state.components);
        self.matched_component_roots.extend(state.component_roots);
        self.matched_conditional_returns
            .extend(state.conditional_returns);
        self.matched_clones.extend(state.clones);
        self.vnode_shadowed_clones
            .extend(state.vnode_shadowed_clones);
        self.matched_list_reads.extend(state.list_reads);
    }
    pub(super) fn wrap_vnode_reactive_value(
        &self,
        value: Expression<'a>,
        source_span: Span,
    ) -> Expression<'a> {
        self.wrap_vnode_value(
            value,
            source_span,
            self.active_vnode_reactive_local.as_deref(),
        )
    }
    pub(super) fn jsx_child_needs_getter(&self, child: &JSXChild<'a>) -> bool {
        let expression = match child {
            JSXChild::ExpressionContainer(container) if container.expression.is_expression() => {
                container
                    .expression
                    .as_expression()
                    .expect("JSX expression")
            }
            JSXChild::Spread(spread) => &spread.expression,
            _ => return false,
        };
        !matches!(
            expression.get_inner_expression(),
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
        ) && self.span_needs_jsx_getter(expression.span())
    }
    fn span_needs_jsx_getter(&self, source_span: Span) -> bool {
        self.reads
            .keys()
            .chain(self.prop_reads.iter())
            .chain(self.jsx_getter_reads.iter())
            .any(|(start, end)| source_span.start <= *start && *end <= source_span.end)
            || self.control_flow_outputs.values().any(|(_, output)| {
                output
                    .references
                    .iter()
                    .any(|(start, end)| source_span.start <= *start && *end <= source_span.end)
            })
    }
    pub(super) fn wrap_vnode_value(
        &self,
        value: Expression<'a>,
        source_span: Span,
        helper: Option<&str>,
    ) -> Expression<'a> {
        let Some(helper) = helper else {
            return value;
        };
        if expression_contains_direct_await(&value)
            || expression_contains_direct_yield(&value)
            || !self.span_needs_jsx_getter(source_span)
        {
            return value;
        }
        self.wrap_jsx_getter(value, source_span, helper)
    }
    pub(super) fn wrap_jsx_getter(
        &self,
        value: Expression<'a>,
        source_span: Span,
        helper: &str,
    ) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        let callee =
            Expression::new_identifier(source_span, self.allocator.alloc_str(helper), &builder);
        let getter = zero_parameter_expression_arrow(self.allocator, value, source_span);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.push(Argument::from(getter));
        if Some(helper) == self.vnode_prop_helper
            && self
                .jsx_getter_calls
                .iter()
                .any(|call| source_span.start <= call.start() && call.end() <= source_span.end)
        {
            arguments.push(Argument::from(Expression::new_boolean_literal(
                source_span,
                true,
                &builder,
            )));
        }
        Expression::new_call_expression(source_span, callee, NONE, arguments, false, &builder)
    }
}
fn element_namespace_name(namespace: DomNamespace) -> Option<&'static str> {
    match namespace {
        DomNamespace::Html => Some("html"),
        DomNamespace::Svg => Some("svg"),
        DomNamespace::MathMl
        | DomNamespace::MathMlTextIntegration
        | DomNamespace::MathMlAnnotationXml => Some("mathml"),
        DomNamespace::Parent => None,
    }
}
fn jsx_intrinsic_tag_name(jsx: &Expression<'_>) -> Option<String> {
    let Expression::JSXElement(element) = jsx else {
        return None;
    };
    match &element.opening_element.name {
        JSXElementName::Identifier(identifier) => Some(identifier.name.to_string()),
        JSXElementName::NamespacedName(name) => {
            Some(format!("{}:{}", name.namespace.name, name.name.name))
        }
        JSXElementName::IdentifierReference(_)
        | JSXElementName::MemberExpression(_)
        | JSXElementName::ThisExpression(_) => None,
    }
}
