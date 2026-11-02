import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanCheck, type Node } from '../src/reader.js'

const page = (controls: number): Node => ({ children: Array.from({ length: controls }, (_, i) => ({ ref: i + 1, role: 'link', name: `l${i}` })) })
const CHECK = 'https://www.google.com/recaptcha/api2/anchor?k=x'

test('a check frame on a page with almost nothing else is a human check in front of the page', () => {
  assert.equal(humanCheck([CHECK], page(3), 30), true)
})

test('a check frame guarding one form on a full page is not a block', () => {
  assert.equal(humanCheck(['https://shop.example/', CHECK], page(240), 30), false)
})

test('no check frame, no human check', () => {
  assert.equal(humanCheck(['https://shop.example/'], page(2), 30), false)
})

test('an invisible check (a badge that only scores the visitor) is not a block', () => {
  assert.equal(humanCheck(['https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible'], page(3), 30), false)
})
