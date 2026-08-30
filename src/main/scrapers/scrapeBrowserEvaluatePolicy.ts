import { parse, type Node } from 'acorn'

const FORBIDDEN_EVALUATE_IDENTIFIERS = new Set([
  'fetch',
  'import',
  'require',
  'XMLHttpRequest',
  'WebSocket',
  'eval',
  'Function',
  'FormData',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'cookieStore',
  'ClipboardItem',
  'FileReader',
  'Reflect',
  'window',
  'globalThis',
  'self',
  'top',
  'parent',
  'opener',
  'frames',
  'history',
  'open',
  'EventSource',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'WebTransport',
  'RTCPeerConnection',
  'Image',
  'Audio',
  'this',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'MessageChannel',
  'postMessage'
])

const FORBIDDEN_EVALUATE_MEMBERS = new Set([
  'cookie',
  'credentials',
  'password',
  'value',
  'files',
  'forms',
  'elements',
  'attributes',
  'innerHTML',
  'outerHTML',
  'constructor',
  '__proto__',
  'prototype',
  'getOwnPropertyDescriptor',
  'sendBeacon',
  'getAttribute',
  'getAttributeNames',
  'defaultValue',
  'checked',
  'selected',
  'selectedIndex',
  'contentWindow',
  'contentDocument',
  'defaultView',
  'remove',
  'removeChild',
  'append',
  'appendChild',
  'prepend',
  'replaceChildren',
  'replaceWith',
  'before',
  'after',
  'insertAdjacentElement',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'setAttribute',
  'removeAttribute',
  'toggleAttribute',
  'click',
  'focus',
  'blur',
  'submit',
  'requestSubmit',
  'reset',
  'dispatchEvent',
  'write',
  'writeln',
  'postMessage',
  'getPrototypeOf',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'getOwnPropertyDescriptors',
  'getOwnPropertyNames',
  'getOwnPropertySymbols',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee'
])

const SENSITIVE_LITERAL = /(?:password|passwd|passcode|credential|captcha|hcaptcha|g-recaptcha|cf-turnstile|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|secret)/iu

const MARKUP_EVALUATE_MEMBERS = new Set([
  'outerHTML',
  'innerHTML',
  'getAttribute',
  'getAttributeNames'
])

export type ForbiddenEvaluateReason =
  | { kind: 'name'; name: string }
  | { kind: 'computed' }
  | { kind: 'this' }
  | { kind: 'import' }
  | { kind: 'sensitive-literal' }
  | { kind: 'unparseable' }

export function forbiddenEvaluateErrorMessage(reason: ForbiddenEvaluateReason): string {
  if (reason.kind === 'name' && MARKUP_EVALUATE_MEMBERS.has(reason.name)) {
    return `evaluate 禁止 ${reason.name}，读局部标记请用 html`
  }
  if (reason.kind === 'name') return `evaluate 禁止 ${reason.name}`
  if (reason.kind === 'computed') return 'evaluate 禁止计算属性访问'
  if (reason.kind === 'this') return 'evaluate 禁止 this'
  if (reason.kind === 'import') return 'evaluate 禁止 import'
  if (reason.kind === 'sensitive-literal') return 'evaluate 表达式含有敏感字面量'
  return 'evaluate 表达式无法解析或含有禁止的 API'
}

function isNode(value: unknown): value is Node {
  return Boolean(value && typeof value === 'object' && typeof (value as Node).type === 'string')
}

function nodeContainsForbiddenEvaluateApi(
  node: Node,
  visited: WeakSet<object>,
  parent?: Node,
  grandparent?: Node
): ForbiddenEvaluateReason | undefined {
  if (visited.has(node)) return undefined
  visited.add(node)

  const record = node as Node & Record<string, unknown>
  if (node.type === 'ThisExpression') return { kind: 'this' }
  if (node.type === 'ImportExpression') return { kind: 'import' }
  if (record.computed === true) return { kind: 'computed' }
  if (node.type === 'Identifier') {
    const name = record.name
    const parentRecord = parent as (Node & Record<string, unknown>) | undefined
    const isMemberName = parent?.type === 'MemberExpression' && parentRecord?.property === node
    const isPatternKey = parent?.type === 'Property' &&
      parentRecord?.key === node &&
      grandparent?.type === 'ObjectPattern'
    if (typeof name === 'string' && FORBIDDEN_EVALUATE_IDENTIFIERS.has(name)) {
      return { kind: 'name', name }
    }
    if (typeof name === 'string' && (isMemberName || isPatternKey) && FORBIDDEN_EVALUATE_MEMBERS.has(name)) {
      return { kind: 'name', name }
    }
  }
  if (node.type === 'Literal' && typeof record.value === 'string') {
    const parentRecord = parent as (Node & Record<string, unknown>) | undefined
    const isPatternKey = parent?.type === 'Property' &&
      parentRecord?.key === node &&
      grandparent?.type === 'ObjectPattern'
    if (isPatternKey && FORBIDDEN_EVALUATE_MEMBERS.has(record.value)) {
      return { kind: 'name', name: record.value }
    }
    if (SENSITIVE_LITERAL.test(record.value)) return { kind: 'sensitive-literal' }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isNode(item)) continue
        const reason = nodeContainsForbiddenEvaluateApi(item, visited, node, parent)
        if (reason) return reason
      }
      continue
    }
    if (isNode(value)) {
      const reason = nodeContainsForbiddenEvaluateApi(value, visited, node, parent)
      if (reason) return reason
    }
  }
  return undefined
}

/**
 * Reject executable access to browser/network escape hatches without treating diagnostic text,
 * comments or regular-expression patterns as executable API references. Forbidden property names
 * are rejected everywhere in executable code so destructuring cannot bypass member-access checks.
 */
export function findForbiddenBrowserEvaluateApi(
  expression: string
): ForbiddenEvaluateReason | undefined {
  try {
    const program = parse(`(${expression}\n)`, { ecmaVersion: 'latest' })
    return nodeContainsForbiddenEvaluateApi(program, new WeakSet())
  } catch {
    return { kind: 'unparseable' }
  }
}

export function containsForbiddenBrowserEvaluateApi(expression: string): boolean {
  return findForbiddenBrowserEvaluateApi(expression) !== undefined
}

export function prepareBrowserEvaluate(
  expression: string,
  requestedTimeoutMs: number | undefined
): { source: string; timeoutMs: number } {
  const normalized = expression.trim()
  if (!normalized) throw new Error('evaluate requires expression')
  const forbidden = findForbiddenBrowserEvaluateApi(normalized)
  if (forbidden) {
    throw new Error(forbiddenEvaluateErrorMessage(forbidden))
  }
  const timeoutMs = typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
    ? Math.max(500, Math.min(10_000, Math.round(requestedTimeoutMs)))
    : 3_000
  return {
    source: `(async () => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, template, iframe, object, embed, input, textarea, select, option, button').forEach((element) => element.remove());
      const sensitive = /(?:password|passwd|passcode|credential|captcha|hcaptcha|g-recaptcha|cf-turnstile|csrf|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|secret)/iu;
      const urlAttributes = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite']);
      for (const element of clone.querySelectorAll('*')) {
        let removeElement = false;
        for (const attribute of Array.from(element.attributes)) {
          if (sensitive.test(attribute.name) || sensitive.test(attribute.value)) {
            removeElement = true;
            break;
          }
          if (!urlAttributes.has(attribute.name.toLowerCase())) continue;
          try {
            const url = new URL(attribute.value, location.href);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            element.setAttribute(attribute.name, url.href);
          } catch {
            element.removeAttribute(attribute.name);
          }
        }
        if (removeElement) element.remove();
      }
      const safeDocument = document.implementation.createHTMLDocument('');
      safeDocument.replaceChild(safeDocument.importNode(clone, true), safeDocument.documentElement);
      const safeLocation = Object.freeze({
        href: location.origin + location.pathname,
        origin: location.origin,
        protocol: location.protocol,
        host: location.host,
        hostname: location.hostname,
        port: location.port,
        pathname: location.pathname,
        search: '',
        hash: ''
      });
      const safeNavigator = Object.freeze({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: Array.from(navigator.languages),
        platform: navigator.platform
      });
      return (async function (
        document, location, navigator, window, globalThis, self, top, parent, opener,
        frames, history, localStorage, sessionStorage, indexedDB, cookieStore
      ) {
        'use strict';
        const candidate = ${normalized};
        const result = typeof candidate === 'function' ? await candidate() : candidate;
        return JSON.parse(JSON.stringify(result));
      }).call(undefined, safeDocument, safeLocation, safeNavigator, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    })()`,
    timeoutMs
  }
}

export async function runPreparedBrowserEvaluate<T>(input: {
  execute(): Promise<T>
  timeoutMs: number
  onTimeout(): Promise<void> | void
}): Promise<T> {
  const timeoutError = new Error('evaluate timed out')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input.execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), input.timeoutMs)
      })
    ])
  } catch (error) {
    if (error === timeoutError) await input.onTimeout()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
