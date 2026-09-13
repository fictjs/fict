//! Receiver families for immutable collection aliases and fresh copies.

use super::*;

/// Direct built-in type contracts must be available before alias execution, so
/// that a copy is not first classified as an opaque external function result.
pub(super) fn declared_arrays(
    program: &Program<'_>,
    scoping: &Scoping,
    bindings: &BTreeMap<SymbolId, BindingId>,
    macros: &BTreeMap<BindingId, FictMacroKind>,
) -> BTreeSet<SymbolId> {
    let mut declared = DeclaredStateReceiverTypeCollector {
        scoping,
        receivers: BTreeMap::new(),
    };
    declared.visit_program(program);
    let mut collector = DeclaredArrayCollector {
        scoping,
        bindings,
        macros,
        arrays: declared
            .receivers
            .into_iter()
            .filter_map(|(symbol, receiver)| {
                (receiver == StateReceiverKind::Array).then_some(symbol)
            })
            .collect(),
    };
    collector.visit_program(program);
    collector.arrays
}

struct DeclaredArrayCollector<'a> {
    scoping: &'a Scoping,
    bindings: &'a BTreeMap<SymbolId, BindingId>,
    macros: &'a BTreeMap<BindingId, FictMacroKind>,
    arrays: BTreeSet<SymbolId>,
}

impl<'a> Visit<'a> for DeclaredArrayCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(binding) = &declarator.id
            && let Some(symbol) = binding.symbol_id.get()
            && let Some(Expression::CallExpression(call)) = declarator
                .init
                .as_ref()
                .map(Expression::get_inner_expression)
            && let Expression::Identifier(callee) = call.callee.get_inner_expression()
            && identifier_symbol(self.scoping, callee)
                .and_then(|symbol| self.bindings.get(&symbol))
                .and_then(|binding| self.macros.get(binding))
                == Some(&FictMacroKind::State)
            && call
                .type_arguments
                .as_ref()
                .and_then(|arguments| arguments.params.first())
                .and_then(|annotation| classify_state_receiver_type(self.scoping, annotation))
                == Some(StateReceiverKind::Array)
        {
            self.arrays.insert(symbol);
        }
        walk_variable_declarator(self, declarator);
    }
}

struct ReceiverDeclarationFact {
    symbol: SymbolId,
    source: ReceiverDeclarationSource,
}

enum ReceiverDeclarationSource {
    Known(StateReceiverKind),
    Alias(SymbolId),
    Method(SymbolId, String),
}

struct ReceiverDeclarationCollector<'semantic> {
    scoping: &'semantic Scoping,
    facts: Vec<ReceiverDeclarationFact>,
}

impl<'a> Visit<'a> for ReceiverDeclarationCollector<'_> {
    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        if matches!(
            declaration.kind,
            VariableDeclarationKind::Const | VariableDeclarationKind::Let
        ) {
            for declarator in &declaration.declarations {
                let (BindingPattern::BindingIdentifier(binding), Some(initializer)) =
                    (&declarator.id, &declarator.init)
                else {
                    continue;
                };
                let Some(symbol) = binding.symbol_id.get() else {
                    continue;
                };
                if self.scoping.symbol_is_mutated(symbol) {
                    continue;
                }
                let direct =
                    classify_state_receiver_assignment(self.scoping, initializer, &BTreeMap::new());
                let source = if direct != StateReceiverKind::Unknown {
                    Some(ReceiverDeclarationSource::Known(direct))
                } else {
                    match initializer.get_inner_expression() {
                        Expression::Identifier(identifier) => {
                            identifier_symbol(self.scoping, identifier)
                                .map(ReceiverDeclarationSource::Alias)
                        }
                        Expression::CallExpression(call) if !call.optional => {
                            static_alias_source_path(self.scoping, &call.callee).and_then(|path| {
                                let [method] = path.properties.as_slice() else {
                                    return None;
                                };
                                let root = path.binding_root()?;
                                (!path.element_wildcard).then(|| {
                                    ReceiverDeclarationSource::Method(root, method.clone())
                                })
                            })
                        }
                        _ => None,
                    }
                };
                if let Some(source) = source {
                    self.facts.push(ReceiverDeclarationFact { symbol, source });
                }
            }
        }
        walk_variable_declaration(self, declaration);
    }
}

pub(super) fn collect_proven_receiver_kinds<'ast>(
    program: &Program<'ast>,
    scoping: &Scoping,
    seeds: &BTreeMap<SymbolId, StateReceiverKind>,
    aliases: &StaticHookAliases,
) -> BTreeMap<SymbolId, StateReceiverKind> {
    let mut collector = ReceiverDeclarationCollector {
        scoping,
        facts: Vec::new(),
    };
    collector.visit_program(program);
    let mut receivers = seeds.clone();
    let mut dependents = BTreeMap::<SymbolId, Vec<(SymbolId, Option<String>)>>::new();
    for fact in collector.facts {
        match fact.source {
            ReceiverDeclarationSource::Known(receiver) => {
                if receivers
                    .get(&fact.symbol)
                    .is_none_or(|current| *current == StateReceiverKind::Unknown)
                {
                    receivers.insert(fact.symbol, receiver);
                }
            }
            ReceiverDeclarationSource::Alias(source) => {
                dependents
                    .entry(source)
                    .or_default()
                    .push((fact.symbol, None));
            }
            ReceiverDeclarationSource::Method(source, method) => {
                dependents
                    .entry(source)
                    .or_default()
                    .push((fact.symbol, Some(method)));
            }
        }
    }
    let mut pending = receivers
        .iter()
        .filter_map(|(symbol, receiver)| {
            (*receiver != StateReceiverKind::Unknown).then_some((*symbol, *receiver))
        })
        .collect::<VecDeque<_>>();
    while let Some((source, receiver)) = pending.pop_front() {
        for (target, method) in dependents.get(&source).into_iter().flatten() {
            if receivers
                .get(target)
                .is_some_and(|current| *current != StateReceiverKind::Unknown)
            {
                continue;
            }
            let result = if let Some(method) = method {
                if !method_is_certified(aliases, source, receiver, method) {
                    continue;
                }
                classify_state_method_result(receiver, method)
            } else {
                receiver
            };
            if result != StateReceiverKind::Unknown {
                receivers.insert(*target, result);
                pending.push_back((*target, result));
            }
        }
    }
    receivers
}

fn method_is_certified(
    aliases: &StaticHookAliases,
    symbol: SymbolId,
    receiver: StateReceiverKind,
    method: &str,
) -> bool {
    let root = StaticAliasPath::root(symbol);
    aliases.builtin_prototype_method_is_intact(receiver, method)
        && aliases.path_is_intact(&root.with_property(method.to_string()))
        // Copying methods consult the receiver's constructor/species. A replaced
        // constructor cannot be used as proof of a fresh standard container.
        && (!array_method_returns_fresh_container(method)
            || (aliases.path_is_intact(&root.with_property("constructor".to_string()))
                && aliases.path_is_intact(&StaticAliasPath::unresolved_global("Array".to_string()))))
}

pub(super) fn primitive_result(
    scoping: &Scoping,
    aliases: &StaticHookAliases,
    receivers: &BTreeMap<SymbolId, StateReceiverKind>,
    expression: &Expression<'_>,
) -> bool {
    let Expression::CallExpression(call) = expression.get_inner_expression() else {
        return false;
    };
    let Some(path) = static_alias_source_path(scoping, &call.callee) else {
        return false;
    };
    let (Some(symbol), [method]) = (path.binding_root(), path.properties.as_slice()) else {
        return false;
    };
    !path.element_wildcard
        && receivers.get(&symbol).is_some_and(|receiver| {
            fict_hir::state_method_returns_scalar(*receiver, method)
                && method_is_certified(aliases, symbol, *receiver, method)
        })
}

impl ReactiveEscapeCollector<'_, '_, '_> {
    /// Index/count positions are coerced synchronously and cannot store their
    /// primitive arguments. Inserted values and arbitrary coercion objects keep
    /// the ordinary escape checks.
    pub(super) fn is_non_retaining_collection_index(
        &self,
        callee: &Expression<'_>,
        index: usize,
        argument: EscapeArgument<'_, '_>,
    ) -> bool {
        if argument.spread
            || !expression_result_is_definitely_primitive(
                self.scoping,
                self.callback_aliases,
                self.definitely_primitive_symbols,
                argument.expression,
            )
        {
            return false;
        }
        let Some(path) = static_alias_source_path(self.scoping, callee) else {
            return false;
        };
        let (Some(symbol), [method]) = (path.binding_root(), path.properties.as_slice()) else {
            return false;
        };
        let numeric = match method.as_str() {
            "splice" | "slice" | "toSpliced" => index < 2,
            "at" | "with" => index == 0,
            "copyWithin" => index < 3,
            "fill" => (1..3).contains(&index),
            _ => false,
        };
        numeric
            && !path.element_wildcard
            && self.proven_receivers.get(&symbol) == Some(&StateReceiverKind::Array)
            && method_is_certified(
                self.callback_aliases,
                symbol,
                StateReceiverKind::Array,
                method,
            )
    }
}

/// Give downstream provenance the same certified receiver family used by the
/// frontend. A nested projection is not a method of its root collection.
pub(super) fn certified_alias_calls(
    calls: &[CallFact],
    receivers: &BTreeMap<SymbolId, StateReceiverKind>,
    aliases: &StaticHookAliases,
) -> BTreeMap<(u32, u32), StateReceiverKind> {
    calls
        .iter()
        .filter_map(|call| {
            let place = call.callee_reference.as_ref()?;
            let PlannedPlaceBase::Binding(symbol) = place.base else {
                return None;
            };
            let [
                PlannedProjection::Static {
                    name,
                    optional: false,
                },
            ] = place.projections.as_slice()
            else {
                return None;
            };
            let receiver = *receivers.get(&symbol)?;
            method_is_certified(aliases, symbol, receiver, name)
                .then_some(((call.span.start(), call.span.end()), receiver))
        })
        .collect()
}
