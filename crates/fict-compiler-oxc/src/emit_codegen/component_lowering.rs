//! Lower planned component props and authored VNode identity in evaluation order.

use super::*;

impl<'a> AstRewriter<'a, '_> {
    pub(super) fn lower_component_element(
        &mut self,
        element: JSXElement<'a>,
        component: ComponentRewrite,
    ) -> Expression<'a> {
        let span = element.span;
        if !component_children_match(&element.children, &component.children) {
            self.diagnostics.push(emit_error(
                "FICT-OXC-EMIT-COMPONENT",
                "component children do not match their EmitIR plan",
                GuaranteeClass::Internal,
            ));
        }
        let opening = element.opening_element.unbox();
        let reactive_identity = self.vnode_identity_needs_getter(&opening);
        let element_type = self.lower_jsx_element_name(opening.name);
        let mut planned_props = component.props.into_iter();
        let mut properties = ArenaVec::new_in(&self.allocator);
        let mut prop_segments = Vec::new();
        let mut key = None;
        let mut key_local = None;
        for attribute in opening.attributes {
            let planned = planned_props.next();
            match attribute {
                JSXAttributeItem::SpreadAttribute(spread) => {
                    let getter = match planned {
                        Some(ComponentProp::Spread { getter, .. }) => getter,
                        _ => {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "component spread prop does not match its EmitIR plan",
                                GuaranteeClass::Internal,
                            ));
                            false
                        }
                    };
                    let spread = spread.unbox();
                    if !properties.is_empty() {
                        let bucket =
                            std::mem::replace(&mut properties, ArenaVec::new_in(&self.allocator));
                        prop_segments.push(Expression::new_object_expression(
                            spread.span,
                            bucket,
                            &AstBuilder::new(self.allocator),
                        ));
                    }
                    let mut value = spread.argument;
                    self.visit_expression(&mut value);
                    if getter && !expression_contains_direct_await(&value) {
                        if let Some(helper) = &component.prop_helper {
                            value = self.wrap_jsx_getter(value, spread.span, helper);
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "reactive component spread has no runtime prop helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    } else {
                        // A non-reactive JSX spread has ordinary object-spread semantics:
                        // copy only enumerable own properties and snapshot accessor values.
                        // `mergeProps(source)` deliberately returns a lone static source as-is,
                        // so passing the source directly would leak inherited properties to the
                        // child component. Materialize the spread snapshot before merging.
                        let builder = AstBuilder::new(self.allocator);
                        let mut snapshot = ArenaVec::new_in(&self.allocator);
                        snapshot.push(ObjectPropertyKind::new_spread_property(
                            spread.span,
                            value,
                            &builder,
                        ));
                        value = Expression::new_object_expression(spread.span, snapshot, &builder);
                    }
                    prop_segments.push(value);
                }
                JSXAttributeItem::Attribute(attribute) => {
                    let attribute = attribute.unbox();
                    let (name, name_span) = jsx_attribute_name(attribute.name);
                    let source_node_span = jsx_attribute_node_span(&attribute.value);
                    let (getter, non_reactive, reactive_function) = match planned {
                        Some(ComponentProp::Named {
                            name: planned_name,
                            getter,
                            non_reactive,
                            reactive_function,
                            ..
                        }) if planned_name == name && source_node_span.is_none() => {
                            (getter, non_reactive, reactive_function)
                        }
                        Some(ComponentProp::Node {
                            name: planned_name,
                            origin,
                        }) if planned_name == name
                            && source_node_span.is_some_and(|span| {
                                component_node_origin_matches(origin, span)
                            }) =>
                        {
                            (false, false, false)
                        }
                        _ => {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "component named prop does not match its EmitIR plan",
                                GuaranteeClass::Internal,
                            ));
                            (false, false, false)
                        }
                    };
                    let value_span =
                        jsx_attribute_source_span(&attribute.value).unwrap_or(name_span);
                    let keyed_runtime_value = (name == "key")
                        .then(|| jsx_attribute_source_span(&attribute.value))
                        .flatten()
                        .filter(|source| {
                            self.active_list_key_origin == Some((source.start, source.end))
                        })
                        .and_then(|_| self.active_list_key_local.clone());
                    let cached_key = keyed_runtime_value.is_some();
                    let mut value = match keyed_runtime_value {
                        Some(local) => Expression::new_identifier(
                            name_span,
                            self.allocator.alloc_str(&local),
                            &AstBuilder::new(self.allocator),
                        ),
                        None => {
                            self.lower_jsx_attribute_value(attribute.value, attribute.span, false)
                        }
                    };
                    if getter && !expression_contains_direct_await(&value) {
                        if let Some(helper) = &component.prop_helper {
                            value = self.wrap_jsx_getter(value, value_span, helper);
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "reactive component prop has no runtime prop helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    if non_reactive {
                        if let Some(helper) = &component.non_reactive_helper {
                            let callee = Expression::new_identifier(
                                name_span,
                                self.allocator.alloc_str(helper),
                                &AstBuilder::new(self.allocator),
                            );
                            let mut arguments = ArenaVec::new_in(&self.allocator);
                            arguments.push(Argument::from(value));
                            value = Expression::new_call_expression(
                                name_span,
                                callee,
                                NONE,
                                arguments,
                                false,
                                &AstBuilder::new(self.allocator),
                            );
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "function component prop has no non-reactive runtime helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    if reactive_function {
                        if let Some(helper) = &component.reactive_function_helper {
                            let callee = Expression::new_identifier(
                                name_span,
                                self.allocator.alloc_str(helper),
                                &AstBuilder::new(self.allocator),
                            );
                            let mut arguments = ArenaVec::new_in(&self.allocator);
                            arguments.push(Argument::from(value));
                            value = Expression::new_call_expression(
                                name_span,
                                callee,
                                NONE,
                                arguments,
                                false,
                                &AstBuilder::new(self.allocator),
                            );
                        } else {
                            self.diagnostics.push(emit_error(
                                "FICT-OXC-EMIT-COMPONENT",
                                "reactive function component prop has no runtime helper",
                                GuaranteeClass::Internal,
                            ));
                        }
                    }
                    if name == "key" {
                        key = Some(if cached_key {
                            value
                        } else {
                            self.stage_vnode_key(value, &mut properties, &mut key_local, name_span)
                        });
                    } else {
                        properties.push(self.object_property(name_span, &name, value));
                    }
                }
            }
        }
        if planned_props.next().is_some() {
            self.diagnostics.push(emit_error(
                "FICT-OXC-EMIT-COMPONENT",
                "component EmitIR has props absent from its source JSX",
                GuaranteeClass::Internal,
            ));
        }
        if let Some(mut children) = self.lower_jsx_children(
            element.children,
            span,
            Some((
                &component.children,
                component.non_reactive_helper.as_deref(),
            )),
        ) {
            if let Some(helper) = &component.children_helper
                && !expression_contains_direct_await(&children)
            {
                let getter = zero_parameter_expression_arrow(self.allocator, children, span);
                let callee = Expression::new_identifier(
                    span,
                    self.allocator.alloc_str(helper),
                    &AstBuilder::new(self.allocator),
                );
                let mut arguments = ArenaVec::new_in(&self.allocator);
                arguments.push(Argument::from(getter));
                children = Expression::new_call_expression(
                    span,
                    callee,
                    NONE,
                    arguments,
                    false,
                    &AstBuilder::new(self.allocator),
                );
            }
            properties.push(self.object_property(span, "children", children));
        }
        let builder = AstBuilder::new(self.allocator);
        if !properties.is_empty() {
            prop_segments.push(Expression::new_object_expression(
                span, properties, &builder,
            ));
        }
        let props = if prop_segments.is_empty() {
            Expression::new_null_literal(span, &builder)
        } else if let Some(helper) = &component.merge_helper {
            let callee =
                Expression::new_identifier(span, self.allocator.alloc_str(helper), &builder);
            let mut arguments = ArenaVec::new_in(&self.allocator);
            arguments.extend(prop_segments.into_iter().map(Argument::from));
            Expression::new_call_expression(span, callee, NONE, arguments, false, &builder)
        } else {
            if prop_segments.len() != 1 {
                self.diagnostics.push(emit_error(
                    "FICT-OXC-EMIT-COMPONENT",
                    "segmented component props have no runtime merge helper",
                    GuaranteeClass::Internal,
                ));
            }
            prop_segments
                .into_iter()
                .next()
                .expect("non-empty component prop segments")
        };
        let mut vnode = ArenaVec::new_in(&self.allocator);
        vnode.push(self.object_property(span, "type", element_type));
        vnode.push(self.object_property(span, "props", props));
        if let Some(key) = key {
            vnode.push(self.object_property(span, "key", key));
        }
        self.append_vnode_site(&mut vnode, span);
        let value = Expression::new_object_expression(span, vnode, &builder);
        let value = self.finish_vnode_key(value, key_local, span);
        if reactive_identity && let Some(helper) = &self.active_vnode_reactive_local {
            return self.wrap_jsx_getter(value, span, helper);
        }
        value
    }
}
