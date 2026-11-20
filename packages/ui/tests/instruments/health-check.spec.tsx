// @no-llm
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { HealthCheck } from '../../src/instruments/HealthCheck.js';
import { Button } from '../../src/primitives/Button.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('HealthCheck', () => {
  it('renders ok, warn, and fail with CLI status words and semantic icons', () => {
    const { container } = render(
      <div>
        <HealthCheck id="a" title="Check A" status="ok" summary="All good." />
        <HealthCheck id="b" title="Check B" status="warn" summary="Needs attention." />
        <HealthCheck id="c" title="Check C" status="fail" summary="Broken." />
      </div>,
    );

    expect(screen.getByText('ok')).toBeTruthy();
    expect(screen.getByText('warn')).toBeTruthy();
    expect(screen.getByText('fail')).toBeTruthy();
    expect(screen.getByText('Check A')).toBeTruthy();
    expect(screen.getByText('All good.')).toBeTruthy();
    expect(container.querySelector('[data-icon="outcome.fulfilled"]')).toBeTruthy();
    expect(container.querySelector('[data-icon="outcome.partial"]')).toBeTruthy();
    expect(container.querySelector('[data-icon="outcome.failed"]')).toBeTruthy();
  });

  it('renders prose remediation and remediation slot', () => {
    render(
      <HealthCheck
        id="search.tavily.api-key"
        title="Tavily API key"
        status="warn"
        summary="No key."
        remediation="Run `yantra secret set tavily.api_key`."
        remediationSlot={<Button onPress={() => undefined}>Add key</Button>}
      />,
    );

    expect(screen.getByText('Run `yantra secret set tavily.api_key`.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add key' })).toBeTruthy();
  });

  it('makes the details disclosure keyboard operable and renders paths in mono', async () => {
    const user = userEvent.setup();
    render(
      <HealthCheck
        id="paths.resolved"
        title="Storage paths resolved"
        status="ok"
        summary="Resolved."
        details={{ dataDir: '/home/user/.yantra/data', source: 'default' }}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Details' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const pathValue = screen.getByText('/home/user/.yantra/data');
    expect(pathValue).toBeTruthy();
    expect(pathValue.className).toContain('type-engine');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <HealthCheck
          id="paths.resolved"
          title="Storage paths resolved"
          status="ok"
          summary="Resolved."
          details={{ dataDir: '/home/user/.yantra/data' }}
        />
        <HealthCheck
          id="config.valid"
          title="Configuration schema valid"
          status="fail"
          summary="Invalid config."
          remediation="Run `yantra config validate`."
        />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
