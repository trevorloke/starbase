// The website's petitions, as it first published them, for a campaign with
// none yet (petition.seed): the site signs people up by these slugs. The
// words are the site's own; edit them under Outreach → Petitions after.
export const SEED_PETITIONS = [
  {
    slug: 'stop-mccallum-pledge',
    title: 'Stop Doug McCallum and Mandeep Nagra pledge',
    body: 'I won’t sit back while City Hall gets run for insiders. I’ll watch every cut, fee hike, and backroom deal, speak up when it counts, and vote to replace Doug McCallum and Mandeep Nagra at the next election.',
    question: null,
  },
  {
    slug: 'skytrain-south-surrey',
    title: 'SkyTrain to South Surrey petition',
    body: [
      'Doug promised SkyTrain to 64 Avenue. It still stops at King George. We’ll help you finish the job, Doug: all the way to South Surrey. We’re also calling on the province to honour its commitment of $250 million for B-Line expansion.',
      '',
      'We’re calling on Mayor Doug McCallum to keep his promise:',
      '1. Commit in writing to SkyTrain reaching at least 64 Avenue, with a target year.',
      '2. Get the extension into TransLink’s next investment plan with a route, a cost, and a funding ask to the province and Ottawa.',
      '3. Report to residents every year on what’s funded, what’s designed, and what’s built.',
    ].join('\n'),
    question: 'Where do you think the line should end?',
  },
];
