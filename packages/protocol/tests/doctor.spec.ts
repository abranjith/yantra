import { describe, expect, it } from 'vitest';

import {
  DOCTOR_CHECK_IDS,
  DoctorCheckId,
  DoctorReadParams,
  DoctorResult,
} from '../src/schemas/doctor.js';

describe('Doctor protocol schemas', () => {
  it('defines 17 unique known check IDs', () => {
    expect(DOCTOR_CHECK_IDS).toHaveLength(17);
    expect(new Set(DOCTOR_CHECK_IDS).size).toBe(17);
    for (const id of DOCTOR_CHECK_IDS) {
      expect(DoctorCheckId.safeParse(id).success).toBe(true);
    }
    expect(DoctorCheckId.safeParse('unknown.check').success).toBe(false);
  });

  it('validates a full DoctorResult including browser and search provenance', () => {
    const parsed = DoctorResult.safeParse({
      checks: [
        {
          id: 'browser.selection',
          title: 'Effective browser selection',
          status: 'ok',
          summary: 'Using Chrome 130',
          details: { source: 'auto', path: '/usr/bin/google-chrome' },
        },
        {
          id: 'future.check',
          title: 'A future check',
          status: 'warn',
          summary: 'Forward-compatible check',
          remediation: 'Do something.',
        },
      ],
      overall: 'warn',
      version: '0.0.1',
      platform: 'linux',
      nodeVersion: 'v24.15.0',
      browser: {
        source: 'auto',
        origin: 'default',
        ownership: 'external',
        executablePath: '/usr/bin/google-chrome',
        browserVersion: '130.0.0.0',
        compatibility: 'tested',
        managedRoot: '/home/user/.yantra/browsers',
        managedBuild: null,
        orphanCount: 0,
        reclaimableBytes: 0,
        alternatives: [],
      },
      search: {
        provider: 'tavily',
        kind: 'api',
        via: 'config',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates DoctorReadParams', () => {
    expect(DoctorReadParams.safeParse({}).success).toBe(true);
    expect(DoctorReadParams.safeParse({ refresh: true }).success).toBe(true);
    expect(DoctorReadParams.safeParse({ refresh: false }).success).toBe(true);
    expect(DoctorReadParams.safeParse({ refresh: 'yes' }).success).toBe(false);
    expect(DoctorReadParams.safeParse({ extra: 1 }).success).toBe(false);
  });
});
