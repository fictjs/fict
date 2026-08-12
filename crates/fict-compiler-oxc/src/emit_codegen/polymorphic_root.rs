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
    conditional_returns: BTreeSet<(u32, u32)>,
    clones: BTreeSet<(u32, u32)>,
    vnode_shadowed_clones: BTreeSet<(u32, u32)>,
    list_reads: BTreeSet<(u32, u32)>,
}
impl<'a> AstRewriter<'a, '_> {
    pub(super) fn lower_template_clone(
        &mut self,
        clone: CloneRewrite,
        jsx: Expression<'a>,
        span: Span,
    ) -> Expression<'a> {
        let Some(namespace_helper) = clone.namespace_helper.clone() else {
            return self.lower_template_clone_optimized(clone, jsx, span);
        };
        let Some(tag_name) = jsx_intrinsic_tag_name(&jsx) else {
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
        self.active_vnode_reactive_local = previous_reactive;
        let fallback_matches = self.rewrite_match_state();
        let fallback_contexts: Vec<_> = context_snapshot
            .keys()
            .filter(|location| !self.context_declarations.contains_key(location))
            .copied()
            .collect();
        self.restore_rewrite_match_state(base_matches);
        self.context_declarations = context_snapshot;
        let optimized = self.lower_template_clone_optimized(clone, jsx, span);
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
        let Some(helper) = &self.active_vnode_reactive_local else {
            return value;
        };
        let contains_reactive_read = self
            .reads
            .keys()
            .chain(self.prop_reads.iter())
            .any(|(start, end)| source_span.start <= *start && *end <= source_span.end)
            || self.control_flow_outputs.values().any(|(_, output)| {
                output
                    .references
                    .iter()
                    .any(|(start, end)| source_span.start <= *start && *end <= source_span.end)
            });
        if !contains_reactive_read {
            return value;
        }
        let builder = AstBuilder::new(self.allocator);
        let callee =
            Expression::new_identifier(source_span, self.allocator.alloc_str(helper), &builder);
        let getter = zero_parameter_expression_arrow(self.allocator, value, source_span);
        let mut arguments = ArenaVec::new_in(&self.allocator);
        arguments.push(Argument::from(getter));
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
