use std::collections::{BTreeMap, BTreeSet};

use fict_diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticSeverity, GuaranteeClass, SourceSpan,
};
use oxc::{
    allocator::{Allocator, TakeIn},
    ast::{
        AstBuilder,
        ast::{
            AssignmentTarget, AssignmentTargetMaybeDefault, AssignmentTargetProperty,
            BindingIdentifier, BindingPattern, Declaration, Expression, IdentifierName,
            IdentifierReference, Program, PropertyKey, SimpleAssignmentTarget, Statement,
            TSModuleDeclaration, TSModuleDeclarationBody, TSModuleDeclarationName, TSType,
            TSTypeName, VariableDeclaration, VariableDeclarationKind,
        },
    },
    ast_visit::{Visit, VisitMut, walk, walk_mut},
    semantic::Scoping,
    span::Span,
    syntax::{identifier::is_identifier_name, symbol::SymbolId},
};

use crate::typescript::{
    TypeScriptCompatibilityPlan, TypeScriptNamespaceMember, TypeScriptNamespacePlan,
    TypeScriptNamespaceReference, TypeScriptNamespaceSegment, namespace_has_runtime_body,
};

pub(crate) struct NamespaceCompatibilityOutput {
    pub(crate) changed: bool,
    pub(crate) diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
struct NamespaceSegment {
    group: SymbolId,
    name: String,
    path: Vec<String>,
    span: Span,
}

#[derive(Debug, Clone)]
struct NamespaceMember {
    group: SymbolId,
    segment: usize,
    symbol: SymbolId,
    name: String,
    exported: bool,
    mutable: bool,
    span: Span,
}

#[derive(Default)]
struct NamespaceFacts {
    segments: Vec<NamespaceSegment>,
    segment_by_span: BTreeMap<(u32, u32), usize>,
    members: Vec<NamespaceMember>,
    mutable_declarations: BTreeSet<(u32, u32)>,
}

enum NamespaceMemberVisibility<'facts> {
    None,
    Rewrite(&'facts NamespaceSegment, &'facts NamespaceMember),
    InternalCrossSegment(&'facts NamespaceMember),
}

impl NamespaceFacts {
    fn referenced_member<'facts>(
        &'facts self,
        stack: &[usize],
        identifier: &IdentifierReference<'_>,
        scoping: &Scoping,
    ) -> Option<&'facts NamespaceMember> {
        let resolved = identifier
            .reference_id
            .get()
            .and_then(|reference| scoping.get_reference(reference).symbol_id());
        if let Some(symbol) = resolved
            && let Some(member) = self.members.iter().find(|member| member.symbol == symbol)
        {
            return Some(member);
        }

        if resolved.is_some() {
            return None;
        }
        for &segment_index in stack.iter().rev() {
            let segment = &self.segments[segment_index];
            let named = || {
                self.members.iter().filter(|member| {
                    member.group == segment.group && member.name == identifier.name.as_str()
                })
            };
            if let Some(member) = named().find(|member| member.exported) {
                return Some(member);
            }
            if let Some(member) = named().find(|member| member.segment != segment_index) {
                return Some(member);
            }
        }
        None
    }

    fn visible_member(
        &self,
        stack: &[usize],
        identifier: &IdentifierReference<'_>,
        scoping: &Scoping,
    ) -> NamespaceMemberVisibility<'_> {
        let Some(member) = self.referenced_member(stack, identifier, scoping) else {
            return NamespaceMemberVisibility::None;
        };
        let cross_segment = !stack.contains(&member.segment);
        let crosses_same_namespace = stack
            .iter()
            .any(|segment| self.segments[*segment].group == member.group);
        if cross_segment && !member.exported && crosses_same_namespace {
            return NamespaceMemberVisibility::InternalCrossSegment(member);
        }
        if member.mutable || (member.exported && cross_segment) {
            return NamespaceMemberVisibility::Rewrite(&self.segments[member.segment], member);
        }
        NamespaceMemberVisibility::None
    }
}

struct NamespaceFactCollector {
    facts: NamespaceFacts,
    stack: Vec<usize>,
}

impl NamespaceFactCollector {
    fn collect_declaration(&mut self, declaration: &Declaration<'_>, exported: bool) {
        let Some(segment) = self.stack.last().copied() else {
            return;
        };
        match declaration {
            Declaration::VariableDeclaration(variable) => {
                let mutable = exported && variable.kind != VariableDeclarationKind::Const;
                if mutable {
                    self.facts
                        .mutable_declarations
                        .insert((variable.span.start, variable.span.end));
                }
                for declarator in &variable.declarations {
                    let mut names = BindingNameCollector::default();
                    names.visit_binding_pattern(&declarator.id);
                    for (symbol, name, span) in names.bindings {
                        self.push_member_parts(segment, symbol, name, span, exported, mutable);
                    }
                }
            }
            Declaration::FunctionDeclaration(function) => {
                if let Some(binding) = &function.id {
                    self.push_member(segment, binding, exported, false);
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(binding) = &class.id {
                    self.push_member(segment, binding, exported, false);
                }
            }
            Declaration::TSEnumDeclaration(enumeration) => {
                self.push_member(segment, &enumeration.id, exported, false);
            }
            Declaration::TSImportEqualsDeclaration(import) => {
                self.push_member(segment, &import.id, exported, false);
            }
            Declaration::TSModuleDeclaration(namespace) => {
                if let TSModuleDeclarationName::Identifier(binding) = &namespace.id {
                    self.push_member(segment, binding, exported, false);
                }
            }
            Declaration::TSTypeAliasDeclaration(_)
            | Declaration::TSInterfaceDeclaration(_)
            | Declaration::TSGlobalDeclaration(_) => {}
        }
    }

    fn collect_statement(&mut self, statement: &Statement<'_>) {
        match statement {
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    self.collect_declaration(declaration, true);
                }
            }
            statement => {
                if let Some(declaration) = statement.as_declaration() {
                    self.collect_declaration(declaration, false);
                }
            }
        }
    }

    fn push_member(
        &mut self,
        segment: usize,
        binding: &BindingIdentifier<'_>,
        exported: bool,
        mutable: bool,
    ) {
        let Some(symbol) = binding.symbol_id.get() else {
            return;
        };
        self.push_member_parts(
            segment,
            symbol,
            binding.name.to_string(),
            binding.span,
            exported,
            mutable,
        );
    }

    fn push_member_parts(
        &mut self,
        segment: usize,
        symbol: SymbolId,
        name: String,
        span: Span,
        exported: bool,
        mutable: bool,
    ) {
        self.facts.members.push(NamespaceMember {
            group: self.facts.segments[segment].group,
            segment,
            symbol,
            name,
            exported,
            mutable,
            span,
        });
    }
}

impl<'a> Visit<'a> for NamespaceFactCollector {
    fn visit_ts_module_declaration(&mut self, namespace: &TSModuleDeclaration<'a>) {
        if !namespace_has_runtime_body(namespace) {
            walk::walk_ts_module_declaration(self, namespace);
            return;
        }
        let TSModuleDeclarationName::Identifier(identifier) = &namespace.id else {
            walk::walk_ts_module_declaration(self, namespace);
            return;
        };
        let Some(group) = identifier.symbol_id.get() else {
            walk::walk_ts_module_declaration(self, namespace);
            return;
        };
        let segment = self.facts.segments.len();
        let mut path = self
            .stack
            .last()
            .map_or_else(Vec::new, |parent| self.facts.segments[*parent].path.clone());
        path.push(identifier.name.to_string());
        self.facts.segments.push(NamespaceSegment {
            group,
            name: identifier.name.to_string(),
            path,
            span: namespace.span,
        });
        self.facts
            .segment_by_span
            .insert((namespace.span.start, namespace.span.end), segment);
        self.stack.push(segment);
        match namespace.body.as_ref() {
            Some(TSModuleDeclarationBody::TSModuleBlock(block)) => {
                for statement in &block.body {
                    self.collect_statement(statement);
                }
            }
            Some(TSModuleDeclarationBody::TSModuleDeclaration(nested)) => {
                if let TSModuleDeclarationName::Identifier(binding) = &nested.id {
                    self.push_member(segment, binding, true, false);
                }
            }
            None => {}
        }
        walk::walk_ts_module_declaration(self, namespace);
        self.stack.pop();
    }
}

#[derive(Default)]
struct BindingNameCollector {
    bindings: Vec<(SymbolId, String, Span)>,
}

impl<'a> Visit<'a> for BindingNameCollector {
    fn visit_binding_identifier(&mut self, binding: &BindingIdentifier<'a>) {
        if let Some(symbol) = binding.symbol_id.get() {
            self.bindings
                .push((symbol, binding.name.to_string(), binding.span));
        }
    }

    fn visit_binding_pattern(&mut self, pattern: &BindingPattern<'a>) {
        walk::walk_binding_pattern(self, pattern);
    }
}

#[derive(Default)]
struct NamespaceWriteCollector {
    spans: BTreeSet<(u32, u32)>,
}

impl<'a> Visit<'a> for NamespaceWriteCollector {
    fn visit_assignment_target(&mut self, target: &AssignmentTarget<'a>) {
        if let AssignmentTarget::AssignmentTargetIdentifier(identifier) = target {
            self.spans
                .insert((identifier.span.start, identifier.span.end));
        }
        walk::walk_assignment_target(self, target);
    }

    fn visit_simple_assignment_target(&mut self, target: &SimpleAssignmentTarget<'a>) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = target {
            self.spans
                .insert((identifier.span.start, identifier.span.end));
        }
        walk::walk_simple_assignment_target(self, target);
    }

    fn visit_assignment_target_property(&mut self, property: &AssignmentTargetProperty<'a>) {
        if let AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) = property {
            self.spans
                .insert((shorthand.binding.span.start, shorthand.binding.span.end));
        }
        walk::walk_assignment_target_property(self, property);
    }
}

struct NamespaceReferenceCollector<'facts> {
    scoping: &'facts Scoping,
    facts: &'facts NamespaceFacts,
    writes: &'facts BTreeSet<(u32, u32)>,
    stack: Vec<usize>,
    references: Vec<TypeScriptNamespaceReference>,
}

impl NamespaceReferenceCollector<'_> {
    fn record(&mut self, identifier: &IdentifierReference<'_>) {
        let Some(source_segment) = self.stack.last().copied() else {
            return;
        };
        let Some(member) = self
            .facts
            .referenced_member(&self.stack, identifier, self.scoping)
        else {
            return;
        };
        let cross_segment = !self.stack.contains(&member.segment);
        if !member.mutable && !cross_segment {
            return;
        }
        let target = &self.facts.segments[member.segment];
        self.references.push(TypeScriptNamespaceReference {
            namespace_path: target.path.clone(),
            member: member.name.clone(),
            declaration_span: source_span(member.span),
            reference_span: source_span(identifier.span),
            source_segment: u32::try_from(source_segment).unwrap_or(u32::MAX),
            target_segment: u32::try_from(member.segment).unwrap_or(u32::MAX),
            cross_segment,
            exported: member.exported,
            mutable: member.mutable,
            write: self
                .writes
                .contains(&(identifier.span.start, identifier.span.end)),
        });
    }
}

impl<'a> Visit<'a> for NamespaceReferenceCollector<'_> {
    fn visit_ts_module_declaration(&mut self, namespace: &TSModuleDeclaration<'a>) {
        let key = (namespace.span.start, namespace.span.end);
        if let Some(segment) = self.facts.segment_by_span.get(&key).copied() {
            self.stack.push(segment);
            walk::walk_ts_module_declaration(self, namespace);
            self.stack.pop();
        } else {
            walk::walk_ts_module_declaration(self, namespace);
        }
    }

    fn visit_ts_type(&mut self, _type: &TSType<'a>) {}

    fn visit_ts_type_name(&mut self, _name: &TSTypeName<'a>) {}

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        self.record(identifier);
    }
}

struct NamespaceRewriter<'a, 'facts> {
    allocator: &'a Allocator,
    scoping: &'facts Scoping,
    facts: &'facts NamespaceFacts,
    stack: Vec<usize>,
    diagnostics: Vec<Diagnostic>,
    changed: bool,
}

impl<'a> NamespaceRewriter<'a, '_> {
    fn qualifier(
        &mut self,
        identifier: &IdentifierReference<'_>,
    ) -> Option<(String, String, Span)> {
        match self
            .facts
            .visible_member(&self.stack, identifier, self.scoping)
        {
            NamespaceMemberVisibility::Rewrite(segment, member) => {
                Some((segment.name.clone(), member.name.clone(), member.span))
            }
            NamespaceMemberVisibility::None => None,
            NamespaceMemberVisibility::InternalCrossSegment(member) => {
                self.diagnostics.push(namespace_error(
                    "FICT-TS-NAMESPACE-REFERENCE",
                    "a namespace declaration segment cannot access an internal binding from another segment",
                    member.span,
                    identifier.span,
                ));
                None
            }
        }
    }

    fn expression_member(&self, namespace: &str, member: &str, span: Span) -> Expression<'a> {
        let builder = AstBuilder::new(self.allocator);
        let object =
            Expression::new_identifier(span, self.allocator.alloc_str(namespace), &builder);
        if is_identifier_name(member) {
            Expression::new_static_member_expression(
                span,
                object,
                IdentifierName::new(span, self.allocator.alloc_str(member), &builder),
                false,
                &builder,
            )
        } else {
            let property = Expression::new_string_literal(
                span,
                self.allocator.alloc_str(member),
                None,
                &builder,
            );
            Expression::new_computed_member_expression(span, object, property, false, &builder)
        }
    }

    fn assignment_member(&self, namespace: &str, member: &str, span: Span) -> AssignmentTarget<'a> {
        let builder = AstBuilder::new(self.allocator);
        AssignmentTarget::new_static_member_expression(
            span,
            Expression::new_identifier(span, self.allocator.alloc_str(namespace), &builder),
            IdentifierName::new(span, self.allocator.alloc_str(member), &builder),
            false,
            &builder,
        )
    }

    fn simple_assignment_member(
        &self,
        namespace: &str,
        member: &str,
        span: Span,
    ) -> SimpleAssignmentTarget<'a> {
        let builder = AstBuilder::new(self.allocator);
        SimpleAssignmentTarget::new_static_member_expression(
            span,
            Expression::new_identifier(span, self.allocator.alloc_str(namespace), &builder),
            IdentifierName::new(span, self.allocator.alloc_str(member), &builder),
            false,
            &builder,
        )
    }
}

impl<'a> VisitMut<'a> for NamespaceRewriter<'a, '_> {
    fn visit_ts_type(&mut self, _type: &mut TSType<'a>) {
        // Type positions are erased by the downstream TypeScript transform and
        // must not be mistaken for runtime namespace reads.
    }

    fn visit_ts_type_name(&mut self, _name: &mut TSTypeName<'a>) {
        // Heritage and query names can be visited without passing through a
        // `TSType`; they are still erased type-only references.
    }

    fn visit_ts_module_declaration(&mut self, namespace: &mut TSModuleDeclaration<'a>) {
        let key = (namespace.span.start, namespace.span.end);
        if let Some(segment) = self.facts.segment_by_span.get(&key).copied() {
            self.stack.push(segment);
            walk_mut::walk_ts_module_declaration(self, namespace);
            self.stack.pop();
        } else {
            walk_mut::walk_ts_module_declaration(self, namespace);
        }
    }

    fn visit_variable_declaration(&mut self, declaration: &mut VariableDeclaration<'a>) {
        if self
            .facts
            .mutable_declarations
            .contains(&(declaration.span.start, declaration.span.end))
        {
            declaration.kind = VariableDeclarationKind::Const;
            for declarator in &mut declaration.declarations {
                declarator.kind = VariableDeclarationKind::Const;
                if declarator.init.is_none() {
                    declarator.init = Some(Expression::new_unary_expression(
                        declarator.span,
                        oxc::syntax::operator::UnaryOperator::Void,
                        Expression::new_numeric_literal(
                            declarator.span,
                            0.0,
                            None,
                            oxc::syntax::number::NumberBase::Decimal,
                            &AstBuilder::new(self.allocator),
                        ),
                        &AstBuilder::new(self.allocator),
                    ));
                }
            }
            self.changed = true;
        }
        walk_mut::walk_variable_declaration(self, declaration);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::Identifier(identifier) = expression
            && let Some((namespace, member, _)) = self.qualifier(identifier)
        {
            let span = identifier.span;
            *expression = self.expression_member(&namespace, &member, span);
            self.changed = true;
            return;
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_assignment_target(&mut self, target: &mut AssignmentTarget<'a>) {
        if let AssignmentTarget::AssignmentTargetIdentifier(identifier) = target
            && let Some((namespace, member, _)) = self.qualifier(identifier)
        {
            let span = identifier.span;
            *target = self.assignment_member(&namespace, &member, span);
            self.changed = true;
            return;
        }
        walk_mut::walk_assignment_target(self, target);
    }

    fn visit_simple_assignment_target(&mut self, target: &mut SimpleAssignmentTarget<'a>) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = target
            && let Some((namespace, member, _)) = self.qualifier(identifier)
        {
            let span = identifier.span;
            *target = self.simple_assignment_member(&namespace, &member, span);
            self.changed = true;
            return;
        }
        walk_mut::walk_simple_assignment_target(self, target);
    }

    fn visit_assignment_target_property(&mut self, property: &mut AssignmentTargetProperty<'a>) {
        if let AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) = property
            && let Some((namespace, member, _)) = self.qualifier(&shorthand.binding)
        {
            let owned = property.take_in(&self.allocator);
            let AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(shorthand) = owned
            else {
                unreachable!("selected namespace shorthand target")
            };
            let shorthand = shorthand.unbox();
            let span = shorthand.binding.span;
            let builder = AstBuilder::new(self.allocator);
            let key = PropertyKey::new_static_identifier(
                span,
                self.allocator.alloc_str(shorthand.binding.name.as_str()),
                &builder,
            );
            let target = self.simple_assignment_member(&namespace, &member, span);
            let binding = match shorthand.init {
                Some(init) => AssignmentTargetMaybeDefault::new_assignment_target_with_default(
                    shorthand.span,
                    target.into(),
                    init,
                    &builder,
                ),
                None => AssignmentTargetMaybeDefault::from(target),
            };
            *property = AssignmentTargetProperty::new_assignment_target_property_property(
                shorthand.span,
                key,
                binding,
                false,
                &builder,
            );
            self.changed = true;
            return;
        }
        walk_mut::walk_assignment_target_property(self, property);
    }

    fn visit_identifier_reference(&mut self, identifier: &mut IdentifierReference<'a>) {
        if let Some((_, _, declaration)) = self.qualifier(identifier) {
            self.diagnostics.push(namespace_error(
                "FICT-TS-NAMESPACE-REFERENCE",
                "namespace member reference occurs in a syntax position that cannot be lowered safely",
                declaration,
                identifier.span,
            ));
        }
    }
}

pub(crate) fn lower_namespace_compatibility<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: &Scoping,
    plan: &TypeScriptCompatibilityPlan,
) -> NamespaceCompatibilityOutput {
    if !plan.requires_fict_lowering {
        return NamespaceCompatibilityOutput {
            changed: false,
            diagnostics: Vec::new(),
        };
    }
    let mut collector = NamespaceFactCollector {
        facts: NamespaceFacts::default(),
        stack: Vec::new(),
    };
    collector.visit_program(program);
    let mut rewriter = NamespaceRewriter {
        allocator,
        scoping,
        facts: &collector.facts,
        stack: Vec::new(),
        diagnostics: Vec::new(),
        changed: false,
    };
    rewriter.visit_program(program);
    NamespaceCompatibilityOutput {
        changed: rewriter.changed,
        diagnostics: rewriter.diagnostics,
    }
}

pub(crate) fn collect_namespace_plan(
    program: &Program<'_>,
    scoping: &Scoping,
) -> TypeScriptNamespacePlan {
    let mut collector = NamespaceFactCollector {
        facts: NamespaceFacts::default(),
        stack: Vec::new(),
    };
    collector.visit_program(program);
    let mut writes = NamespaceWriteCollector::default();
    writes.visit_program(program);
    let mut reference_collector = NamespaceReferenceCollector {
        scoping,
        facts: &collector.facts,
        writes: &writes.spans,
        stack: Vec::new(),
        references: Vec::new(),
    };
    reference_collector.visit_program(program);
    let group_counts = collector.facts.segments.iter().fold(
        BTreeMap::<SymbolId, usize>::new(),
        |mut counts, segment| {
            *counts.entry(segment.group).or_default() += 1;
            counts
        },
    );
    let namespace_symbols: BTreeSet<_> = collector
        .facts
        .segments
        .iter()
        .map(|segment| segment.group)
        .collect();
    TypeScriptNamespacePlan {
        segments: collector
            .facts
            .segments
            .iter()
            .enumerate()
            .map(|(index, segment)| TypeScriptNamespaceSegment {
                path: segment.path.clone(),
                declaration_span: source_span(segment.span),
                source_order: u32::try_from(index).unwrap_or(u32::MAX),
                merged: group_counts.get(&segment.group).copied().unwrap_or(0) > 1,
                members: collector
                    .facts
                    .members
                    .iter()
                    .filter(|member| member.segment == index)
                    .map(|member| TypeScriptNamespaceMember {
                        name: member.name.clone(),
                        declaration_span: source_span(member.span),
                        exported: member.exported,
                        mutable: member.mutable,
                        namespace: namespace_symbols.contains(&member.symbol),
                    })
                    .collect(),
            })
            .collect(),
        references: reference_collector.references,
    }
}

fn namespace_error(
    code: &'static str,
    message: &'static str,
    declaration: Span,
    reference: Span,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::new(code).expect("namespace diagnostic literal"),
        DiagnosticSeverity::Error,
        message,
    )
    .with_primary_span(source_span(reference))
    .with_secondary_label(source_span(declaration), "namespace member declared here")
    .with_guarantee_class(GuaranteeClass::Unsupported)
}

fn source_span(span: Span) -> SourceSpan {
    SourceSpan::new(span.start, span.end).expect("OXC spans are ordered")
}
