/**
 * The row's actions on both kinds of device, without a browser.
 *
 * The failure this file exists for: Edit and Delete were collapsed on every device to keep the
 * ledger quiet, so a phone — which cannot hover — was left with two invisible buttons that still
 * swallowed taps. The fix is a capability query, so the gate on it has to be the stylesheet's own
 * cascade, not a string match. This file parses public/style.css, resolves the cascade for a 390 px
 * finger and a 1280 px pointer, and applies it to the DOM the page actually builds: a group screen
 * with an expense, a payment, a waiting member and an approved one.
 *
 * Two habits are load-bearing here. Every hiding declaration on the cluster must sit inside
 * `@media (hover: hover)`, and that scan is shown to fail on an in-memory mutant that lifts the
 * hiding rule out of the query — a resolver that reads nothing would pass every assertion written
 * over it. And every absence claim is preceded by a presence count: the tests that say "no control
 * is faded" first prove the scan can see at least eight controls, both row actions and three roster
 * controls.
 *
 * What this file cannot see is pixels. elementFromPoint, a live hover and Tab traversal need a
 * Chromium/CDP harness (scripts/e2e/page-actions.mjs, item 841); this file proves the cascade and
 * the controls the page builds, and does not claim to prove paint.
 *
 * No jsdom and no browser: public/app.js is a plain ES module whose DOM wiring sits behind a
 * guard, so `init` is handed a stand-in document and window, exactly as tests/lifecycle.test.mjs
 * does.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { init } from '../public/app.js';
import {
  deriveGroupKey,
  formatCode,
  generateCode,
  groupIdFromCode,
  idFromSecret,
  randomSecret,
  seal
} from '../public/crypto.js';
import { expenseAad, settlementAad } from '../public/expense.js';
import { saveCode, saveSession, setLastGroup } from '../public/store.js';
import { saveCache } from '../public/cache.js';

const pageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(join(pageRoot, 'public', 'index.html'), 'utf8');
const stylesheet = readFileSync(join(pageRoot, 'public', 'style.css'), 'utf8');

/* The two devices this item is about: a finger that cannot hover, and a pointer that can. */
const PHONE = Object.freeze({ width: 390, hover: 'none', scheme: 'dark', media: 'screen' });
const DESK = Object.freeze({ width: 1280, hover: 'hover', scheme: 'dark', media: 'screen' });

/* --------------------------------------------------------------- the stylesheet */

/** Split a selector or media condition on a separator that is not inside brackets or parens. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let buffer = '';
  for (const character of text) {
    if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    if (depth === 0 && character === separator) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += character;
  }
  parts.push(buffer);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseDeclarations(source) {
  const declarations = [];
  for (const part of source.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (!property) continue;
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, '').trim();
    declarations.push({ property, value, important });
  }
  return declarations;
}

const OUTLINE_STYLES = new Set(['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']);
const OUTLINE_WIDTH = /^(?:thin|medium|thick|[\d.]+(?:px|rem|em))$/;

/** The longhands this file reads, so `outline: 2px solid` can compete with `outline-offset`. */
function expandDeclarations(declarations) {
  const expanded = [];
  for (const declaration of declarations) {
    if (declaration.property !== 'outline') {
      expanded.push(declaration);
      continue;
    }
    let style = null;
    let width = null;
    for (const token of declaration.value.split(/\s+/).filter(Boolean)) {
      if (style === null && OUTLINE_STYLES.has(token)) {
        style = token;
        continue;
      }
      if (width === null && OUTLINE_WIDTH.test(token)) {
        width = token;
        continue;
      }
      expanded.push({ ...declaration, property: 'outline-color', value: token });
    }
    expanded.push({ ...declaration, property: 'outline-style', value: style ?? 'none' });
    expanded.push({ ...declaration, property: 'outline-width', value: width ?? 'medium' });
  }
  return expanded;
}

/**
 * Every rule, its media context and its declarations.
 *
 * An at-rule this resolver does not model is an error rather than a skip: silently ignoring a block
 * is exactly how a hiding declaration would escape the scans below.
 */
function parseStylesheet(text) {
  const rules = [];
  collectRules(text.replace(/\/\*[\s\S]*?\*\//g, ''), null, rules);
  return rules;
}

function collectRules(source, media, rules) {
  let index = 0;
  while (index < source.length) {
    const brace = source.indexOf('{', index);
    if (brace === -1) break;
    const prelude = source.slice(index, brace).trim();
    let depth = 0;
    let close = -1;
    for (let cursor = brace; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    if (close === -1) throw new Error('style.css has an unclosed block');
    const body = source.slice(brace + 1, close);
    if (prelude.startsWith('@media')) {
      collectRules(body, { condition: prelude.slice('@media'.length).trim(), parent: media }, rules);
    } else if (prelude.startsWith('@')) {
      throw new Error(`the resolver does not model ${prelude}`);
    } else if (prelude) {
      rules.push({
        order: rules.length,
        media,
        selectorText: prelude,
        selectors: splitTopLevel(prelude, ',').map((selector) => ({
          text: selector,
          chain: parseSelector(selector),
          specificity: specificityOf(selector)
        })),
        declarations: expandDeclarations(parseDeclarations(body))
      });
    }
    index = close + 1;
  }
}

function specificityOf(selector) {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  const attributes = (selector.match(/\[[^\]]*\]/g) ?? []).length;
  const pseudos = (selector.match(/:(?!:)[\w-]+/g) ?? []).length;
  const without = selector.replace(/\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?|#[\w-]+/g, ' ');
  const types = (without.match(/(?:^|[\s>+])([a-zA-Z][\w-]*)/g) ?? []).length;
  return [ids, classes + attributes + pseudos, types];
}

function compareSpecificity(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const COMBINATORS = new Set(['>', '+']);

/** A selector as a right-to-left chain of compounds, with the combinator that links each one left. */
function parseSelector(text) {
  const segments = [];
  let buffer = '';
  let depth = 0;
  for (const character of text.trim()) {
    if (character === '[' || character === '(') depth += 1;
    if (character === ']' || character === ')') depth -= 1;
    if (depth === 0 && COMBINATORS.has(character)) {
      if (buffer.trim()) segments.push(buffer.trim());
      segments.push(character);
      buffer = '';
      continue;
    }
    if (depth === 0 && /\s/.test(character)) {
      if (buffer.trim()) segments.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += character;
  }
  if (buffer.trim()) segments.push(buffer.trim());

  const chain = [];
  let combinator = ' ';
  for (const segment of segments) {
    if (COMBINATORS.has(segment)) {
      combinator = segment;
      continue;
    }
    chain.push({ compound: parseCompound(segment), combinator: chain.length === 0 ? null : combinator });
    combinator = ' ';
  }
  return chain;
}

function parseCompound(text) {
  const tests = [];
  let index = 0;
  const type = /^(\*|[a-zA-Z][\w-]*)/.exec(text);
  if (type) {
    if (type[1] !== '*') tests.push({ kind: 'type', value: type[1].toUpperCase() });
    index = type[0].length;
  }
  while (index < text.length) {
    const character = text[index];
    if (character === '.') {
      const match = /^\.([\w-]+)/.exec(text.slice(index));
      if (!match) throw new Error(`unreadable class selector in ${text}`);
      tests.push({ kind: 'class', value: match[1] });
      index += match[0].length;
      continue;
    }
    if (character === '#') {
      const match = /^#([\w-]+)/.exec(text.slice(index));
      if (!match) throw new Error(`unreadable id selector in ${text}`);
      tests.push({ kind: 'id', value: match[1] });
      index += match[0].length;
      continue;
    }
    if (character === '[') {
      const end = text.indexOf(']', index);
      if (end === -1) throw new Error(`unclosed attribute selector in ${text}`);
      const inner = text.slice(index + 1, end).trim();
      const match = /^([\w-]+)(?:\s*([~^$*|]?=)\s*"?([^"]*)"?)?$/.exec(inner);
      if (!match) throw new Error(`unreadable attribute selector [${inner}]`);
      tests.push({
        kind: 'attribute',
        name: match[1],
        operator: match[2] ?? null,
        value: match[3] ?? null
      });
      index = end + 1;
      continue;
    }
    if (character === ':') {
      const match = /^::?([\w-]+)(?:\(([^)]*)\))?/.exec(text.slice(index));
      if (!match) throw new Error(`unreadable pseudo-class in ${text}`);
      tests.push({ kind: 'pseudo', name: match[1], argument: match[2] ?? null });
      index += match[0].length;
      continue;
    }
    throw new Error(`unreadable selector ${text} at ${text.slice(index)}`);
  }
  return tests;
}

function classNames(node) {
  return String(node.className ?? '').split(/\s+/).filter(Boolean);
}

function elementChildren(node) {
  return node.childNodes.filter((child) => typeof child?.tagName === 'string');
}

function attributeValue(node, name) {
  if (name === 'class') return node.className || null;
  if (name === 'id') return node.attributes.id ?? null;
  if (name === 'hidden') return node.hidden === true ? '' : null;
  if (name === 'disabled') return node.disabled === true ? '' : null;
  if (name === 'checked') return node.checked === true ? '' : null;
  if (name === 'type') return node.type || node.attributes.type || null;
  if (Object.hasOwn(node.attributes, name)) return node.attributes[name];
  if (name.startsWith('data-')) {
    const key = name.slice(5).replace(/-([a-z])/g, (_whole, letter) => letter.toUpperCase());
    if (Object.hasOwn(node.dataset, key)) return String(node.dataset[key]);
  }
  return null;
}

function matchesAttribute(node, test) {
  const actual = attributeValue(node, test.name);
  if (actual === null || actual === undefined) return false;
  if (test.operator === null) return true;
  const expected = test.value ?? '';
  switch (test.operator) {
    case '=':
      return actual === expected;
    case '~=':
      return String(actual).split(/\s+/).includes(expected);
    case '^=':
      return String(actual).startsWith(expected);
    case '$=':
      return String(actual).endsWith(expected);
    case '*=':
      return String(actual).includes(expected);
    case '|=':
      return actual === expected || String(actual).startsWith(`${expected}-`);
    default:
      throw new Error(`unreadable attribute operator ${test.operator}`);
  }
}

function matchesPseudo(node, name) {
  switch (name) {
    case 'root':
      return node.tagName === 'HTML';
    case 'hover':
      return node.hover === true;
    case 'focus-within':
      return node.focusWithin === true;
    case 'focus-visible':
      return node.focusVisible === true;
    case 'disabled':
      return node.disabled === true;
    case 'checked':
      return node.checked === true;
    case 'first-child':
      return node.parentElement ? elementChildren(node.parentElement)[0] === node : false;
    default:
      throw new Error(`the resolver does not model :${name}`);
  }
}

function matchesCompound(node, tests) {
  return tests.every((test) => {
    if (test.kind === 'type') return node.tagName === test.value;
    if (test.kind === 'class') return classNames(node).includes(test.value);
    if (test.kind === 'id') return node.attributes.id === test.value;
    if (test.kind === 'attribute') return matchesAttribute(node, test);
    return matchesPseudo(node, test.name);
  });
}

function matchesChain(node, chain, index = chain.length - 1) {
  if (!node || index < 0) return false;
  if (!matchesCompound(node, chain[index].compound)) return false;
  if (index === 0) return true;
  const combinator = chain[index].combinator;
  if (combinator === '>') return matchesChain(node.parentElement, chain, index - 1);
  if (combinator === '+') {
    const siblings = node.parentElement ? elementChildren(node.parentElement) : [];
    return matchesChain(siblings[siblings.indexOf(node) - 1], chain, index - 1);
  }
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (matchesChain(ancestor, chain, index - 1)) return true;
  }
  return false;
}

function mediaConditionMatches(condition, environment) {
  return condition
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .every((feature) => {
      let match;
      if ((match = /^\(\s*min-width\s*:\s*([\d.]+)(rem|px)\s*\)$/i.exec(feature))) {
        return environment.width >= Number(match[1]) * (match[2].toLowerCase() === 'rem' ? 16 : 1);
      }
      if ((match = /^\(\s*max-width\s*:\s*([\d.]+)(rem|px)\s*\)$/i.exec(feature))) {
        return environment.width <= Number(match[1]) * (match[2].toLowerCase() === 'rem' ? 16 : 1);
      }
      if ((match = /^\(\s*hover\s*:\s*(hover|none)\s*\)$/i.exec(feature))) {
        return environment.hover === match[1].toLowerCase();
      }
      if ((match = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(feature))) {
        return environment.scheme === match[1].toLowerCase();
      }
      if (/^print$/i.test(feature)) return environment.media === 'print';
      if (/^screen$/i.test(feature)) return environment.media === 'screen';
      throw new Error(`the resolver does not model @media ${feature}`);
    });
}

function mediaApplies(media, environment) {
  if (!media) return true;
  for (let node = media; node; node = node.parent) {
    if (!mediaConditionMatches(node.condition, environment)) return false;
  }
  return true;
}

const INITIAL_VALUES = new Map([
  ['opacity', '1'],
  ['pointer-events', 'auto'],
  ['display', 'block'],
  ['visibility', 'visible'],
  ['outline-width', 'medium'],
  ['outline-style', 'none'],
  ['outline-color', 'currentcolor'],
  ['outline-offset', '0px']
]);
const INHERITED_PROPERTIES = new Set(['pointer-events', 'visibility']);

/** The cascade, resolved for one node in one media environment. Inheritance is included. */
function resolveStyle(node, environment, rules = parseStylesheet(stylesheet)) {
  const memo = new Map();
  const value = (current, property) => {
    const key = `${current.uid}:${property}`;
    if (memo.has(key)) return memo.get(key);

    const declarations = [];
    for (const rule of rules) {
      if (!mediaApplies(rule.media, environment)) continue;
      let specificity = null;
      for (const selector of rule.selectors) {
        if (!matchesChain(current, selector.chain)) continue;
        if (specificity === null || compareSpecificity(selector.specificity, specificity) > 0) {
          specificity = selector.specificity;
        }
      }
      if (specificity === null) continue;
      for (const declaration of rule.declarations) {
        if (declaration.property !== property) continue;
        declarations.push({ ...declaration, specificity, order: rule.order });
      }
    }

    let resolved;
    if (declarations.length > 0) {
      const important = declarations.filter((declaration) => declaration.important);
      const pool = important.length > 0 ? important : declarations;
      pool.sort((left, right) => {
        const bySpecificity = compareSpecificity(left.specificity, right.specificity);
        return bySpecificity !== 0 ? bySpecificity : left.order - right.order;
      });
      resolved = pool.at(-1).value;
    } else if (INHERITED_PROPERTIES.has(property) && current.parentElement) {
      resolved = value(current.parentElement, property);
    } else {
      resolved = INITIAL_VALUES.get(property) ?? 'initial';
    }

    memo.set(key, resolved);
    return resolved;
  };
  return { get: (property) => value(node, property) };
}

/* ------------------------------------------------------------- what hiding means */

function hides(declaration) {
  if (declaration.property === 'opacity') return Number(declaration.value) < 1;
  if (declaration.property === 'pointer-events') return declaration.value === 'none';
  if (declaration.property === 'display') return declaration.value === 'none';
  if (declaration.property === 'visibility') {
    return declaration.value === 'hidden' || declaration.value === 'collapse';
  }
  return false;
}

function hoverCapabilityGuard(media) {
  for (let node = media; node; node = node.parent) {
    if (/\(\s*hover\s*:\s*hover\s*\)/i.test(node.condition)) return true;
  }
  return false;
}

/**
 * Every declaration that hides the cluster, and whether it is behind a hover-capability query.
 *
 * The scan is text-based on purpose: it reads the sheet as written, so a hiding rule cannot hide
 * from it by only applying in one environment.
 */
function hidingDeclarations(rules) {
  const problems = [];
  let found = 0;
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => /\.expense-actions\b/.test(selector.text))) continue;
    for (const declaration of rule.declarations) {
      if (!hides(declaration)) continue;
      found += 1;
      if (!hoverCapabilityGuard(rule.media)) {
        problems.push(
          `${rule.selectorText} hides with ${declaration.property} ${declaration.value} outside @media (hover: hover)`
        );
      }
    }
  }
  return { problems, found };
}

/** Every rule that paints something below full opacity must also take it out of the pointer path. */
function transparencyViolations(rules) {
  const problems = [];
  let checked = 0;
  for (const rule of rules) {
    const faded = rule.declarations.filter(
      (declaration) => declaration.property === 'opacity' && Number(declaration.value) < 1
    );
    if (faded.length === 0) continue;
    checked += 1;
    const pointer = rule.declarations.find((declaration) => declaration.property === 'pointer-events');
    if (!pointer || pointer.value !== 'none') {
      problems.push(
        `${rule.selectorText} sets opacity ${faded.map((declaration) => declaration.value).join('/')} without pointer-events: none`
      );
    }
  }
  return { problems, checked };
}

function visibleAndTappable(style) {
  const problems = [];
  if (style.get('opacity') !== '1') problems.push(`opacity ${style.get('opacity')}`);
  if (style.get('pointer-events') === 'none') problems.push('pointer-events none');
  if (style.get('display') === 'none') problems.push('display none');
  if (style.get('visibility') !== 'visible') problems.push(`visibility ${style.get('visibility')}`);
  return problems;
}

/* ------------------------------------------------------------------ the DOM */

let elementCount = 0;

class FakeElement {
  constructor(tag, attributes = {}) {
    this.uid = ++elementCount;
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.checked = Object.hasOwn(attributes, 'checked');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.value = attributes.value ?? '';
    this.type = attributes.type ?? '';
    this.dataset = {};
    this.className = attributes.class ?? '';
    this.parentElement = null;
    this.childNodes = [];
    this.style = {};
    this.hover = false;
    this.focusWithin = false;
    this.focusVisible = false;
    this._text = '';
    this.listeners = new Map();
  }

  get classList() {
    const self = this;
    const names = () => new Set(String(self.className).split(/\s+/).filter(Boolean));
    const write = (set) => {
      self.className = [...set].join(' ');
    };
    return {
      add: (...values) => {
        const set = names();
        values.forEach((value) => set.add(value));
        write(set);
      },
      remove: (...values) => {
        const set = names();
        values.forEach((value) => set.delete(value));
        write(set);
      },
      contains: (value) => names().has(value),
      toggle: (value, force) => {
        const set = names();
        const wanted = force ?? !set.has(value);
        if (wanted) set.add(value);
        else set.delete(value);
        write(set);
        return wanted;
      }
    };
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
  }

  get options() {
    return elementChildren(this).filter((child) => child.tagName === 'OPTION');
  }

  get selectedIndex() {
    return this.options.findIndex((option) => option.checked);
  }

  set selectedIndex(index) {
    this.options.forEach((option, position) => {
      option.checked = position === index;
    });
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, once: options?.once === true });
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }

  dispatch(type, event = {}) {
    const delivered = { type, preventDefault() {}, ...event };
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener(delivered);
    }
  }

  click() {
    this.dispatch('click');
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }

  getAttribute(name) {
    return attributeValue(this, name);
  }

  focus() {}

  blur() {}

  querySelectorAll(selector) {
    const chains = splitTopLevel(selector, ',').map(parseSelector);
    return descendants(this).filter((node) => chains.some((chain) => matchesChain(node, chain)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function descendants(node) {
  const nodes = [];
  for (const child of elementChildren(node)) {
    nodes.push(child, ...descendants(child));
  }
  return nodes;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr'
]);

function attributesOf(source) {
  const attributes = {};
  for (const match of String(source).matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
  )) {
    attributes[match[1]] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

/** index.html as a real tree, so a hidden panel really hides the controls under it. */
function parsePage(source) {
  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  html.append(head, body);

  let current = head;
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let match;
  while ((match = tags.exec(source))) {
    /* Text between tags is what a parsed button says; without it every server-rendered label is
       blank and the control scan would compare against nothing. */
    const text = source.slice(last, match.index);
    if (text.trim() && current) current._text += text;
    last = tags.lastIndex;

    const [, closing, name, rawAttributes, selfClosing] = match;
    const tag = name.toLowerCase();
    if (tag === 'html' || tag === 'head') continue;
    if (tag === 'body') {
      if (!closing) current = body;
      continue;
    }
    if (tag === 'script' || tag === 'style') continue;
    if (closing) {
      let node = current;
      while (node && node !== body && node !== head && node.tagName.toLowerCase() !== tag) {
        node = node.parentElement;
      }
      if (node && node !== body && node !== head) current = node.parentElement ?? body;
      continue;
    }
    const element = new FakeElement(tag, attributesOf(rawAttributes));
    current.append(element);
    if (!VOID_TAGS.has(tag) && selfClosing !== '/') current = element;
  }

  return { html, body };
}

function fakeDocument() {
  const { html, body } = parsePage(pageSource);
  const all = () => descendants(html);
  return {
    documentElement: html,
    body,
    getElementById(id) {
      return all().find((node) => node.attributes.id === id) ?? null;
    },
    querySelectorAll(selector) {
      const chains = splitTopLevel(selector, ',').map(parseSelector);
      return all().filter((node) => chains.some((chain) => matchesChain(node, chain)));
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag)
  };
}

function fakeClock() {
  let next = 0;
  let now = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) {
      const id = ++next;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, delay = 0) {
      const id = ++next;
      timers.set(id, { fn, at: now + delay, every: delay });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (due === null || timer.at < due.timer.at || (timer.at === due.timer.at && id < due.id)) {
            due = { id, timer };
          }
        }
        if (due === null) break;
        now = due.timer.at;
        if (due.timer.every !== undefined) due.timer.at = now + due.timer.every;
        else timers.delete(due.id);
        due.timer.fn();
      }
    }
  };
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  message(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  drop(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code });
  }
}

function fakeWindow({ href = 'https://splitter.test/' } = {}) {
  const clock = fakeClock();
  const location = { href };
  return {
    location,
    history: {
      replaceState(_state, _title, url) {
        if (typeof url === 'string') location.href = new URL(url, location.href).toString();
      }
    },
    navigator: { onLine: true },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    WebSocket: FakeSocket,
    fetch: async () => ({ ok: true, status: 200 }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, delay) => clock.setInterval(fn, delay),
    clearInterval: (id) => clock.clearInterval(id),
    clock
  };
}

/* -------------------------------------------------------------- the fixture */

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, budgetMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (check()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await wait(2);
}

let fixturePromise = null;

/** One host, one waiting member, one approved member, one expense and one payment. */
function groupFixture() {
  fixturePromise ??= buildFixture();
  return fixturePromise;
}

async function buildFixture() {
  const code = generateCode();
  const groupId = await groupIdFromCode(code);
  const secret = randomSecret();
  const memberId = await idFromSecret(secret);
  const key = await deriveGroupKey(code);
  const pendingId = await idFromSecret(randomSecret());
  const friendId = await idFromSecret(randomSecret());

  const roster = [
    { id: memberId, status: 'approved', nameBlob: await seal(key, { name: 'Asha' }) },
    { id: pendingId, status: 'pending', nameBlob: await seal(key, { name: 'Balan' }) },
    { id: friendId, status: 'approved', nameBlob: await seal(key, { name: 'Chitra' }) }
  ];

  const expenseId = randomSecret();
  const expense = {
    id: expenseId,
    rev: 1,
    deleted: false,
    blob: await seal(
      key,
      {
        kind: 'expense',
        description: 'Dinner',
        amountPaise: 30_000,
        paidBy: [{ memberId, amountPaise: 30_000 }],
        split: { [memberId]: 30_000 },
        date: '2026-11-18',
        time: '20:00',
        note: ''
      },
      expenseAad(groupId, expenseId)
    ),
    author: memberId,
    creator: memberId,
    at: 1
  };

  const paymentId = randomSecret();
  const payment = {
    id: paymentId,
    rev: 1,
    deleted: false,
    blob: await seal(
      key,
      {
        kind: 'settlement',
        from: memberId,
        to: friendId,
        amountPaise: 5_000,
        date: '2026-11-18',
        time: '21:00',
        note: ''
      },
      settlementAad(groupId, paymentId)
    ),
    author: memberId,
    creator: memberId,
    at: 2
  };

  const nameBlob = await seal(key, { name: 'Goa trip' });
  const base = {
    groupId,
    hostId: memberId,
    memberId,
    role: 'host',
    joinMode: 'approval',
    nameBlob,
    metaBlob: null,
    roster
  };

  return {
    code,
    groupId,
    secret,
    memberId,
    pendingId,
    friendId,
    expenseId,
    paymentId,
    cached: { ...base, savedAt: Date.now(), records: [expense, payment] },
    frame: { t: 'state', ...base, records: [expense, payment] }
  };
}

/** Boot the page on the host's seat, speak once, and wait for the group to be painted. */
async function openGroup() {
  const fixture = await groupFixture();
  FakeSocket.instances = [];
  const doc = fakeDocument();
  const win = fakeWindow();

  saveSession(win.localStorage, {
    groupId: fixture.groupId,
    memberId: fixture.memberId,
    memberSecret: fixture.secret,
    displayName: 'Asha'
  });
  saveCode(win.sessionStorage, fixture.groupId, fixture.code);
  setLastGroup(win.localStorage, fixture.groupId);
  saveCache(win.localStorage, fixture.groupId, fixture.cached);

  init(doc, win);
  await until(() => FakeSocket.instances.length > 0, 'the resume socket');
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open');
  socket.message(fixture.frame);

  const pending = doc.getElementById('roster-pending');
  await until(() => doc.getElementById('ledger-list').childNodes.length > 0, 'the ledger row');
  await until(() => pending.childNodes.length > 0, 'the waiting member');
  await until(() => doc.getElementById('connection').hidden, 'the connection chip to clear');
  await settle();

  return { doc, win, socket, fixture };
}

function expenseRow(doc) {
  const row = doc
    .getElementById('ledger-list')
    .childNodes.find((node) => classNames(node).includes('expense-row'));
  assert.ok(row, 'the painted group must show an expense row');
  return row;
}

function clusterOf(row) {
  const cluster = descendants(row).find((node) => classNames(node).includes('expense-actions'));
  assert.ok(cluster, 'the expense row must carry an actions cluster');
  return cluster;
}

function isInside(ancestor, node) {
  for (let current = node; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

const CONTROL_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);

function isControl(node) {
  if (!CONTROL_TAGS.has(node.tagName)) return false;
  if (node.tagName === 'A') return Boolean(node.attributes.href);
  if (node.tagName === 'INPUT') return node.type !== 'hidden';
  return true;
}

function paintedControls(doc, environment, rules = parseStylesheet(stylesheet)) {
  return descendants(doc.body).filter((node) => {
    if (!isControl(node)) return false;
    for (let current = node; current; current = current.parentElement) {
      if (current.hidden === true) return false;
    }
    const style = resolveStyle(node, environment, rules);
    return style.get('display') !== 'none' && style.get('visibility') === 'visible';
  });
}

/* ------------------------------------------------- the stylesheet, as written */

test('the row actions are hidden only by a hover-capability media block', () => {
  const { problems, found } = hidingDeclarations(parseStylesheet(stylesheet));
  assert.ok(found >= 2, `the sheet must hide the cluster somewhere for this scan to mean anything, found ${found}`);
  assert.deepEqual(problems, [], problems.join('\n'));

  const base = parseStylesheet(stylesheet).find((rule) =>
    rule.selectors.some((selector) => selector.text === '.expense-actions')
  );
  assert.ok(base, 'the sheet must have a base .expense-actions rule');
  assert.equal(
    base.declarations.find((declaration) => declaration.property === 'display')?.value,
    'flex',
    'the cluster is a painted flex row by default'
  );
  assert.equal(
    base.declarations.some((declaration) => hides(declaration)),
    false,
    'the base rule must not hide anything'
  );

  /* The mutant is the regression this test names: the same hiding rule, outside the query. */
  const mutant = parseStylesheet(`${stylesheet}\n.expense-actions { opacity: 0; pointer-events: none; }\n`);
  const failed = hidingDeclarations(mutant);
  assert.equal(failed.problems.length, 2, 'the scan must catch both hiding declarations outside the query');
  assert.match(failed.problems.join('\n'), /opacity 0 outside @media \(hover: hover\)/);
  assert.match(failed.problems.join('\n'), /pointer-events none outside @media \(hover: hover\)/);
});

test('without hover the cluster resolves visible, opaque and in the pointer path', async () => {
  const { doc } = await openGroup();
  const cluster = clusterOf(expenseRow(doc));

  assert.deepEqual(
    visibleAndTappable(resolveStyle(cluster, PHONE)),
    [],
    'a device that cannot hover must paint Edit and Delete from the first frame'
  );

  for (const button of cluster.childNodes) {
    const style = resolveStyle(button, PHONE);
    assert.equal(style.get('opacity'), '1', `${button.textContent} must be opaque without interaction`);
    assert.notEqual(style.get('pointer-events'), 'none', `${button.textContent} must be tappable`);
  }

  const mutant = parseStylesheet(`${stylesheet}\n.expense-actions { opacity: 0; pointer-events: none; }\n`);
  const broken = visibleAndTappable(resolveStyle(cluster, PHONE, mutant));
  assert.ok(broken.length > 0, 'the resolution must fail on a base hiding rule, or it reads nothing');
  assert.match(broken.join(', '), /opacity 0/);
  assert.match(broken.join(', '), /pointer-events none/);
});

test('a control that is transparent is never hit-testable', async () => {
  const { doc } = await openGroup();
  const cluster = clusterOf(expenseRow(doc));

  const resting = resolveStyle(cluster, DESK);
  assert.equal(resting.get('opacity'), '0', 'a hovering device opens with the cluster collapsed');
  assert.equal(resting.get('pointer-events'), 'none', 'the collapsed cluster must not take a click');
  for (const button of cluster.childNodes) {
    assert.equal(
      resolveStyle(button, DESK).get('pointer-events'),
      'none',
      `${button.textContent} must inherit the closed pointer path`
    );
  }

  const { problems, checked } = transparencyViolations(parseStylesheet(stylesheet));
  assert.ok(checked >= 2, `the sheet must carry the cluster and the disabled primary, checked ${checked}`);
  assert.deepEqual(problems, [], problems.join('\n'));

  const primary = doc.getElementById('create-btn');
  primary.disabled = true;
  const disabledStyle = resolveStyle(primary, DESK);
  assert.equal(disabledStyle.get('opacity'), '0.65', 'the disabled primary is the faded control');
  assert.equal(disabledStyle.get('pointer-events'), 'none', 'a faded primary must not be hit-testable');
  primary.disabled = false;

  const flat = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const mutantSheet = flat.replace(/opacity:\s*0\.65;\s*pointer-events:\s*none;/, 'opacity: 0.65;');
  assert.notEqual(mutantSheet, flat, 'the mutation must have removed the pointer rule');
  const mutant = transparencyViolations(parseStylesheet(mutantSheet));
  assert.equal(mutant.problems.length, 1, 'the mutant must be caught exactly once');
  assert.match(mutant.problems[0], /\.primary:disabled/);
});

test('hovering the row reveals both actions and leaving collapses them', async () => {
  const { doc } = await openGroup();
  const row = expenseRow(doc);
  const cluster = clusterOf(row);

  assert.equal(resolveStyle(cluster, DESK).get('opacity'), '0', 'the row opens quiet');

  row.hover = true;
  const revealed = resolveStyle(cluster, DESK);
  assert.equal(revealed.get('opacity'), '1', 'hovering the row paints its actions');
  assert.equal(revealed.get('pointer-events'), 'auto', 'and makes them the target of a click');
  for (const button of cluster.childNodes) {
    assert.equal(resolveStyle(button, DESK).get('pointer-events'), 'auto', `${button.textContent} must be clickable`);
  }

  row.hover = false;
  assert.equal(resolveStyle(cluster, DESK).get('opacity'), '0', 'leaving the row collapses them again');
  assert.equal(resolveStyle(cluster, DESK).get('pointer-events'), 'none', 'and closes the pointer path with them');
});

test('keyboard focus reveals the cluster and the actions keep a visible ring', async () => {
  const { doc } = await openGroup();
  const row = expenseRow(doc);
  const cluster = clusterOf(row);
  const buttons = cluster.childNodes;

  assert.deepEqual(
    buttons.map((button) => button.textContent).slice(0, 2),
    ['Edit', 'Delete'],
    'the row offers both actions in that order'
  );

  row.focusWithin = true;
  for (const button of buttons) button.focusVisible = true;

  const revealed = resolveStyle(cluster, DESK);
  assert.equal(revealed.get('opacity'), '1', 'a focused action paints the cluster');
  assert.equal(revealed.get('pointer-events'), 'auto', 'and keeps it in the pointer path');

  for (const button of buttons) {
    const style = resolveStyle(button, DESK);
    assert.equal(style.get('outline-style'), 'solid', `${button.textContent} needs a visible ring`);
    assert.equal(style.get('outline-width'), '2px', `${button.textContent} ring is two pixels`);
    assert.equal(style.get('outline-offset'), '2px', `${button.textContent} ring is offset from the edge`);
  }
});

test('a painted group shows the controls the scan counts', async () => {
  const { doc } = await openGroup();
  const controls = paintedControls(doc, PHONE);
  const labels = controls.map((node) => node.textContent.trim());

  assert.ok(controls.length >= 8, `a painted group must show at least eight controls, counted ${controls.length}`);

  assert.deepEqual(
    clusterOf(expenseRow(doc)).childNodes.map((button) => button.textContent),
    ['Edit', 'Delete'],
    'both row actions are painted'
  );

  const roster = doc.getElementById('roster');
  const rosterControls = controls.filter((node) => isInside(roster, node));
  assert.ok(
    rosterControls.length >= 3,
    `the roster must contribute at least three controls, counted ${rosterControls.length}`
  );
  for (const label of ['Let in', 'No', 'Remove']) {
    assert.ok(
      rosterControls.some((node) => node.textContent === label),
      `the roster must show ${label} before any absence is claimed`
    );
  }

  assert.ok(labels.includes('Add expense'), 'the group header is painted');
  assert.ok(labels.includes('Record a payment'), 'the balances panel is painted');
});

test('no enabled control resolves below opacity 1 without hover', async () => {
  const { doc } = await openGroup();
  const controls = paintedControls(doc, PHONE).filter((node) => node.disabled !== true);
  assert.ok(controls.length >= 8, `the scan must have controls to inspect, counted ${controls.length}`);

  const faded = [];
  for (const node of controls) {
    const style = resolveStyle(node, PHONE);
    const label = `${node.tagName.toLowerCase()} "${node.textContent.trim()}"`;
    if (style.get('opacity') !== '1') faded.push(`${label} resolves at opacity ${style.get('opacity')}`);
    if (style.get('pointer-events') === 'none') faded.push(`${label} is outside the pointer path`);
  }
  assert.deepEqual(faded, [], faded.join('\n'));

  const payments = doc.getElementById('payment-list');
  const paymentDelete = controls.find(
    (node) => node.textContent === 'Delete' && isInside(payments, node)
  );
  assert.ok(paymentDelete, 'the fixture must paint the payment Delete before claiming anything about it');
  assert.equal(resolveStyle(paymentDelete, PHONE).get('opacity'), '1', 'the payment Delete is painted as it is');

  const roster = doc.getElementById('roster');
  const rosterControls = controls.filter((node) => isInside(roster, node));
  assert.ok(rosterControls.length >= 3, 'the roster controls are part of the claim');
  for (const node of rosterControls) {
    assert.equal(
      resolveStyle(node, PHONE).get('opacity'),
      '1',
      `the roster control "${node.textContent}" must be painted as it is`
    );
  }
});

test("one click on Edit opens the sheet on that row's expense", async () => {
  const { doc } = await openGroup();
  const [edit] = clusterOf(expenseRow(doc)).childNodes;
  assert.equal(doc.getElementById('expense-panel').hidden, true, 'the sheet starts closed');

  edit.click();
  await settle();

  assert.equal(doc.getElementById('expense-panel').hidden, false, 'the click opens the sheet');
  assert.equal(
    doc.getElementById('expense-description').value,
    'Dinner',
    "the sheet carries that row's description"
  );
  assert.equal(doc.getElementById('expense-amount').value, '300.00', "and that row's amount");
  assert.equal(doc.getElementById('expense-save').textContent, 'Save changes', 'and saves rather than adds');
});

test('the first Delete click arms only that button and sends nothing', async () => {
  const { doc, socket } = await openGroup();
  const remove = clusterOf(expenseRow(doc)).childNodes[1];
  const before = socket.sent.length;

  remove.click();

  assert.equal(remove.textContent, 'Delete? It leaves every screen', 'the first click asks');
  assert.equal(remove.classList.contains('is-armed'), true, 'and marks itself as armed');
  assert.equal(doc.querySelectorAll('.is-armed').length, 1, 'no other control is armed');
  assert.equal(socket.sent.length, before, 'nothing is sent before the second click');
  assert.equal(
    socket.sent.some((frame) => frame.t === 'put'),
    false,
    'no tombstone exists after one click'
  );
});

test('the second Delete click sends exactly one tombstone for that record', async () => {
  const { doc, socket, fixture } = await openGroup();
  const remove = clusterOf(expenseRow(doc)).childNodes[1];

  remove.click();
  const afterFirst = socket.sent.length;
  remove.click();

  const puts = socket.sent.filter((frame) => frame.t === 'put');
  assert.equal(puts.length, 1, 'one click sends one tombstone');
  assert.deepEqual(
    puts[0],
    { t: 'put', id: fixture.expenseId, base: 1, blob: null, deleted: true },
    'the tombstone names that record and the revision it started from'
  );
  assert.equal(socket.sent.length, afterFirst + 1, 'the second click is exactly one frame');
  assert.equal(remove.textContent, 'Delete', 'the armed text is cleared');
  assert.equal(remove.disabled, true, 'the button cannot send a second tombstone');
});
