// The change ledger: commit, dependency-aware undo and suppression, as one piece of logic
// over a small synchronous store. The fake keeps that store in memory and the SQLite
// service in library.sqlite, so both behave alike. Types: catalog-ledger.d.ts.
//
// An operation is applied to the spine as a list of writes. Each write records the state
// it replaced (before) and the state it left (after), which is all undo needs. A change
// set is indexed by the keys its writes touched, the albums it referred to and the change
// sets it named, which is how its dependents are found.
import {
  APPROVING_CLASSES, CHANGE_OPERATION_KINDS, FAVORITE_FIELD, LINKS_LOCK_FIELD, MEMBERSHIP_LOCK_FIELD, TRAIT_FIELD_PREFIX, USER_SOURCE, USER_SOURCE_ID, catalogError, isCatalogId,
  isTraitValue, propagateLicence, traitOfField, validateCatalogChange,
} from './catalog-rules.js'

export const DEFAULT_CHANGE_PAGE = 50
export const MAX_CHANGE_PAGE = 200
export const MAX_OPERATIONS = 500
export const MAX_SUMMARY_LENGTH = 200
const AUTHOR_KINDS = ['user', 'route', 'job']
const SUBJECT_KINDS = ['album', 'asset']
const LINK_KINDS = ['album', 'track']
const USER_AUTHOR = { kind: 'user' }

const invalid = detail => catalogError('invalid-request', detail)
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isText = value => typeof value === 'string' && value.length > 0
const optional = (value, check) => value === undefined || check(value)
const unique = values => [...new Set(values)]
const keyOf = (...parts) => JSON.stringify(parts)
const albumKey = id => keyOf('album', id)
const changeSetKey = id => keyOf('change-set', id)
const album = id => ({ kind: 'album', id })

// Numbering follows the asset across membership changes. A later move can correct either
// field independently, and Undo exposes the previous correction or the latest scanned value.
export function trackNumbering(assetIds, changeSetsByKeys) {
  const assets = new Set(assetIds)
  const numbers = new Map()
  if (!assets.size) return numbers
  for (const record of changeSetsByKeys(assetIds.map(id => keyOf('member', id)))) {
    for (const { operation, state } of record.operations) {
      if (state !== 'applied' || operation.kind !== 'move-track' || !assets.has(operation.assetId)) continue
      const { assetId, disc, track } = operation
      const previous = numbers.get(assetId)
      numbers.set(assetId, { disc: disc ?? previous?.disc, track: track ?? previous?.track })
    }
  }
  return numbers
}

// Carries a refusal out of the transaction, which rolls back what the undo had done so far.
class Blocked extends Error {
  constructor(reason, blockedBy) {
    super(reason)
    this.result = { status: 'blocked', reason, blockedBy }
  }
}

const normalSubject = subject => {
  if (!isObject(subject) || !SUBJECT_KINDS.includes(subject.kind) || !isCatalogId(subject.id)) throw invalid('subject')
  return { kind: subject.kind, id: subject.id }
}
const normalAuthor = author => {
  if (!isObject(author) || !AUTHOR_KINDS.includes(author.kind)) throw invalid('author')
  if (author.kind === 'user') return USER_AUTHOR
  if (!isCatalogId(author.id)) throw invalid('author id')
  if (author.kind === 'route') return { kind: 'route', id: author.id }
  if (!optional(author.route, isCatalogId)) throw invalid('author route')
  return { kind: 'job', id: author.id, route: author.route }
}
// Fixed key order, so an operation always has the same fingerprint.
const normalOperation = operation => {
  if (!isObject(operation) || !CHANGE_OPERATION_KINDS.includes(operation.kind)) throw invalid('operation')
  const { kind } = operation
  if (kind === 'set-field') {
    if (!isText(operation.field)) throw invalid('field')
    return { kind, subject: normalSubject(operation.subject), field: operation.field, value: operation.value }
  }
  if (kind === 'lock-field') {
    if (!isText(operation.field) || typeof operation.locked !== 'boolean') throw invalid('lock')
    return { kind, subject: normalSubject(operation.subject), field: operation.field, locked: operation.locked }
  }
  if (kind === 'merge-albums') {
    const valid = isCatalogId(operation.into) && Array.isArray(operation.from) && operation.from.length > 0 && operation.from.every(isCatalogId)
      && unique(operation.from).length === operation.from.length && !operation.from.includes(operation.into)
    if (!valid) throw invalid('merge')
    return { kind, into: operation.into, from: [...operation.from] }
  }
  if (kind === 'split-album') {
    const valid = isCatalogId(operation.albumId) && Array.isArray(operation.assetIds) && operation.assetIds.length > 0 && operation.assetIds.every(isCatalogId)
      && unique(operation.assetIds).length === operation.assetIds.length
    if (!valid) throw invalid('split')
    return { kind, albumId: operation.albumId, assetIds: [...operation.assetIds] }
  }
  if (kind === 'move-track') {
    if (!isCatalogId(operation.assetId) || !isCatalogId(operation.albumId) || !optional(operation.disc, isCount) || !optional(operation.track, isCount)) throw invalid('move')
    return { kind, assetId: operation.assetId, albumId: operation.albumId, disc: operation.disc, track: operation.track }
  }
  if (!isCatalogId(operation.sourceId) || !LINK_KINDS.includes(operation.linkKind) || !isText(operation.externalId)) throw invalid('relink')
  const subject = normalSubject(operation.subject)
  if ((operation.linkKind === 'album') !== (subject.kind === 'album')) throw invalid('link kind does not match its subject')
  return { kind, sourceId: operation.sourceId, linkKind: operation.linkKind, externalId: operation.externalId, subject }
}
const normalEvidence = reference => {
  const valid = isObject(reference) && typeof reference.supports === 'boolean' && (reference.sourceId === undefined) !== (reference.observationId === undefined)
    && optional(reference.sourceId, isCatalogId) && optional(reference.observationId, isCatalogId)
  if (!valid) throw invalid('evidence')
  return { supports: reference.supports, sourceId: reference.sourceId, observationId: reference.observationId }
}
const normalInput = input => {
  if (!isObject(input) || !isCatalogId(input.id) || !isCount(input.committedAt)) throw invalid('change set')
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > MAX_OPERATIONS) throw invalid('operations')
  if (!optional(input.evidence, Array.isArray) || !optional(input.dependsOn, value => Array.isArray(value) && value.every(isCatalogId))) throw invalid('change set')
  if (!optional(input.baseVersion, isCount) || !optional(input.summary, value => isText(value) && value.length <= MAX_SUMMARY_LENGTH)) throw invalid('change set')
  const author = normalAuthor(input.author)
  const operations = input.operations.map(normalOperation)
  const automated = author.kind !== 'user'
  if (automated && input.baseVersion === undefined) throw invalid('an automated change names the version it was computed against')
  if (!optional(input.amends, isCatalogId)) throw invalid('amends')
  for (const operation of operations) {
    const decision = operation.kind === 'set-field' && (operation.field.startsWith(TRAIT_FIELD_PREFIX) || operation.field === FAVORITE_FIELD)
    if ((decision || operation.kind === 'lock-field') && automated) throw invalid('only the user locks a field, sets a trait by hand or picks a favourite')
    if (decision && operation.field === FAVORITE_FIELD && typeof operation.value !== 'boolean') throw invalid('favourite')
    if (operation.kind === 'set-field' && operation.field.startsWith(TRAIT_FIELD_PREFIX) && !(traitOfField(operation.field) && optional(operation.value, isTraitValue))) throw invalid('trait')
  }
  return {
    id: input.id, author, operations, evidence: (input.evidence ?? []).map(normalEvidence), dependsOn: unique(input.dependsOn ?? []),
    baseVersion: input.baseVersion, committedAt: input.committedAt, summary: input.summary, amends: input.amends,
  }
}
// What a route is held to after the user undoes its work. A job answers for the route it ran.
const suppressionAuthor = author => (author.kind === 'user' ? undefined : author.kind === 'job' && author.route === undefined ? `job:${author.id}` : `route:${author.route ?? author.id}`)
const fingerprint = value => JSON.stringify(value)

export function createLedger(store) {
  const requireAlbum = id => store.requireSubject(album(id)).id

  // The spine state one write stands for, and how to put a state back.
  const read = ({ type, target: [first, second, third, fourth] }) => {
    if (type === 'field') return store.override({ kind: first, id: second }, third)
    if (type === 'lock') return store.lock({ kind: first, id: second }, third)
    if (type === 'decision') return store.decision(first, { kind: second, id: third }, fourth)
    if (type === 'member') return store.memberOf(first)
    return store.findLink(first, second, third)
  }
  const put = ({ type, target: [first, second, third, fourth] }, value, decidedAt, restoring = false) => {
    if (type === 'field' || type === 'lock') {
      const subject = { kind: first, id: second }
      if (type === 'field') store.setOverride(subject, third, value)
      else store.setLock(subject, third, value)
      store.touch(subject)
    } else if (type === 'decision') {
      const subject = { kind: second, id: third }
      store.setDecision(first, subject, fourth, value?.value, decidedAt)
      store.touch(subject)
    } else if (type === 'member') {
      const current = store.memberOf(first)
      if (current) store.touch(album(current.albumId))
      store.setMember(first, value, restoring)
      if (value) store.touch(album(value.albumId))
    } else if (value) store.setLink(value)
    else store.removeLink(first, second, third)
  }
  // Whether the spine still holds what the write left. A scan may renumber a track, and an
  // undo re-dates a decision, so those are compared by what they mean.
  const holds = (type, current, after) => {
    if (type === 'member') return current?.albumId === after?.albumId
    if (type === 'link') return current?.subject.kind === after?.subject.kind && current?.subject.id === after?.subject.id
    if (type === 'decision') return current !== undefined && current.value === after.value
    return fingerprint(current) === fingerprint(after)
  }
  const write = (type, target, after) => {
    const entry = { type, target, key: keyOf(type, ...target) }
    entry.before = read(entry)
    entry.after = after
    put(entry, after, after?.decidedAt)
    return entry
  }
  const restore = (entry, undoneAt) => {
    if (entry.type === 'decision') return put(entry, entry.before, undoneAt)
    if (entry.type !== 'member' || !entry.before) return put(entry, entry.before)
    // Back to its album at the path the latest scan saw. Pre-upgrade rows can still
    // need the original numbers from the receipt until the scanner supplies them again.
    const current = store.memberOf(entry.target[0])
    const { albumId, disc, track } = entry.before
    return put(entry, {
      albumId, path: current.path,
      disc: current.disc === entry.after.disc ? disc : current.disc,
      track: current.track === entry.after.track ? track : current.track,
    }, undefined, true)
  }

  const move = (member, albumId) => write('member', [member.assetId], { albumId, disc: member.disc, track: member.track, path: member.path })
  const APPLY = {
    'set-field'(operation, context) {
      const subject = store.requireSubject(operation.subject)
      const reads = subject.kind === 'album' ? [albumKey(subject.id)] : []
      // A hand-set trait and a favourite are user decisions, and are written as such.
      const trait = traitOfField(operation.field)
      if (trait || operation.field === FAVORITE_FIELD) {
        const [kind, name] = trait ? ['trait', trait] : ['favorite', '']
        const stored = store.decision(kind, subject, name)
        if (stored && stored.decidedAt > context.committedAt) throw invalid('older than the stored decision')
        return { writes: [write('decision', [kind, subject.kind, subject.id, name], { value: operation.value, decidedAt: context.committedAt })], reads, before: stored?.value }
      }
      // What the catalog showed until now: an earlier override, or what the sources observed.
      const before = store.fieldValue(subject, operation.field)
      const value = operation.value === undefined ? undefined : {
        value: operation.value, evidenceClass: context.basis, sourceId: context.sourceId, licence: context.licence, observedAt: context.committedAt, changeSetId: context.id,
      }
      return { writes: [write('field', [subject.kind, subject.id, operation.field], value)], reads, before }
    },
    'lock-field'(operation, context) {
      const subject = store.requireSubject(operation.subject)
      return { writes: [write('lock', [subject.kind, subject.id, operation.field], operation.locked ? context.id : undefined)], reads: subject.kind === 'album' ? [albumKey(subject.id)] : [] }
    },
    // Members move to the surviving anchor and so do the provider's album IDs, so a later scan agrees.
    'merge-albums'(operation) {
      const into = requireAlbum(operation.into)
      const writes = operation.from.map(requireAlbum).flatMap(from => [
        ...store.membersOf(from).map(member => move(member, into)),
        ...store.albumLinks(from).map(link => write('link', [link.sourceId, link.kind, link.externalId], { ...link, subject: album(into) })),
      ])
      return { writes, reads: [into, ...operation.from].map(albumKey) }
    },
    'split-album'(operation, context) {
      const from = requireAlbum(operation.albumId)
      const members = new Map(store.membersOf(from).map(member => [member.assetId, member]))
      if (!operation.assetIds.every(assetId => members.has(assetId))) throw invalid('not a track of the album')
      if (operation.assetIds.length >= members.size) throw invalid('a split leaves at least one track')
      const createdAlbumId = store.newAlbum(context.committedAt)
      return { writes: operation.assetIds.map(assetId => move(members.get(assetId), createdAlbumId)), reads: [albumKey(from)], creates: [albumKey(createdAlbumId)], createdAlbumId }
    },
    'move-track'(operation) {
      const { id: assetId } = store.requireSubject({ kind: 'asset', id: operation.assetId })
      const albumId = requireAlbum(operation.albumId)
      const current = store.memberOf(assetId)
      const after = { albumId, disc: current?.disc, track: current?.track, path: current?.path ?? '' }
      return { writes: [write('member', [assetId], after)], reads: [albumId, ...current ? [current.albumId] : []].map(albumKey) }
    },
    'relink-provider'(operation, context) {
      const source = store.findSource(operation.sourceId)
      if (!source) throw catalogError('unknown-source', operation.sourceId)
      if (!APPROVING_CLASSES.includes(source.evidenceClass)) throw catalogError('model-cannot-link', source.id)
      const subject = store.requireSubject(operation.subject)
      const link = { sourceId: source.id, kind: operation.linkKind, externalId: operation.externalId, subject, evidenceClass: source.evidenceClass, linkedAt: context.committedAt }
      return { writes: [write('link', [source.id, operation.linkKind, operation.externalId], link)], reads: subject.kind === 'album' ? [albumKey(subject.id)] : [] }
    },
  }

  // What an operation changes, for the stale check, and which locks stand in its way.
  const subjectsOf = operation => {
    if (operation.kind === 'merge-albums') return [operation.into, ...operation.from].map(album)
    if (operation.kind === 'split-album') return [album(operation.albumId)]
    if (operation.kind === 'move-track') return [album(operation.albumId), { kind: 'asset', id: operation.assetId }]
    return [operation.subject]
  }
  const locksOf = operation => {
    if (operation.kind === 'set-field') return [{ subject: operation.subject, field: operation.field }]
    if (operation.kind === 'relink-provider') return [{ subject: operation.subject, field: LINKS_LOCK_FIELD }]
    if (operation.kind === 'lock-field') return []
    const current = operation.kind === 'move-track' ? store.memberOf(operation.assetId)?.albumId : undefined
    const albums = operation.kind === 'move-track' ? [operation.albumId, ...current ? [current] : []] : subjectsOf(operation).map(subject => subject.id)
    return albums.map(id => ({ subject: album(id), field: MEMBERSHIP_LOCK_FIELD }))
  }

  // The service reads the class of each item from the registry, so an author cannot claim one.
  const resolveEvidence = (author, references) => {
    const evidence = author.kind === 'user' ? [{ evidenceClass: 'user', supports: true, sourceId: USER_SOURCE_ID, licence: USER_SOURCE.licence }] : []
    for (const reference of references) {
      const observation = reference.observationId === undefined ? undefined : store.findObservation(reference.observationId)
      const source = reference.sourceId === undefined ? undefined : store.findSource(reference.sourceId)
      if (reference.observationId !== undefined && !observation) throw catalogError('unknown-observation', reference.observationId)
      if (reference.sourceId !== undefined && !source) throw catalogError('unknown-source', reference.sourceId)
      const { evidenceClass, licence } = observation ?? source
      if (evidenceClass === 'user' && author.kind !== 'user') throw invalid('only the user gives user evidence')
      evidence.push({ evidenceClass, supports: reference.supports, sourceId: observation?.sourceId ?? source.id, observationId: observation?.id, licence })
    }
    return evidence
  }

  // One object per change set while an operation runs, whichever query found it.
  const openSession = () => {
    const cache = new Map()
    const intern = record => {
      if (!record) return undefined
      if (!cache.has(record.id)) cache.set(record.id, record)
      return cache.get(record.id)
    }
    return {
      find: id => cache.get(id) ?? intern(store.findChangeSet(id)),
      byKeys: keys => (keys.length ? store.changeSetsByKeys(keys).map(intern) : []),
      adopt: record => { cache.set(record.id, record) },
    }
  }
  const appliedIndexes = record => record.operations.flatMap((operation, index) => (operation.state === 'applied' ? [index] : []))
  const writeKeys = (record, indexes) => unique(indexes.flatMap(index => record.operations[index].writes.map(entry => entry.key)))

  // The applied operations that build on the given ones: a later write to the same state,
  // a use of an album they created, or a change set that names this one.
  const dependentsOf = (session, record, indexes) => {
    const chosen = indexes.map(index => {
      const operation = record.operations[index]
      return { index, written: new Set(operation.writes.map(entry => entry.key)), created: new Set(operation.creates ?? []) }
    })
    const keys = unique([...chosen.flatMap(item => [...item.written, ...item.created]), changeSetKey(record.id)])
    const found = []
    for (const other of session.byKeys(keys)) {
      if (other.seq < record.seq) continue
      const sameSet = other.id === record.id
      const named = !sameSet && other.dependsOn.includes(record.id)
      const dependent = appliedIndexes(other).filter(index => {
        if (sameSet && indexes.includes(index)) return false
        const operation = other.operations[index]
        return named || chosen.some(item => (!sameSet || index > item.index)
          && (operation.writes.some(entry => item.written.has(entry.key)) || operation.reads.some(key => item.created.has(key))))
      })
      if (dependent.length) found.push({ record: other, indexes: dependent })
    }
    return found
  }

  const refreshState = (session, record) => {
    const applied = appliedIndexes(record)
    const previous = record.state
    if (!applied.length) record.state = record.suppressed ? 'suppressed' : 'undone'
    else {
      const keys = writeKeys(record, applied)
      const covered = new Set(session.byKeys(keys).filter(other => other.seq > record.seq).flatMap(other => writeKeys(other, appliedIndexes(other))))
      record.state = keys.length > 0 && keys.every(key => covered.has(key)) ? 'superseded' : 'applied'
    }
    return record.state !== previous
  }
  // Change sets that wrote the same state may have become superseded, or effective again.
  const refreshNeighbours = (session, keys, changed) => {
    for (const other of session.byKeys(keys)) if (refreshState(session, other) && !changed.includes(other)) store.updateChangeSet(other)
  }

  const view = (session, record) => ({
    id: record.id, author: record.author,
    operations: record.operations.map(({ operation, state, createdAlbumId, before }) => ({ operation, state, createdAlbumId, before })),
    evidence: record.evidence, verdict: record.verdict, dependsOn: record.dependsOn,
    dependents: unique(dependentsOf(session, record, appliedIndexes(record)).map(item => item.record.id)).filter(id => id !== record.id),
    state: record.state, committedAt: record.committedAt, version: record.version, summary: record.summary, undos: record.undos,
  })

  // The user still moving the same control: the new value joins the change set that began
  // the gesture, which keeps the value from before it. Anything else commits on its own.
  const amend = (session, input) => {
    const target = session.find(input.amends)
    const [operation, ...others] = input.operations
    const [first, ...rest] = target?.operations ?? []
    const same = target && !others.length && !rest.length && input.author.kind === 'user' && target.author.kind === 'user' && first.state === 'applied'
      && operation.kind === 'set-field' && fingerprint({ ...operation, value: undefined }) === fingerprint({ ...first.operation, value: undefined })
    if (!same || first.writes.length !== 1 || dependentsOf(session, target, [0]).length) return undefined
    const [entry] = first.writes
    if (!holds(entry.type, read(entry), entry.after)) return undefined
    const after = entry.type === 'decision' ? { value: operation.value, decidedAt: input.committedAt }
      : operation.value === undefined ? undefined : { ...entry.after, value: operation.value, observedAt: input.committedAt, changeSetId: target.id }
    if (entry.type !== 'decision' && entry.after === undefined) return undefined
    put(entry, after, after?.decidedAt)
    entry.after = after
    first.operation = operation
    target.committedAt = input.committedAt
    target.version = store.flush()
    store.updateChangeSet(target)
    return { status: 'applied', changeSet: view(session, target), version: target.version, rebased: false, replayed: false }
  }

  const commit = input => {
    const session = openSession()
    const rejected = (reason, detail) => ({ status: 'rejected', reason, version: store.version(), ...detail })
    const existing = session.find(input.id)
    const requested = fingerprint({ author: input.author, operations: input.operations, evidence: input.evidence, dependsOn: input.dependsOn })
    if (existing) {
      // A retry after a lost acknowledgement: the work is done, so it is only reported again.
      if (existing.fingerprint !== requested) throw catalogError('change-set-conflict', input.id)
      return { status: 'applied', changeSet: view(session, existing), version: store.version(), rebased: false, replayed: true }
    }
    const amended = input.amends === undefined ? undefined : amend(session, input)
    if (amended) return amended
    const resolved = resolveEvidence(input.author, input.evidence)
    const verdict = validateCatalogChange({ evidence: resolved })
    if (!verdict.approvable) return rejected('not-approvable', { verdict })
    const automated = input.author.kind !== 'user'
    if (automated) {
      const author = suppressionAuthor(input.author)
      const suppressedBy = input.operations.map(operation => store.suppression(author, fingerprint(operation))).find(id => id !== undefined)
      if (suppressedBy !== undefined) return rejected('suppressed', { suppressedBy })
      const locks = input.operations.flatMap(locksOf).filter(lock => store.lock(lock.subject, lock.field) !== undefined)
      if (locks.length) return rejected('locked', { locks })
    }
    const before = store.version()
    if (input.baseVersion !== undefined) {
      if (input.baseVersion > before) throw invalid('baseVersion is ahead of the catalog')
      // Stale only where it matters: a subject the change touches moved on after it was computed.
      const subjects = input.operations.flatMap(subjectsOf).filter(subject => store.subjectVersion(subject) > input.baseVersion)
      if (subjects.length) return rejected('stale', { subjects: unique(subjects.map(fingerprint)).map(text => JSON.parse(text)) })
    }
    const missing = input.dependsOn.filter(id => {
      const dependency = session.find(id)
      if (!dependency) throw catalogError('unknown-change-set', id)
      return dependency.state !== 'applied' && dependency.state !== 'superseded'
    })
    if (missing.length) return rejected('dependency-not-applied', { dependsOn: missing })

    const supporting = resolved.filter(item => item.supports && item.evidenceClass === verdict.basis)
    const context = { id: input.id, committedAt: input.committedAt, basis: verdict.basis, sourceId: supporting[0].sourceId, licence: propagateLicence(supporting.map(item => item.licence)) }
    const operations = input.operations.map(operation => {
      const { writes, reads, creates, createdAlbumId, before } = APPLY[operation.kind](operation, context)
      return { operation, state: 'applied', writes, reads, creates, createdAlbumId, before }
    })
    const record = {
      id: input.id, fingerprint: requested, author: input.author, operations, verdict, dependsOn: input.dependsOn, state: 'applied', committedAt: input.committedAt,
      evidence: resolved.map(({ licence, ...item }) => item), version: before, summary: input.summary, undos: [],
    }
    const written = unique(operations.flatMap(operation => operation.writes.map(entry => entry.key)))
    record.keys = unique([...written, ...operations.flatMap(operation => [...operation.reads, ...operation.creates ?? []]), ...input.dependsOn.map(changeSetKey)])
    store.insertChangeSet(record)
    record.version = store.flush()
    if (record.version !== before) store.updateChangeSet(record)
    session.adopt(record)
    refreshNeighbours(session, written, [record])
    return { status: 'applied', changeSet: view(session, record), version: record.version, rebased: input.baseVersion !== undefined && input.baseVersion < before, replayed: false }
  }

  // Dependents go first, newest first, so every write is undone against the state it left.
  const undoOperations = (session, record, indexes, request, root, undone) => {
    const dependents = dependentsOf(session, record, indexes)
    if (dependents.length && !request.cascade) throw new Blocked('has-dependents', unique(dependents.map(item => item.record.id)))
    for (const dependent of dependents.sort((a, b) => b.record.seq - a.record.seq)) {
      undoOperations(session, dependent.record, dependent.indexes.filter(index => dependent.record.operations[index].state === 'applied'), request, root, undone)
    }
    const live = indexes.filter(index => record.operations[index].state === 'applied').sort((a, b) => b - a)
    for (const index of live) {
      const operation = record.operations[index]
      for (const entry of [...operation.writes].reverse()) {
        if (!holds(entry.type, read(entry), entry.after)) throw new Blocked('changed-since', [record.id])
        restore(entry, request.undoneAt)
      }
      operation.state = 'undone'
    }
    if (!live.length) return
    record.undos.push({ operations: live.reverse(), author: request.author, undoneAt: request.undoneAt, causedBy: record === root ? undefined : root.id })
    if (!undone.includes(record)) undone.push(record)
    // Only what the user turned down directly is held against its route.
    const author = suppressionAuthor(record.author)
    if (record !== root || request.author.kind !== 'user' || author === undefined) return
    for (const index of live) store.setSuppression(author, fingerprint(record.operations[index].operation), record.id)
    record.suppressed = true
  }
  const undo = request => {
    const session = openSession()
    const record = session.find(request.id)
    if (!record) throw catalogError('unknown-change-set', request.id)
    const indexes = request.operations ?? record.operations.map((operation, index) => index)
    if (indexes.some(index => !isCount(index) || index >= record.operations.length)) throw invalid('operation index')
    const undone = []
    undoOperations(session, record, unique(indexes), request, record, undone)
    for (const item of undone) refreshState(session, item)
    for (const item of undone) store.updateChangeSet(item)
    refreshNeighbours(session, unique(undone.flatMap(item => writeKeys(item, item.operations.map((operation, index) => index)))), undone)
    const version = store.flush()
    return { status: 'undone', changeSets: unique([record, ...undone]).map(item => view(session, item)), version }
  }
  const normalUndo = request => {
    if (!isObject(request) || !isCatalogId(request.id) || !isCount(request.undoneAt)) throw invalid('undo')
    if (!optional(request.operations, value => Array.isArray(value) && value.length > 0) || !optional(request.cascade, value => typeof value === 'boolean')) throw invalid('undo')
    return { id: request.id, operations: request.operations, cascade: request.cascade === true, author: request.author === undefined ? USER_AUTHOR : normalAuthor(request.author), undoneAt: request.undoneAt }
  }
  // A refusal undoes nothing: the transaction it was thrown out of has rolled back.
  const guarded = body => {
    try { return store.transaction(body) } catch (error) {
      if (error instanceof Blocked) return { ...error.result, version: store.version() }
      throw error
    }
  }

  return {
    commitChangeSet(input) {
      const normal = normalInput(input)
      return store.transaction(() => commit(normal))
    },
    undoChangeSet(request) {
      const normal = normalUndo(request)
      return guarded(() => undo(normal))
    },
    undoField(request) {
      if (!isObject(request) || !isText(request.field)) throw invalid('undo')
      const subject = normalSubject(request.subject)
      const trait = traitOfField(request.field)
      const key = trait ? keyOf('decision', 'trait', subject.kind, subject.id, trait)
        : request.field === FAVORITE_FIELD ? keyOf('decision', 'favorite', subject.kind, subject.id, '') : keyOf('field', subject.kind, subject.id, request.field)
      return guarded(() => {
        const latest = store.changeSetsByKeys([key]).findLast(record => appliedIndexes(record).some(index => record.operations[index].writes.some(entry => entry.key === key)))
        if (!latest) throw new Blocked('nothing-to-undo', [])
        const index = appliedIndexes(latest).findLast(item => latest.operations[item].writes.some(entry => entry.key === key))
        return undo(normalUndo({ id: latest.id, operations: [index], cascade: request.cascade, undoneAt: request.undoneAt }))
      })
    },
    getChangeSet(request) {
      const session = openSession()
      const record = isCatalogId(request?.id) ? session.find(request.id) : undefined
      return { changeSet: record && view(session, record) }
    },
    listChangeSets(request = {}) {
      const { offset = 0, limit = DEFAULT_CHANGE_PAGE } = request
      if (!isCount(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_PAGE) throw invalid('change set page')
      const session = openSession()
      const { records, total } = store.changeSetPage({ offset, limit })
      return { changeSets: records.map(record => view(session, session.find(record.id))), total, version: store.version() }
    },
  }
}
