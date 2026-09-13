//! Dynamic JSX consumers track opaque calls as well as directly visible reactive reads.
//! These are deferred-consumer hints, not accessor rewrites or purity/materialization facts.

use super::{BTreeSet, BindingId, HirFile, HirFunction, HirInstructionKind, ValueId, ValueKind};
use fict_hir::SourceSpan;

#[derive(Debug)]
pub(super) struct JsxGetterFacts {
    pub bindings: BTreeSet<BindingId>,
    pub calls: BTreeSet<SourceSpan>,
}
impl JsxGetterFacts {
    pub fn value_needs_getter(
        &self,
        hir: &HirFile,
        function: &HirFunction,
        value: ValueId,
    ) -> bool {
        let value = &function.values[value.as_usize()];
        let ValueKind::SyntaxFragment(fragment) = value.kind else {
            return false;
        };
        hir.syntax_fragments[fragment.as_usize()]
            .summary
            .referenced_bindings
            .iter()
            .any(|binding| self.bindings.contains(binding))
            || value.origin.primary_span.is_some_and(|span| {
                self.calls
                    .iter()
                    .any(|call| span.start() <= call.start() && call.end() <= span.end())
            })
    }
}

pub(super) fn collect_jsx_getters(hir: &HirFile, bindings: BTreeSet<BindingId>) -> JsxGetterFacts {
    // A call can read through parameters, callbacks, methods or imported closures.
    // Absence of a statically known dependency cannot prove its result is constant.
    // Defer evaluation to the JSX consumer; runtime tracking still respects untrack.
    // Only call sites are marked: passing a callable does not invoke or wrap it.
    let calls = hir
        .functions
        .iter()
        .flat_map(|function| &function.blocks)
        .flat_map(|block| &block.instructions)
        .filter(|instruction| matches!(instruction.kind, HirInstructionKind::Call(_)))
        .filter_map(|instruction| instruction.origin.primary_span)
        .collect();
    JsxGetterFacts { bindings, calls }
}
