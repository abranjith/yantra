import {
  APP_OPTION_EXEMPTIONS,
  COMMAND_REGISTRY,
  KNOWN_DEAD_OPTIONS,
  durationProblem,
  expandOptions,
  findLeaf,
  parseAgentDurationMs,
  parseInvocation,
  type EffectiveOptions,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildComposerModel,
  canSubmit,
  composerArgv,
  flagLabel,
  sourceText,
  toInvocation,
  valueText,
  type ComposerPath,
  type ComposerValues,
} from '../../../src/features/composer/composer-model.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const PATHS: readonly ComposerPath[] = ['ask', 'research', 'do', 'run', 'resume'];

function values(positional: string, options: ComposerValues['options'] = {}): ComposerValues {
  return { positional, options };
}

function flags(
  path: ComposerPath,
  input: ComposerValues = values('q'),
  effective: EffectiveOptions | null = null,
) {
  return buildComposerModel({ path, values: input, effective }).fields.map((field) => field.flag);
}

/** registry applicable (LLM mode) ∩ app-surfaced − dead − secret input, computed independently. */
function expectedFlags(path: ComposerPath): string[] {
  const entry = findLeaf([path])!;
  return expandOptions(entry, COMMAND_REGISTRY.option_groups)
    .filter((spec) => spec.input.kind !== 'secret-input')
    .filter((spec) => !APP_OPTION_EXEMPTIONS.some((item) => item.long === spec.long))
    .filter(
      (spec) =>
        !KNOWN_DEAD_OPTIONS.some((dead) => dead.command === entry.id && dead.option === spec.long),
    )
    .filter((spec) => !(path === 'run' && spec.long === '--params'))
    .filter(
      (spec) =>
        spec.applicability === undefined ||
        spec.applicability.every((condition) =>
          'mode' in condition
            ? condition.mode === 'llm'
            : 'equals' in condition
              ? condition.equals === 'terminal'
              : true,
        ),
    )
    .map((spec) => spec.long);
}

describe('@no-llm composer model: which options appear', () => {
  it.each(PATHS)('%s shows applicable, app-surfaced, live options only', (path) => {
    expect(flags(path)).toEqual(expectedFlags(path));
  });

  it('matches the reviewed option names per command', () => {
    expect(Object.fromEntries(PATHS.map((path) => [path, flags(path)]))).toMatchSnapshot();
  });

  it('never shows the app exemptions', () => {
    for (const path of PATHS) {
      for (const exempt of ['--json', '--open', '--no-color'])
        expect(flags(path)).not.toContain(exempt);
    }
  });

  it('shows --no-browse on research only', () => {
    expect(PATHS.filter((path) => flags(path).includes('--no-browse'))).toEqual(['research']);
  });

  it('shows --template on ask, research and do, never on run', () => {
    expect(PATHS.filter((path) => flags(path).includes('--template'))).toEqual([
      'ask',
      'research',
      'do',
    ]);
  });

  it('drops the dead run and resume controls', () => {
    for (const dead of ['--max-duration', '--max-tokens', '--tool-timeout', '--no-screenshots']) {
      expect(flags('run')).not.toContain(dead);
      expect(flags('resume')).not.toContain(dead);
    }
    expect(flags('run')).toContain('--params-file');
    expect(flags('run')).not.toContain('--params');
  });

  it('hides model options once --no-llm is set, and shows the deterministic ones', () => {
    const deterministic = flags('research', values('q', { llm: true }));

    expect(deterministic).not.toContain('--model');
    expect(deterministic).not.toContain('--no-browse');
    expect(deterministic).toContain('--pipeline-timeout');
    expect(deterministic).toContain('--no-llm');
    expect(flags('research')).not.toContain('--pipeline-timeout');
  });

  it('follows the host-resolved mode when the environment turns the model off', () => {
    const effective: EffectiveOptions = {
      path: ['ask'],
      mode: 'deterministic',
      options: [
        {
          option: 'llm',
          flag: '--no-llm',
          value: false,
          source: { kind: 'env', name: 'LLM_PROVIDER' },
        },
      ],
    };

    expect(flags('ask', values('q'), effective)).not.toContain('--model');
  });

  it('shows --detail only while the format is terminal', () => {
    expect(flags('ask', values('q', { format: 'md' }))).not.toContain('--detail');
    expect(flags('ask', values('q', { format: 'terminal' }))).toContain('--detail');
  });
});

describe('@no-llm composer model: validation', () => {
  it('needs the positional value', () => {
    const empty = buildComposerModel({ path: 'research', values: values('  '), effective: null });

    expect(empty.errors).toEqual([
      { field: 'positional', message: 'Enter a topic.', blocking: true },
    ]);
    expect(canSubmit(empty)).toBe(false);
  });

  it('refuses exactly the durations the CLI refuses, in the CLI’s words', () => {
    const samples = [
      '15m',
      '900s',
      '900000',
      '1h',
      '0',
      '-5m',
      '1.5m',
      'soon',
      '15 m',
      '5d',
      '99999999999h',
      '',
    ];
    for (const raw of samples.filter((sample) => sample !== '')) {
      const model = buildComposerModel({
        path: 'ask',
        values: values('q', { maxDuration: raw }),
        effective: null,
      });
      const error = model.errors.find((item) => item.field === '--max-duration');
      expect(error === undefined).toBe(parseAgentDurationMs(raw) !== null);
      expect(error?.message ?? null).toBe(durationProblem(raw, '--max-duration'));
    }
    expect(durationProblem('99999999999h', '--max-duration')).toBe(
      '--max-duration is too large to represent safely in milliseconds.',
    );
    expect(durationProblem('soon', '--max-duration')).toBe(
      '--max-duration must be a positive duration such as 15m, 900s, or 900000.',
    );
  });

  it('checks numbers and their bounds', () => {
    const bad = buildComposerModel({
      path: 'research',
      values: values('q', { maxSources: 'many' }),
      effective: null,
    });
    const ok = buildComposerModel({
      path: 'research',
      values: values('q', { maxSources: '12' }),
      effective: null,
    });

    expect(bad.errors.map((error) => error.message)).toEqual(['--max-sources must be a number.']);
    expect(ok.errors).toEqual([]);
  });

  it('reports a registry relation, advising when the command checks it more precisely', () => {
    const model = buildComposerModel({
      path: 'ask',
      values: values('q', { browserPath: '/usr/bin/chrome', browser: 'managed' }),
      effective: null,
    });

    expect(model.errors).toEqual([
      {
        field: '--browser-path',
        message: 'rejected unless --browser is system or absent (resolveBrowserSelectionOverride)',
        blocking: false,
      },
    ]);
    expect(canSubmit(model)).toBe(true);
  });

  it('needs every required workflow param', () => {
    const model = buildComposerModel({
      path: 'run',
      values: {
        positional: 'nightly',
        options: {},
        params: [
          { key: 'city', type: 'string', required: true, value: '' },
          { key: 'limit', type: 'number', required: false, value: '' },
        ],
      },
      effective: null,
    });

    expect(model.errors).toEqual([
      { field: 'params.city', message: 'Enter city; the workflow needs it.', blocking: true },
    ]);
  });
});

describe('@no-llm composer model: the command', () => {
  it('emits only user-set flags, never effective defaults', () => {
    const effective: EffectiveOptions = {
      path: ['research'],
      mode: 'llm',
      options: [
        {
          option: 'model',
          flag: '--model',
          value: 'm',
          source: { kind: 'preference', key: 'agent.model' },
        },
      ],
    };
    const model = buildComposerModel({
      path: 'research',
      values: values('quiet laptops', { llm: true, maxSources: '12' }),
      effective,
    });

    expect(composerArgv(model)).toEqual(['quiet laptops', '--no-llm', '--max-sources', '12']);
  });

  it('round-trips through the CLI parser', () => {
    const model = buildComposerModel({
      path: 'do',
      values: values("q's $x `y` 100%", {
        allowHost: ['a.test', 'b.test'],
        saveAs: 'flow',
        turnTimeout: '90s',
      }),
      effective: null,
    });

    const invocation = toInvocation(model, {
      invocationId: '01JD2X7Q8R9S0T1V2W3X000021',
      cwd: CWD,
    });
    const parsed = parseInvocation([...invocation.path, ...invocation.argv], { cwd: CWD });

    expect(parsed.isOk).toBe(true);
    if (!parsed.isOk) return;
    expect(parsed.value.arguments.goal).toBe("q's $x `y` 100%");
    expect(parsed.value.options.allowHost).toEqual(['a.test', 'b.test']);
    expect(parsed.value.options.turnTimeout).toBe('90s');
    expect(invocation).toMatchObject({ path: ['do'], cwd: CWD });
  });

  it('keeps an operand that looks like a flag an operand', () => {
    const model = buildComposerModel({
      path: 'ask',
      values: values('-5 degrees?', { llm: true }),
      effective: null,
    });

    const argv = composerArgv(model);
    const parsed = parseInvocation(['ask', ...argv], { cwd: CWD });

    expect(argv).toEqual(['--no-llm', '--', '-5 degrees?']);
    expect(parsed.isOk && parsed.value.arguments.query).toBe('-5 degrees?');
  });

  it('serializes workflow params as repeated --params in declared order', () => {
    const model = buildComposerModel({
      path: 'run',
      values: {
        positional: 'nightly',
        options: {},
        params: [
          { key: 'city', type: 'string', required: true, value: 'Pune' },
          { key: 'limit', type: 'number', required: false, value: '' },
          { key: 'when', type: 'string', required: false, value: 'a=b' },
        ],
      },
      effective: null,
    });

    expect(composerArgv(model)).toEqual([
      'nightly',
      '--params',
      'city=Pune',
      '--params',
      'when=a=b',
    ]);
  });

  it('asks before using a dangerous option', () => {
    const plain = buildComposerModel({ path: 'resume', values: values('run-1'), effective: null });
    const forced = buildComposerModel({
      path: 'resume',
      values: values('run-1', { force: true }),
      effective: null,
    });

    expect(plain.dangers).toEqual([]);
    expect(forced.dangers).toEqual([
      {
        flag: '--force',
        reason: 'resumes past a scope-violation or ethics refusal without the consent check',
      },
    ]);
  });
});

describe('@no-llm composer model: words', () => {
  it('labels flags in words', () => {
    expect(flagLabel('--max-sources')).toBe('Max sources');
    expect(flagLabel('--no-llm')).toBe('No LLM');
  });

  it('says where a value came from', () => {
    expect(sourceText({ kind: 'env', name: 'YANTRA_AGENT_MODEL' })).toBe('from YANTRA_AGENT_MODEL');
    expect(sourceText({ kind: 'preference', key: 'agent.model' })).toBe(
      'from preference agent.model',
    );
    expect(sourceText({ kind: 'config', key: 'browser.source' })).toBe(
      'from config browser.source',
    );
    expect(sourceText({ kind: 'default' })).toBe('default');
    expect(sourceText({ kind: 'flag' })).toBe('set here');
  });

  it('writes switch values as on and off from the flag’s point of view', () => {
    const model = buildComposerModel({ path: 'research', values: values('q'), effective: null });
    const noLlm = model.fields.find((field) => field.flag === '--no-llm')!;
    const browse = model.fields.find((field) => field.flag === '--no-browse')!;

    expect(valueText(noLlm, true)).toBe('off');
    expect(valueText(noLlm, false)).toBe('on');
    expect(valueText(browse, true)).toBe('off');
    expect(
      valueText(
        model.fields.find((field) => field.flag === '--model')!,
        null,
      ),
    ).toBe('not set');
  });
});
