use std::collections::BTreeSet;

use fict_diagnostics::{
    Diagnostic, DiagnosticBundle, DiagnosticCode, DiagnosticSeverity, GuaranteeClass,
};

use crate::{
    ArrayElement, BindingKind, BlockId, CallHost, FunctionId, FunctionKind, HirFile, HirFunction,
    HirInstruction, HirInstructionKind, HirTerminator, ImportKind, JsxAttribute, JsxAttributeValue,
    JsxChild, JsxElementName, JsxNode, LiteralValue, LocalId, LocalKind, MutationEffect,
    ObjectEntry, Origin, OriginKind, Place, PlaceBase, Projection, Purity, ScopeKind, SsaName,
    StructuredSourceHint, StructuredSourceKind, SyntaxFragmentKind, TerminatorKind, ValueId,
    ValueKind,
};

const MAX_DIAGNOSTICS: usize = 128;

/// Verify all typed-HIR arena, ownership, reference, and semantic invariants.
///
/// Verification is deterministic and fail-closed. It does not attempt to repair malformed HIR.
pub fn verify_hir(file: &HirFile) -> Result<(), DiagnosticBundle> {
    let mut verifier = Verifier {
        file,
        diagnostics: DiagnosticBundle::default(),
    };
    verifier.verify_file();
    if verifier.diagnostics.is_empty() {
        Ok(())
    } else {
        verifier.diagnostics.sort_deterministically();
        Err(verifier.diagnostics)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DefinitionKind {
    Instruction,
    Literal(LiteralValue),
    Function(FunctionId),
    Ssa(SsaName),
    Syntax(crate::SyntaxFragmentId),
}

struct Verifier<'file> {
    file: &'file HirFile,
    diagnostics: DiagnosticBundle,
}

impl Verifier<'_> {
    fn verify_file(&mut self) {
        if self.file.root_function.as_usize() >= self.file.functions.len() {
            self.error(
                "FICT-HIR-ID",
                format!(
                    "root function fn{} is outside the function arena",
                    self.file.root_function.index()
                ),
                None,
            );
        }

        for (index, scope) in self.file.scopes.iter().enumerate() {
            if scope.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "scope arena index {index} contains scope{}",
                        scope.id.index()
                    ),
                    Some(scope.origin),
                );
            }
            self.verify_origin(scope.origin);
            if let Some(parent) = scope.parent {
                self.scope(parent, scope.origin);
                if parent.index() >= scope.id.index() {
                    self.error(
                        "FICT-HIR-SCOPE",
                        format!(
                            "scope{} parent scope{} must precede its child",
                            scope.id.index(),
                            parent.index()
                        ),
                        Some(scope.origin),
                    );
                }
            } else if scope.kind != ScopeKind::Module {
                self.error(
                    "FICT-HIR-SCOPE",
                    format!("root scope{} must have module kind", scope.id.index()),
                    Some(scope.origin),
                );
            }
        }

        for (index, binding) in self.file.bindings.iter().enumerate() {
            if binding.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "binding arena index {index} contains binding{}",
                        binding.id.index()
                    ),
                    Some(binding.origin),
                );
            }
            self.scope(binding.scope, binding.origin);
            self.verify_origin(binding.origin);
            match (binding.kind, &binding.import) {
                (BindingKind::Import, None) => self.error(
                    "FICT-HIR-BINDING",
                    format!(
                        "import binding{} is missing module identity",
                        binding.id.index()
                    ),
                    Some(binding.origin),
                ),
                (BindingKind::Import, Some(import)) => {
                    if import.source.is_empty() {
                        self.error(
                            "FICT-HIR-BINDING",
                            format!(
                                "import binding{} has an empty source specifier",
                                binding.id.index()
                            ),
                            Some(binding.origin),
                        );
                    }
                    if import.kind == ImportKind::TypeOnly {
                        self.error(
                            "FICT-HIR-BINDING",
                            format!(
                                "type-only import binding{} must not enter runtime HIR",
                                binding.id.index()
                            ),
                            Some(binding.origin),
                        );
                    }
                }
                (_, Some(_)) => self.error(
                    "FICT-HIR-BINDING",
                    format!(
                        "non-import binding{} carries import identity",
                        binding.id.index()
                    ),
                    Some(binding.origin),
                ),
                (_, None) => {}
            }
        }

        for (index, fragment) in self.file.syntax_fragments.iter().enumerate() {
            if fragment.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "syntax fragment arena index {index} contains fragment{}",
                        fragment.id.index()
                    ),
                    Some(fragment.origin),
                );
            }
            self.verify_origin(fragment.origin);
            if fragment.kind == SyntaxFragmentKind::Pattern && fragment.summary.pattern.is_none() {
                self.error(
                    "FICT-HIR-SYNTAX",
                    format!(
                        "pattern fragment{} is missing a pattern summary",
                        fragment.id.index()
                    ),
                    Some(fragment.origin),
                );
            }
            if fragment.kind != SyntaxFragmentKind::Pattern && fragment.summary.pattern.is_some() {
                self.error(
                    "FICT-HIR-SYNTAX",
                    format!(
                        "non-pattern fragment{} carries a pattern summary",
                        fragment.id.index()
                    ),
                    Some(fragment.origin),
                );
            }
            self.verify_binding_list(
                &fragment.summary.referenced_bindings,
                "syntax reference",
                fragment.origin,
            );
            if let Some(pattern) = &fragment.summary.pattern {
                self.verify_binding_list(
                    &pattern.declared_bindings,
                    "pattern declaration",
                    fragment.origin,
                );
                self.verify_binding_list(
                    &pattern.assigned_bindings,
                    "pattern assignment",
                    fragment.origin,
                );
            }
        }

        let mut module_functions = 0_usize;
        for (index, function) in self.file.functions.iter().enumerate() {
            if function.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "function arena index {index} contains fn{}",
                        function.id.index()
                    ),
                    Some(function.origin),
                );
            }
            if function.kind == FunctionKind::Module {
                module_functions += 1;
                if function.id != self.file.root_function {
                    self.error(
                        "FICT-HIR-FUNCTION",
                        format!(
                            "non-root fn{} is classified as a module function",
                            function.id.index()
                        ),
                        Some(function.origin),
                    );
                }
            }
            self.verify_function(function);
        }
        if module_functions != 1 {
            self.error(
                "FICT-HIR-FUNCTION",
                format!("HIR must contain exactly one module function, found {module_functions}"),
                None,
            );
        }

        for (index, template) in self.file.templates.iter().enumerate() {
            if template.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "template arena index {index} contains template{}",
                        template.id.index()
                    ),
                    Some(template.origin),
                );
            }
            self.function(template.owner, template.origin);
            self.verify_origin(template.origin);
            if template.root.contains_fragment() && !template.contains_fragment {
                self.error(
                    "FICT-HIR-JSX-FRAGMENT",
                    format!(
                        "template{} contains a structural fragment but does not declare it",
                        template.id.index()
                    ),
                    Some(template.origin),
                );
            }
            if let Some(owner) = self.file.functions.get(template.owner.as_usize()) {
                self.verify_jsx(&template.root, owner);
            }
        }
    }

    fn verify_function(&mut self, function: &HirFunction) {
        self.verify_origin(function.origin);
        self.scope(function.scope, function.origin);
        if let Some(binding) = function.binding {
            self.binding(binding, function.origin);
        }
        if function.kind == FunctionKind::Module
            && let Some(scope) = self.file.scopes.get(function.scope.as_usize())
            && scope.kind != ScopeKind::Module
        {
            self.error(
                "FICT-HIR-FUNCTION",
                format!("module fn{} must use a module scope", function.id.index()),
                Some(function.origin),
            );
        }

        for (index, local) in function.locals.iter().enumerate() {
            if local.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "fn{} local arena index {index} contains local{}",
                        function.id.index(),
                        local.id.index()
                    ),
                    Some(local.origin),
                );
            }
            self.scope(local.scope, local.origin);
            if let Some(binding) = local.binding {
                self.binding(binding, local.origin);
            }
            self.verify_origin(local.origin);
        }

        let mut parameter_locals = BTreeSet::new();
        for parameter in &function.parameters {
            self.local(function, parameter.local, parameter.origin);
            self.fragment(parameter.pattern, parameter.origin);
            if let Some(binding) = parameter.binding {
                self.binding(binding, parameter.origin);
            }
            if let Some(default_value) = parameter.default_value {
                self.verify_origin(default_value);
            }
            if let Some(properties) = &parameter.object_properties {
                let mut bindings = BTreeSet::new();
                for property in properties {
                    self.binding(property.binding, property.origin);
                    self.verify_origin(property.origin);
                    for reference in &property.references {
                        self.verify_origin(*reference);
                    }
                    for check in &property.checks {
                        self.verify_origin(check.origin);
                    }
                    if let Some(default_value) = property.default_value {
                        self.verify_origin(default_value);
                    }
                    if (property.mode == crate::HirObjectParameterMode::Value
                        && (!property.references.is_empty() || property.default_value.is_some()))
                        || (property.mode == crate::HirObjectParameterMode::Mutable
                            && !property.references.is_empty())
                    {
                        self.error(
                            "FICT-HIR-PROPS-MODE",
                            "plain value props cannot carry accessor rewrites or defaults, and mutable props cannot carry accessor rewrites",
                            Some(property.origin),
                        );
                    }
                    let checks_are_ordered_prefixes =
                        property
                            .checks
                            .iter()
                            .try_fold(0, |previous_length, check| {
                                (check.path.len() > previous_length
                                    && check.path.len() < property.path.len()
                                    && property.path.starts_with(&check.path))
                                .then_some(check.path.len())
                            });
                    if property.path.is_empty()
                        || property.path.iter().any(String::is_empty)
                        || property.checks.iter().any(|check| {
                            check.path.is_empty() || check.path.iter().any(String::is_empty)
                        })
                        || checks_are_ordered_prefixes.is_none()
                        || !bindings.insert(property.binding)
                    {
                        self.error(
                            "FICT-HIR-PROPS",
                            "modeled object parameters require ordered prefix checks, non-empty paths, and unique bindings",
                            Some(property.origin),
                        );
                    }
                }
            }
            if let Some(rest) = &parameter.object_rest {
                self.binding(rest.binding, rest.origin);
                self.verify_origin(rest.origin);
                if parameter.object_properties.is_none()
                    || rest.excluded.iter().any(String::is_empty)
                    || parameter
                        .object_properties
                        .as_ref()
                        .is_some_and(|properties| {
                            properties
                                .iter()
                                .any(|property| property.binding == rest.binding)
                        })
                {
                    self.error(
                        "FICT-HIR-PROPS-REST",
                        "modeled props rest requires non-empty excluded keys and a distinct binding",
                        Some(rest.origin),
                    );
                }
            }
            self.verify_origin(parameter.origin);
            if !parameter_locals.insert(parameter.local) {
                self.error(
                    "FICT-HIR-FUNCTION",
                    format!(
                        "fn{} repeats parameter local{}",
                        function.id.index(),
                        parameter.local.index()
                    ),
                    Some(parameter.origin),
                );
            }
            if let Some(local) = function.locals.get(parameter.local.as_usize())
                && (local.kind != LocalKind::Parameter || local.binding != parameter.binding)
            {
                self.error(
                    "FICT-HIR-FUNCTION",
                    format!(
                        "fn{} parameter local{} disagrees with its local arena entry",
                        function.id.index(),
                        parameter.local.index()
                    ),
                    Some(parameter.origin),
                );
            }
            if let Some(fragment) = self.file.syntax_fragments.get(parameter.pattern.as_usize())
                && fragment.kind != SyntaxFragmentKind::Pattern
            {
                self.error(
                    "FICT-HIR-FUNCTION",
                    format!(
                        "fn{} parameter local{} does not reference a pattern fragment",
                        function.id.index(),
                        parameter.local.index()
                    ),
                    Some(parameter.origin),
                );
            }
        }

        for (index, value) in function.values.iter().enumerate() {
            if value.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "fn{} value arena index {index} contains value{}",
                        function.id.index(),
                        value.id.index()
                    ),
                    Some(value.origin),
                );
            }
            self.verify_origin(value.origin);
            match value.kind {
                ValueKind::Parameter(local) => {
                    self.local(function, local, value.origin);
                    if !parameter_locals.contains(&local) {
                        self.error(
                            "FICT-HIR-VALUE",
                            format!(
                                "fn{} value{} references non-parameter local{}",
                                function.id.index(),
                                value.id.index(),
                                local.index()
                            ),
                            Some(value.origin),
                        );
                    }
                }
                ValueKind::Ssa(name) => self.local(function, name.local, value.origin),
                ValueKind::Function(nested) => self.function(nested, value.origin),
                ValueKind::SyntaxFragment(fragment) => self.fragment(fragment, value.origin),
                ValueKind::InstructionResult | ValueKind::Literal(_) => {}
            }
        }

        if function.blocks.is_empty() {
            self.error(
                "FICT-HIR-CFG",
                format!("fn{} has no basic blocks", function.id.index()),
                Some(function.origin),
            );
        }
        self.block(function, function.entry, function.origin);

        let mut definitions: Vec<Option<DefinitionKind>> = vec![None; function.values.len()];
        for (index, block) in function.blocks.iter().enumerate() {
            if block.id.as_usize() != index {
                self.error(
                    "FICT-HIR-ID",
                    format!(
                        "fn{} block arena index {index} contains block{}",
                        function.id.index(),
                        block.id.index()
                    ),
                    Some(block.origin),
                );
            }
            self.scope(block.scope, block.origin);
            self.verify_origin(block.origin);
            if let Some(hint) = &block.source_hint {
                self.verify_source_hint(function, hint);
            }
            for instruction in &block.instructions {
                self.verify_instruction(function, instruction, &mut definitions);
            }
            self.verify_terminator(function, &block.terminator);
        }

        for value in &function.values {
            let actual = definitions
                .get(value.id.as_usize())
                .and_then(Option::as_ref);
            match (&value.kind, actual) {
                (ValueKind::Parameter(_), None) => {}
                (ValueKind::Parameter(_), Some(_)) => self.error(
                    "FICT-HIR-VALUE",
                    format!(
                        "fn{} parameter value{} is also defined by an instruction",
                        function.id.index(),
                        value.id.index()
                    ),
                    Some(value.origin),
                ),
                (ValueKind::InstructionResult, Some(DefinitionKind::Instruction))
                | (ValueKind::Literal(_), Some(DefinitionKind::Literal(_)))
                | (ValueKind::Function(_), Some(DefinitionKind::Function(_)))
                | (ValueKind::Ssa(_), Some(DefinitionKind::Ssa(_)))
                | (ValueKind::SyntaxFragment(_), Some(DefinitionKind::Syntax(_))) => {
                    if !definition_matches(&value.kind, actual.expect("matched Some")) {
                        self.value_definition_mismatch(function, value.id, value.origin);
                    }
                }
                (_, _) => self.value_definition_mismatch(function, value.id, value.origin),
            }
        }

        let mut previous_region = None;
        for region in &function.regions {
            if previous_region.is_some_and(|previous| previous >= *region) {
                self.error(
                    "FICT-HIR-REGION",
                    format!(
                        "fn{} region IDs must be strictly increasing and unique",
                        function.id.index()
                    ),
                    Some(function.origin),
                );
                break;
            }
            previous_region = Some(*region);
        }
    }

    fn verify_instruction(
        &mut self,
        function: &HirFunction,
        instruction: &HirInstruction,
        definitions: &mut [Option<DefinitionKind>],
    ) {
        self.verify_origin(instruction.origin);
        if instruction.semantics.purity == Purity::Pure
            && instruction.semantics.mutation != MutationEffect::None
        {
            self.error(
                "FICT-HIR-EFFECT",
                "a pure instruction cannot carry a mutation effect",
                Some(instruction.origin),
            );
        }

        if let Some(result) = instruction.result {
            self.value(function, result, instruction.origin);
            let expected = match &instruction.kind {
                HirInstructionKind::Literal(literal) => DefinitionKind::Literal(literal.clone()),
                HirInstructionKind::Function { function } => DefinitionKind::Function(*function),
                HirInstructionKind::Phi { target, .. } => DefinitionKind::Ssa(*target),
                HirInstructionKind::SyntaxFragment { fragment, .. } => {
                    DefinitionKind::Syntax(*fragment)
                }
                _ => DefinitionKind::Instruction,
            };
            if let Some(slot) = definitions.get_mut(result.as_usize())
                && slot.replace(expected).is_some()
            {
                self.error(
                    "FICT-HIR-VALUE",
                    format!(
                        "fn{} value{} has more than one instruction definition",
                        function.id.index(),
                        result.index()
                    ),
                    Some(instruction.origin),
                );
            }
        }

        match &instruction.kind {
            HirInstructionKind::Declare {
                local, initializer, ..
            } => {
                self.local(function, *local, instruction.origin);
                self.optional_value(function, *initializer, instruction.origin);
            }
            HirInstructionKind::Read { place } => {
                self.verify_place(function, place, instruction.origin);
            }
            HirInstructionKind::Write { place, value } => {
                self.verify_place(function, place, instruction.origin);
                self.value(function, *value, instruction.origin);
                self.require_mutation(instruction, "write");
            }
            HirInstructionKind::ReadWrite {
                place,
                compound,
                value,
                update,
                prefix,
            } => {
                self.verify_place(function, place, instruction.origin);
                self.optional_value(function, *value, instruction.origin);
                self.require_mutation(instruction, "read-write");
                let valid = matches!(
                    (compound, value, update),
                    (Some(_), Some(_), None) | (None, None, Some(_))
                );
                if !valid || (*prefix && update.is_none()) {
                    self.error(
                        "FICT-HIR-INSTRUCTION",
                        "read-write instruction must be exactly one compound assignment or update",
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Iteration {
                kind,
                source,
                pattern,
                targets,
            } => {
                self.value(function, *source, instruction.origin);
                self.fragment(*pattern, instruction.origin);
                if let Some(fragment) = self.file.syntax_fragments.get(pattern.as_usize())
                    && fragment.kind != SyntaxFragmentKind::Pattern
                {
                    self.error(
                        "FICT-HIR-INSTRUCTION",
                        "iteration instruction must reference a pattern fragment",
                        Some(instruction.origin),
                    );
                }
                let mut unique = std::collections::BTreeSet::new();
                for target in targets {
                    self.local(function, *target, instruction.origin);
                    if !unique.insert(*target) {
                        self.error(
                            "FICT-HIR-INSTRUCTION",
                            "iteration instruction repeats a direct local target",
                            Some(instruction.origin),
                        );
                    }
                }
                self.require_mutation(instruction, "iteration");
                if *kind == crate::IterationKind::AwaitOf
                    && !function.flags.is_async
                    && function.kind != FunctionKind::Module
                {
                    self.error(
                        "FICT-HIR-FUNCTION",
                        format!("non-async fn{} contains for-await-of", function.id.index()),
                        Some(instruction.origin),
                    );
                }
                if instruction.result.is_some() {
                    self.error(
                        "FICT-HIR-INSTRUCTION",
                        "iteration target assignment cannot define a value result",
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Literal(_) | HirInstructionKind::Debugger => {}
            HirInstructionKind::Unary { argument, .. } => {
                self.value(function, *argument, instruction.origin);
            }
            HirInstructionKind::Binary { left, right, .. } => {
                self.value(function, *left, instruction.origin);
                self.value(function, *right, instruction.origin);
            }
            HirInstructionKind::Conditional {
                test,
                consequent,
                alternate,
            } => {
                self.value(function, *test, instruction.origin);
                self.value(function, *consequent, instruction.origin);
                self.value(function, *alternate, instruction.origin);
            }
            HirInstructionKind::Sequence { values } => {
                for value in values {
                    self.value(function, *value, instruction.origin);
                }
                if values.len() < 2 {
                    self.error(
                        "FICT-HIR-SEQUENCE",
                        "a sequence expression must contain at least two values",
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::TemplateLiteral {
                quasis,
                expressions,
            } => {
                for expression in expressions {
                    self.value(function, *expression, instruction.origin);
                }
                if quasis.len() != expressions.len().saturating_add(1) {
                    self.error(
                        "FICT-HIR-TEMPLATE",
                        "an untagged template must contain exactly one more quasi than expression",
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::TaggedTemplate {
                tag,
                quasis,
                substitutions,
                host,
            } => {
                self.value(function, *tag, instruction.origin);
                for substitution in substitutions {
                    self.value(function, *substitution, instruction.origin);
                }
                if quasis.len() != substitutions.len().saturating_add(1) {
                    self.error(
                        "FICT-HIR-TAGGED-TEMPLATE",
                        "a tagged template must contain exactly one more quasi than substitution",
                        Some(instruction.origin),
                    );
                }
                match host {
                    CallHost::Binding(binding) => self.binding(*binding, instruction.origin),
                    CallHost::Function(nested) => self.function(*nested, instruction.origin),
                    CallHost::ReactiveScope(host) => {
                        self.binding(host.callee, instruction.origin);
                    }
                    CallHost::Unknown => {}
                }
            }
            HirInstructionKind::Call(call) => {
                self.value(function, call.callee, instruction.origin);
                for argument in &call.arguments {
                    self.value(function, argument.value, instruction.origin);
                }
                if call.macro_kind.is_some() && call.reactive_kind.is_some() {
                    self.error(
                        "FICT-HIR-CALL-KIND",
                        "a call cannot be both a compiler macro and a runtime reactive creator",
                        Some(instruction.origin),
                    );
                }
                if call.reactive_kind.is_some() && !matches!(call.host, CallHost::Binding(_)) {
                    self.error(
                        "FICT-HIR-CALL-KIND",
                        "runtime reactive creators must retain their resolved import binding",
                        Some(instruction.origin),
                    );
                }
                match call.host {
                    CallHost::Binding(binding) => self.binding(binding, instruction.origin),
                    CallHost::Function(nested) => self.function(nested, instruction.origin),
                    CallHost::ReactiveScope(host) => self.binding(host.callee, instruction.origin),
                    CallHost::Unknown => {}
                }
            }
            HirInstructionKind::New { callee, arguments } => {
                self.value(function, *callee, instruction.origin);
                for argument in arguments {
                    self.value(function, argument.value, instruction.origin);
                }
            }
            HirInstructionKind::Array { elements } => {
                for element in elements {
                    match element {
                        ArrayElement::Hole(origin) => self.verify_origin(*origin),
                        ArrayElement::Value(value) => {
                            self.value(function, *value, instruction.origin);
                        }
                        ArrayElement::Spread { value, origin } => {
                            self.value(function, *value, *origin);
                            self.verify_origin(*origin);
                        }
                    }
                }
            }
            HirInstructionKind::Object { entries } => {
                let mut prototype_setters = 0_u32;
                for entry in entries {
                    match entry {
                        ObjectEntry::Property {
                            key,
                            value,
                            kind,
                            shorthand,
                            prototype_setter,
                            origin,
                        } => {
                            if let crate::PropertyKey::Computed(key) = key {
                                self.value(function, *key, *origin);
                            }
                            self.value(function, *value, *origin);
                            self.verify_origin(*origin);
                            let must_set_prototype = *kind == crate::ObjectPropertyKind::Init
                                && !*shorthand
                                && matches!(
                                    key,
                                    crate::PropertyKey::Static(name) if name == "__proto__"
                                );
                            if *prototype_setter {
                                prototype_setters = prototype_setters.saturating_add(1);
                            }
                            if *prototype_setter != must_set_prototype {
                                self.error(
                                    "FICT-HIR-OBJECT",
                                    "a non-shorthand static __proto__ initializer must be marked as the object prototype setter",
                                    Some(*origin),
                                );
                            }
                        }
                        ObjectEntry::Spread { value, origin } => {
                            self.value(function, *value, *origin);
                            self.verify_origin(*origin);
                        }
                    }
                }
                if prototype_setters > 1 {
                    self.error(
                        "FICT-HIR-OBJECT",
                        "an object literal cannot contain multiple __proto__ prototype setters",
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Function { function: nested } => {
                self.function(*nested, instruction.origin);
            }
            HirInstructionKind::Jsx { template } => {
                self.template(*template, instruction.origin);
                if let Some(template) = self.file.templates.get(template.as_usize())
                    && template.owner != function.id
                {
                    self.error(
                        "FICT-HIR-JSX",
                        format!(
                            "fn{} references template{} owned by fn{}",
                            function.id.index(),
                            template.id.index(),
                            template.owner.index()
                        ),
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Await { value } => {
                self.value(function, *value, instruction.origin);
                if !function.flags.is_async && function.kind != FunctionKind::Module {
                    self.error(
                        "FICT-HIR-FUNCTION",
                        format!("non-async fn{} contains await", function.id.index()),
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Yield { value, .. } => {
                self.optional_value(function, *value, instruction.origin);
                if !function.flags.is_generator {
                    self.error(
                        "FICT-HIR-FUNCTION",
                        format!("non-generator fn{} contains yield", function.id.index()),
                        Some(instruction.origin),
                    );
                }
            }
            HirInstructionKind::Phi { target, sources } => {
                self.local(function, target.local, instruction.origin);
                for (block, source) in sources {
                    self.block(function, *block, instruction.origin);
                    self.local(function, source.local, instruction.origin);
                    if source.local != target.local {
                        self.error(
                            "FICT-HIR-SSA",
                            format!(
                                "phi for local{} has source local{}",
                                target.local.index(),
                                source.local.index()
                            ),
                            Some(instruction.origin),
                        );
                    }
                }
            }
            HirInstructionKind::SyntaxFragment { fragment, inputs } => {
                self.fragment(*fragment, instruction.origin);
                for input in inputs {
                    self.value(function, *input, instruction.origin);
                }
            }
        }
    }

    fn verify_terminator(&mut self, function: &HirFunction, terminator: &HirTerminator) {
        self.verify_origin(terminator.origin);
        match &terminator.kind {
            TerminatorKind::Return { value } => {
                self.optional_value(function, *value, terminator.origin);
            }
            TerminatorKind::Throw { value } => {
                self.value(function, *value, terminator.origin);
            }
            TerminatorKind::Goto { target } => {
                self.block(function, *target, terminator.origin);
            }
            TerminatorKind::Branch {
                test,
                consequent,
                alternate,
            } => {
                self.value(function, *test, terminator.origin);
                self.block(function, *consequent, terminator.origin);
                self.block(function, *alternate, terminator.origin);
            }
            TerminatorKind::ForIn { object, body, exit } => {
                self.value(function, *object, terminator.origin);
                self.block(function, *body, terminator.origin);
                self.block(function, *exit, terminator.origin);
                if body == exit {
                    self.error(
                        "FICT-HIR-CFG",
                        "for-in body and exit targets must be distinct",
                        Some(terminator.origin),
                    );
                }
            }
            TerminatorKind::ForOf {
                iterable,
                r#await,
                body,
                exit,
            } => {
                self.value(function, *iterable, terminator.origin);
                self.block(function, *body, terminator.origin);
                self.block(function, *exit, terminator.origin);
                if body == exit {
                    self.error(
                        "FICT-HIR-CFG",
                        "for-of body and exit targets must be distinct",
                        Some(terminator.origin),
                    );
                }
                if *r#await && !function.flags.is_async && function.kind != FunctionKind::Module {
                    self.error(
                        "FICT-HIR-FUNCTION",
                        format!("non-async fn{} contains for-await-of", function.id.index()),
                        Some(terminator.origin),
                    );
                }
            }
            TerminatorKind::Switch {
                discriminant,
                cases,
            } => {
                self.value(function, *discriminant, terminator.origin);
                let mut defaults = 0_u32;
                for case in cases {
                    self.optional_value(function, case.test, case.origin);
                    self.block(function, case.target, case.origin);
                    self.verify_origin(case.origin);
                    defaults += u32::from(case.test.is_none());
                }
                if defaults > 1 {
                    self.error(
                        "FICT-HIR-CFG",
                        "switch terminator has more than one default case",
                        Some(terminator.origin),
                    );
                }
            }
            TerminatorKind::Try {
                body,
                catch,
                finally,
                continuation,
            } => {
                self.block(function, *body, terminator.origin);
                self.optional_block(function, *catch, terminator.origin);
                self.optional_block(function, *finally, terminator.origin);
                self.block(function, *continuation, terminator.origin);
                if catch.is_none() && finally.is_none() {
                    self.error(
                        "FICT-HIR-CFG",
                        "try terminator must have a catch or finally target",
                        Some(terminator.origin),
                    );
                }
                let targets = std::iter::once(*body)
                    .chain(*catch)
                    .chain(*finally)
                    .chain(std::iter::once(*continuation));
                let mut unique = BTreeSet::new();
                if targets.into_iter().any(|target| !unique.insert(target)) {
                    self.error(
                        "FICT-HIR-CFG",
                        "try body, catch, finally, and continuation targets must be distinct",
                        Some(terminator.origin),
                    );
                }
            }
            TerminatorKind::Unreachable => {}
        }
    }

    fn verify_source_hint(&mut self, function: &HirFunction, hint: &StructuredSourceHint) {
        self.verify_origin(hint.origin);
        self.optional_block(function, hint.exit, hint.origin);
        if matches!(&hint.kind, StructuredSourceKind::Switch) {
            if hint.exit.is_none() {
                self.error(
                    "FICT-HIR-SOURCE-HINT",
                    "switch source hint requires a normal exit block",
                    Some(hint.origin),
                );
            }
            let mut tests = BTreeSet::new();
            let mut bodies = BTreeSet::new();
            let mut defaults = 0_u32;
            for case in &hint.switch_cases {
                self.optional_block(function, case.test, case.origin);
                self.block(function, case.body, case.origin);
                self.verify_origin(case.origin);
                defaults = defaults.saturating_add(u32::from(case.test.is_none()));
                if case.test.is_some_and(|test| !tests.insert(test)) {
                    self.error(
                        "FICT-HIR-SOURCE-HINT",
                        "switch source clauses require distinct test blocks",
                        Some(case.origin),
                    );
                }
                if !bodies.insert(case.body) {
                    self.error(
                        "FICT-HIR-SOURCE-HINT",
                        "switch source clauses require distinct body blocks",
                        Some(case.origin),
                    );
                }
            }
            if !tests.is_disjoint(&bodies) {
                self.error(
                    "FICT-HIR-SOURCE-HINT",
                    "switch source test and body blocks must be disjoint",
                    Some(hint.origin),
                );
            }
            if defaults > 1 {
                self.error(
                    "FICT-HIR-SOURCE-HINT",
                    "switch source hint has more than one default clause",
                    Some(hint.origin),
                );
            }
        } else if !hint.switch_cases.is_empty() {
            self.error(
                "FICT-HIR-SOURCE-HINT",
                "only switch source hints may retain switch clauses",
                Some(hint.origin),
            );
        }
    }

    fn verify_place(&mut self, function: &HirFunction, place: &Place, origin: Origin) {
        match place.base {
            PlaceBase::Local(local) => self.local(function, local, origin),
            PlaceBase::Ssa(name) => self.local(function, name.local, origin),
            PlaceBase::Value(value) => self.value(function, value, origin),
        }
        for projection in &place.projections {
            if let Projection::ComputedProperty { key, .. } = projection {
                self.value(function, *key, origin);
            }
        }
    }

    fn verify_jsx(&mut self, root: &JsxNode, owner: &HirFunction) {
        enum Item<'a> {
            Node(&'a JsxNode),
            Child(&'a JsxChild),
        }

        let mut stack = vec![Item::Node(root)];
        while let Some(item) = stack.pop() {
            match item {
                Item::Node(JsxNode::Element(element)) => {
                    self.verify_origin(element.origin);
                    match element.name {
                        JsxElementName::Component(binding) => {
                            self.binding(binding, element.origin);
                        }
                        JsxElementName::Member { root, .. } => {
                            self.binding(root, element.origin);
                        }
                        JsxElementName::Dynamic(value) => {
                            self.value(owner, value, element.origin);
                        }
                        JsxElementName::Intrinsic(_) => {}
                    }
                    for attribute in element.attributes.iter().rev() {
                        match attribute {
                            JsxAttribute::Named { value, origin, .. } => {
                                self.verify_origin(*origin);
                                match value {
                                    JsxAttributeValue::Expression { value, .. } => {
                                        self.value(owner, *value, *origin);
                                    }
                                    JsxAttributeValue::Node(node) => {
                                        stack.push(Item::Node(node));
                                    }
                                    JsxAttributeValue::ImplicitTrue
                                    | JsxAttributeValue::Text(_) => {}
                                }
                            }
                            JsxAttribute::Spread { value, origin, .. } => {
                                self.value(owner, *value, *origin);
                                self.verify_origin(*origin);
                            }
                        }
                    }
                    for child in element.children.iter().rev() {
                        stack.push(Item::Child(child));
                    }
                }
                Item::Node(JsxNode::Fragment { children, origin }) => {
                    self.verify_origin(*origin);
                    for child in children.iter().rev() {
                        stack.push(Item::Child(child));
                    }
                }
                Item::Child(JsxChild::Text { origin, .. }) => self.verify_origin(*origin),
                Item::Child(JsxChild::Expression {
                    value,
                    list,
                    origin,
                    ..
                }) => {
                    self.value(owner, *value, *origin);
                    self.verify_origin(*origin);
                    if let Some(list) = list {
                        self.verify_origin(list.items);
                        if list.key.is_some() != list.key_source.is_some()
                            || list.key_alias_initializer.is_some() && list.key.is_none()
                        {
                            self.error(
                                "FICT-HIR-JSX-LIST",
                                "JSX list keys and key sources must both be present or absent, and aliases require an explicit key",
                                Some(*origin),
                            );
                        }
                        if let Some(key) = list.key {
                            self.verify_origin(key);
                        }
                        if let Some(key_source) = list.key_source {
                            self.verify_origin(key_source);
                        }
                        if let Some(initializer) = list.key_alias_initializer {
                            self.verify_origin(initializer);
                        }
                        self.function(list.callback, *origin);
                        match list.receiver {
                            crate::JsxListReceiver::ArrayLiteral => {}
                            crate::JsxListReceiver::Binding { root, .. } => {
                                self.binding(root, *origin);
                            }
                        }
                        for reference in list.item_references.iter().chain(&list.index_references) {
                            self.verify_origin(*reference);
                        }
                    }
                }
                Item::Child(JsxChild::Spread { value, origin }) => {
                    self.value(owner, *value, *origin);
                    self.verify_origin(*origin);
                }
                Item::Child(JsxChild::Node(node)) => stack.push(Item::Node(node)),
            }
        }
    }

    fn verify_binding_list(&mut self, bindings: &[crate::BindingId], role: &str, origin: Origin) {
        let mut seen = BTreeSet::new();
        for binding in bindings {
            self.binding(*binding, origin);
            if !seen.insert(*binding) {
                self.error(
                    "FICT-HIR-SYNTAX",
                    format!("{role} list repeats binding{}", binding.index()),
                    Some(origin),
                );
            }
        }
    }

    fn verify_origin(&mut self, origin: Origin) {
        match (origin.kind, origin.primary_span) {
            (OriginKind::Source | OriginKind::Desugared(_), None) => self.error(
                "FICT-HIR-SPAN",
                "source or desugared origin is missing its primary span",
                None,
            ),
            (_, Some(span)) if span.end() > self.file.source_len => self.error(
                "FICT-HIR-SPAN",
                format!(
                    "source span {}..{} exceeds file length {}",
                    span.start(),
                    span.end(),
                    self.file.source_len
                ),
                Some(origin),
            ),
            _ => {}
        }
    }

    fn require_mutation(&mut self, instruction: &HirInstruction, operation: &str) {
        if instruction.semantics.mutation == MutationEffect::None {
            self.error(
                "FICT-HIR-EFFECT",
                format!("{operation} instruction must carry a mutation effect"),
                Some(instruction.origin),
            );
        }
    }

    fn value_definition_mismatch(
        &mut self,
        function: &HirFunction,
        value: ValueId,
        origin: Origin,
    ) {
        self.error(
            "FICT-HIR-VALUE",
            format!(
                "fn{} value{} does not match exactly one compatible definition",
                function.id.index(),
                value.index()
            ),
            Some(origin),
        );
    }

    fn scope(&mut self, scope: crate::ScopeId, origin: Origin) {
        if scope.as_usize() >= self.file.scopes.len() {
            self.error(
                "FICT-HIR-REF",
                format!("scope{} is outside the scope arena", scope.index()),
                Some(origin),
            );
        }
    }

    fn binding(&mut self, binding: crate::BindingId, origin: Origin) {
        if binding.as_usize() >= self.file.bindings.len() {
            self.error(
                "FICT-HIR-REF",
                format!("binding{} is outside the binding arena", binding.index()),
                Some(origin),
            );
        }
    }

    fn function(&mut self, function: FunctionId, origin: Origin) {
        if function.as_usize() >= self.file.functions.len() {
            self.error(
                "FICT-HIR-REF",
                format!("fn{} is outside the function arena", function.index()),
                Some(origin),
            );
        }
    }

    fn fragment(&mut self, fragment: crate::SyntaxFragmentId, origin: Origin) {
        if fragment.as_usize() >= self.file.syntax_fragments.len() {
            self.error(
                "FICT-HIR-REF",
                format!(
                    "fragment{} is outside the syntax fragment arena",
                    fragment.index()
                ),
                Some(origin),
            );
        }
    }

    fn template(&mut self, template: crate::TemplateId, origin: Origin) {
        if template.as_usize() >= self.file.templates.len() {
            self.error(
                "FICT-HIR-REF",
                format!("template{} is outside the template arena", template.index()),
                Some(origin),
            );
        }
    }

    fn local(&mut self, function: &HirFunction, local: LocalId, origin: Origin) {
        if local.as_usize() >= function.locals.len() {
            self.error(
                "FICT-HIR-REF",
                format!(
                    "fn{} local{} is outside the local arena",
                    function.id.index(),
                    local.index()
                ),
                Some(origin),
            );
        }
    }

    fn value(&mut self, function: &HirFunction, value: ValueId, origin: Origin) {
        if value.as_usize() >= function.values.len() {
            self.error(
                "FICT-HIR-REF",
                format!(
                    "fn{} value{} is outside the value arena",
                    function.id.index(),
                    value.index()
                ),
                Some(origin),
            );
        }
    }

    fn optional_value(&mut self, function: &HirFunction, value: Option<ValueId>, origin: Origin) {
        if let Some(value) = value {
            self.value(function, value, origin);
        }
    }

    fn block(&mut self, function: &HirFunction, block: BlockId, origin: Origin) {
        if block.as_usize() >= function.blocks.len() {
            self.error(
                "FICT-HIR-REF",
                format!(
                    "fn{} block{} is outside the block arena",
                    function.id.index(),
                    block.index()
                ),
                Some(origin),
            );
        }
    }

    fn optional_block(&mut self, function: &HirFunction, block: Option<BlockId>, origin: Origin) {
        if let Some(block) = block {
            self.block(function, block, origin);
        }
    }

    fn error(&mut self, code: &str, message: impl Into<String>, origin: Option<Origin>) {
        if self.diagnostics.as_slice().len() >= MAX_DIAGNOSTICS {
            return;
        }
        let mut diagnostic = Diagnostic::new(
            DiagnosticCode::new(code).expect("HIR verifier diagnostic code must be valid"),
            DiagnosticSeverity::Error,
            message,
        )
        .with_guarantee_class(GuaranteeClass::Internal);
        if let Some(span) = origin.and_then(|item| item.primary_span) {
            diagnostic = diagnostic.with_primary_span(span);
        }
        self.diagnostics.push(diagnostic);
    }
}

fn definition_matches(value: &ValueKind, definition: &DefinitionKind) -> bool {
    match (value, definition) {
        (ValueKind::InstructionResult, DefinitionKind::Instruction) => true,
        (ValueKind::Literal(left), DefinitionKind::Literal(right)) => left == right,
        (ValueKind::Function(left), DefinitionKind::Function(right)) => left == right,
        (ValueKind::Ssa(left), DefinitionKind::Ssa(right)) => left == right,
        (ValueKind::SyntaxFragment(left), DefinitionKind::Syntax(right)) => left == right,
        _ => false,
    }
}
