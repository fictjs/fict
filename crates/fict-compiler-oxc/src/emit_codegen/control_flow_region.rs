use std::collections::{BTreeMap, BTreeSet};

use fict_hir::BindingId;
use oxc::{
    allocator::{Allocator, TakeIn, Vec as ArenaVec},
    ast::{
        AstBuilder, NONE,
        ast::{
            Argument, BindingPattern, Expression, FormalParameterKind, FormalParameters,
            FunctionBody, ObjectPropertyKind, PropertyKey, PropertyKind, Statement,
            VariableDeclarator,
        },
    },
    span::{GetSpan, Span},
};

use super::semantic_identity::SemanticIdentities;

#[derive(Debug, Clone)]
pub(super) struct ControlFlowRegionOutputRewrite {
    pub(super) binding: BindingId,
    pub(super) name: String,
    pub(super) declaration: (u32, u32),
    pub(super) references: Vec<(u32, u32)>,
}

#[derive(Debug, Clone)]
pub(super) struct ControlFlowRegionRewrite {
    pub(super) target: String,
    pub(super) helper: String,
    pub(super) context: String,
    pub(super) outputs: Vec<ControlFlowRegionOutputRewrite>,
}

impl ControlFlowRegionRewrite {
    pub(super) fn new(
        target: &str,
        helper: &str,
        context: &str,
        outputs: Vec<ControlFlowRegionOutputRewrite>,
    ) -> Self {
        Self {
            target: target.to_owned(),
            helper: helper.to_owned(),
            context: context.to_owned(),
            outputs,
        }
    }
}

pub(super) fn lower_statements<'a>(
    allocator: &'a Allocator,
    statements: &mut ArenaVec<'a, Statement<'a>>,
    rewrites: &BTreeMap<(u32, u32), ControlFlowRegionRewrite>,
    identities: &SemanticIdentities,
    matched: &mut BTreeSet<(u32, u32)>,
) {
    let locations: Vec<_> = statements
        .iter()
        .filter_map(|statement| {
            let span = statement.span();
            let location = (span.start, span.end);
            rewrites.contains_key(&location).then_some(location)
        })
        .collect();
    for location in locations {
        let Some(rewrite) = rewrites.get(&location) else {
            continue;
        };
        if lower_one(allocator, statements, location, rewrite, identities) {
            matched.insert(location);
        }
    }
}

fn lower_one<'a>(
    allocator: &'a Allocator,
    statements: &mut ArenaVec<'a, Statement<'a>>,
    location: (u32, u32),
    rewrite: &ControlFlowRegionRewrite,
    identities: &SemanticIdentities,
) -> bool {
    let Some(control_index) = statements.iter().position(|statement| {
        statement.span().start == location.0
            && statement.span().end == location.1
            && matches!(
                statement,
                Statement::IfStatement(_)
                    | Statement::SwitchStatement(_)
                    | Statement::TryStatement(_)
            )
    }) else {
        return false;
    };
    let expected: BTreeSet<_> = rewrite
        .outputs
        .iter()
        .map(|output| output.binding)
        .collect();
    if expected.len() != rewrite.outputs.len() {
        return false;
    }

    let expected_outer: BTreeSet<_> = rewrite
        .outputs
        .iter()
        .filter(|output| output.declaration.0 < location.0)
        .map(|output| output.binding)
        .collect();
    // Lift only a complete suffix of declarations immediately before the dispatcher. Splitting a
    // declaration or moving one across a retained initializer would reverse authored effects.
    let mut declaration_start = control_index;
    let mut found = BTreeSet::new();
    while declaration_start > 0 {
        let Statement::VariableDeclaration(declaration) = &statements[declaration_start - 1] else {
            break;
        };
        let bindings: Option<Vec<_>> = declaration
            .declarations
            .iter()
            .map(|declarator| declarator_binding(declarator, identities))
            .collect();
        let Some(bindings) = bindings else {
            break;
        };
        if bindings.is_empty()
            || !bindings
                .iter()
                .all(|binding| expected_outer.contains(binding))
        {
            break;
        }
        found.extend(bindings);
        declaration_start -= 1;
    }
    if found != expected_outer {
        return false;
    }

    let authored = statements.take_in(&allocator);
    let mut outer = ArenaVec::new_in(&allocator);
    let mut body = ArenaVec::new_in(&allocator);
    for (index, statement) in authored.into_iter().enumerate() {
        if declaration_start <= index && index < control_index {
            body.push(statement);
            continue;
        }
        if index == control_index {
            body.push(statement);
            body.push(region_return_statement(
                allocator,
                rewrite,
                Span::new(location.0, location.1),
            ));
            outer.push(region_declaration(
                allocator,
                rewrite,
                body.take_in(&allocator),
                Span::new(location.0, location.1),
            ));
            continue;
        }
        outer.push(statement);
    }
    *statements = outer;
    true
}

fn declarator_binding(
    declarator: &VariableDeclarator<'_>,
    identities: &SemanticIdentities,
) -> Option<BindingId> {
    let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
        return None;
    };
    identifier
        .symbol_id
        .get()
        .and_then(|symbol| identities.binding_for_symbol(symbol))
}

fn region_return_statement<'a>(
    allocator: &'a Allocator,
    rewrite: &ControlFlowRegionRewrite,
    span: Span,
) -> Statement<'a> {
    let builder = AstBuilder::new(allocator);
    let mut properties = ArenaVec::new_in(&allocator);
    for output in &rewrite.outputs {
        let name = allocator.alloc_str(&output.name);
        properties.push(ObjectPropertyKind::new_object_property(
            span,
            PropertyKind::Init,
            PropertyKey::new_static_identifier(span, name, &builder),
            Expression::new_identifier(span, name, &builder),
            false,
            false,
            true,
            &builder,
        ));
    }
    Statement::new_return_statement(
        span,
        Some(Expression::new_object_expression(
            span, properties, &builder,
        )),
        &builder,
    )
}

fn region_declaration<'a>(
    allocator: &'a Allocator,
    rewrite: &ControlFlowRegionRewrite,
    statements: ArenaVec<'a, Statement<'a>>,
    span: Span,
) -> Statement<'a> {
    let builder = AstBuilder::new(allocator);
    let parameters = FormalParameters::boxed(
        span,
        FormalParameterKind::ArrowFormalParameters,
        ArenaVec::new_in(&allocator),
        NONE,
        &builder,
    );
    let body = FunctionBody::boxed(span, ArenaVec::new_in(&allocator), statements, &builder);
    let callback = Expression::new_arrow_function_expression(
        span, false, false, NONE, parameters, NONE, body, &builder,
    );
    let mut arguments = ArenaVec::new_in(&allocator);
    arguments.push(Argument::from(Expression::new_identifier(
        span,
        allocator.alloc_str(&rewrite.context),
        &builder,
    )));
    arguments.push(Argument::from(callback));
    let call = Expression::new_call_expression(
        span,
        Expression::new_identifier(span, allocator.alloc_str(&rewrite.helper), &builder),
        NONE,
        arguments,
        false,
        &builder,
    );
    super::const_statement(allocator, &rewrite.target, call, span)
}
