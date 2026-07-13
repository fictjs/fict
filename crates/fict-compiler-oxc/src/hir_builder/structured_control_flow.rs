use std::collections::BTreeMap;

use fict_diagnostics::SourceSpan;
use fict_hir::{BlockId, FunctionId, IterationKind, ScopeId, StructuredSourceKind};
use oxc::{
    ast::ast::{
        ArrowFunctionExpression, AssignmentTargetRest, AssignmentTargetWithDefault, BlockStatement,
        Expression, ForStatementLeft, Function, IdentifierReference, Program, Statement,
    },
    ast_visit::{
        Visit,
        walk::{
            walk_arrow_function_expression, walk_assignment_target_rest,
            walk_assignment_target_with_default, walk_function,
        },
    },
    semantic::Scoping,
    span::GetSpan,
    syntax::{operator::UnaryOperator, scope::ScopeFlags, symbol::SymbolId},
};

use super::{PatternBindingCollector, source_span};

#[derive(Debug, Clone)]
pub(super) struct FunctionControlFlowPlan {
    pub blocks: Vec<PlannedBlock>,
    pub owners: Vec<SpanOwner>,
    pub supported: bool,
    pub has_control_flow: bool,
}

impl FunctionControlFlowPlan {
    pub(super) fn block_for_span(&self, span: SourceSpan) -> BlockId {
        self.owners
            .iter()
            .filter(|owner| contains(owner.span, span))
            .min_by_key(|owner| owner.span.end().saturating_sub(owner.span.start()))
            .map_or(BlockId::new(0), |owner| owner.block)
    }
}

#[derive(Debug, Clone)]
pub(super) struct PlannedBlock {
    pub id: BlockId,
    pub scope: ScopeId,
    pub origin: SourceSpan,
    pub source_kind: Option<StructuredSourceKind>,
    pub source_exit: Option<BlockId>,
    pub source_origin: Option<SourceSpan>,
    pub terminator: PlannedTerminator,
}

#[derive(Debug, Clone)]
pub(super) enum PlannedTerminator {
    Return {
        value: Option<SourceSpan>,
        origin: SourceSpan,
    },
    Throw {
        value: SourceSpan,
        origin: SourceSpan,
    },
    Goto {
        target: BlockId,
        origin: SourceSpan,
    },
    Branch {
        test: SourceSpan,
        has_effects: bool,
        consequent: BlockId,
        alternate: BlockId,
        origin: SourceSpan,
    },
    ForEach {
        kind: IterationKind,
        source: SourceSpan,
        source_block: BlockId,
        source_has_effects: bool,
        target: PlannedIterationTarget,
        body: BlockId,
        exit: BlockId,
        origin: SourceSpan,
    },
    Unreachable {
        origin: SourceSpan,
    },
}

#[derive(Debug, Clone)]
pub(super) struct PlannedIterationTarget {
    pub span: SourceSpan,
    pub declared: Vec<SymbolId>,
    pub assigned: Vec<SymbolId>,
    pub has_defaults: bool,
    pub has_rest: bool,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct SpanOwner {
    pub span: SourceSpan,
    pub block: BlockId,
}

pub(super) fn collect(
    program: &Program<'_>,
    function_by_span: &BTreeMap<(u32, u32), FunctionId>,
    scoping: &Scoping,
) -> BTreeMap<FunctionId, FunctionControlFlowPlan> {
    let mut collector = PlanCollector {
        function_by_span,
        scoping,
        plans: BTreeMap::new(),
    };
    collector.visit_program(program);
    collector.plans
}

struct PlanCollector<'facts> {
    function_by_span: &'facts BTreeMap<(u32, u32), FunctionId>,
    scoping: &'facts Scoping,
    plans: BTreeMap<FunctionId, FunctionControlFlowPlan>,
}

impl<'a> Visit<'a> for PlanCollector<'_> {
    fn visit_function(&mut self, function: &Function<'a>, flags: ScopeFlags) {
        if let (Some(body), Some(function_id)) = (
            function.body.as_ref(),
            self.function_by_span
                .get(&(function.span.start, function.span.end))
                .copied(),
        ) {
            let scope = function.scope_id.get().map_or(ScopeId::new(0), |scope| {
                ScopeId::new(count_u32(scope.index()))
            });
            self.plans.insert(
                function_id,
                PlanBuilder::new(scope, source_span(body.span), self.scoping)
                    .build(&body.statements),
            );
        }
        walk_function(self, function, flags);
    }

    fn visit_arrow_function_expression(&mut self, function: &ArrowFunctionExpression<'a>) {
        if let Some(function_id) = self
            .function_by_span
            .get(&(function.span.start, function.span.end))
            .copied()
        {
            let scope = function.scope_id.get().map_or(ScopeId::new(0), |scope| {
                ScopeId::new(count_u32(scope.index()))
            });
            let plan = if let Some(expression) = function.get_expression() {
                PlanBuilder::new(scope, source_span(function.body.span), self.scoping)
                    .build_expression(expression)
            } else {
                PlanBuilder::new(scope, source_span(function.body.span), self.scoping)
                    .build(&function.body.statements)
            };
            self.plans.insert(function_id, plan);
        }
        walk_arrow_function_expression(self, function);
    }
}

struct PlanBuilder<'semantic> {
    blocks: Vec<PlannedBlock>,
    owners: Vec<SpanOwner>,
    control_targets: Vec<ControlTarget>,
    supported: bool,
    has_control_flow: bool,
    function_scope: ScopeId,
    body_span: SourceSpan,
    scoping: &'semantic Scoping,
}

#[derive(Debug, Clone)]
struct ControlTarget {
    label: Option<String>,
    break_target: BlockId,
    continue_target: Option<BlockId>,
}

impl<'semantic> PlanBuilder<'semantic> {
    fn new(function_scope: ScopeId, body_span: SourceSpan, scoping: &'semantic Scoping) -> Self {
        Self {
            blocks: vec![PlannedBlock {
                id: BlockId::new(0),
                scope: function_scope,
                origin: body_span,
                source_kind: None,
                source_exit: None,
                source_origin: None,
                terminator: PlannedTerminator::Unreachable { origin: body_span },
            }],
            owners: Vec::new(),
            control_targets: Vec::new(),
            supported: true,
            has_control_flow: false,
            function_scope,
            body_span,
            scoping,
        }
    }

    fn build(mut self, statements: &[Statement<'_>]) -> FunctionControlFlowPlan {
        let current = self.lower_statement_list(statements, Some(BlockId::new(0)), false);
        if let Some(current) = current {
            self.blocks[current.as_usize()].terminator = PlannedTerminator::Return {
                value: None,
                origin: self.body_span,
            };
        }
        self.finish()
    }

    fn build_expression(mut self, expression: &Expression<'_>) -> FunctionControlFlowPlan {
        let span = source_span(expression.span());
        self.owners.push(SpanOwner {
            span,
            block: BlockId::new(0),
        });
        self.blocks[0].terminator = PlannedTerminator::Return {
            value: Some(span),
            origin: span,
        };
        self.finish()
    }

    fn finish(self) -> FunctionControlFlowPlan {
        FunctionControlFlowPlan {
            blocks: self.blocks,
            owners: self.owners,
            supported: self.supported,
            has_control_flow: self.has_control_flow,
        }
    }

    fn lower_statement_list(
        &mut self,
        statements: &[Statement<'_>],
        mut current: Option<BlockId>,
        unreachable: bool,
    ) -> Option<BlockId> {
        let mut disconnected = unreachable;
        for statement in statements {
            if current.is_none() {
                current = Some(self.new_block(self.function_scope, source_span(statement.span())));
                disconnected = true;
            }
            current = self.lower_statement(statement, current.expect("current block"));
        }
        if disconnected { None } else { current }
    }

    fn lower_statement(&mut self, statement: &Statement<'_>, current: BlockId) -> Option<BlockId> {
        match statement {
            Statement::BlockStatement(block) => self.lower_block(block, current),
            Statement::IfStatement(statement) => self.lower_if(statement, current),
            Statement::DoWhileStatement(statement) => self.lower_do_while(statement, current, None),
            Statement::WhileStatement(statement) => self.lower_while(statement, current, None),
            Statement::ForStatement(statement) => self.lower_for(statement, current, None),
            Statement::ForInStatement(statement) => self.lower_for_in(statement, current, None),
            Statement::ForOfStatement(statement) => self.lower_for_of(statement, current, None),
            Statement::LabeledStatement(statement) => self.lower_labeled(statement, current),
            Statement::BreakStatement(statement) => self.lower_break(statement, current),
            Statement::ContinueStatement(statement) => self.lower_continue(statement, current),
            Statement::ReturnStatement(statement) => {
                let value = statement
                    .argument
                    .as_ref()
                    .map(|value| source_span(value.span()));
                if let Some(value) = value {
                    self.owners.push(SpanOwner {
                        span: value,
                        block: current,
                    });
                }
                self.blocks[current.as_usize()].terminator = PlannedTerminator::Return {
                    value,
                    origin: source_span(statement.span),
                };
                None
            }
            Statement::ThrowStatement(statement) => {
                let value = source_span(statement.argument.span());
                self.owners.push(SpanOwner {
                    span: value,
                    block: current,
                });
                self.blocks[current.as_usize()].terminator = PlannedTerminator::Throw {
                    value,
                    origin: source_span(statement.span),
                };
                None
            }
            Statement::SwitchStatement(_)
            | Statement::TryStatement(_)
            | Statement::WithStatement(_) => {
                self.supported = false;
                self.owners.push(SpanOwner {
                    span: source_span(statement.span()),
                    block: current,
                });
                Some(current)
            }
            _ => {
                self.owners.push(SpanOwner {
                    span: source_span(statement.span()),
                    block: current,
                });
                Some(current)
            }
        }
    }

    fn lower_block(&mut self, block: &BlockStatement<'_>, current: BlockId) -> Option<BlockId> {
        self.lower_statement_list(&block.body, Some(current), false)
    }

    fn lower_if(
        &mut self,
        statement: &oxc::ast::ast::IfStatement<'_>,
        current: BlockId,
    ) -> Option<BlockId> {
        self.has_control_flow = true;
        let origin = source_span(statement.span);
        let test = source_span(statement.test.span());
        self.owners.push(SpanOwner {
            span: test,
            block: current,
        });
        let scope = self.blocks[current.as_usize()].scope;

        let consequent = self.new_block(
            statement_scope(&statement.consequent, scope),
            source_span(statement.consequent.span()),
        );
        let alternate = match &statement.alternate {
            Some(alternate) => self.new_block(
                statement_scope(alternate, scope),
                source_span(alternate.span()),
            ),
            None => self.new_block(scope, origin),
        };
        let join = self.new_block(scope, origin);
        self.blocks[current.as_usize()].source_kind = Some(StructuredSourceKind::Conditional);
        self.blocks[current.as_usize()].source_exit = Some(join);
        self.blocks[current.as_usize()].source_origin = Some(origin);
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Branch {
            test,
            has_effects: expression_has_effects(&statement.test),
            consequent,
            alternate,
            origin,
        };

        if let Some(end) = self.lower_statement(&statement.consequent, consequent) {
            self.blocks[end.as_usize()].terminator = PlannedTerminator::Goto {
                target: join,
                origin: source_span(statement.consequent.span()),
            };
        }
        if let Some(alternate_statement) = &statement.alternate {
            if let Some(end) = self.lower_statement(alternate_statement, alternate) {
                self.blocks[end.as_usize()].terminator = PlannedTerminator::Goto {
                    target: join,
                    origin: source_span(alternate_statement.span()),
                };
            }
        } else {
            self.blocks[alternate.as_usize()].terminator = PlannedTerminator::Goto {
                target: join,
                origin,
            };
        }
        Some(join)
    }

    fn lower_while(
        &mut self,
        statement: &oxc::ast::ast::WhileStatement<'_>,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        self.has_control_flow = true;
        let origin = source_span(statement.span);
        let scope = self.blocks[current.as_usize()].scope;
        let header = self.new_block(scope, origin);
        let body = self.new_block(
            statement_scope(&statement.body, scope),
            source_span(statement.body.span()),
        );
        let exit = self.new_block(scope, origin);
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
            target: header,
            origin,
        };

        let test = source_span(statement.test.span());
        self.owners.push(SpanOwner {
            span: test,
            block: header,
        });
        self.set_loop_hint(header, StructuredSourceKind::WhileLoop, exit, origin);
        self.blocks[header.as_usize()].terminator = PlannedTerminator::Branch {
            test,
            has_effects: expression_has_effects(&statement.test),
            consequent: body,
            alternate: exit,
            origin,
        };

        self.control_targets.push(ControlTarget {
            label,
            break_target: exit,
            continue_target: Some(header),
        });
        let body_end = self.lower_statement(&statement.body, body);
        self.control_targets.pop();
        if let Some(body_end) = body_end {
            self.blocks[body_end.as_usize()].terminator = PlannedTerminator::Goto {
                target: header,
                origin: source_span(statement.body.span()),
            };
        }
        Some(exit)
    }

    fn lower_do_while(
        &mut self,
        statement: &oxc::ast::ast::DoWhileStatement<'_>,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        self.has_control_flow = true;
        let origin = source_span(statement.span);
        let scope = self.blocks[current.as_usize()].scope;
        let header = self.new_block(scope, origin);
        let body = self.new_block(
            statement_scope(&statement.body, scope),
            source_span(statement.body.span()),
        );
        let test_block = self.new_block(scope, source_span(statement.test.span()));
        let exit = self.new_block(scope, origin);
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
            target: header,
            origin,
        };
        self.set_loop_hint(header, StructuredSourceKind::DoWhileLoop, exit, origin);
        self.blocks[header.as_usize()].terminator = PlannedTerminator::Goto {
            target: body,
            origin,
        };

        let test = source_span(statement.test.span());
        self.owners.push(SpanOwner {
            span: test,
            block: test_block,
        });
        self.blocks[test_block.as_usize()].terminator = PlannedTerminator::Branch {
            test,
            has_effects: expression_has_effects(&statement.test),
            consequent: header,
            alternate: exit,
            origin,
        };

        self.control_targets.push(ControlTarget {
            label,
            break_target: exit,
            continue_target: Some(test_block),
        });
        let body_end = self.lower_statement(&statement.body, body);
        self.control_targets.pop();
        if let Some(body_end) = body_end {
            self.blocks[body_end.as_usize()].terminator = PlannedTerminator::Goto {
                target: test_block,
                origin: source_span(statement.body.span()),
            };
        }
        Some(exit)
    }

    fn lower_for(
        &mut self,
        statement: &oxc::ast::ast::ForStatement<'_>,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        self.has_control_flow = true;
        let origin = source_span(statement.span);
        let parent_scope = self.blocks[current.as_usize()].scope;
        let loop_scope = statement
            .scope_id
            .get()
            .map_or(parent_scope, |scope| ScopeId::new(count_u32(scope.index())));
        let preheader = if let Some(initializer) = &statement.init {
            let span = source_span(initializer.span());
            let block = self.new_block(loop_scope, span);
            self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
                target: block,
                origin,
            };
            self.owners.push(SpanOwner { span, block });
            block
        } else {
            current
        };
        let header = self.new_block(loop_scope, origin);
        let body = self.new_block(
            statement_scope(&statement.body, loop_scope),
            source_span(statement.body.span()),
        );
        let update = self.new_block(
            loop_scope,
            statement
                .update
                .as_ref()
                .map_or(origin, |update| source_span(update.span())),
        );
        let exit = self.new_block(parent_scope, origin);
        self.blocks[preheader.as_usize()].terminator = PlannedTerminator::Goto {
            target: header,
            origin,
        };
        self.set_loop_hint(header, StructuredSourceKind::ForLoop, exit, origin);

        if let Some(test_expression) = &statement.test {
            let test = source_span(test_expression.span());
            self.owners.push(SpanOwner {
                span: test,
                block: header,
            });
            self.blocks[header.as_usize()].terminator = PlannedTerminator::Branch {
                test,
                has_effects: expression_has_effects(test_expression),
                consequent: body,
                alternate: exit,
                origin,
            };
        } else {
            self.blocks[header.as_usize()].terminator = PlannedTerminator::Goto {
                target: body,
                origin,
            };
        }
        if let Some(update_expression) = &statement.update {
            self.owners.push(SpanOwner {
                span: source_span(update_expression.span()),
                block: update,
            });
        }
        self.blocks[update.as_usize()].terminator = PlannedTerminator::Goto {
            target: header,
            origin,
        };

        self.control_targets.push(ControlTarget {
            label,
            break_target: exit,
            continue_target: Some(update),
        });
        let body_end = self.lower_statement(&statement.body, body);
        self.control_targets.pop();
        if let Some(body_end) = body_end {
            self.blocks[body_end.as_usize()].terminator = PlannedTerminator::Goto {
                target: update,
                origin: source_span(statement.body.span()),
            };
        }
        Some(exit)
    }

    fn lower_for_in(
        &mut self,
        statement: &oxc::ast::ast::ForInStatement<'_>,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        let parent_scope = self.blocks[current.as_usize()].scope;
        let loop_scope = statement
            .scope_id
            .get()
            .map_or(parent_scope, |scope| ScopeId::new(count_u32(scope.index())));
        self.lower_for_each(
            source_span(statement.span),
            loop_scope,
            &statement.left,
            &statement.right,
            &statement.body,
            IterationKind::In,
            current,
            label,
        )
    }

    fn lower_for_of(
        &mut self,
        statement: &oxc::ast::ast::ForOfStatement<'_>,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        let parent_scope = self.blocks[current.as_usize()].scope;
        let loop_scope = statement
            .scope_id
            .get()
            .map_or(parent_scope, |scope| ScopeId::new(count_u32(scope.index())));
        self.lower_for_each(
            source_span(statement.span),
            loop_scope,
            &statement.left,
            &statement.right,
            &statement.body,
            if statement.r#await {
                IterationKind::AwaitOf
            } else {
                IterationKind::Of
            },
            current,
            label,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn lower_for_each(
        &mut self,
        origin: SourceSpan,
        loop_scope: ScopeId,
        left: &ForStatementLeft<'_>,
        source_expression: &Expression<'_>,
        statement_body: &Statement<'_>,
        kind: IterationKind,
        current: BlockId,
        label: Option<String>,
    ) -> Option<BlockId> {
        self.has_control_flow = true;
        let parent_scope = self.blocks[current.as_usize()].scope;
        let header = self.new_block(loop_scope, origin);
        let body = self.new_block(
            statement_scope(statement_body, loop_scope),
            source_span(statement_body.span()),
        );
        let exit = self.new_block(parent_scope, origin);
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
            target: header,
            origin,
        };

        let source = source_span(source_expression.span());
        self.owners.push(SpanOwner {
            span: source,
            block: current,
        });
        self.owners.push(SpanOwner {
            span: source_span(left.span()),
            block: body,
        });
        let target = planned_iteration_target(left, self.scoping);
        let source_kind = match kind {
            IterationKind::In => StructuredSourceKind::ForInLoop,
            IterationKind::Of => StructuredSourceKind::ForOfLoop,
            IterationKind::AwaitOf => StructuredSourceKind::ForAwaitOfLoop,
        };
        self.set_loop_hint(header, source_kind, exit, origin);
        self.blocks[header.as_usize()].terminator = PlannedTerminator::ForEach {
            kind,
            source,
            source_block: current,
            source_has_effects: expression_has_effects(source_expression),
            target,
            body,
            exit,
            origin,
        };

        self.control_targets.push(ControlTarget {
            label,
            break_target: exit,
            continue_target: Some(header),
        });
        let body_end = self.lower_statement(statement_body, body);
        self.control_targets.pop();
        if let Some(body_end) = body_end {
            self.blocks[body_end.as_usize()].terminator = PlannedTerminator::Goto {
                target: header,
                origin: source_span(statement_body.span()),
            };
        }
        Some(exit)
    }

    fn lower_labeled(
        &mut self,
        statement: &oxc::ast::ast::LabeledStatement<'_>,
        current: BlockId,
    ) -> Option<BlockId> {
        let label = Some(statement.label.name.to_string());
        match &statement.body {
            Statement::WhileStatement(loop_statement) => {
                self.lower_while(loop_statement, current, label)
            }
            Statement::DoWhileStatement(loop_statement) => {
                self.lower_do_while(loop_statement, current, label)
            }
            Statement::ForStatement(loop_statement) => {
                self.lower_for(loop_statement, current, label)
            }
            Statement::ForInStatement(loop_statement) => {
                self.lower_for_in(loop_statement, current, label)
            }
            Statement::ForOfStatement(loop_statement) => {
                self.lower_for_of(loop_statement, current, label)
            }
            _ => {
                self.supported = false;
                self.owners.push(SpanOwner {
                    span: source_span(statement.span),
                    block: current,
                });
                Some(current)
            }
        }
    }

    fn lower_break(
        &mut self,
        statement: &oxc::ast::ast::BreakStatement<'_>,
        current: BlockId,
    ) -> Option<BlockId> {
        let label = statement.label.as_ref().map(|label| label.name.as_str());
        let target = label.map_or_else(
            || {
                self.control_targets
                    .last()
                    .map(|target| target.break_target)
            },
            |label| {
                self.control_targets
                    .iter()
                    .rev()
                    .find(|target| target.label.as_deref() == Some(label))
                    .map(|target| target.break_target)
            },
        );
        let Some(target) = target else {
            self.supported = false;
            return Some(current);
        };
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
            target,
            origin: source_span(statement.span),
        };
        None
    }

    fn lower_continue(
        &mut self,
        statement: &oxc::ast::ast::ContinueStatement<'_>,
        current: BlockId,
    ) -> Option<BlockId> {
        let label = statement.label.as_ref().map(|label| label.name.as_str());
        let target = label.map_or_else(
            || {
                self.control_targets
                    .iter()
                    .rev()
                    .find_map(|target| target.continue_target)
            },
            |label| {
                self.control_targets
                    .iter()
                    .rev()
                    .find(|target| target.label.as_deref() == Some(label))
                    .and_then(|target| target.continue_target)
            },
        );
        let Some(target) = target else {
            self.supported = false;
            return Some(current);
        };
        self.blocks[current.as_usize()].terminator = PlannedTerminator::Goto {
            target,
            origin: source_span(statement.span),
        };
        None
    }

    fn set_loop_hint(
        &mut self,
        header: BlockId,
        kind: StructuredSourceKind,
        exit: BlockId,
        origin: SourceSpan,
    ) {
        self.blocks[header.as_usize()].source_kind = Some(kind);
        self.blocks[header.as_usize()].source_exit = Some(exit);
        self.blocks[header.as_usize()].source_origin = Some(origin);
    }

    fn new_block(&mut self, scope: ScopeId, origin: SourceSpan) -> BlockId {
        let id = BlockId::new(count_u32(self.blocks.len()));
        self.blocks.push(PlannedBlock {
            id,
            scope,
            origin,
            source_kind: None,
            source_exit: None,
            source_origin: None,
            terminator: PlannedTerminator::Unreachable { origin },
        });
        id
    }
}

pub(super) fn planned_iteration_target(
    left: &ForStatementLeft<'_>,
    scoping: &Scoping,
) -> PlannedIterationTarget {
    let span = source_span(left.span());
    if let ForStatementLeft::VariableDeclaration(declaration) = left {
        let mut collector = PatternBindingCollector::default();
        for declarator in &declaration.declarations {
            collector.visit_binding_pattern(&declarator.id);
        }
        return PlannedIterationTarget {
            span,
            declared: collector.symbols,
            assigned: Vec::new(),
            has_defaults: collector.has_defaults,
            has_rest: collector.has_rest,
        };
    }

    let mut collector = IterationAssignmentCollector {
        scoping,
        assigned: Vec::new(),
        has_defaults: false,
        has_rest: false,
    };
    collector.visit_for_statement_left(left);
    PlannedIterationTarget {
        span,
        declared: Vec::new(),
        assigned: collector.assigned,
        has_defaults: collector.has_defaults,
        has_rest: collector.has_rest,
    }
}

struct IterationAssignmentCollector<'semantic> {
    scoping: &'semantic Scoping,
    assigned: Vec<SymbolId>,
    has_defaults: bool,
    has_rest: bool,
}

impl<'a> Visit<'a> for IterationAssignmentCollector<'_> {
    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let Some(reference) = identifier
            .reference_id
            .get()
            .map(|reference| self.scoping.get_reference(reference))
        else {
            return;
        };
        if reference.is_write()
            && let Some(symbol) = reference.symbol_id()
            && !self.assigned.contains(&symbol)
        {
            self.assigned.push(symbol);
        }
    }

    fn visit_assignment_target_with_default(&mut self, target: &AssignmentTargetWithDefault<'a>) {
        self.has_defaults = true;
        walk_assignment_target_with_default(self, target);
    }

    fn visit_assignment_target_rest(&mut self, target: &AssignmentTargetRest<'a>) {
        self.has_rest = true;
        walk_assignment_target_rest(self, target);
    }
}

#[derive(Default)]
struct ExpressionEffectCollector {
    found: bool,
}

impl<'a> Visit<'a> for ExpressionEffectCollector {
    fn visit_function(&mut self, _function: &Function<'a>, _flags: ScopeFlags) {
        // A nested function body is lazy unless a call expression invokes it. The call itself is
        // already an effect boundary for a branch condition.
    }

    fn visit_arrow_function_expression(&mut self, _function: &ArrowFunctionExpression<'a>) {
        // A nested arrow body is lazy for the same reason as a function expression.
    }

    fn visit_assignment_expression(
        &mut self,
        _expression: &oxc::ast::ast::AssignmentExpression<'a>,
    ) {
        self.found = true;
    }

    fn visit_update_expression(&mut self, _expression: &oxc::ast::ast::UpdateExpression<'a>) {
        self.found = true;
    }

    fn visit_call_expression(&mut self, _expression: &oxc::ast::ast::CallExpression<'a>) {
        self.found = true;
    }

    fn visit_new_expression(&mut self, _expression: &oxc::ast::ast::NewExpression<'a>) {
        self.found = true;
    }

    fn visit_import_expression(&mut self, _expression: &oxc::ast::ast::ImportExpression<'a>) {
        self.found = true;
    }

    fn visit_await_expression(&mut self, _expression: &oxc::ast::ast::AwaitExpression<'a>) {
        self.found = true;
    }

    fn visit_yield_expression(&mut self, _expression: &oxc::ast::ast::YieldExpression<'a>) {
        self.found = true;
    }

    fn visit_tagged_template_expression(
        &mut self,
        _expression: &oxc::ast::ast::TaggedTemplateExpression<'a>,
    ) {
        self.found = true;
    }

    fn visit_unary_expression(&mut self, expression: &oxc::ast::ast::UnaryExpression<'a>) {
        if expression.operator == UnaryOperator::Delete {
            self.found = true;
        } else {
            self.visit_expression(&expression.argument);
        }
    }
}

fn expression_has_effects(expression: &Expression<'_>) -> bool {
    let mut collector = ExpressionEffectCollector::default();
    collector.visit_expression(expression);
    collector.found
}

fn statement_scope(statement: &Statement<'_>, fallback: ScopeId) -> ScopeId {
    match statement {
        Statement::BlockStatement(block) => block
            .scope_id
            .get()
            .map_or(fallback, |scope| ScopeId::new(count_u32(scope.index()))),
        _ => fallback,
    }
}

fn contains(container: SourceSpan, candidate: SourceSpan) -> bool {
    container.start() <= candidate.start() && container.end() >= candidate.end()
}

fn count_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
