/**
 * The Drshya icon registry: semantic names over Lucide plus six custom glyphs.
 *
 * This is the only file allowed to import `lucide-react` (lint enforces it,
 * plan_ui §9). Components ask for meaning (`outcome.fulfilled`,
 * `action.stop`), so the icon set can be swapped or retuned here alone.
 * Later features add names to `ICON_NAMES` and a record below; the
 * `satisfies` clause makes a missing record a type error, and the registry
 * test makes it a test failure.
 */

import {
  AppWindow,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleStop,
  CircleX,
  Contrast,
  Copy,
  CornerDownLeft,
  createLucideIcon,
  Ellipsis,
  ExternalLink,
  EyeOff,
  Hand,
  Info,
  Minus,
  MonitorOff,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings2,
  SquareTerminal,
  X,
  type IconNode,
  type LucideIcon,
} from 'lucide-react';

import { BINDU } from './glyphs/bindu.js';
import { CAPTURE } from './glyphs/capture.js';
import { CONTRACT } from './glyphs/contract.js';
import type { GlyphNode } from './glyphs/glyph.js';
import { HANDOFF } from './glyphs/handoff.js';
import { PROTECTED } from './glyphs/protected.js';
import { PROVENANCE } from './glyphs/provenance.js';

/** Every icon name, in display order. Closed: adding one is a typed change. */
export const ICON_NAMES = [
  'outcome.fulfilled',
  'outcome.partial',
  'outcome.failed',
  'outcome.aborted',
  'status.needsYou',
  'status.info',
  'action.stop',
  'action.copy',
  'action.close',
  'action.openExternal',
  'action.retry',
  'action.add',
  'action.edit',
  'action.command',
  'action.more',
  'action.search',
  'action.go',
  'action.enter',
  'nav.chevronDown',
  'nav.chevronRight',
  'nav.check',
  'nav.settings',
  'field.increment',
  'field.decrement',
  'liveView.headed',
  'liveView.noPage',
  'liveView.unavailable',
  'glyph.bindu',
  'glyph.contract',
  'glyph.capture',
  'glyph.handoff',
  'glyph.protected',
  'glyph.provenance',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Where an icon comes from; both render through Lucide's icon component. */
export type IconRecord =
  | { readonly source: 'lucide'; readonly component: LucideIcon }
  | { readonly source: 'glyph'; readonly component: LucideIcon; readonly node: GlyphNode };

function glyph(name: string, node: GlyphNode): IconRecord {
  const iconNode: IconNode = node.map(([element, attributes]) => [element, { ...attributes }]);
  return { source: 'glyph', component: createLucideIcon(name, iconNode), node };
}

function lucide(component: LucideIcon): IconRecord {
  return { source: 'lucide', component };
}

export const ICON_REGISTRY = {
  'outcome.fulfilled': lucide(CircleCheck),
  // A half-filled circle: partial, unverified, budget low.
  'outcome.partial': lucide(Contrast),
  'outcome.failed': lucide(CircleX),
  // Aborted has no signal color: secondary ink plus this ban glyph (spec S4).
  'outcome.aborted': lucide(Ban),
  'status.needsYou': lucide(Hand),
  'status.info': lucide(Info),
  'action.stop': lucide(CircleStop),
  'action.copy': lucide(Copy),
  'action.close': lucide(X),
  'action.openExternal': lucide(ExternalLink),
  'action.retry': lucide(RotateCw),
  'action.add': lucide(Plus),
  'action.edit': lucide(Pencil),
  // The command palette: type a yantra command.
  'action.command': lucide(SquareTerminal),
  'action.more': lucide(Ellipsis),
  'action.search': lucide(Search),
  // Go to a page.
  'action.go': lucide(ArrowRight),
  // The Enter key, in keyboard hints.
  'action.enter': lucide(CornerDownLeft),
  'nav.chevronDown': lucide(ChevronDown),
  'nav.chevronRight': lucide(ChevronRight),
  'nav.check': lucide(Check),
  'nav.settings': lucide(Settings2),
  'field.increment': lucide(Plus),
  'field.decrement': lucide(Minus),
  // FEAT-069 live view states; `glyph.protected` covers the protected screen.
  'liveView.headed': lucide(AppWindow),
  'liveView.noPage': lucide(EyeOff),
  'liveView.unavailable': lucide(MonitorOff),
  'glyph.bindu': glyph('drshya-bindu', BINDU),
  'glyph.contract': glyph('drshya-contract', CONTRACT),
  'glyph.capture': glyph('drshya-capture', CAPTURE),
  'glyph.handoff': glyph('drshya-handoff', HANDOFF),
  'glyph.protected': glyph('drshya-protected', PROTECTED),
  'glyph.provenance': glyph('drshya-provenance', PROVENANCE),
} as const satisfies Record<IconName, IconRecord>;
