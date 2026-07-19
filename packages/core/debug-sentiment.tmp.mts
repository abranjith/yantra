import { WinkAnalyzer } from './src/synthesis/analysis/wink-analyzer.js';
import { BlockSegmentingAnalyzer } from './src/synthesis/analysis/block-segmentation.js';
import { DeterministicSynthesizer } from './src/synthesis/deterministic.js';
import type { SynthesisDoc, SynthesisInput, SynthesisOptions } from './src/synthesis/types.js';

const analyzer = new BlockSegmentingAnalyzer(new WinkAnalyzer());

const sentences = [
  'The market shipped 41000 electric vehicle exports toward Europe.',
  'The fleet averaged 320 electric vehicle miles per charge.',
  'The programme recalled 7500 electric vehicle sedans recently.',
  'The registry logged 28000 electric vehicle registrations this period.',
  'The grid added 200000 electric vehicle chargers along highways.',
  'The survey found electric vehicle owners are happy with charging times.',
  'The reviewers called the electric vehicle lineup fantastic, amazing and delightful.',
  'A fantastic 90% of delighted owners praised the amazing electric vehicle lineup.',
  'Tesla widened its electric vehicle lineup this season.',
  'Rivian entered the electric vehicle pickup segment recently.',
  'Hyundai reorganised its electric vehicle division here.',
];

for (const t of sentences) {
  const s = analyzer.analyze(t).sentences[0]!;
  console.log(JSON.stringify({ text: t.slice(0, 55), sentiment: s.sentiment }));
}

function doc(url: string, text: string): SynthesisDoc {
  return {
    url, finalUrl: null, host: new URL(url).hostname, title: 'EV market',
    fetchedAt: '2026-06-01T00:00:00.000Z', publishedAt: null, text, excerpt: null,
  };
}

const input: SynthesisInput = {
  query: 'electric vehicle market trends',
  docs: sentences.map((text, i) => doc(`https://ev-${i}.example.com/r`, text)),
  failures: [],
};
const opts: SynthesisOptions = {
  strategy: 'deterministic', detail: 'full', length: 'short', scope: 'public',
  taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', runId: 'run-123', searchProvider: 'tavily',
};

const result = await new DeterministicSynthesizer({ clock: () => new Date('2026-06-02T00:00:00.000Z') }).synthesize(input, opts);
if (result.isOk) {
  const brief = result.value.brief;
  console.log('findings:', JSON.stringify(brief.key_findings.map((f) => f.text), null, 1));
  for (const s of brief.sections) {
    console.log(`--- ${s.heading} ---`);
    console.log(s.body_md);
  }
} else {
  console.log('ERR', result.error.message);
}
