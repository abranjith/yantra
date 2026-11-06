import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../../src/primitives/Button.js';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from '../../src/primitives/Disclosure.js';
import { Tab, TabList, TabPanel, Tabs, tabStyles } from '../../src/primitives/Tabs.js';
import { Tooltip, TooltipTrigger } from '../../src/primitives/Tooltip.js';

function RunTabs({ onSelectionChange }: { readonly onSelectionChange?: (key: unknown) => void }) {
  return (
    <Tabs defaultSelectedKey="timeline" {...(onSelectionChange ? { onSelectionChange } : {})}>
      <TabList aria-label="Run views">
        <Tab id="timeline">Timeline</Tab>
        <Tab id="evidence">Evidence</Tab>
        <Tab id="audit">Audit</Tab>
      </TabList>
      <TabPanel id="timeline">Timeline panel</TabPanel>
      <TabPanel id="evidence">Evidence panel</TabPanel>
      <TabPanel id="audit">Audit panel</TabPanel>
    </Tabs>
  );
}

describe('@no-llm Drshya Tabs', () => {
  it('moves selection and focus with the arrow keys, and aria-selected follows', async () => {
    const onSelectionChange = vi.fn();
    render(<RunTabs onSelectionChange={onSelectionChange} />);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Timeline' }));

    await userEvent.keyboard('{ArrowRight}');

    const evidence = screen.getByRole('tab', { name: 'Evidence' });
    expect(document.activeElement).toBe(evidence);
    expect(evidence.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(onSelectionChange).toHaveBeenLastCalledWith('evidence');
    expect(screen.getByRole('tabpanel').textContent).toBe('Evidence panel');
  });

  it('wraps from the last tab to the first', async () => {
    render(<RunTabs />);

    await userEvent.tab();
    await userEvent.keyboard('{ArrowLeft}');

    expect(screen.getByRole('tab', { name: 'Audit' }).getAttribute('aria-selected')).toBe('true');
  });

  it('labels the tab list', () => {
    render(<RunTabs />);

    expect(screen.getByRole('tablist', { name: 'Run views' })).toBeDefined();
  });

  it('shows selection by weight and an Ion underline, never by color alone', () => {
    const classes = tabStyles().split(' ');

    expect(classes).toContain('selected:font-extrabold');
    expect(classes).toContain('font-medium');
    expect(classes).toContain('selected:border-accent');
  });

  it('marks the selected tab for styling', () => {
    render(<RunTabs />);

    expect(screen.getByRole('tab', { name: 'Timeline' }).hasAttribute('data-selected')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Evidence' }).hasAttribute('data-selected')).toBe(false);
  });
});

describe('@no-llm Drshya Tooltip', () => {
  function CopyWithTooltip() {
    return (
      <TooltipTrigger>
        <Button variant="quiet" icon="action.copy" aria-label="Copy command" />
        <Tooltip>Copy the CLI command</Tooltip>
      </TooltipTrigger>
    );
  }

  it('does not open on mount', () => {
    render(<CopyWithTooltip />);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus and closes on Escape', async () => {
    render(<CopyWithTooltip />);

    await userEvent.tab();
    expect(screen.getByRole('tooltip').textContent).toBe('Copy the CLI command');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('supplements the trigger’s own name instead of replacing it', async () => {
    render(<CopyWithTooltip />);

    await userEvent.tab();

    const trigger = screen.getByRole('button', { name: 'Copy command' });
    const tooltip = screen.getByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  it('renders as the solid inverse surface, not glass', async () => {
    render(<CopyWithTooltip />);

    await userEvent.tab();

    const className = screen.getByRole('tooltip').className;
    expect(className).toContain('bg-ink');
    expect(className).toContain('text-surface');
    expect(className).not.toContain('glass');
  });

  it('opens when controlled, for deterministic screenshots', () => {
    render(
      <TooltipTrigger isOpen>
        <Button aria-label="Stop" icon="action.stop" />
        <Tooltip>Stops the run</Tooltip>
      </TooltipTrigger>,
    );

    expect(screen.getByRole('tooltip').textContent).toBe('Stops the run');
  });
});

describe('@no-llm Drshya Disclosure', () => {
  function Constraints({ defaultExpanded = false }: { readonly defaultExpanded?: boolean }) {
    return (
      <Disclosure defaultExpanded={defaultExpanded}>
        <DisclosureTrigger headingLevel={3}>Constraints</DisclosureTrigger>
        <DisclosurePanel>Return window at least 30 days</DisclosurePanel>
      </Disclosure>
    );
  }

  it('toggles aria-expanded with Enter', async () => {
    render(<Constraints />);
    const trigger = screen.getByRole('button', { name: 'Constraints' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Return window at least 30 days')).toBeDefined();
  });

  it('keeps a collapsed panel hidden and out of the accessibility tree', () => {
    render(<Constraints />);

    const panel = screen.getByText('Return window at least 30 days', { ignore: false });
    const region = panel.closest('[id]');
    expect(region?.hasAttribute('hidden')).toBe(true);
    expect(screen.queryByRole('group', { hidden: false })).toBeNull();
  });

  it('wraps the trigger in a heading of the requested level', () => {
    render(<Constraints />);

    expect(screen.getByRole('heading', { level: 3, name: 'Constraints' })).toBeDefined();
  });

  it('supports controlled mode', async () => {
    function Controlled() {
      const [expanded, setExpanded] = useState(false);
      return (
        <>
          <span data-testid="state">{expanded ? 'open' : 'closed'}</span>
          <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
            <DisclosureTrigger>Also consulted</DisclosureTrigger>
            <DisclosurePanel>Two pages</DisclosurePanel>
          </Disclosure>
        </>
      );
    }
    render(<Controlled />);

    await userEvent.click(screen.getByRole('button', { name: 'Also consulted' }));

    expect(screen.getByTestId('state').textContent).toBe('open');
    expect(
      screen.getByRole('button', { name: 'Also consulted' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('starts expanded when uncontrolled with defaultExpanded', () => {
    render(<Constraints defaultExpanded />);

    expect(screen.getByRole('button', { name: 'Constraints' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('turns the chevron when expanded, as a reduced-motion-safe transition', async () => {
    render(<Constraints />);

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Constraints' }));
    });

    const chevron = screen
      .getByRole('button', { name: 'Constraints' })
      .querySelector('svg[data-icon="nav.chevronRight"]')?.parentElement;
    expect(chevron?.className).toContain('group-expanded:rotate-90');
    expect(chevron?.className).toContain('duration-(--duration-quick)');
  });
});
