//! Prove scalar derivations and logical consumers before generated namespace copies.
//! Only total scalar expressions over closed numeric component signals may cross a getter.
//! This deliberately does not infer purity from result types or TypeScript annotations.

use super::{DerivedCreationRewrite, SemanticIdentities};
use fict_emit::{EmitOperation, EmitProgram, RuntimeHelper};
use fict_hir::{BindingId, FunctionKind};
use oxc::{
    ast::ast::{
        ArrowFunctionExpression, AssignmentExpression, AssignmentTarget, BindingPattern,
        CallExpression, Expression, Function, FunctionBody, IdentifierReference, JSXChild,
        JSXElement, JSXElementName, Program, ReturnStatement, SimpleAssignmentTarget, Statement,
        UpdateExpression, VariableDeclarationKind, VariableDeclarator,
    },
    ast_visit::{Visit, walk},
    span::Span,
    syntax::{
        operator::{BinaryOperator, UnaryOperator},
        scope::ScopeFlags,
    },
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

type Location = (u32, u32);
type Dependencies = BTreeSet<BindingId>;
pub(super) type JsxInlineReads = BTreeMap<Location, JsxInlineRead>;

#[derive(Default)]
pub(super) struct DerivedReadProofs {
    pub jsx_reads: JsxInlineReads,
    pub unused: BTreeSet<BindingId>,
}

pub(super) struct JsxInlineRead {
    pub binding: BindingId,
    pub name: String,
}

struct Definition {
    name: String,
    owner: Option<Location>,
    start: u32,
    end: u32,
    inputs: Option<Dependencies>,
}

struct Consumer {
    owner: Option<Location>,
    location: Location,
    returned: bool,
}

pub(super) fn analyze(
    program: &Program<'_>,
    identities: &SemanticIdentities,
    emit: &EmitProgram,
    creations: &BTreeMap<BindingId, DerivedCreationRewrite>,
) -> DerivedReadProofs {
    if !emit.optimize
        || emit.preview
        || creations.is_empty()
        || identities.has_reserved_name("eval")
    {
        return DerivedReadProofs::default();
    }
    let mut states = BTreeMap::new();
    for function in &emit.functions {
        if function.kind != FunctionKind::Component {
            continue;
        }
        for operation in &function.operations {
            if let EmitOperation::CreateReactive {
                slot,
                helper: RuntimeHelper::UseSignal,
                origin,
                ..
            } = operation
                && let Some(binding) = function
                    .slots
                    .iter()
                    .find(|candidate| candidate.id == *slot)
                    .and_then(|slot| slot.binding)
                && let Some(span) = origin.primary_span
            {
                states.insert(binding, (span.start(), span.end()));
            }
        }
    }
    if states.is_empty() {
        return DerivedReadProofs::default();
    }
    let mut collector = ProofCollector {
        identities,
        creations,
        states,
        initial: BTreeSet::new(),
        initialized_at: BTreeMap::new(),
        writes: BTreeMap::new(),
        recognized_writes: BTreeSet::new(),
        invalid: BTreeSet::new(),
        definitions: BTreeMap::new(),
        references: BTreeMap::new(),
        jsx_reads: BTreeSet::new(),
        owner: None,
        depth: 0,
        returned: false,
        intrinsic: true,
    };
    collector.visit_program(program);

    let mut scalars = collector.initial;
    let mut invalid: VecDeque<_> = collector.invalid.into_iter().collect();
    let mut dependents: BTreeMap<BindingId, BTreeSet<BindingId>> = BTreeMap::new();
    for (binding, writes) in &collector.writes {
        for inputs in writes {
            let Some(inputs) = inputs else {
                invalid.push_back(*binding);
                continue;
            };
            for input in inputs {
                if !scalars.contains(input) {
                    invalid.push_back(*binding);
                }
                dependents.entry(*input).or_default().insert(*binding);
            }
        }
    }
    // Every signal starts with a scalar literal. Invalidate unsupported writes and their
    // dependents once; safe write cycles preserve the invariant without repeated rescans.
    while let Some(binding) = invalid.pop_front() {
        if scalars.remove(&binding)
            && let Some(users) = dependents.remove(&binding)
        {
            invalid.extend(users);
        }
    }
    let mut proofs = DerivedReadProofs::default();
    for (binding, definition) in collector.definitions {
        let references = collector
            .references
            .get(&binding)
            .map_or(&[][..], Vec::as_slice);
        if references.len() > 1 {
            continue;
        }
        let total = definition.inputs.is_some_and(|inputs| {
            !inputs.is_empty()
                && inputs.is_subset(&scalars)
                && inputs.iter().all(|binding| {
                    collector
                        .initialized_at
                        .get(binding)
                        .is_some_and(|(owner, end)| {
                            *owner == definition.owner && *end <= definition.start
                        })
                })
        });
        if !total {
            continue;
        }
        if references.is_empty() {
            // Elide only materialized implicit memos, under the same source/value proof.
            // A second check on the rewritten AST must still find no generated consumers.
            if creations
                .get(&binding)
                .is_some_and(|creation| creation.rewrite.local.is_some())
            {
                proofs.unused.insert(binding);
            }
            continue;
        }
        let reference = &references[0];
        if reference.returned
            && reference.owner == definition.owner
            && definition.end <= reference.location.0
            && collector.jsx_reads.contains(&reference.location)
        {
            proofs.jsx_reads.insert(
                reference.location,
                JsxInlineRead {
                    binding,
                    name: definition.name,
                },
            );
        }
    }
    proofs
}

struct ProofCollector<'p> {
    identities: &'p SemanticIdentities,
    creations: &'p BTreeMap<BindingId, DerivedCreationRewrite>,
    states: BTreeMap<BindingId, Location>,
    initial: BTreeSet<BindingId>,
    initialized_at: BTreeMap<BindingId, (Option<Location>, u32)>,
    writes: BTreeMap<BindingId, Vec<Option<Dependencies>>>,
    recognized_writes: BTreeSet<Location>,
    invalid: BTreeSet<BindingId>,
    definitions: BTreeMap<BindingId, Definition>,
    references: BTreeMap<BindingId, Vec<Consumer>>,
    jsx_reads: BTreeSet<Location>,
    owner: Option<Location>,
    depth: usize,
    returned: bool,
    intrinsic: bool,
}

impl ProofCollector<'_> {
    fn dependencies(&self, expression: &Expression<'_>) -> Option<Dependencies> {
        // State stays number/boolean/nullish. Reject string recurrences whose concatenation
        // can grow without a static bound and throw an observable invalid-string-length error.
        scalar_dependencies(expression, self.identities, &self.states, false)
    }

    fn write(&mut self, identifier: &IdentifierReference<'_>, inputs: Option<Dependencies>) {
        if let Some(binding) = self.identities.binding_for_reference(identifier)
            && self.states.contains_key(&binding)
        {
            self.recognized_writes.insert(location(identifier.span));
            self.writes.entry(binding).or_default().push(inputs);
        }
    }
}

impl<'a> Visit<'a> for ProofCollector<'_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        let previous = (self.owner, self.returned, self.intrinsic);
        self.owner = Some(location(function.span));
        self.returned = false;
        self.intrinsic = true;
        walk::walk_function(self, function, flags);
        (self.owner, self.returned, self.intrinsic) = previous;
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        let previous = (self.owner, self.returned, self.intrinsic);
        self.owner = Some(location(function.span));
        self.returned = false;
        self.intrinsic = true;
        walk::walk_arrow_function_expression(self, function);
        (self.owner, self.returned, self.intrinsic) = previous;
    }

    fn visit_function_body(&mut self, body: &FunctionBody<'a>) {
        let previous = self.depth;
        self.depth = 0;
        walk::walk_function_body(self, body);
        self.depth = previous;
    }

    fn visit_statement(&mut self, statement: &Statement<'a>) {
        self.depth += 1;
        walk::walk_statement(self, statement);
        self.depth -= 1;
    }

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'a>) {
        let previous = self.returned;
        self.returned = self.depth == 1;
        walk::walk_return_statement(self, statement);
        self.returned = previous;
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let BindingPattern::BindingIdentifier(identifier) = &declarator.id
            && let Some(binding) = identifier
                .symbol_id
                .get()
                .and_then(|id| self.identities.binding_for_symbol(id))
            && let Some(initializer) = &declarator.init
        {
            if self.depth == 1
                && let Expression::CallExpression(call) = initializer.get_inner_expression()
                && self.states.get(&binding) == Some(&location(call.span))
                && let Some(argument) = call
                    .arguments
                    .first()
                    .and_then(|argument| argument.as_expression())
                && self
                    .dependencies(argument)
                    .is_some_and(|inputs| inputs.is_empty())
            {
                self.initial.insert(binding);
                self.initialized_at
                    .insert(binding, (self.owner, declarator.span.end));
            }
            if self.depth == 1
                && declarator.kind == VariableDeclarationKind::Const
                && let Some(creation) = self.creations.get(&binding)
                && if identifier.name.starts_with("__") {
                    creation.inline_compiler_names
                } else {
                    creation.inline_user_names
                }
            {
                self.definitions.insert(
                    binding,
                    Definition {
                        name: identifier.name.to_string(),
                        owner: self.owner,
                        start: declarator.span.start,
                        end: declarator.span.end,
                        inputs: scalar_dependencies(
                            initializer,
                            self.identities,
                            &self.states,
                            true,
                        ),
                    },
                );
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_assignment_expression(&mut self, assignment: &AssignmentExpression<'a>) {
        if let AssignmentTarget::AssignmentTargetIdentifier(identifier) = &assignment.left {
            self.write(identifier, self.dependencies(&assignment.right));
        }
        walk::walk_assignment_expression(self, assignment);
    }

    fn visit_update_expression(&mut self, update: &UpdateExpression<'a>) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) = &update.argument {
            self.write(identifier, Some(BTreeSet::new()));
        }
        walk::walk_update_expression(self, update);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        // Manual calls or writes to a macro binding do not have this closed value contract.
        if let Expression::Identifier(identifier) = call.callee.get_inner_expression()
            && let Some(binding) = self.identities.binding_for_reference(identifier)
            && self.states.contains_key(&binding)
        {
            self.invalid.insert(binding);
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let Some(binding) = self.identities.binding_for_reference(identifier) else {
            return;
        };
        let span = location(identifier.span);
        if self.states.contains_key(&binding)
            && self.identities.reference_is_write(identifier)
            && !self.recognized_writes.contains(&span)
        {
            self.invalid.insert(binding);
        }
        if self.creations.contains_key(&binding) {
            self.references.entry(binding).or_default().push(Consumer {
                owner: self.owner,
                location: span,
                returned: self.returned,
            });
        }
    }

    fn visit_jsx_element(&mut self, element: &JSXElement<'a>) {
        let previous = self.intrinsic;
        self.intrinsic &= matches!(&element.opening_element.name, JSXElementName::Identifier(_));
        if self.intrinsic {
            for child in &element.children {
                if let JSXChild::ExpressionContainer(container) = child
                    && let Some(Expression::Identifier(identifier)) = container
                        .expression
                        .as_expression()
                        .map(Expression::get_inner_expression)
                {
                    self.jsx_reads.insert(location(identifier.span));
                }
            }
        }
        walk::walk_jsx_element(self, element);
        self.intrinsic = previous;
    }
}

fn scalar_dependencies(
    expression: &Expression<'_>,
    identities: &SemanticIdentities,
    states: &BTreeMap<BindingId, Location>,
    strings: bool,
) -> Option<Dependencies> {
    let combine = |expressions: &[&Expression<'_>]| {
        let mut inputs = BTreeSet::new();
        for expression in expressions {
            inputs.extend(scalar_dependencies(
                expression, identities, states, strings,
            )?);
        }
        Some(inputs)
    };
    match expression.get_inner_expression() {
        Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => Some(BTreeSet::new()),
        Expression::StringLiteral(_) if strings => Some(BTreeSet::new()),
        Expression::Identifier(identifier) => identities
            .binding_for_reference(identifier)
            .filter(|binding| states.contains_key(binding))
            .map(|binding| BTreeSet::from([binding])),
        Expression::UnaryExpression(unary)
            if unary.operator != UnaryOperator::Delete
                && (strings || unary.operator != UnaryOperator::Typeof) =>
        {
            combine(&[&unary.argument])
        }
        Expression::BinaryExpression(binary)
            if !matches!(
                binary.operator,
                BinaryOperator::In | BinaryOperator::Instanceof
            ) =>
        {
            combine(&[&binary.left, &binary.right])
        }
        Expression::LogicalExpression(logical) => combine(&[&logical.left, &logical.right]),
        Expression::ConditionalExpression(conditional) => combine(&[
            &conditional.test,
            &conditional.consequent,
            &conditional.alternate,
        ]),
        Expression::SequenceExpression(sequence) => {
            combine(&sequence.expressions.iter().collect::<Vec<_>>())
        }
        Expression::TemplateLiteral(template) if strings => {
            combine(&template.expressions.iter().collect::<Vec<_>>())
        }
        _ => None,
    }
}

fn location(span: Span) -> Location {
    (span.start, span.end)
}
