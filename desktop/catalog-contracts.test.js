import test from 'node:test'
import assert from 'node:assert/strict'
import { runCatalogContractSuite } from '../shared/catalog-contract-suite.js'
import { createFakeCatalogService } from '../shared/catalog-fake.js'
import {
  LICENCE_ORDER, licenceAllowsCommercialUse, propagateEvidenceClass, propagateLicence, validateCatalogChange,
} from '../shared/catalog-rules.js'

runCatalogContractSuite('fake catalog service', () => ({ service: createFakeCatalogService() }))

const evidence = (evidenceClass, supports = true) => ({ evidenceClass, supports })
const verdict = (...items) => validateCatalogChange({ kind: 'merge', subjects: [], evidence: items })

test('model evidence never approves a catalog change', () => {
  assert.deepEqual(verdict(), { approvable: false, reason: 'no-evidence' })
  assert.deepEqual(verdict(evidence('model'), evidence('model')), { approvable: false, reason: 'model-only' })
  assert.deepEqual(verdict(evidence('guess')), { approvable: false, reason: 'model-only' })
  assert.deepEqual(verdict(evidence('deterministic'), evidence('model', false)), { approvable: true, basis: 'deterministic' })
  assert.deepEqual(verdict(evidence('deterministic'), evidence('deterministic', false), evidence('model')), { approvable: false, reason: 'contradicted' })
  assert.deepEqual(verdict(evidence('user'), evidence('deterministic', false)), { approvable: true, basis: 'user' })
  assert.deepEqual(verdict(evidence('user', false), evidence('deterministic'), evidence('model')), { approvable: false, reason: 'rejected-by-user' })
  assert.deepEqual(verdict({ evidenceClass: 'deterministic' }), { approvable: false, reason: 'contradicted' })
})

test('derived data takes the most restrictive licence of its inputs', () => {
  assert.equal(propagateLicence(['CC0-1.0']), 'CC0-1.0')
  assert.equal(propagateLicence(['user', 'MIT', 'CC-BY-4.0']), 'CC-BY-4.0')
  assert.equal(propagateLicence(['CC-BY-NC-SA-3.0', 'CC0-1.0']), 'CC-BY-NC-SA-3.0')
  assert.equal(propagateLicence(['MIT', 'made-up']), 'unknown')
  assert.equal(propagateLicence(['unknown', 'proprietary', 'MIT']), 'proprietary')
  assert.equal(propagateLicence([]), 'unknown')
  for (const [index, licence] of LICENCE_ORDER.entries()) {
    for (const other of LICENCE_ORDER.slice(index)) assert.equal(propagateLicence([other, licence]), other)
  }
  assert.deepEqual(LICENCE_ORDER.filter(licenceAllowsCommercialUse), ['user', 'CC0-1.0', 'MIT', 'CC-BY-4.0'])
  assert.equal(licenceAllowsCommercialUse('made-up'), false)
})

test('a value derived from model evidence is model evidence', () => {
  assert.equal(propagateEvidenceClass('deterministic', []), 'deterministic')
  assert.equal(propagateEvidenceClass('user', ['deterministic']), 'user')
  assert.equal(propagateEvidenceClass('deterministic', ['user', 'model']), 'model')
  assert.equal(propagateEvidenceClass('model', []), 'model')
})
