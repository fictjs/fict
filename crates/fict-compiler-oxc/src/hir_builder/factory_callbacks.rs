//! Callback contracts of intact values returned by known runtime factories.

use super::*;
use fict_hir::{RuntimeBindingFact, RuntimeBindingKind};
use runtime_callbacks::{RuntimeCallbackHost, RuntimeImports};

#[derive(Default)]
pub(super) struct FactoryCallbacks {
    hosts: BTreeMap<StaticAliasPath, RuntimeCallbackHost>,
    runtime_paths: BTreeMap<StaticAliasPath, RuntimeBindingKind>,
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
