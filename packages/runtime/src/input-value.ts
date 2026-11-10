// Browsers sanitize range values when type/min/max/step change. Reapply the
// controlled value after those writes, including when the value did not change.
const setters = new WeakMap<Element, () => void>()

export function registerInputValueSetter(input: Element, setter: () => void): void {
  setters.set(input, setter)
}

export function syncInputValue(element: Element, property: string): void {
  if (property === 'type' || property === 'min' || property === 'max' || property === 'step') {
    setters.get(element)?.()
  }
}
