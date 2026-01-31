/**
 * Tests for custom queries option in render
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup, buildQueries, queries as defaultQueries } from '../src/index'
import { createElement } from '@fictjs/runtime'

// Custom query helpers using buildQueries from @testing-library/dom
const queryAllByCustomAttr = (container: HTMLElement, attr: string): HTMLElement[] => {
  return Array.from(container.querySelectorAll(`[data-custom="${attr}"]`))
}

const getMultipleError = (_c: Element | null, attr: string) =>
  `Found multiple elements with data-custom="${attr}"`

const getMissingError = (_c: Element | null, attr: string) =>
  `Unable to find element with data-custom="${attr}"`

const [
  queryByCustomAttr,
  getAllByCustomAttr,
  getByCustomAttr,
  findAllByCustomAttr,
  findByCustomAttr,
] = buildQueries(queryAllByCustomAttr, getMultipleError, getMissingError)

// Custom queries object that extends default queries
const customQueries = {
  ...defaultQueries,
  queryByCustomAttr,
  getAllByCustomAttr,
  getByCustomAttr,
  findAllByCustomAttr,
  findByCustomAttr,
  queryAllByCustomAttr,
}

describe('custom queries', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('with custom queries option', () => {
    it('provides custom queries alongside default queries', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: {
              'data-custom': 'my-element',
              children: 'Hello World',
            },
            key: undefined,
          }),
        { queries: customQueries },
      )

      // Access custom query - use type assertion since custom queries are dynamic
      const getByCustomAttr = result.getByCustomAttr as (attr: string) => HTMLElement
      const element = getByCustomAttr('my-element')
      expect(element).toBeTruthy()
      expect(element.textContent).toBe('Hello World')

      // Default queries should still work
      const byText = result.getByText('Hello World')
      expect(byText).toBeTruthy()
    })

    it('queryByCustomAttr returns null when not found', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: { children: 'No custom attr' },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const queryByCustomAttr = result.queryByCustomAttr as (attr: string) => HTMLElement | null
      const element = queryByCustomAttr('nonexistent')
      expect(element).toBeNull()
    })

    it('getByCustomAttr throws when element not found', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: { children: 'No custom attr' },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const getByCustomAttr = result.getByCustomAttr as (attr: string) => HTMLElement
      expect(() => getByCustomAttr('nonexistent')).toThrow(
        'Unable to find element with data-custom="nonexistent"',
      )
    })

    it('getAllByCustomAttr returns all matching elements', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: {
              children: [
                createElement({
                  type: 'span',
                  props: { 'data-custom': 'item', children: 'First' },
                  key: '1',
                }),
                createElement({
                  type: 'span',
                  props: { 'data-custom': 'item', children: 'Second' },
                  key: '2',
                }),
                createElement({
                  type: 'span',
                  props: { 'data-custom': 'item', children: 'Third' },
                  key: '3',
                }),
              ],
            },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const getAllByCustomAttr = result.getAllByCustomAttr as (attr: string) => HTMLElement[]
      const elements = getAllByCustomAttr('item')
      expect(elements).toHaveLength(3)
      expect(elements[0]!.textContent).toBe('First')
      expect(elements[1]!.textContent).toBe('Second')
      expect(elements[2]!.textContent).toBe('Third')
    })

    it('findByCustomAttr waits for element to appear', async () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: { children: 'Loading...' },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const findByCustomAttr = result.findByCustomAttr as (attr: string) => Promise<HTMLElement>

      // Start async find
      const findPromise = findByCustomAttr('delayed')

      // Update after a delay
      setTimeout(() => {
        result.rerender(() =>
          createElement({
            type: 'div',
            props: { 'data-custom': 'delayed', children: 'Loaded!' },
            key: undefined,
          }),
        )
      }, 50)

      const element = await findPromise
      expect(element.textContent).toBe('Loaded!')
    })
  })

  describe('custom query error messages', () => {
    it('shows descriptive error for multiple elements', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: {
              children: [
                createElement({
                  type: 'span',
                  props: { 'data-custom': 'duplicate', children: 'First' },
                  key: '1',
                }),
                createElement({
                  type: 'span',
                  props: { 'data-custom': 'duplicate', children: 'Second' },
                  key: '2',
                }),
              ],
            },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const getByCustomAttr = result.getByCustomAttr as (attr: string) => HTMLElement
      expect(() => getByCustomAttr('duplicate')).toThrow(
        'Found multiple elements with data-custom="duplicate"',
      )
    })
  })

  describe('rerender with custom queries', () => {
    it('custom queries work after rerender', () => {
      const result = render(
        () =>
          createElement({
            type: 'div',
            props: { 'data-custom': 'original', children: 'Original' },
            key: undefined,
          }),
        { queries: customQueries },
      )

      const getByCustomAttr = result.getByCustomAttr as (attr: string) => HTMLElement
      expect(getByCustomAttr('original').textContent).toBe('Original')

      result.rerender(() =>
        createElement({
          type: 'div',
          props: { 'data-custom': 'updated', children: 'Updated' },
          key: undefined,
        }),
      )

      expect(getByCustomAttr('updated').textContent).toBe('Updated')
      expect(() => getByCustomAttr('original')).toThrow()
    })
  })

  describe('combining with wrapper', () => {
    it('custom queries work with wrapper component', () => {
      const Wrapper = (props: { children: any }) =>
        createElement({
          type: 'div',
          props: { class: 'wrapper', children: props.children },
          key: undefined,
        })

      const result = render(
        () =>
          createElement({
            type: 'span',
            props: { 'data-custom': 'wrapped', children: 'Wrapped content' },
            key: undefined,
          }),
        {
          queries: customQueries,
          wrapper: Wrapper,
        },
      )

      const getByCustomAttr = result.getByCustomAttr as (attr: string) => HTMLElement
      expect(result.container.querySelector('.wrapper')).toBeTruthy()
      expect(getByCustomAttr('wrapped').textContent).toBe('Wrapped content')
    })
  })
})
