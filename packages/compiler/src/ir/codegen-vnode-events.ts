import {
  isCamelCaseEventName,
  normalizeEventAttributeName,
  parseKnownEventNameWithModifiers,
  parseNamespacedEventName,
} from './codegen-template-extraction'

export interface NormalizedVNodeEventProp {
  name: string
  eventName: string | null
  isEvent: boolean
  capture: boolean
  passive: boolean
  once: boolean
  resumableExplicit: boolean
}

/** Normalize JSX event spellings once for both VNode and resumable lowering. */
export function normalizeVNodeEventPropName(name: string): NormalizedVNodeEventProp {
  const normalized = normalizeEventAttributeName(name)
  const namespacedEvent = parseNamespacedEventName(normalized.name)
  if (!namespacedEvent && !isCamelCaseEventName(normalized.name)) {
    return {
      name: normalized.name,
      eventName: null,
      isEvent: false,
      capture: false,
      passive: false,
      once: false,
      resumableExplicit: normalized.resumableExplicit,
    }
  }

  let eventName = namespacedEvent?.eventName ?? normalized.name.slice(2)
  let capture = namespacedEvent?.capture ?? false
  let passive = false
  let once = false
  if (!namespacedEvent) {
    const knownEvent = parseKnownEventNameWithModifiers(eventName)
    if (knownEvent) {
      eventName = knownEvent.eventName
      capture ||= knownEvent.capture
      passive = knownEvent.passive
      once = knownEvent.once
    } else {
      let changed = true
      while (changed) {
        changed = false
        if (eventName.endsWith('Capture')) {
          eventName = eventName.slice(0, -7)
          capture = true
          changed = true
        }
        if (eventName.endsWith('Passive')) {
          eventName = eventName.slice(0, -7)
          passive = true
          changed = true
        }
        if (eventName.endsWith('Once')) {
          eventName = eventName.slice(0, -4)
          once = true
          changed = true
        }
      }
    }
  }

  return {
    name: normalized.name,
    eventName: namespacedEvent ? eventName : eventName.toLowerCase(),
    isEvent: true,
    capture,
    passive,
    once,
    resumableExplicit: normalized.resumableExplicit,
  }
}
