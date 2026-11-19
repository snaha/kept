export const TRAIT_KEYS = ['mood', 'energy', 'acoustic', 'vocal'] as const
export type TraitKey = typeof TRAIT_KEYS[number]
export type Traits = Record<TraitKey, number>
/** `hand` was set by the user. `estimated` was computed and may carry a 0-1 confidence. */
export type TraitSource = 'hand' | 'estimated'
export type TraitReading = { value: number; source: TraitSource; confidence?: number }
export type TraitReadings = Partial<Record<TraitKey, TraitReading>>
export type EstimatedTraits = Partial<Record<TraitKey, { value: number; confidence?: number }>>

export const isTraitValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100

/** A hand-set value always wins over an estimate for the same axis. */
export function resolveTraits(hand?: Partial<Traits>, estimated?: EstimatedTraits): TraitReadings {
  const readings: TraitReadings = {}
  for (const key of TRAIT_KEYS) {
    const handValue = hand?.[key]
    const guess = estimated?.[key]
    if (isTraitValue(handValue)) readings[key] = { value: handValue, source: 'hand' }
    else if (guess && isTraitValue(guess.value)) readings[key] = { value: guess.value, source: 'estimated', confidence: guess.confidence }
  }
  return readings
}

export const hasReadings = (readings: TraitReadings) => TRAIT_KEYS.some(key => !!readings[key])
export const hasSource = (readings: TraitReadings, source: TraitSource) => TRAIT_KEYS.some(key => readings[key]?.source === source)
