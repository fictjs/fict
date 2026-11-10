//! Callback contracts of intact values returned by known runtime factories.

use super::*;
use fict_hir::{RuntimeBindingFact, RuntimeBindingKind};
use oxc::ast::ast::Argument;
use runtime_callbacks::{RuntimeCallbackHost, RuntimeImports};

#[derive(Default)]
pub(super) struct FactoryCallbacks {
    hosts: BTreeMap<StaticAliasPath, RuntimeCallbackHost>,
    runtime_paths: BTreeMap<StaticAliasPath, RuntimeBindingKind>,
    signal_receivers: BTreeMap<StaticAliasPath, StateReceiverKind>,
    pub(super) resource_getters: BTreeSet<(u32, u32)>,
}

impl FactoryCallbacks {
    pub(super) fn collect(
        program: &Program<'_>,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        imports: &RuntimeImports,
        exports: &[ModuleExport],
    ) -> Self {
        let mut declarations = FactoryDeclarations {
            scoping,
            aliases,
            imports,
            exposed: factory_exposure::collect(program, scoping, aliases, exports),
            facts: Self::default(),
        };
        declarations.visit_program(program);
        let mut writes = SignalWrites {
            scoping,
            aliases,
            imports,
            receivers: &mut declarations.facts.signal_receivers,
        };
        writes.visit_program(program);
        let mut getters = ResourceGetters {
            scoping,
            aliases,
            imports,
            facts: &declarations.facts,
            getters: BTreeSet::new(),
        };
        getters.visit_program(program);
        declarations.facts.resource_getters = getters.getters;
        declarations.facts
    }

    pub(super) fn bindings(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        bindings: &[FrontendBinding],
        mapping: &BTreeMap<SymbolId, BindingId>,
    ) -> Vec<RuntimeBindingFact> {
        let mut facts = Vec::new();
        for binding in bindings {
            let symbol = SymbolId::from_usize(binding.id.as_usize());
            if !matches!(
                binding.kind,
                FrontendBindingKind::Const | FrontendBindingKind::Let
            ) || scoping.symbol_is_mutated(symbol)
            {
                continue;
            }
            let raw = StaticAliasPath::root(symbol);
            let resolved = aliases.resolve(&raw);
            if raw.element_wildcard
                || resolved.element_wildcard
                || !aliases.path_is_intact(&raw)
                || !aliases.path_is_intact(&resolved)
            {
                continue;
            }
            if let Some(kind) = self
                .runtime_paths
                .get(&resolved)
                .or_else(|| self.runtime_paths.get(&raw))
                && let Some(binding) = mapping.get(&symbol)
            {
                facts.push(RuntimeBindingFact {
                    binding: *binding,
                    kind: *kind,
                });
            }
        }
        facts.sort_unstable();
        facts
    }

    pub(super) fn host(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        callee: &Expression<'_>,
    ) -> Option<RuntimeCallbackHost> {
        let raw = static_alias_source_path(scoping, callee)?;
        let resolved = aliases.resolve(&raw);
        if raw.element_wildcard
            || resolved.element_wildcard
            || !aliases.path_is_intact(&raw)
            || !aliases.path_is_intact(&resolved)
        {
            return None;
        }
        self.hosts
            .get(&resolved)
            .or_else(|| self.hosts.get(&raw))
            .copied()
    }
}

struct FactoryDeclarations<'a> {
    scoping: &'a Scoping,
    aliases: &'a StaticHookAliases,
    imports: &'a RuntimeImports,
    exposed: BTreeSet<StaticAliasPath>,
    facts: FactoryCallbacks,
}

impl FactoryDeclarations<'_> {
    fn path(
        &self,
        pattern: &BindingPattern<'_>,
        property: Option<&str>,
    ) -> Option<StaticAliasPath> {
        let BindingPattern::BindingIdentifier(binding) = pattern else {
            return None;
        };
        let symbol = binding.symbol_id.get()?;
        if self.scoping.symbol_is_mutated(symbol) {
            return None;
        }
        let mut path = StaticAliasPath::root(symbol);
        if property.is_some() && self.exposed.iter().any(|exposed| path.starts_with(exposed)) {
            return None;
        }
        if let Some(property) = property {
            path = path.with_property(property.to_owned());
        }
        self.aliases.path_is_intact(&path).then_some(path)
    }

    fn register(
        &mut self,
        pattern: &BindingPattern<'_>,
        property: Option<&str>,
        host: RuntimeCallbackHost,
    ) {
        let Some(path) = self.path(pattern, property) else {
            return;
        };
        self.facts.hosts.insert(self.aliases.resolve(&path), host);
        self.facts.hosts.insert(path.clone(), host);
        self.facts
            .runtime_paths
            .insert(self.aliases.resolve(&path), RuntimeBindingKind::Stable);
        self.facts
            .runtime_paths
            .insert(path, RuntimeBindingKind::Stable);
    }

    fn reactive(&mut self, pattern: &BindingPattern<'_>, property: Option<&str>) {
        let Some(path) = self.path(pattern, property) else {
            return;
        };
        self.facts
            .runtime_paths
            .insert(self.aliases.resolve(&path), RuntimeBindingKind::Accessor);
        self.facts
            .runtime_paths
            .insert(path.clone(), RuntimeBindingKind::Accessor);
        if property.is_some()
            && let Some(root) = path.binding_root()
        {
            self.facts
                .runtime_paths
                .insert(StaticAliasPath::root(root), RuntimeBindingKind::Container);
        }
    }
}

impl<'a> Visit<'a> for FactoryDeclarations<'_> {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if matches!(
            declaration.kind,
            VariableDeclarationKind::Const | VariableDeclarationKind::Let
        ) {
            for declarator in &declaration.declarations {
                let Some(Expression::CallExpression(call)) = declarator
                    .init
                    .as_ref()
                    .map(Expression::get_inner_expression)
                else {
                    continue;
                };
                if call.optional {
                    continue;
                }
                let Some((source, name)) =
                    self.imports
                        .resolve(self.scoping, self.aliases, &call.callee)
                else {
                    continue;
                };
                if name == "resource" && matches!(source, "fict" | "fict/plus") {
                    self.register(
                        &declarator.id,
                        Some("read"),
                        RuntimeCallbackHost::ResourceRead,
                    );
                } else if matches!(name.as_str(), "createSignal" | "signal")
                    && matches!(
                        source,
                        "fict/advanced"
                            | "fict/internal"
                            | "@fictjs/runtime/advanced"
                            | "@fictjs/runtime/internal"
                    )
                {
                    self.reactive(&declarator.id, None);
                    if let Some(path) = self.path(&declarator.id, None) {
                        self.facts
                            .hosts
                            .insert(self.aliases.resolve(&path), RuntimeCallbackHost::Signal);
                        let receiver = call
                            .type_arguments
                            .as_ref()
                            .and_then(|types| types.params.first())
                            .and_then(|ty| classify_state_receiver_type(self.scoping, ty))
                            .or_else(|| {
                                call.arguments
                                    .first()
                                    .and_then(Argument::as_expression)
                                    .map(|value| {
                                        classify_state_receiver_expression(self.scoping, value)
                                    })
                            })
                            .unwrap_or(StateReceiverKind::Unknown);
                        self.facts
                            .signal_receivers
                            .insert(self.aliases.resolve(&path), receiver);
                    }
                } else if matches!(source, "fict" | "@fictjs/runtime")
                    && matches!(name.as_str(), "prop" | "useDeferredValue")
                {
                    self.reactive(&declarator.id, None);
                } else if matches!(source, "fict" | "@fictjs/runtime") && name == "mergeProps" {
                    if let Some(path) = self.path(&declarator.id, None) {
                        self.facts
                            .runtime_paths
                            .insert(self.aliases.resolve(&path), RuntimeBindingKind::Container);
                        self.facts
                            .runtime_paths
                            .insert(path, RuntimeBindingKind::Container);
                    }
                } else if name == "useTransition" && matches!(source, "fict" | "@fictjs/runtime") {
                    self.register(&declarator.id, Some("1"), RuntimeCallbackHost::Managed);
                    self.reactive(&declarator.id, Some("0"));
                    // Destructuring calls the array iterator. A modified prototype cannot
                    // certify which value becomes the second binding.
                    if let BindingPattern::ArrayPattern(pattern) = &declarator.id
                        && pattern.rest.is_none()
                        && self.aliases.path_is_intact(
                            &StaticAliasPath::unresolved_global("Array".to_owned())
                                .with_property("prototype".to_owned()),
                        )
                    {
                        if let Some(Some(start)) = pattern.elements.get(1) {
                            self.register(start, None, RuntimeCallbackHost::Managed);
                        }
                        if let Some(Some(pending)) = pattern.elements.first() {
                            self.reactive(pending, None);
                        }
                    }
                }
            }
        }
        walk_variable_declaration(self, declaration);
    }
}

struct ResourceGetters<'a> {
    scoping: &'a Scoping,
    aliases: &'a StaticHookAliases,
    imports: &'a RuntimeImports,
    facts: &'a FactoryCallbacks,
    getters: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for ResourceGetters<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if self.facts.host(self.scoping, self.aliases, &call.callee)
            == Some(RuntimeCallbackHost::ResourceRead)
            && call.arguments.len() == 1
            && let Some(Expression::CallExpression(getter)) = call.arguments[0]
                .as_expression()
                .map(Expression::get_inner_expression)
            && !getter.optional
            && getter.arguments.len() == 1
            && getter.arguments[0].as_expression().is_some()
            && self
                .imports
                .resolve(self.scoping, self.aliases, &getter.callee)
                .is_some_and(|(source, name)| {
                    name == "reactive"
                        && matches!(source, "fict/advanced" | "@fictjs/runtime/advanced")
                })
        {
            self.getters.insert((getter.span.start, getter.span.end));
        }
        walk_call_expression(self, call);
    }
}

impl ReactiveEscapeCollector<'_, '_, '_> {
    pub(super) fn resource_getter_is_owned(&self, arguments: &[EscapeArgument<'_, '_>]) -> bool {
        let [argument] = arguments else {
            return false;
        };
        if argument.spread {
            return false;
        }
        let Expression::CallExpression(getter) = argument.expression.get_inner_expression() else {
            return false;
        };
        if !self
            .factory_callbacks
            .resource_getters
            .contains(&(getter.span.start, getter.span.end))
        {
            return false;
        }
        getter.arguments.first().is_some_and(|argument| {
            argument.as_expression().is_some_and(|expression| {
                self.callback_timing(expression)
                    .is_some_and(|timing| !timing.may_suspend && !timing.may_return_iterator)
            })
        })
    }
}

struct SignalWrites<'a> {
    scoping: &'a Scoping,
    aliases: &'a StaticHookAliases,
    imports: &'a RuntimeImports,
    receivers: &'a mut BTreeMap<StaticAliasPath, StateReceiverKind>,
}

impl SignalWrites<'_> {
    fn signal_read(&self, expression: &Expression<'_>) -> Option<StaticAliasPath> {
        let Expression::CallExpression(call) = expression.get_inner_expression() else {
            return None;
        };
        if !call.arguments.is_empty() {
            return None;
        }
        let path = self
            .aliases
            .resolve(&static_alias_source_path(self.scoping, &call.callee)?);
        self.receivers.contains_key(&path).then_some(path)
    }

    fn invalidate_reads(&mut self, expression: &Expression<'_>) {
        struct Reads<'a, 'b>(&'a SignalWrites<'b>, BTreeSet<StaticAliasPath>);
        impl<'a> Visit<'a> for Reads<'_, '_> {
            fn visit_expression(&mut self, expression: &Expression<'a>) {
                if let Some(path) = self.0.signal_read(expression) {
                    self.1.insert(path);
                }
                oxc::ast_visit::walk::walk_expression(self, expression);
            }
        }
        let mut reads = Reads(self, BTreeSet::new());
        reads.visit_expression(expression);
        for path in reads.1 {
            self.receivers.insert(path, StateReceiverKind::Unknown);
        }
    }
}

impl<'a> Visit<'a> for SignalWrites<'_> {
    fn visit_variable_declarator(&mut self, declaration: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declaration.id
            && let Some(symbol) = binding.symbol_id.get()
            && !self.aliases.path_is_intact(&StaticAliasPath::root(symbol))
            && let Some(value) = &declaration.init
            && let Some(path) = self.signal_read(value)
        {
            self.receivers.insert(path, StateReceiverKind::Unknown);
        }
        walk_variable_declarator(self, declaration);
    }

    fn visit_assignment_expression(&mut self, expression: &AssignmentExpression<'a>) {
        match &expression.left {
            AssignmentTarget::StaticMemberExpression(member) => {
                self.invalidate_reads(&member.object)
            }
            AssignmentTarget::ComputedMemberExpression(member) => {
                self.invalidate_reads(&member.object)
            }
            _ => {}
        }
        oxc::ast_visit::walk::walk_assignment_expression(self, expression);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let signal = static_alias_source_path(self.scoping, &call.callee)
            .map(|path| self.aliases.resolve(&path))
            .filter(|path| self.receivers.contains_key(path));
        if !call.arguments.is_empty()
            && let Some(path) = &signal
            && let Some(receiver) = self.receivers.get_mut(path)
        {
            let next = call
                .arguments
                .first()
                .and_then(Argument::as_expression)
                .map(|value| classify_state_receiver_expression(self.scoping, value));
            if next != Some(*receiver) {
                *receiver = StateReceiverKind::Unknown;
            }
        }
        let runtime_host = self
            .imports
            .host(self.scoping, self.aliases, &call.callee)
            .is_some();
        let member_receiver = call.callee.get_member_expr().and_then(|member| {
            let path = self.signal_read(member.object())?;
            let family = *self.receivers.get(&path)?;
            let method = member.static_property_name()?;
            Some((
                path,
                classify_state_method_call(family, method)
                    == StateMethodCallSemantics::ReadOnlyReceiver,
            ))
        });
        if signal.is_none()
            && !runtime_host
            && !member_receiver
                .as_ref()
                .is_some_and(|(_, readonly)| *readonly)
        {
            for argument in &call.arguments {
                if let Some(expression) = argument.as_expression() {
                    self.invalidate_reads(expression);
                }
            }
        }
        if let Some((path, false)) = member_receiver {
            self.receivers.insert(path, StateReceiverKind::Unknown);
        }
        walk_call_expression(self, call);
    }
}

impl FactoryCallbacks {
    pub(super) fn expression_receiver(
        &self,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
        expression: &Expression<'_>,
    ) -> StateReceiverKind {
        let Expression::CallExpression(call) = expression.get_inner_expression() else {
            return StateReceiverKind::Unknown;
        };
        if call.optional {
            return StateReceiverKind::Unknown;
        }
        if call.arguments.is_empty()
            && let Some(path) = static_alias_source_path(scoping, &call.callee)
            && aliases.path_is_intact(&path)
            && aliases.path_is_intact(&aliases.resolve(&path))
            && let Some(receiver) = self.signal_receivers.get(&aliases.resolve(&path))
        {
            return *receiver;
        }
        let Some(member) = call.callee.get_member_expr() else {
            return StateReceiverKind::Unknown;
        };
        let Some(method) = member.static_property_name() else {
            return StateReceiverKind::Unknown;
        };
        let receiver = self.expression_receiver(scoping, aliases, member.object());
        if !aliases.builtin_prototype_method_is_intact(receiver, method) {
            return StateReceiverKind::Unknown;
        }
        classify_state_method_result(receiver, method)
    }

    pub(super) fn memo_contracts(
        &self,
        program: &Program<'_>,
        scoping: &Scoping,
        aliases: &StaticHookAliases,
    ) -> memo_side_effects::RuntimeCallContracts {
        let mut collector = SignalMethodCalls {
            facts: self,
            scoping,
            aliases,
            contracts: Default::default(),
        };
        collector.visit_program(program);
        collector.contracts
    }
}

struct SignalMethodCalls<'a> {
    facts: &'a FactoryCallbacks,
    scoping: &'a Scoping,
    aliases: &'a StaticHookAliases,
    contracts: memo_side_effects::RuntimeCallContracts,
}

impl<'a> Visit<'a> for SignalMethodCalls<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let span = (call.span.start, call.span.end);
        if !call.arguments.is_empty()
            && let Some(path) = static_alias_source_path(self.scoping, &call.callee)
            && self
                .facts
                .signal_receivers
                .contains_key(&self.aliases.resolve(&path))
        {
            self.contracts.writes.insert(span);
        }
        if let Some(member) = call.callee.get_member_expr()
            && let Some(method) = member.static_property_name()
        {
            let receiver =
                self.facts
                    .expression_receiver(self.scoping, self.aliases, member.object());
            if classify_state_method_call(receiver, method)
                == StateMethodCallSemantics::ReadOnlyReceiver
                && self
                    .aliases
                    .builtin_prototype_method_is_intact(receiver, method)
            {
                self.contracts.readonly_methods.insert(span);
            }
        }
        walk_call_expression(self, call);
    }
}
