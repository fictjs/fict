use fict_diagnostics::{Diagnostic, GuaranteeClass};
use fict_emit::{EmitOperation, EmitProgram, PropsOperation};

use super::{emit_error, is_scoped_helper};

pub(super) fn unsupported_operations(emit: &EmitProgram) -> Vec<Diagnostic> {
    let unsupported_scoped_helper = emit.functions.iter().find(|function| {
        function.context.is_none()
            && function
                .operations
                .iter()
                .filter_map(EmitOperation::helper)
                .any(is_scoped_helper)
    });
    if let Some(function) = unsupported_scoped_helper {
        let mut diagnostic = emit_error(
            "FICT-OXC-EMIT-CONTEXT",
            "component and hook runtime helpers require a function context plan",
            GuaranteeClass::Unsupported,
        );
        diagnostic.primary_span = function.operations.iter().find_map(|operation| {
            operation
                .helper()
                .filter(|helper| is_scoped_helper(*helper))
                .and(operation_origin(operation).primary_span)
        });
        return vec![diagnostic];
    }
    let unsupported = emit
        .functions
        .iter()
        .flat_map(|function| &function.operations)
        .find(|operation| match operation {
            EmitOperation::WriteReactive { projections, .. } => !projections.is_empty(),
            EmitOperation::UpdateReactive { projections, .. } => !projections.is_empty(),
            EmitOperation::ApplyProps { operation, .. } => {
                !matches!(operation, PropsOperation::Spread { .. })
            }
            _ => false,
        });
    unsupported.map_or_else(Vec::new, |operation| {
        let mut diagnostic = emit_error(
            "FICT-OXC-EMIT-UNSUPPORTED",
            "EmitIR contains an operation not yet materialized by the OXC output adapter",
            GuaranteeClass::Unsupported,
        );
        diagnostic.primary_span = operation_origin(operation).primary_span;
        vec![diagnostic]
    })
}

pub(super) fn operation_origin(operation: &EmitOperation) -> fict_hir::Origin {
    match operation {
        EmitOperation::PreserveHir { origin, .. }
        | EmitOperation::CreateReactive { origin, .. }
        | EmitOperation::CreateDerived { origin, .. }
        | EmitOperation::TrackRuntimeReactive { origin, .. }
        | EmitOperation::ReadReactive { origin, .. }
        | EmitOperation::RegisterEffect { origin, .. }
        | EmitOperation::WriteReactive { origin, .. }
        | EmitOperation::WriteReactivePattern { origin, .. }
        | EmitOperation::UpdateReactive { origin, .. }
        | EmitOperation::CreateVNode { origin, .. }
        | EmitOperation::DeclareTemplate { origin, .. }
        | EmitOperation::CloneTemplate { origin, .. }
        | EmitOperation::ResolveElement { origin, .. }
        | EmitOperation::InvokeComponent { origin, .. }
        | EmitOperation::BindDom { origin, .. }
        | EmitOperation::ApplyProps { origin, .. }
        | EmitOperation::BindEvent { origin, .. }
        | EmitOperation::BindRef { origin, .. }
        | EmitOperation::Evaluate { origin, .. }
        | EmitOperation::Insert { origin, .. }
        | EmitOperation::Conditional { origin, .. }
        | EmitOperation::ConditionalReturn { origin, .. }
        | EmitOperation::KeyedChild { origin, .. }
        | EmitOperation::KeyedList { origin, .. }
        | EmitOperation::Return { origin, .. } => *origin,
    }
}
