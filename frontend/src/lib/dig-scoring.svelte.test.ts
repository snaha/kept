import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalog, dig, digScore, resetDig, setEstimatedTraits, saveMetadata } from './discovery.svelte'
import { resolveTraits } from './traits'
import type { Collection } from './music'

const album = (id: string): Collection => ({ id, rawId: id, source: 'local', kind: 'album', title: id, sub: 'Artist', cover: '', count: 1, available: true })

describe('Dig scoring uses only the axes an album has', () => {
  beforeEach(() => { resetDig(); catalog.items = {}; catalog.estimated = {}; catalog.stats = {} })
  afterEach(() => { resetDig(); catalog.items = {}; catalog.estimated = {}; catalog.stats = {} })

  it('scores everything the same while Dig is idle', () => {
    expect(digScore(album('none'))).toBe(1)
  })

  it('ranks an untagged album at zero when only tag axes are active', () => {
    Object.assign(dig, { moodOn: true, mood: 50, energy: 50 })
    expect(digScore(album('none'))).toBe(0)
  })

  it('scores an album with energy but no mood on the energy axis alone', () => {
    Object.assign(dig, { moodOn: true, mood: 90, energy: 30 })
    catalog.items.a = { traits: { energy: 30 } }
    expect(digScore(album('a'))).toBe(1)
    catalog.items.b = { traits: { energy: 80 } }
    expect(digScore(album('b'))).toBe(0)
  })

  it('normalises by the number of axes present', () => {
    Object.assign(dig, { moodOn: true, mood: 50, energy: 50, acoustic: 70 })
    catalog.items.one = { traits: { mood: 60 } }
    catalog.items.two = { traits: { mood: 60, energy: 60, acoustic: 60 } }
    expect(digScore(album('one'))).toBeCloseTo(0.9)
    expect(digScore(album('two'))).toBeCloseTo(1 - (10 + 10 + 10) / 3 / 100)
  })

  it('still rejects an album when any present axis is too far away', () => {
    Object.assign(dig, { moodOn: true, mood: 10, energy: 10 })
    catalog.items.far = { traits: { mood: 10, energy: 90 } }
    expect(digScore(album('far'))).toBe(0)
  })

  it('lets estimated traits fill axes and hand-set values win', () => {
    Object.assign(dig, { moodOn: true, mood: 50, energy: 20 })
    setEstimatedTraits('e', { energy: { value: 25, confidence: .6 } })
    expect(digScore(album('e'))).toBeCloseTo(.95)
    saveMetadata('e', { traits: { energy: 90 } })
    expect(digScore(album('e'))).toBe(0)
  })

  it('keeps presets working when an album has no mood', () => {
    Object.assign(dig, { preset: 'Focus time', moodOn: true, mood: 50, energy: 25, acoustic: 50, vocal: 15 })
    setEstimatedTraits('sound', { energy: { value: 30 }, vocal: { value: 20 } })
    expect(digScore(album('sound'))).toBeGreaterThan(0)
  })

  it('does not hide an unplayed album behind familiarity when it has no traits and a tag axis is active', () => {
    Object.assign(dig, { acoustic: 80 })
    expect(digScore(album('untagged'))).toBe(0)
  })

  it('resolves a hand value over an estimate per axis', () => {
    expect(resolveTraits({ mood: 40 }, { mood: { value: 70 }, energy: { value: 20, confidence: .5 } })).toEqual({
      mood: { value: 40, source: 'hand' }, energy: { value: 20, source: 'estimated', confidence: .5 },
    })
  })
})
