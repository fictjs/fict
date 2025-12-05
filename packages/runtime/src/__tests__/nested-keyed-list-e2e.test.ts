import { describe, it, expect, beforeEach } from 'vitest'

import { createEffect } from '../effect'
import { createKeyedList } from '../list-helpers'
import { createSignal } from '../signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Nested Keyed List E2E', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('renders two-level nested lists (categories with items)', async () => {
    interface Item {
      id: number
      name: string
    }

    interface Category {
      id: number
      title: string
      items: Item[]
    }

    const categories = createSignal<Category[]>([
      {
        id: 1,
        title: 'Fruits',
        items: [
          { id: 101, name: 'Apple' },
          { id: 102, name: 'Banana' },
        ],
      },
      {
        id: 2,
        title: 'Vegetables',
        items: [
          { id: 201, name: 'Carrot' },
          { id: 202, name: 'Broccoli' },
        ],
      },
    ])

    // Outer list: categories
    const categoryList = createKeyedList(
      () => categories(),
      cat => cat.id,
      (catSig, _indexSig) => {
        const section = document.createElement('section')
        section.setAttribute('data-category-id', String(catSig().id))

        const h2 = document.createElement('h2')
        createEffect(() => {
          h2.textContent = catSig().title
        })
        section.appendChild(h2)

        const ul = document.createElement('ul')
        section.appendChild(ul)

        // Inner list: items
        const itemList = createKeyedList(
          () => catSig().items,
          item => item.id,
          (itemSig, _itemIndexSig) => {
            const li = document.createElement('li')
            li.setAttribute('data-item-id', String(itemSig().id))

            createEffect(() => {
              li.textContent = itemSig().name
            })

            return [li]
          },
        )

        ul.appendChild(itemList.startMarker)
        ul.appendChild(itemList.endMarker)

        return [section]
      },
    )

    container.appendChild(categoryList.startMarker)
    container.appendChild(categoryList.endMarker)

    await tick()

    // Verify initial render
    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(2)
    expect(sections[0]!.getAttribute('data-category-id')).toBe('1')
    expect(sections[1]!.getAttribute('data-category-id')).toBe('2')

    const category1Items = sections[0]!.querySelectorAll('li')
    expect(category1Items.length).toBe(2)
    expect(category1Items[0]!.textContent).toBe('Apple')
    expect(category1Items[1]!.textContent).toBe('Banana')

    const category2Items = sections[1]!.querySelectorAll('li')
    expect(category2Items.length).toBe(2)
    expect(category2Items[0]!.textContent).toBe('Carrot')
    expect(category2Items[1]!.textContent).toBe('Broccoli')

    categoryList.dispose()
  })

  it('updates nested items while preserving parent structure', async () => {
    interface Item {
      id: number
      name: string
    }

    interface Category {
      id: number
      title: string
      items: Item[]
    }

    const categories = createSignal<Category[]>([
      {
        id: 1,
        title: 'Fruits',
        items: [
          { id: 101, name: 'Apple' },
          { id: 102, name: 'Banana' },
        ],
      },
    ])

    const categoryList = createKeyedList(
      () => categories(),
      cat => cat.id,
      (catSig, _indexSig) => {
        const section = document.createElement('section')
        section.setAttribute('data-category-id', String(catSig().id))

        const h2 = document.createElement('h2')
        createEffect(() => {
          h2.textContent = catSig().title
        })
        section.appendChild(h2)

        const ul = document.createElement('ul')
        section.appendChild(ul)

        const itemList = createKeyedList(
          () => catSig().items,
          item => item.id,
          (itemSig, _itemIndexSig) => {
            const li = document.createElement('li')
            li.setAttribute('data-item-id', String(itemSig().id))

            createEffect(() => {
              li.textContent = itemSig().name
            })

            return [li]
          },
        )

        ul.appendChild(itemList.startMarker)
        ul.appendChild(itemList.endMarker)

        return [section]
      },
    )

    container.appendChild(categoryList.startMarker)
    container.appendChild(categoryList.endMarker)

    await tick()

    // Save reference to parent section
    const originalSection = container.querySelector('section')!

    // Update nested items
    categories([
      {
        id: 1,
        title: 'Fruits',
        items: [
          { id: 101, name: 'Red Apple' }, // Updated
          { id: 102, name: 'Banana' },
          { id: 103, name: 'Orange' }, // New item
        ],
      },
    ])

    await tick()

    // Parent section should be the same DOM node
    const updatedSection = container.querySelector('section')!
    expect(updatedSection).toBe(originalSection)

    // Check updated items
    const items = updatedSection.querySelectorAll('li')
    expect(items.length).toBe(3)
    expect(items[0]!.textContent).toBe('Red Apple')
    expect(items[1]!.textContent).toBe('Banana')
    expect(items[2]!.textContent).toBe('Orange')

    categoryList.dispose()
  })

  it('handles reordering parent categories with nested items', async () => {
    interface Item {
      id: number
      name: string
    }

    interface Category {
      id: number
      title: string
      items: Item[]
    }

    const categories = createSignal<Category[]>([
      {
        id: 1,
        title: 'Fruits',
        items: [{ id: 101, name: 'Apple' }],
      },
      {
        id: 2,
        title: 'Vegetables',
        items: [{ id: 201, name: 'Carrot' }],
      },
    ])

    const categoryList = createKeyedList(
      () => categories(),
      cat => cat.id,
      (catSig, _indexSig) => {
        const section = document.createElement('section')
        section.setAttribute('data-category-id', String(catSig().id))

        const h2 = document.createElement('h2')
        createEffect(() => {
          h2.textContent = catSig().title
        })
        section.appendChild(h2)

        const ul = document.createElement('ul')
        section.appendChild(ul)

        const itemList = createKeyedList(
          () => catSig().items,
          item => item.id,
          (itemSig, _itemIndexSig) => {
            const li = document.createElement('li')
            createEffect(() => {
              li.textContent = itemSig().name
            })
            return [li]
          },
        )

        ul.appendChild(itemList.startMarker)
        ul.appendChild(itemList.endMarker)

        return [section]
      },
    )

    container.appendChild(categoryList.startMarker)
    container.appendChild(categoryList.endMarker)

    await tick()

    // Save references
    const firstSection = container.children[0] as HTMLElement
    const secondSection = container.children[1] as HTMLElement

    expect(firstSection.getAttribute('data-category-id')).toBe('1')
    expect(secondSection.getAttribute('data-category-id')).toBe('2')

    // Reverse order
    categories([
      {
        id: 2,
        title: 'Vegetables',
        items: [{ id: 201, name: 'Carrot' }],
      },
      {
        id: 1,
        title: 'Fruits',
        items: [{ id: 101, name: 'Apple' }],
      },
    ])

    await tick()

    // Check that DOM nodes are reordered
    expect(container.children[0]).toBe(secondSection)
    expect(container.children[1]).toBe(firstSection)

    // Content should still be correct
    expect(container.children[0]!.querySelector('h2')!.textContent).toBe('Vegetables')
    expect(container.children[1]!.querySelector('h2')!.textContent).toBe('Fruits')

    categoryList.dispose()
  })

  it('handles deep nesting (3 levels)', async () => {
    interface SubItem {
      id: number
      value: string
    }

    interface Item {
      id: number
      name: string
      subItems: SubItem[]
    }

    interface Category {
      id: number
      title: string
      items: Item[]
    }

    const categories = createSignal<Category[]>([
      {
        id: 1,
        title: 'Level 1',
        items: [
          {
            id: 11,
            name: 'Level 2 - A',
            subItems: [
              { id: 111, value: 'Level 3 - X' },
              { id: 112, value: 'Level 3 - Y' },
            ],
          },
        ],
      },
    ])

    // Level 1
    const categoryList = createKeyedList(
      () => categories(),
      cat => cat.id,
      (catSig, _indexSig) => {
        const div1 = document.createElement('div')
        div1.className = 'level-1'
        div1.setAttribute('data-id', String(catSig().id))

        const h1 = document.createElement('h1')
        createEffect(() => {
          h1.textContent = catSig().title
        })
        div1.appendChild(h1)

        // Level 2
        const itemList = createKeyedList(
          () => catSig().items,
          item => item.id,
          (itemSig, _itemIndexSig) => {
            const div2 = document.createElement('div')
            div2.className = 'level-2'
            div2.setAttribute('data-id', String(itemSig().id))

            const h2 = document.createElement('h2')
            createEffect(() => {
              h2.textContent = itemSig().name
            })
            div2.appendChild(h2)

            // Level 3
            const subItemList = createKeyedList(
              () => itemSig().subItems,
              subItem => subItem.id,
              (subItemSig, _subIndexSig) => {
                const div3 = document.createElement('div')
                div3.className = 'level-3'
                div3.setAttribute('data-id', String(subItemSig().id))

                createEffect(() => {
                  div3.textContent = subItemSig().value
                })

                return [div3]
              },
            )

            div2.appendChild(subItemList.startMarker)
            div2.appendChild(subItemList.endMarker)

            return [div2]
          },
        )

        div1.appendChild(itemList.startMarker)
        div1.appendChild(itemList.endMarker)

        return [div1]
      },
    )

    container.appendChild(categoryList.startMarker)
    container.appendChild(categoryList.endMarker)

    await tick()
    await tick() // Extra tick for nested rendering

    // Verify 3-level structure
    const level1 = container.querySelector('.level-1')!
    expect(level1.getAttribute('data-id')).toBe('1')
    expect(level1.querySelector('h1')!.textContent).toBe('Level 1')

    const level2 = level1.querySelector('.level-2')!
    expect(level2.getAttribute('data-id')).toBe('11')
    expect(level2.querySelector('h2')!.textContent).toBe('Level 2 - A')

    const level3Items = level2.querySelectorAll('.level-3')
    expect(level3Items.length).toBe(2)
    expect(level3Items[0]!.textContent).toBe('Level 3 - X')
    expect(level3Items[1]!.textContent).toBe('Level 3 - Y')

    // Update deepest level
    categories([
      {
        id: 1,
        title: 'Level 1',
        items: [
          {
            id: 11,
            name: 'Level 2 - A',
            subItems: [
              { id: 112, value: 'Level 3 - Y' }, // Reordered
              { id: 111, value: 'Level 3 - X Updated' }, // Updated
              { id: 113, value: 'Level 3 - Z' }, // New
            ],
          },
        ],
      },
    ])

    await tick()

    const updatedLevel3Items = level2.querySelectorAll('.level-3')
    expect(updatedLevel3Items.length).toBe(3)
    expect(updatedLevel3Items[0]!.textContent).toBe('Level 3 - Y')
    expect(updatedLevel3Items[1]!.textContent).toBe('Level 3 - X Updated')
    expect(updatedLevel3Items[2]!.textContent).toBe('Level 3 - Z')

    categoryList.dispose()
  })

  it('handles empty nested lists', async () => {
    interface Item {
      id: number
      name: string
    }

    interface Category {
      id: number
      title: string
      items: Item[]
    }

    const categories = createSignal<Category[]>([
      {
        id: 1,
        title: 'Empty Category',
        items: [],
      },
      {
        id: 2,
        title: 'Non-empty Category',
        items: [{ id: 201, name: 'Item 1' }],
      },
    ])

    const categoryList = createKeyedList(
      () => categories(),
      cat => cat.id,
      (catSig, _indexSig) => {
        const section = document.createElement('section')
        section.setAttribute('data-category-id', String(catSig().id))

        const h2 = document.createElement('h2')
        createEffect(() => {
          h2.textContent = catSig().title
        })
        section.appendChild(h2)

        const ul = document.createElement('ul')
        section.appendChild(ul)

        const itemList = createKeyedList(
          () => catSig().items,
          item => item.id,
          (itemSig, _itemIndexSig) => {
            const li = document.createElement('li')
            createEffect(() => {
              li.textContent = itemSig().name
            })
            return [li]
          },
        )

        ul.appendChild(itemList.startMarker)
        ul.appendChild(itemList.endMarker)

        return [section]
      },
    )

    container.appendChild(categoryList.startMarker)
    container.appendChild(categoryList.endMarker)

    await tick()

    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(2)

    // First category should have no items
    const emptyItems = sections[0]!.querySelectorAll('li')
    expect(emptyItems.length).toBe(0)

    // Second category should have 1 item
    const nonEmptyItems = sections[1]!.querySelectorAll('li')
    expect(nonEmptyItems.length).toBe(1)

    // Add items to empty category
    categories([
      {
        id: 1,
        title: 'Empty Category',
        items: [{ id: 101, name: 'New Item' }],
      },
      {
        id: 2,
        title: 'Non-empty Category',
        items: [{ id: 201, name: 'Item 1' }],
      },
    ])

    await tick()

    // Now first category should have 1 item
    const updatedEmptyItems = sections[0]!.querySelectorAll('li')
    expect(updatedEmptyItems.length).toBe(1)
    expect(updatedEmptyItems[0]!.textContent).toBe('New Item')

    categoryList.dispose()
  })
})
