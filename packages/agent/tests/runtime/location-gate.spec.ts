import { brandSanitized } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  locationHandoffFor,
  requiresUserLocation,
  type AmbientContextView,
} from '../../src/runtime/location-gate.js';

const GRANTED_UNSET: AmbientContextView = { grants: { location: true }, userLocation: null };
const DENIED: AmbientContextView = { grants: { location: false }, userLocation: null };
const AVAILABLE: AmbientContextView = {
  grants: { location: true },
  userLocation: brandSanitized('Naperville, IL, US'),
};

describe('@no-llm requiresUserLocation', () => {
  const phrases = [
    'near me',
    'nearby',
    'close to me',
    'closest to me',
    'nearest to me',
    'around me',
    'next to me',
    'around here',
    'near here',
    'close to here',
    'in my area',
    'my area',
    'my neighborhood',
    'my city',
    'my town',
    'my region',
    'my zip',
    'my location',
    'where i am',
    'where i live',
    'local to me',
  ];

  it.each(phrases)('triggers on "%s"', (phrase) => {
    expect(requiresUserLocation(`cheap hotels ${phrase} august 5 2026`)).toBe(true);
  });

  it('does not trigger on a goal carrying its own anchor', () => {
    // Deliberate exclusion: bare "nearest"/"closest" need nothing from the profile.
    expect(requiresUserLocation('nearest station to Times Square')).toBe(false);
    expect(requiresUserLocation('closest airport to Heathrow')).toBe(false);
  });

  it('does not trigger on unrelated uses of the same words', () => {
    expect(requiresUserLocation('the deadline is near')).toBe(false);
    expect(requiresUserLocation('summarize my calendar')).toBe(false);
    expect(requiresUserLocation('compare the top three 4K monitors')).toBe(false);
  });

  it('matches case- and punctuation-insensitively', () => {
    expect(requiresUserLocation('Hotels Near-Me')).toBe(true);
    expect(requiresUserLocation('hotels near me?')).toBe(true);
    expect(requiresUserLocation('HOTELS   NEAR   ME')).toBe(true);
    expect(requiresUserLocation('restaurants "nearby"!')).toBe(true);
  });

  it('respects word boundaries rather than matching substrings', () => {
    expect(requiresUserLocation('nearbyte storage benchmarks')).toBe(false);
    expect(requiresUserLocation('unnearby')).toBe(false);
  });

  it('matches the exact goal from the logged failing run', () => {
    expect(requiresUserLocation('cheap hotels near me August 5 2026 2 nights')).toBe(true);
  });

  it('handles empty and whitespace-only goals without throwing', () => {
    expect(requiresUserLocation('')).toBe(false);
    expect(requiresUserLocation('   ')).toBe(false);
  });
});

describe('@no-llm locationHandoffFor', () => {
  it('does not fire when a location is available', () => {
    expect(locationHandoffFor('cheap hotels near me', AVAILABLE)).toBeNull();
  });

  it('does not fire when the goal does not need a location', () => {
    expect(locationHandoffFor('compare the top three 4K monitors', GRANTED_UNSET)).toBeNull();
  });

  it('fires with the never-infer blocker when the value is simply unset', () => {
    const handoff = locationHandoffFor('cheap hotels near me', GRANTED_UNSET);
    expect(handoff).not.toBeNull();
    expect(handoff?.blocker).toBe(
      'This goal needs your location, but none is available and Yantra will not infer one.',
    );
  });

  it('tells a granted user to set their city', () => {
    const handoff = locationHandoffFor('cheap hotels near me', GRANTED_UNSET);
    expect(handoff?.safestNextAction).toContain('yantra prefs set locale.city');
    expect(handoff?.safestNextAction).not.toContain('context.location');
  });

  it('tells a user who turned location off to re-enable it', () => {
    const handoff = locationHandoffFor('cheap hotels near me', DENIED);
    expect(handoff?.safestNextAction).toContain('Location sharing is off');
    expect(handoff?.safestNextAction).toContain('yantra prefs set context.location true');
    expect(handoff?.safestNextAction).not.toContain('locale.city');
  });

  it('offers naming the location in the query in both variants', () => {
    for (const ambient of [GRANTED_UNSET, DENIED]) {
      expect(locationHandoffFor('hotels near me', ambient)?.safestNextAction).toContain(
        'name the location in the query',
      );
    }
  });

  it('treats an absent ambient block as granted-but-unset', () => {
    const handoff = locationHandoffFor('hotels near me', undefined);
    expect(handoff?.safestNextAction).toContain('yantra prefs set locale.city');
  });

  it('treats a blank location value as unavailable', () => {
    const blank: AmbientContextView = {
      grants: { location: true },
      userLocation: brandSanitized(''),
    };
    expect(locationHandoffFor('hotels near me', blank)).not.toBeNull();
  });
});
