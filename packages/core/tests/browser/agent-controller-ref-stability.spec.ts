import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { layoutBrowser } from '../helpers/layout-browser.js';

describe('@no-llm element-keyed refs and verified replacements', () => {
  let browser: Awaited<ReturnType<typeof layoutBrowser>>;
  beforeEach(async () => {
    browser = await layoutBrowser();
  });
  afterEach(async () => {
    await browser?.close();
  });

  it('keeps refs and labels when validation text is added', async () => {
    await browser.page.setContent('<div>Email<input></div>');
    const before = await browser.controller.observe();
    await browser.controller.fill(before.interactables[0]!.ref, 'Synthetic');
    await browser.page.evaluate(() => {
      document
        .querySelector('div')!
        .insertAdjacentHTML('beforeend', '<span role="alert">Invalid email</span>');
    });
    const after = await browser.controller.observe();
    expect(after.interactables[0]!.ref).toBe(before.interactables[0]!.ref);
    expect(after.interactables[0]!.field?.label).toBe('Email');
    await browser.page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<button>Next</button>');
    });
    expect(
      (await browser.controller.observe()).interactables.find((entry) => entry.name === 'Next')
        ?.ref,
    ).toBe('e2');
  }, 45_000);

  it('moves unnamed elements without transferring their refs', async () => {
    await browser.page.setContent(
      '<section><input data-fixture-key="a"><input data-fixture-key="b"></section>',
    );
    const before = await browser.controller.observe();
    await browser.page.evaluate(() => {
      const root = document.querySelector('section')!;
      root.prepend(root.lastElementChild!);
    });
    await browser.controller.observe();
    expect(
      await browser.controller.evaluateOn(before.interactables[0]!.ref, (element) =>
        element.getAttribute('data-fixture-key'),
      ),
    ).toBe('a');
    expect(
      await browser.controller.evaluateOn(before.interactables[1]!.ref, (element) =>
        element.getAttribute('data-fixture-key'),
      ),
    ).toBe('b');
  }, 45_000);

  it('refuses fills and clicks on an unlabeled replacement, even after observing it', async () => {
    await browser.page.setContent('<section><input><input></section>');
    const ref = (await browser.controller.observe()).interactables[0]!.ref;
    await browser.page.evaluate(() => {
      const input = document.querySelector('input')!;
      input.replaceWith(input.cloneNode());
    });
    const after = await browser.controller.observe();
    expect(after.interactables.map((entry) => entry.ref)).not.toContain(ref);
    await expect(browser.controller.fill(ref, 'Wrong')).rejects.toMatchObject({
      reason: 'unverified-replacement',
    });
    await expect(browser.controller.click(ref)).rejects.toMatchObject({
      reason: 'unverified-replacement',
    });
    expect(await browser.page.$eval('input', (element) => element.value)).toBe('');
  }, 45_000);

  it('reuses a uniquely labelled replacement and commits through a stale handle', async () => {
    await browser.page.setContent('<div>Email<input></div>');
    const ref = (await browser.controller.observe()).interactables[0]!.ref;
    await browser.page.evaluate(() => {
      const input = document.querySelector('input')!;
      input.replaceWith(input.cloneNode());
    });
    await browser.controller.fill(ref, 'Synthetic');
    expect((await browser.controller.observe()).interactables[0]!.ref).toBe(ref);
    expect(await browser.page.$eval('input', (element) => element.value)).toBe('Synthetic');
  }, 45_000);

  it('refuses two same-identity replacements with the actual candidates', async () => {
    await browser.page.setContent('<input aria-label="Email">');
    const ref = (await browser.controller.observe()).interactables[0]!.ref;
    await browser.page.evaluate(() => {
      document.body.innerHTML = '<input aria-label="Email"><input aria-label="Email">';
    });
    await expect(browser.controller.fill(ref, 'Wrong')).rejects.toMatchObject({
      reason: 'unverified-replacement',
      candidates: ['e2', 'e3'],
    });
  }, 45_000);
});
