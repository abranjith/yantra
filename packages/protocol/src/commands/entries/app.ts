import { exit, jsonOption, leaf, option, PARSE_ERRORS } from './builders.js';

/** `yantra ui`: opens the Yantra app (FEAT-065). */
export const ui = leaf({
  id: 'ui',
  description: 'Open the Yantra app in a browser window',
  registration: 'added',
  options: [
    option('--print', 'print the app URL instead of opening a window', { default: false }),
    jsonOption('emit JSON describing the opened app'),
  ],
  execution: {
    default: 'exemption',
    exemption: {
      decision: 'D15',
      reason: 'it starts or reuses the app host and opens its window, so it runs from a terminal',
    },
  },
  effect: 'local',
  danger: { level: 'none' },
  exit_codes: [
    exit.ok('the app window opened, or the URL was printed'),
    exit.validation(PARSE_ERRORS),
    exit.environment(
      'no Chromium browser was found (the URL is still printed), or the app host could not start or be verified',
    ),
  ],
  json: { flag: '--json', shape: 'document', schema: 'UiOpenResult' },
});
