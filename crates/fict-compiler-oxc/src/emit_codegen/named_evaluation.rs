use oxc::{
    allocator::{Allocator, Vec as ArenaVec},
    ast::{
        AstBuilder,
        ast::{Expression, ObjectPropertyKind, PropertyKey, PropertyKind},
    },
    span::GetSpan,
};

pub(super) fn preserve_assignment_name<'a>(
    allocator: &'a Allocator,
    name: &str,
    value: Expression<'a>,
) -> Expression<'a> {
    let anonymous = match value.get_inner_expression() {
        Expression::FunctionExpression(function) => function.id.is_none(),
        Expression::ArrowFunctionExpression(_) => true,
        Expression::ClassExpression(class) => class.id.is_none(),
        _ => false,
    };
    if !anonymous {
        return value;
    }
    // Object property NamedEvaluation sets the name before class static initializers
    // run and does not introduce the lexical self-binding of an explicitly named
    // function/class. A computed key also handles the identifier __proto__ correctly.
    let span = value.span();
    let builder = AstBuilder::new(allocator);
    let name = allocator.alloc_str(name);
    let key = PropertyKey::new_string_literal(span, name, None, &builder);
    let mut properties = ArenaVec::new_in(&allocator);
    properties.push(ObjectPropertyKind::new_object_property(
        span,
        PropertyKind::Init,
        key,
        value,
        false,
        false,
        true,
        &builder,
    ));
    let object = Expression::new_object_expression(span, properties, &builder);
    let key = Expression::new_string_literal(span, name, None, &builder);
    Expression::new_computed_member_expression(span, object, key, false, &builder)
}
