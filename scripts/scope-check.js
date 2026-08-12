#!/usr/bin/env node
// Undeclared-identifier scan for our CJS sources.
//
// WHY THIS EXISTS. A `kickWatchdog?.()` call in the `start` action referenced a
// const declared inside `gracefulShutdown`. Optional chaining guards a null VALUE,
// never an undeclared BINDING, so it threw ReferenceError — and because the failing
// path had never executed in any shipped version, it survived THREE adversarial
// review rounds and a 1057-test suite. It would have aborted startup mid-upgrade
// and left a zombie process reporting `/health: ok` forever.
//
// `node --check`, `new Function` and `vm.compileFunction` all miss this: it is not
// a syntax error, and the reference is only wrong relative to scope. A scope-
// tracking AST walk finds it statically, for the whole class, in milliseconds.
//
// Usage: node scripts/scope-check.js <file.js> [...]  (exit 1 if anything is found)
'use strict';
const fs = require('fs');
const acorn = require('acorn');

const NODE_GLOBALS = new Set([
  // CJS wrapper
  'require', 'module', 'exports', '__dirname', '__filename',
  // Node
  'process', 'console', 'Buffer', 'global', 'globalThis', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'queueMicrotask', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'fetch', 'structuredClone',
  'performance', 'atob', 'btoa', 'crypto', 'WebSocket', 'Blob', 'FormData',
  'Headers', 'Request', 'Response', 'Event', 'EventTarget', 'MessageChannel',
  'MessageEvent', 'MessagePort', 'BroadcastChannel',
  // ECMAScript
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'Date', 'JSON', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'FinalizationRegistry', 'Proxy', 'Reflect', 'Intl', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Atomics', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'NaN', 'Infinity', 'undefined', 'eval', 'escape', 'unescape', 'arguments',
]);

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });

  // scope: { vars:Set, kind:'function'|'block', parent }
  const problems = [];

  function newScope(parent, kind) { return { vars: new Set(), kind, parent }; }
  function declare(scope, name, kind) {
    // var/function hoist to nearest function scope; let/const/class stay in block
    let s = scope;
    if (kind === 'var' || kind === 'function' || kind === 'param') {
      while (s.kind !== 'function' && s.parent) s = s.parent;
    }
    s.vars.add(name);
  }
  function isDeclared(scope, name) {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return true;
    return NODE_GLOBALS.has(name);
  }
  function bindPattern(scope, node, kind) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': declare(scope, node.name, kind); break;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') bindPattern(scope, p.argument, kind);
          else { if (p.computed) ref(scope, p.key); bindPattern(scope, p.value, kind); }
        }
        break;
      case 'ArrayPattern': for (const el of node.elements) bindPattern(scope, el, kind); break;
      case 'AssignmentPattern': bindPattern(scope, node.left, kind); walk(node.right, scope); break;
      case 'RestElement': bindPattern(scope, node.argument, kind); break;
      default: walk(node, scope);
    }
  }
  function ref(scope, node) { if (node && node.type === 'Identifier') useIdent(scope, node); else walk(node, scope); }
  function useIdent(scope, node) {
    if (!isDeclared(scope, node.name)) {
      problems.push({ name: node.name, line: node.loc.start.line, col: node.loc.start.column });
    }
  }

  // Hoist declarations visible within a scope body without descending into
  // nested functions. Handles: var (through blocks), function declarations
  // (their own block), let/const/class (own block only).
  function hoist(nodes, scope) {
    for (const n of nodes) hoistNode(n, scope);
  }
  function hoistNode(n, scope) {
    if (!n) return;
    switch (n.type) {
      case 'VariableDeclaration':
        for (const d of n.declarations) bindNames(d.id, scope, n.kind === 'var' ? 'var' : 'lexical');
        break;
      case 'FunctionDeclaration':
        if (n.id) declare(scope, n.id.name, 'function');
        break;
      case 'ClassDeclaration':
        if (n.id) declare(scope, n.id.name, 'lexical');
        break;
      // var hoists through these containers; let/const do not (they get their
      // own block scope handled at walk time — declaring them here for the
      // OUTER block would be wrong, so recurse for `var` only).
      case 'BlockStatement': hoistVarsOnly(n.body, scope); break;
      case 'IfStatement':
        hoistNode(n.consequent && { type: 'BlockStatement', body: [n.consequent] }, scope);
        hoistVarsOnly([n.consequent], scope); hoistVarsOnly([n.alternate], scope); break;
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
        hoistVarsOnly([n.init, n.left, n.body].filter(Boolean), scope); break;
      case 'WhileStatement': case 'DoWhileStatement': hoistVarsOnly([n.body], scope); break;
      case 'TryStatement':
        hoistVarsOnly([n.block, n.handler && n.handler.body, n.finalizer].filter(Boolean), scope); break;
      case 'SwitchStatement': for (const c of n.cases) hoistVarsOnly(c.consequent, scope); break;
      case 'LabeledStatement': hoistNode(n.body, scope); break;
    }
  }
  function hoistVarsOnly(nodes, scope) {
    for (const n of nodes || []) {
      if (!n) continue;
      if (n.type === 'VariableDeclaration' && n.kind === 'var') {
        for (const d of n.declarations) bindNames(d.id, scope, 'var');
      } else if (n.type !== 'FunctionDeclaration' && n.type !== 'FunctionExpression'
          && n.type !== 'ArrowFunctionExpression' && n.type !== 'ClassDeclaration') {
        hoistNode(n, scope); // recurse through nested statements for `var`
      }
    }
  }
  function bindNames(pat, scope, kind) {
    switch (pat.type) {
      case 'Identifier': declare(scope, pat.name, kind); break;
      case 'ObjectPattern':
        for (const p of pat.properties) {
          if (p.type === 'RestElement') bindNames(p.argument, scope, kind);
          else bindNames(p.value, scope, kind);
        }
        break;
      case 'ArrayPattern': for (const el of pat.elements) if (el) bindNames(el, scope, kind); break;
      case 'AssignmentPattern': bindNames(pat.left, scope, kind); break;
      case 'RestElement': bindNames(pat.argument, scope, kind); break;
    }
  }

  function walkFunction(node, scope) {
    const fnScope = newScope(scope, 'function');
    if (node.type !== 'ArrowFunctionExpression') fnScope.vars.add('arguments');
    if (node.id && node.type === 'FunctionExpression') fnScope.vars.add(node.id.name);
    for (const p of node.params) bindPattern(fnScope, p, 'param');
    if (node.body.type === 'BlockStatement') {
      hoist(node.body.body, fnScope);
      for (const st of node.body.body) walk(st, fnScope);
    } else walk(node.body, fnScope);
  }

  function walk(node, scope) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier': useIdent(scope, node); return;
      case 'MemberExpression':
        walk(node.object, scope);
        if (node.computed) walk(node.property, scope);
        return;
      case 'Property':
        if (node.computed) walk(node.key, scope);
        walk(node.value, scope);
        return;
      case 'PropertyDefinition': case 'MethodDefinition':
        if (node.computed) walk(node.key, scope);
        if (node.value) walk(node.value, scope);
        return;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          // names already hoisted; walk initializers and computed keys in pattern
          bindPattern(scope, d.id, node.kind === 'var' ? 'var' : 'lexical');
          if (d.init) walk(d.init, scope);
        }
        return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        walkFunction(node, scope); return;
      case 'ClassDeclaration': case 'ClassExpression': {
        const cs = newScope(scope, 'block');
        if (node.id) cs.vars.add(node.id.name);
        if (node.superClass) walk(node.superClass, cs);
        for (const el of node.body.body) walk(el, cs);
        return;
      }
      case 'BlockStatement': {
        const bs = newScope(scope, 'block');
        hoist(node.body, bs);
        for (const st of node.body) walk(st, bs);
        return;
      }
      case 'ForStatement': {
        const fs2 = newScope(scope, 'block');
        if (node.init) { hoistNode(node.init, fs2); walk(node.init, fs2); }
        if (node.test) walk(node.test, fs2);
        if (node.update) walk(node.update, fs2);
        walk(node.body, fs2);
        return;
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const fs2 = newScope(scope, 'block');
        if (node.left.type === 'VariableDeclaration') { hoistNode(node.left, fs2); walk(node.left, fs2); }
        else walk(node.left, fs2);
        walk(node.right, fs2);
        walk(node.body, fs2);
        return;
      }
      case 'CatchClause': {
        const cs = newScope(scope, 'block');
        if (node.param) bindPattern(cs, node.param, 'lexical');
        // walk body's statements in cs directly (body is a BlockStatement; give it its own too — harmless)
        walk(node.body, cs);
        return;
      }
      case 'LabeledStatement': walk(node.body, scope); return;
      case 'BreakStatement': case 'ContinueStatement': return; // label idents aren't variable refs
      case 'MetaProperty': return; // new.target / import.meta
      case 'TemplateLiteral': for (const e of node.expressions) walk(e, scope); return;
      case 'TaggedTemplateExpression': walk(node.tag, scope); walk(node.quasi, scope); return;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') useIdent(scope, node.left);
        else walk(node.left, scope);
        walk(node.right, scope);
        return;
      default: {
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
          const v = node[key];
          if (Array.isArray(v)) { for (const c of v) walk(c, scope); }
          else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, scope);
        }
      }
    }
  }

  const top = newScope(null, 'function');
  hoist(ast.body, top);
  for (const st of ast.body) walk(st, top);
  return problems;
}

module.exports = { checkFile: check };

if (require.main !== module) return;

let bad = false;
for (const f of process.argv.slice(2)) {
  const probs = check(f);
  if (probs.length) {
    bad = true;
    for (const p of probs) console.log(`${f}:${p.line}:${p.col + 1}  undeclared identifier '${p.name}'`);
  } else {
    console.log(`${f}: OK — no undeclared identifiers`);
  }
}
process.exit(bad ? 1 : 0);
