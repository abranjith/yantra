/**
 * The checked-in long-form corpus the `article` fixture serves (about 1,500
 * words of original prose). It is deliberately unrelated to the vehicle
 * inventory, so no listing value can leak into an article answer, and it states
 * two checkable facts ({@link ARTICLE_FACTS}) a question can be scored against.
 */

export const ARTICLE_TITLE = 'Sizing a home backup battery for a multi-day outage';
export const ARTICLE_AUTHOR = 'Mara Ellison';
export const ARTICLE_PUBLISHED = '2026-03-14';

/** The facts an `article-question` answer must state. */
export const ARTICLE_FACTS = Object.freeze({
  /** Days of essential load the guide recommends covering. */
  coverageDays: '1.5 days',
  /** The example household's resulting battery capacity. */
  exampleCapacity: '15 kWh',
});

/** Section headings and their paragraphs, in reading order. */
export const ARTICLE_SECTIONS: readonly {
  readonly heading: string | null;
  readonly paragraphs: readonly string[];
}[] = Object.freeze([
  {
    heading: null,
    paragraphs: [
      'A home backup battery is usually bought after a long outage, when the memory of a warm ' +
        'freezer and a dark house is still fresh. That timing tends to produce one of two ' +
        'mistakes. Some households buy far more capacity than they will ever use, because the ' +
        'largest system felt like the safest one. Others buy a unit sized for an evening of ' +
        'lights and discover during the next storm that it cannot keep the refrigerator cold ' +
        'until morning. Both mistakes come from skipping the same step: writing down what the ' +
        'battery actually has to run, and for how long.',
      'This guide walks through that step. It does not recommend a brand or a chemistry, and it ' +
        'does not assume solar panels are part of the system. It focuses on the arithmetic that ' +
        'decides whether a battery of a given size will carry a household through a realistic ' +
        'outage, and on the judgment calls that the arithmetic cannot make for you.',
    ],
  },
  {
    heading: 'Start with essential loads, not the whole house',
    paragraphs: [
      'The first decision is what counts as essential. A whole-house backup that runs central ' +
        'air conditioning, an electric range, and a clothes dryer is a very different machine ' +
        'from one that keeps food cold, water flowing, and phones charged. Most households that ' +
        'go through this exercise end up with a short list: the refrigerator and freezer, a few ' +
        'lights, the internet router, phone and laptop chargers, a well pump or sump pump where ' +
        'one exists, and the blower and controls of a gas furnace in cold climates.',
      'Write each item down with its running power in watts and an honest estimate of how many ' +
        'hours a day it actually runs. A refrigerator is the classic trap here. Its nameplate may ' +
        'list several hundred watts, but the compressor cycles on and off, so its average draw ' +
        'across a day is much lower. A modern refrigerator often averages around 150 watts, which ' +
        'works out to roughly 3.6 kWh over twenty-four hours. A router and a handful of LED ' +
        'lights add surprisingly little; a pump or a furnace blower can add a great deal.',
      'Add the daily energy of every essential item together. For the example household used ' +
        'throughout this guide — a refrigerator, a chest freezer, lighting, networking, ' +
        'charging, and a furnace blower during a winter outage — the total comes to about 10 kWh ' +
        'per day. Your number will differ, and it is worth measuring rather than guessing: an ' +
        'inexpensive plug-in energy meter left on the refrigerator for a week will tell you more ' +
        'than any nameplate.',
    ],
  },
  {
    heading: 'Decide how long the battery must carry the load',
    paragraphs: [
      'The second decision is duration. Utility outage statistics are dominated by short events ' +
        'measured in minutes, which any battery can ride through. The outages that matter for ' +
        'sizing are the long ones that follow severe weather, when crews are stretched across a ' +
        'region and restoration takes a day or more. Planning for the median outage produces a ' +
        'battery that fails exactly when it is needed.',
      'The recommendation in this guide is to size the battery for at least 1.5 days of essential ' +
        'load. A day and a half covers the common pattern of an outage that begins in the evening, ' +
        'runs through the following day, and is restored sometime the next night. It also leaves ' +
        'room for the usual underestimates in the load list. Households in areas with a history ' +
        'of multi-day outages, or with medical equipment that cannot be interrupted, should plan ' +
        'for more.',
      'For the example household, the arithmetic is straightforward: 10 kWh per day for 1.5 days ' +
        'means the battery needs to deliver 15 kWh of usable energy. That is usable energy, not ' +
        'the capacity printed on the box, which brings us to the next step.',
    ],
  },
  {
    heading: 'Account for usable capacity and conversion losses',
    paragraphs: [
      'Batteries are rarely allowed to discharge completely. Manufacturers reserve part of the ' +
        'stored energy to protect the cells, and the remaining usable fraction varies by product. ' +
        'A specification sheet will usually list both a total and a usable figure; the usable ' +
        'figure is the one that matters. When only a total is given, ask the installer what ' +
        'depth of discharge the system permits.',
      'Energy is also lost converting the battery’s direct current into the alternating current ' +
        'that household circuits use. The inverter’s efficiency depends on how heavily it is ' +
        'loaded, and it is usually lowest at very light loads — which is exactly how a battery ' +
        'spends most of a night, running a refrigerator and a router. A reasonable planning ' +
        'margin is to add a tenth to the usable energy you calculated, so the example household ' +
        'would look for a system that delivers comfortably more than its 15 kWh target.',
    ],
  },
  {
    heading: 'Check power, not only energy',
    paragraphs: [
      'Energy answers the question of how long; power answers the question of how much at once. ' +
        'A battery can hold plenty of energy and still trip its inverter when a well pump starts ' +
        'while the microwave is running. Motors draw a brief surge when they start, often several ' +
        'times their running power, and the inverter has to supply that surge without shutting ' +
        'down.',
      'List the items that might start at the same moment and add their surge figures. Compare ' +
        'that total with the inverter’s continuous and peak ratings. If the numbers are close, ' +
        'it is usually cheaper to stagger loads — letting the pump start before the microwave — ' +
        'than to buy a larger inverter, but that only works if everyone in the household knows ' +
        'the rule during an outage.',
    ],
  },
  {
    heading: 'Plan the outage, not just the purchase',
    paragraphs: [
      'A battery sized with care can still run flat early if the household behaves as though the ' +
        'grid were up. The simplest protection is a short written plan: which circuits stay on, ' +
        'which appliances wait, and who checks the state of charge each morning. Keeping the ' +
        'freezer closed, cooking on a gas grill outdoors, and charging devices during the day ' +
        'all stretch a fixed amount of stored energy further.',
      'It is also worth rehearsing once. Switch to the backup circuits on a mild weekend and run ' +
        'the house on essentials for an evening. The rehearsal will reveal the forgotten item — ' +
        'the garage door that will not open, the furnace that needs a circuit no one moved — ' +
        'while the fix is still a short call to an electrician rather than an emergency.',
    ],
  },
  {
    heading: 'Temperature changes what a battery can deliver',
    paragraphs: [
      'Batteries are rated at comfortable room temperatures, and outages rarely arrive in ' +
        'comfortable weather. A battery installed in an unheated garage can deliver noticeably ' +
        'less energy on a freezing night than its specification sheet promises, and some systems ' +
        'limit charging altogether below a threshold temperature to protect the cells. Heat has ' +
        'its own cost: a battery that spends summers in a hot attic ages faster, and its usable ' +
        'capacity shrinks year by year.',
      'Where the battery lives is therefore part of the sizing decision. An indoor location with ' +
        'a stable temperature preserves both the capacity you paid for and the lifetime you ' +
        'expect. If the only practical location is outdoors or in a garage, ask the installer how ' +
        'the system behaves at the coldest temperatures your area sees, and plan on the lower ' +
        'figure rather than the brochure one.',
    ],
  },
  {
    heading: 'Common sizing mistakes',
    paragraphs: [
      'The most common mistake is sizing from monthly utility bills. A bill reports the whole ' +
        'house, including the loads you deliberately left off the essential list, and it averages ' +
        'away the cold or hot days when an outage is most likely. Bills are useful for checking ' +
        'that an estimate is plausible, but they are a poor substitute for a measured list of ' +
        'what must keep running.',
      'The second mistake is forgetting standby loads. Many devices draw a few watts even when ' +
        'they look switched off, and a dozen of them running for a day and a half add up to a ' +
        'meaningful fraction of a small battery. Unplugging what the household does not need ' +
        'during an outage is free capacity.',
      'The third mistake is treating the battery as the only plan. A cooler, a supply of ice, ' +
        'and a few battery lanterns cost little and buy time if the outage outlasts the ' +
        'calculation. A well-sized battery is the center of an outage plan, not the whole of it.',
    ],
  },
  {
    heading: 'When to revisit the size',
    paragraphs: [
      'Loads change. A new heat pump, an electric vehicle charger, or a home office with ' +
        'several monitors can quietly double the essential list. Revisit the calculation whenever ' +
        'a large appliance is added, and after any long outage, when the household has real ' +
        'evidence about what it actually used.',
      'The guide’s two numbers are a starting point, not a verdict. Measure the essential load, ' +
        'plan for at least 1.5 days, add a margin for usable capacity and conversion losses, and ' +
        'check that the inverter can start everything that might start together. A battery ' +
        'chosen that way will rarely be the largest one on the market, and it will rarely leave ' +
        'a household in the dark before the lights come back on.',
    ],
  },
]);
