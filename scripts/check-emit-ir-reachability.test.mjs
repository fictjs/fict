import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emitOperationVariants,
  missingEmitOperationProducers,
} from './check-emit-ir-reachability.mjs'

const emitIr = variants => `
  pub enum EmitOperation {
    ${variants.join('\n    ')}
  }
`

test('extracts struct, tuple, and unit EmitOperation variants', () => {
  assert.deepEqual(
    emitOperationVariants(emitIr(['Preserve { value: u32 },', 'Transform(u32),', 'Return,'])),
    ['Preserve', 'Transform', 'Return'],
  )
})

test('requires every EmitOperation variant in a production lowerer', () => {
  const ir = emitIr([
    'Preserve { value: u32 },',
    'Mapped { value: u32 },',
    'Dead { value: u32 },',
    'Return,',
  ])
  assert.deepEqual(
    missingEmitOperationProducers(ir, [
      `
        operations.push(EmitOperation::Preserve { value });
        values.map(|value| EmitOperation::Mapped { value });
        match operation { EmitOperation::Dead { .. } => {} }
        // operations.push(EmitOperation::Dead { value });
        operations.push(EmitOperation::Return);
      `,
    ]),
    ['Dead'],
  )
})

test('rejects missing and malformed EmitOperation declarations', () => {
  assert.throws(() => emitOperationVariants('pub enum Other {}'), /unable to locate/)
  assert.throws(() => emitOperationVariants('pub enum EmitOperation { Broken {'), /unterminated/)
})
