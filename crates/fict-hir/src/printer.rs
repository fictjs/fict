use std::fmt::Write;

use crate::{
    BindingId, HirFile, JsxAttribute, JsxAttributeValue, JsxChild, JsxElementName, JsxNode, Origin,
    OriginKind, ScopeId, ValueId,
};

/// Print deterministic, source-free typed HIR suitable for snapshots and differential tests.
///
/// The printer follows arena order and never includes addresses, frontend nodes, or process state.
#[must_use]
pub fn print_hir(file: &HirFile) -> String {
    let mut output = String::new();
    writeln!(
        output,
        "file file{} source_len={} root=fn{}",
        file.id.index(),
        file.source_len,
        file.root_function.index()
    )
    .expect("writing to String cannot fail");

    for scope in &file.scopes {
        writeln!(
            output,
            "scope scope{} kind={:?} parent={} origin={}",
            scope.id.index(),
            scope.kind,
            optional_scope(scope.parent),
            print_origin(scope.origin)
        )
        .expect("writing to String cannot fail");
    }
    for binding in &file.bindings {
        writeln!(
            output,
            "binding binding{} kind={:?} scope=scope{} name={:?} import={:?} origin={}",
            binding.id.index(),
            binding.kind,
            binding.scope.index(),
            binding.display_name,
            binding.import,
            print_origin(binding.origin)
        )
        .expect("writing to String cannot fail");
    }
    for fragment in &file.syntax_fragments {
        writeln!(
            output,
            "fragment fragment{} kind={:?} refs={} pattern={:?} effects={} throw={} await={} yield={} jsx={} decorators={} origin={}",
            fragment.id.index(),
            fragment.kind,
            binding_list(&fragment.summary.referenced_bindings),
            fragment.summary.pattern,
            fragment.summary.has_side_effects,
            fragment.summary.may_throw,
            fragment.summary.contains_await,
            fragment.summary.contains_yield,
            fragment.summary.contains_jsx,
            fragment.summary.contains_decorators,
            print_origin(fragment.origin)
        )
        .expect("writing to String cannot fail");
    }

    for function in &file.functions {
        writeln!(
            output,
            "function fn{} kind={:?} binding={} scope=scope{} async={} generator={} arrow={} no_memo={} pure={} entry=block{} regions={:?} origin={}",
            function.id.index(),
            function.kind,
            optional_binding(function.binding),
            function.scope.index(),
            function.flags.is_async,
            function.flags.is_generator,
            function.flags.is_arrow,
            function.flags.no_memo,
            function.flags.pure,
            function.entry.index(),
            function.regions,
            print_origin(function.origin)
        )
        .expect("writing to String cannot fail");
        for parameter in &function.parameters {
            writeln!(
                output,
                "  parameter local{} binding={} pattern=fragment{} origin={}",
                parameter.local.index(),
                optional_binding(parameter.binding),
                parameter.pattern.index(),
                print_origin(parameter.origin)
            )
            .expect("writing to String cannot fail");
        }
        for local in &function.locals {
            writeln!(
                output,
                "  local local{} kind={:?} declaration={:?} binding={} scope=scope{} name={:?} origin={}",
                local.id.index(),
                local.kind,
                local.declaration_kind,
                optional_binding(local.binding),
                local.scope.index(),
                local.debug_name,
                print_origin(local.origin)
            )
            .expect("writing to String cannot fail");
        }
        for value in &function.values {
            writeln!(
                output,
                "  value value{} kind={:?} origin={}",
                value.id.index(),
                value.kind,
                print_origin(value.origin)
            )
            .expect("writing to String cannot fail");
        }
        for block in &function.blocks {
            writeln!(
                output,
                "  block block{} scope=scope{} hint={:?} origin={}",
                block.id.index(),
                block.scope.index(),
                block.source_hint,
                print_origin(block.origin)
            )
            .expect("writing to String cannot fail");
            for (index, instruction) in block.instructions.iter().enumerate() {
                writeln!(
                    output,
                    "    instruction {index} result={} kind={:?} semantics={:?} origin={}",
                    optional_value(instruction.result),
                    instruction.kind,
                    instruction.semantics,
                    print_origin(instruction.origin)
                )
                .expect("writing to String cannot fail");
            }
            writeln!(
                output,
                "    terminator kind={:?} origin={}",
                block.terminator.kind,
                print_origin(block.terminator.origin)
            )
            .expect("writing to String cannot fail");
        }
    }

    for template in &file.templates {
        writeln!(
            output,
            "template template{} owner=fn{} origin={}",
            template.id.index(),
            template.owner.index(),
            print_origin(template.origin)
        )
        .expect("writing to String cannot fail");
        print_jsx(&mut output, &template.root);
    }

    output
}

enum JsxPrintItem<'jsx> {
    Node(&'jsx JsxNode, usize),
    Attribute(&'jsx JsxAttribute, usize),
    Child(&'jsx JsxChild, usize),
    End(&'static str, usize),
}

fn print_jsx(output: &mut String, root: &JsxNode) {
    let mut stack = vec![JsxPrintItem::Node(root, 1)];
    while let Some(item) = stack.pop() {
        match item {
            JsxPrintItem::Node(JsxNode::Element(element), depth) => {
                writeln!(
                    output,
                    "{}element name={} origin={}",
                    indentation(depth),
                    print_jsx_name(&element.name),
                    print_origin(element.origin)
                )
                .expect("writing to String cannot fail");
                stack.push(JsxPrintItem::End("element", depth));
                for child in element.children.iter().rev() {
                    stack.push(JsxPrintItem::Child(child, depth + 1));
                }
                for attribute in element.attributes.iter().rev() {
                    stack.push(JsxPrintItem::Attribute(attribute, depth + 1));
                }
            }
            JsxPrintItem::Node(JsxNode::Fragment { children, origin }, depth) => {
                writeln!(
                    output,
                    "{}fragment origin={}",
                    indentation(depth),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
                stack.push(JsxPrintItem::End("fragment", depth));
                for child in children.iter().rev() {
                    stack.push(JsxPrintItem::Child(child, depth + 1));
                }
            }
            JsxPrintItem::Attribute(
                JsxAttribute::Named {
                    name,
                    value,
                    origin,
                },
                depth,
            ) => {
                writeln!(
                    output,
                    "{}attribute name={name:?} value={} origin={}",
                    indentation(depth),
                    print_jsx_attribute_value(value),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
                if let JsxAttributeValue::Node(node) = value {
                    stack.push(JsxPrintItem::Node(node, depth + 1));
                }
            }
            JsxPrintItem::Attribute(JsxAttribute::Spread { value, origin }, depth) => {
                writeln!(
                    output,
                    "{}attribute spread=value{} origin={}",
                    indentation(depth),
                    value.index(),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
            }
            JsxPrintItem::Child(JsxChild::Text { value, origin }, depth) => {
                writeln!(
                    output,
                    "{}child text={value:?} origin={}",
                    indentation(depth),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
            }
            JsxPrintItem::Child(
                JsxChild::Expression {
                    value,
                    kind,
                    contains_fragment,
                    function_like,
                    origin,
                },
                depth,
            ) => {
                writeln!(
                    output,
                    "{}child expression=value{} kind={kind:?} fragment={contains_fragment} function_like={function_like} origin={}",
                    indentation(depth),
                    value.index(),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
            }
            JsxPrintItem::Child(JsxChild::Spread { value, origin }, depth) => {
                writeln!(
                    output,
                    "{}child spread=value{} origin={}",
                    indentation(depth),
                    value.index(),
                    print_origin(*origin)
                )
                .expect("writing to String cannot fail");
            }
            JsxPrintItem::Child(JsxChild::Node(node), depth) => {
                stack.push(JsxPrintItem::Node(node, depth));
            }
            JsxPrintItem::End(kind, depth) => {
                writeln!(output, "{}end-{kind}", indentation(depth))
                    .expect("writing to String cannot fail");
            }
        }
    }
}

fn print_jsx_name(name: &JsxElementName) -> String {
    match name {
        JsxElementName::Intrinsic(name) => format!("intrinsic({name:?})"),
        JsxElementName::Component(binding) => format!("component(binding{})", binding.index()),
        JsxElementName::Member { root, properties } => {
            format!("member(binding{}, {properties:?})", root.index())
        }
        JsxElementName::Dynamic(value) => format!("dynamic(value{})", value.index()),
    }
}

fn print_jsx_attribute_value(value: &JsxAttributeValue) -> String {
    match value {
        JsxAttributeValue::ImplicitTrue => "true".into(),
        JsxAttributeValue::Text(value) => format!("text({value:?})"),
        JsxAttributeValue::Expression {
            value,
            function_like,
            contains_fragment,
        } => format!(
            "expression(value{}, function_like={function_like}, fragment={contains_fragment})",
            value.index()
        ),
        JsxAttributeValue::Node(_) => "node".into(),
    }
}

fn print_origin(origin: Origin) -> String {
    let span = origin.primary_span.map_or_else(
        || "-".into(),
        |span| format!("{}..{}", span.start(), span.end()),
    );
    match origin.kind {
        OriginKind::Source => format!("source@{span}"),
        OriginKind::Desugared(kind) => format!("desugared({kind:?})@{span}"),
        OriginKind::Generated(kind) => format!("generated({kind:?})@{span}"),
    }
}

fn indentation(depth: usize) -> String {
    "  ".repeat(depth)
}

fn optional_scope(scope: Option<ScopeId>) -> String {
    scope.map_or_else(|| "-".into(), |scope| format!("scope{}", scope.index()))
}

fn optional_binding(binding: Option<BindingId>) -> String {
    binding.map_or_else(
        || "-".into(),
        |binding| format!("binding{}", binding.index()),
    )
}

fn optional_value(value: Option<ValueId>) -> String {
    value.map_or_else(|| "-".into(), |value| format!("value{}", value.index()))
}

fn binding_list(bindings: &[BindingId]) -> String {
    bindings
        .iter()
        .map(|binding| format!("binding{}", binding.index()))
        .collect::<Vec<_>>()
        .join(",")
}
