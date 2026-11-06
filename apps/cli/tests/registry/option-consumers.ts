/**
 * Static option-consumer analysis for the registry integrity suite.
 *
 * Uses the TypeScript compiler API (not regular expressions) to record, per
 * module, which option attributes are read and which resolvers are called. A
 * leaf's options are consumed when its handler module, or a module it imports
 * directly from `apps/cli/src`, reads them.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ExpandedOption, OptionGroupId } from '@yantra/protocol';
import ts from 'typescript';

/** What one module (or a union of modules) observably does with options. */
export interface ModuleFacts {
  /** Attributes read as `options.x`, `opts.x`, `options['x']` or destructured `{ x }`. */
  readonly optionReads: ReadonlySet<string>;
  /** Every property name read anywhere (`a.x`, `a?.x`), assignment targets excluded. */
  readonly propertyReads: ReadonlySet<string>;
  /** Names of called functions and methods (`f()`, `a.f()`). */
  readonly calls: ReadonlySet<string>;
  /** Relative import specifiers. */
  readonly imports: readonly string[];
}

const OPTION_BAGS = new Set(['options', 'opts']);

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Collects the facts of one source text. */
export function factsOf(sourceText: string, fileName = 'module.ts'): ModuleFacts {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const optionReads = new Set<string>();
  const propertyReads = new Set<string>();
  const calls = new Set<string>();
  const imports: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.startsWith('.')) imports.push(node.moduleSpecifier.text);
    } else if (ts.isPropertyAccessExpression(node) && !isAssignmentTarget(node)) {
      propertyReads.add(node.name.text);
      if (ts.isIdentifier(node.expression) && OPTION_BAGS.has(node.expression.text)) {
        optionReads.add(node.name.text);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      OPTION_BAGS.has(node.expression.text) &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      optionReads.add(node.argumentExpression.text);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) optionReads.add(name.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) calls.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { optionReads, propertyReads, calls, imports };
}

/** Unions several modules' facts. */
export function mergeFacts(all: readonly ModuleFacts[]): ModuleFacts {
  return {
    optionReads: new Set(all.flatMap((facts) => [...facts.optionReads])),
    propertyReads: new Set(all.flatMap((facts) => [...facts.propertyReads])),
    calls: new Set(all.flatMap((facts) => [...facts.calls])),
    imports: all.flatMap((facts) => facts.imports),
  };
}

/** Facts of a handler module plus the modules it imports directly from `src`. */
export function handlerFacts(modulePath: string): ModuleFacts {
  const own = factsOf(readFileSync(modulePath, 'utf8'), modulePath);
  const imported = own.imports.map((specifier) => {
    const target = resolve(dirname(modulePath), specifier.replace(/\.js$/, '.ts'));
    return factsOf(readFileSync(target, 'utf8'), target);
  });
  return mergeFacts([own, ...imported]);
}

const AGENT_RESOLVERS = ['resolveAgentInvocation', 'resolveAgent'];

/**
 * Whether a module consumes a group option: it calls the group's resolver and
 * reads the group's use marker from the result.
 */
const GROUP_CONSUMED: Readonly<Record<OptionGroupId, (facts: ModuleFacts) => boolean>> = {
  'agent-model': (f) =>
    AGENT_RESOLVERS.some((name) => f.calls.has(name)) &&
    (f.propertyReads.has('model') || f.propertyReads.has('auth')),
  'agent-budget': (f) =>
    AGENT_RESOLVERS.some((name) => f.calls.has(name)) && f.propertyReads.has('budgets'),
  'agent-turn': (f) =>
    AGENT_RESOLVERS.some((name) => f.calls.has(name)) &&
    (f.propertyReads.has('turnTimeoutMs') || f.propertyReads.has('budgets')),
  'no-llm': (f) => [...AGENT_RESOLVERS, 'noLlmReason'].some((name) => f.calls.has(name)),
  screenshots: (f) => f.propertyReads.has('screenshots'),
  'browser-selection': (f) => f.calls.has('resolveBrowserSelectionOverride'),
};

/** Whether `facts` show a consumer for `option`. */
export function isConsumed(option: ExpandedOption, facts: ModuleFacts): boolean {
  if (option.group !== undefined) return GROUP_CONSUMED[option.group](facts);
  return facts.optionReads.has(option.attribute);
}
