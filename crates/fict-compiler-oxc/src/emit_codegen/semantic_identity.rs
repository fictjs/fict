use super::{
    DerivedCreationRewrite, convert_diagnostics, emit_error, zero_parameter_expression_arrow,
};
use crate::frontend::symbol_is_runtime;
use fict_diagnostics::{Diagnostic, GuaranteeClass, SourceSpan};
use fict_hir::BindingId;
use oxc::{
    allocator::{Allocator, CloneIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, ArrayExpressionElement, BindingIdentifier, BindingPattern, Expression,
            FormalParameterKind, FormalParameters, FunctionBody, IdentifierReference, Program,
            Statement, VariableDeclarationKind, VariableDeclarator,
        },
    },
    ast_visit::Visit,
    semantic::SemanticBuilder,
    span::Span,
    syntax::{reference::ReferenceId, symbol::SymbolId},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default)]
pub(super) struct SemanticIdentities {
    symbols: BTreeMap<SymbolId, BindingId>,
    references: BTreeMap<ReferenceId, BindingId>,
    reserved_names: BTreeSet<String>,
}

impl SemanticIdentities {
    pub(super) fn build(program: &Program<'_>) -> Result<Self, Vec<Diagnostic>> {
        let mut reserved_names = ReservedNameCollector::default();
        reserved_names.visit_program(program);
        let built = SemanticBuilder::new()
            .with_check_syntax_error(true)
            .with_enum_eval(true)
            .build(program);
        if built.diagnostics.has_errors() {
            return Err(convert_diagnostics(
                built.diagnostics,
                "FICT-SEMANTIC-EMIT-IDENTITY",
            ));
        }
        let scoping = built.semantic.scoping();
        let mut identities = Self {
            reserved_names: reserved_names.names,
            ..Self::default()
        };
        // Mirror the frontend's runtime-only BindingId compaction exactly. OXC SymbolId values
        // cannot be used directly because erased TypeScript bindings remain in the symbol table.
        for (index, symbol) in scoping
            .symbol_ids()
            .filter(|symbol| symbol_is_runtime(scoping.symbol_flags(*symbol)))
            .enumerate()
        {
            let binding = BindingId::new(u32::try_from(index).unwrap_or(u32::MAX));
            identities.symbols.insert(symbol, binding);
            identities.references.extend(
                scoping
                    .get_resolved_reference_ids(symbol)
                    .iter()
                    .map(|reference| (*reference, binding)),
            );
        }
        Ok(identities)
    }

    pub(super) fn binding_for_reference(
        &self,
        identifier: &IdentifierReference<'_>,
    ) -> Option<BindingId> {
        identifier
            .reference_id
            .get()
            .and_then(|reference| self.references.get(&reference).copied())
    }

    fn pattern_bindings<'a>(&self, pattern: &BindingPattern<'a>) -> Vec<PatternBindingIdentity> {
        let mut collector = PatternBindingCollector {
            identities: self,
            bindings: Vec::new(),
        };
        collector.visit_binding_pattern(pattern);
        collector.bindings
    }

    fn destructure_temporary_name(&self, span: Span) -> String {
        let preferred = format!("__fict_destructure_{}", span.start);
        if !self.reserved_names.contains(&preferred) {
            return preferred;
        }
        let mut suffix = 1_u32;
        loop {
            let candidate = format!("{preferred}_{suffix}");
            if !self.reserved_names.contains(&candidate) {
                return candidate;
            }
            suffix = suffix.saturating_add(1);
        }
    }
}

#[derive(Default)]
struct ReservedNameCollector {
    names: BTreeSet<String>,
}

impl<'a> Visit<'a> for ReservedNameCollector {
    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        self.names.insert(identifier.name.to_string());
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        self.names.insert(identifier.name.to_string());
    }
}

#[derive(Debug, Clone)]
struct PatternBindingIdentity {
    binding: BindingId,
    name: String,
    span: Span,
}

struct PatternBindingCollector<'identities> {
    identities: &'identities SemanticIdentities,
    bindings: Vec<PatternBindingIdentity>,
}

impl<'a> Visit<'a> for PatternBindingCollector<'_> {
    fn visit_binding_identifier(&mut self, identifier: &BindingIdentifier<'a>) {
        let Some(binding) = identifier
            .symbol_id
            .get()
            .and_then(|symbol| self.identities.symbols.get(&symbol).copied())
        else {
            return;
        };
        self.bindings.push(PatternBindingIdentity {
            binding,
            name: identifier.name.to_string(),
            span: identifier.span,
        });
    }
}

pub(super) fn rewrite_derived_declarator<'a>(
    allocator: &'a Allocator,
    mut declarator: VariableDeclarator<'a>,
    plans: &BTreeMap<BindingId, DerivedCreationRewrite>,
    identities: &SemanticIdentities,
    matched: &mut BTreeSet<BindingId>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<VariableDeclarator<'a>> {
    let bindings = identities.pattern_bindings(&declarator.id);
    if !bindings.iter().any(|identity| {
        plans.contains_key(&identity.binding) && !matched.contains(&identity.binding)
    }) {
        return vec![declarator];
    }
    let Some(initializer) = declarator.init.take() else {
        diagnostics.push(
            emit_error(
                "FICT-OXC-EMIT-IDENTITY",
                "derived creation binding identifies a declaration without an initializer",
                GuaranteeClass::Internal,
            )
            .with_primary_span(SourceSpan::empty(declarator.span.start)),
        );
        return vec![declarator];
    };
    if matches!(declarator.id, BindingPattern::BindingIdentifier(_))
        && let [identity] = bindings.as_slice()
        && let Some(planned) = plans.get(&identity.binding).cloned()
    {
        declarator.init = Some(derived_accessor_expression(
            allocator,
            initializer,
            planned.rewrite.local,
            planned.rewrite.context,
            declarator.span,
        ));
        matched.insert(identity.binding);
        return vec![declarator];
    }
    if bindings.len() > 1 {
        return rewrite_shared_pattern_declarator(
            allocator,
            declarator,
            bindings,
            initializer,
            plans,
            identities,
            matched,
        );
    }
    // Replaying the authored pattern inside the accessor preserves nested keys, rest elements,
    // and the binding-local name without reverse-engineering its destructuring path.
    let pattern = declarator.id;
    let mut rewritten = Vec::with_capacity(bindings.len());
    for identity in bindings {
        let getter = pattern_getter_expression(
            allocator,
            pattern.clone_in(allocator),
            initializer.clone_in(allocator),
            &identity.name,
            declarator.span,
        );
        let value = if let Some(planned) = plans
            .get(&identity.binding)
            .filter(|_| !matched.contains(&identity.binding))
            .cloned()
        {
            matched.insert(identity.binding);
            derived_accessor_from_getter(
                allocator,
                getter,
                planned.rewrite.local,
                planned.rewrite.context,
                declarator.span,
            )
        } else {
            invoke_zero_parameter_getter(allocator, getter, declarator.span)
        };
        rewritten.push(VariableDeclarator::new(
            declarator.span,
            declarator.kind,
            BindingPattern::new_binding_identifier(
                identity.span,
                allocator.alloc_str(&identity.name),
                &AstBuilder::new(allocator),
            ),
            NONE,
            Some(value),
            declarator.definite,
            &AstBuilder::new(allocator),
        ));
    }
    rewritten
}

fn rewrite_shared_pattern_declarator<'a>(
    allocator: &'a Allocator,
    declarator: VariableDeclarator<'a>,
    bindings: Vec<PatternBindingIdentity>,
    initializer: Expression<'a>,
    plans: &BTreeMap<BindingId, DerivedCreationRewrite>,
    identities: &SemanticIdentities,
    matched: &mut BTreeSet<BindingId>,
) -> Vec<VariableDeclarator<'a>> {
    let shared_binding = bindings
        .iter()
        .find(|identity| {
            plans.contains_key(&identity.binding) && !matched.contains(&identity.binding)
        })
        .expect("shared pattern rewrite has an unmatched derived binding");
    let shared_binding_id = shared_binding.binding;
    let shared_plan = plans
        .get(&shared_binding_id)
        .expect("shared pattern binding has a derived creation plan")
        .clone();
    let temporary = identities.destructure_temporary_name(declarator.span);
    let getter = pattern_tuple_getter_expression(
        allocator,
        declarator.id,
        initializer,
        &bindings,
        declarator.span,
    );
    let shared_value = derived_accessor_from_getter(
        allocator,
        getter,
        shared_plan.rewrite.local,
        shared_plan.rewrite.context,
        declarator.span,
    );
    let builder = AstBuilder::new(allocator);
    let mut rewritten = Vec::with_capacity(bindings.len() + 1);
    rewritten.push(VariableDeclarator::new(
        declarator.span,
        declarator.kind,
        BindingPattern::new_binding_identifier(
            declarator.span,
            allocator.alloc_str(&temporary),
            &builder,
        ),
        NONE,
        Some(shared_value),
        declarator.definite,
        &builder,
    ));

    for (index, identity) in bindings.into_iter().enumerate() {
        let getter = tuple_member_getter_expression(allocator, &temporary, index, declarator.span);
        let value = if identity.binding == shared_binding_id {
            matched.insert(identity.binding);
            getter
        } else if let Some(planned) = plans
            .get(&identity.binding)
            .filter(|_| !matched.contains(&identity.binding))
            .cloned()
        {
            matched.insert(identity.binding);
            derived_accessor_from_getter(
                allocator,
                getter,
                planned.rewrite.local,
                planned.rewrite.context,
                declarator.span,
            )
        } else {
            invoke_zero_parameter_getter(allocator, getter, declarator.span)
        };
        rewritten.push(VariableDeclarator::new(
            declarator.span,
            declarator.kind,
            BindingPattern::new_binding_identifier(
                identity.span,
                allocator.alloc_str(&identity.name),
                &builder,
            ),
            NONE,
            Some(value),
            declarator.definite,
            &builder,
        ));
    }
    rewritten
}

fn derived_accessor_expression<'a>(
    allocator: &'a Allocator,
    initializer: Expression<'a>,
    helper: Option<String>,
    context: Option<String>,
    span: Span,
) -> Expression<'a> {
    let getter = zero_parameter_expression_arrow(allocator, initializer, span);
    derived_accessor_from_getter(allocator, getter, helper, context, span)
}

fn derived_accessor_from_getter<'a>(
    allocator: &'a Allocator,
    getter: Expression<'a>,
    helper: Option<String>,
    context: Option<String>,
    span: Span,
) -> Expression<'a> {
    let Some(helper) = helper else {
        return getter;
    };
    let builder = AstBuilder::new(allocator);
    let callee = Expression::new_identifier(span, allocator.alloc_str(&helper), &builder);
    let context = context
        .map(|context| Expression::new_identifier(span, allocator.alloc_str(&context), &builder));
    let arguments = ArenaVec::from_iter_in(
        context.into_iter().chain([getter]).map(Argument::from),
        &allocator,
    );
    Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
}

fn pattern_getter_expression<'a>(
    allocator: &'a Allocator,
    pattern: BindingPattern<'a>,
    initializer: Expression<'a>,
    result: &str,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let declarator = VariableDeclarator::new(
        span,
        VariableDeclarationKind::Const,
        pattern,
        NONE,
        Some(initializer),
        false,
        &builder,
    );
    let mut declarations = ArenaVec::new_in(&allocator);
    declarations.push(declarator);
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_variable_declaration(
        span,
        VariableDeclarationKind::Const,
        declarations,
        false,
        &builder,
    ));
    statements.push(Statement::new_return_statement(
        span,
        Some(Expression::new_identifier(
            span,
            allocator.alloc_str(result),
            &builder,
        )),
        &builder,
    ));
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::new_in(&allocator),
        NONE,
        &builder,
    );
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    Expression::new_arrow_function_expression(
        span, false, false, NONE, parameters, NONE, body, &builder,
    )
}

fn pattern_tuple_getter_expression<'a>(
    allocator: &'a Allocator,
    pattern: BindingPattern<'a>,
    initializer: Expression<'a>,
    bindings: &[PatternBindingIdentity],
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let declarator = VariableDeclarator::new(
        span,
        VariableDeclarationKind::Const,
        pattern,
        NONE,
        Some(initializer),
        false,
        &builder,
    );
    let mut declarations = ArenaVec::new_in(&allocator);
    declarations.push(declarator);
    let mut statements = ArenaVec::new_in(&allocator);
    statements.push(Statement::new_variable_declaration(
        span,
        VariableDeclarationKind::Const,
        declarations,
        false,
        &builder,
    ));
    let elements = ArenaVec::from_iter_in(
        bindings.iter().map(|identity| {
            ArrayExpressionElement::from(Expression::new_identifier(
                identity.span,
                allocator.alloc_str(&identity.name),
                &builder,
            ))
        }),
        &allocator,
    );
    statements.push(Statement::new_return_statement(
        span,
        Some(Expression::new_array_expression(span, elements, &builder)),
        &builder,
    ));
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::new_in(&allocator),
        NONE,
        &builder,
    );
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    Expression::new_arrow_function_expression(
        span, false, false, NONE, parameters, NONE, body, &builder,
    )
}

fn tuple_member_getter_expression<'a>(
    allocator: &'a Allocator,
    temporary: &str,
    index: usize,
    span: Span,
) -> Expression<'a> {
    let builder = AstBuilder::new(allocator);
    let tuple = Expression::new_call_expression(
        span,
        Expression::new_identifier(span, allocator.alloc_str(temporary), &builder),
        NONE,
        ArenaVec::new_in(&allocator),
        false,
        &builder,
    );
    let property = Expression::new_numeric_literal(
        span,
        f64::from(u32::try_from(index).expect("destructuring binding index fits u32")),
        None,
        oxc::syntax::number::NumberBase::Decimal,
        &builder,
    );
    let member = Expression::new_computed_member_expression(span, tuple, property, false, &builder);
    zero_parameter_expression_arrow(allocator, member, span)
}

fn invoke_zero_parameter_getter<'a>(
    allocator: &'a Allocator,
    getter: Expression<'a>,
    span: Span,
) -> Expression<'a> {
    Expression::new_call_expression(
        span,
        getter,
        NONE,
        ArenaVec::new_in(&allocator),
        false,
        &AstBuilder::new(allocator),
    )
}
