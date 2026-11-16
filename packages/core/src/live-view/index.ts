/**
 * Live browser view (FEAT-069): screen protection inputs, frame generations,
 * the CDP screencast source and the per-run hub. Frames are never persisted
 * and never sent to the model; nothing here is reachable from a tool.
 */
export * from './errors.js';
export * from './focus-guard.js';
export * from './frame-gate.js';
export * from './task-page-source.js';
export * from './replay-task-page.js';
export * from './screencast-source.js';
export * from './live-view-hub.js';
