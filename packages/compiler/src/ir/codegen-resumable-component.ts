import type { CodegenContext } from './codegen'
import {
  reserveGeneratedIndexedModuleName,
  reserveGeneratedModuleName,
} from './codegen-name-allocation'
import { genModuleUrlExpr } from './codegen-resumable-utils'
import { runtimeIdentifier } from './codegen-runtime-helpers'

export function registerResumableComponent(componentName: string, ctx: CodegenContext): void {
  if (!ctx.resumableEnabled) return
  if (!ctx.hoistedResumableStatements || !ctx.resumableComponents) return
  if (ctx.resumableComponents.has(componentName)) return

  const { t } = ctx
  const allocatedResume = reserveGeneratedIndexedModuleName(
    ctx,
    '__fict_r',
    ctx.resumableComponentCounter ?? 0,
  )
  const resumeExport = allocatedResume.name
  ctx.resumableComponentCounter = allocatedResume.nextIndex

  const scopeParam = t.identifier('scopeId')
  const hostParam = t.identifier('host')
  const snapshotId = t.identifier('snapshot')
  const ctxId = t.identifier('ctx')
  const runtimeModuleUrlExpr = t.memberExpression(
    t.metaProperty(t.identifier('import'), t.identifier('meta')),
    t.identifier('url'),
  )

  ctx.helpersUsed.add('getSSRScope')
  ctx.helpersUsed.add('ensureScope')
  ctx.helpersUsed.add('prepareContext')
  ctx.helpersUsed.add('pushContext')
  ctx.helpersUsed.add('popContext')
  ctx.helpersUsed.add('hydrateComponent')
  ctx.helpersUsed.add('qrl')
  ctx.helpersUsed.add('setComponentMeta')

  const snapshotDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      snapshotId,
      t.callExpression(runtimeIdentifier(ctx, 'getSSRScope'), [scopeParam]),
    ),
  ])
  const earlyReturn = t.ifStatement(t.unaryExpression('!', snapshotId), t.returnStatement())
  const ensureCtxDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      ctxId,
      t.callExpression(runtimeIdentifier(ctx, 'ensureScope'), [scopeParam, hostParam, snapshotId]),
    ),
  ])
  // Prepare context so __fictPushContext will use it.
  const prepareCtx = t.expressionStatement(
    t.callExpression(runtimeIdentifier(ctx, 'prepareContext'), [ctxId]),
  )
  // Push context onto ctxStack so __fictUseContext can find it.
  const pushCtx = t.expressionStatement(t.callExpression(runtimeIdentifier(ctx, 'pushContext'), []))
  // Use hydrateComponent which runs view INSIDE withHydration for proper DOM claiming.
  const hydrateCall = t.expressionStatement(
    t.callExpression(runtimeIdentifier(ctx, 'hydrateComponent'), [
      t.arrowFunctionExpression(
        [],
        t.callExpression(t.identifier(componentName), [
          t.logicalExpression(
            '||',
            t.memberExpression(snapshotId, t.identifier('props')),
            t.objectExpression([]),
          ),
        ]),
      ),
      hostParam,
    ]),
  )
  const popCtx = t.expressionStatement(t.callExpression(runtimeIdentifier(ctx, 'popContext'), []))

  const resumeFnId = t.identifier(resumeExport)
  const resumeFn = t.exportNamedDeclaration(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        resumeFnId,
        t.arrowFunctionExpression(
          [scopeParam, hostParam],
          t.blockStatement([
            snapshotDecl,
            earlyReturn,
            ensureCtxDecl,
            t.tryStatement(
              t.blockStatement([prepareCtx, pushCtx, hydrateCall]),
              null,
              t.blockStatement([popCtx]),
            ),
          ]),
        ),
      ),
    ]),
    [],
  )

  // Register resume function to prevent tree-shaking.
  // This creates a side effect that keeps the export alive.
  ctx.helpersUsed.add('registerResume')
  const registerCall = t.expressionStatement(
    t.callExpression(runtimeIdentifier(ctx, 'registerResume'), [
      t.callExpression(runtimeIdentifier(ctx, 'qrl'), [
        runtimeModuleUrlExpr,
        t.stringLiteral(resumeExport),
      ]),
      resumeFnId,
    ]),
  )

  const metaId = t.identifier(reserveGeneratedModuleName(ctx, `__fict_meta_${componentName}`))
  const moduleUrlExpr = genModuleUrlExpr(ctx)
  const typeKeyExpr = t.binaryExpression('+', t.stringLiteral(`${componentName}@`), moduleUrlExpr)
  const resumeQrlExpr = t.callExpression(runtimeIdentifier(ctx, 'qrl'), [
    genModuleUrlExpr(ctx),
    t.stringLiteral(resumeExport),
  ])
  const metaDecl = t.variableDeclaration('const', [
    t.variableDeclarator(
      metaId,
      t.objectExpression([
        t.objectProperty(t.identifier('id'), typeKeyExpr),
        t.objectProperty(t.identifier('resume'), resumeQrlExpr),
      ]),
    ),
  ])
  const assignMeta = t.expressionStatement(
    t.callExpression(runtimeIdentifier(ctx, 'setComponentMeta'), [
      t.identifier(componentName),
      metaId,
    ]),
  )

  ctx.hoistedResumableStatements.push(resumeFn, registerCall, metaDecl, assignMeta)
  ctx.resumableComponents.set(componentName, { resumeExport, typeKey: componentName })
}
