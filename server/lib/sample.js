// Imagine Surrey sample data — realistic doors across six Surrey
// neighbourhoods so a fresh workspace can be tested on day one.
//
// Positions come from Surrey's grid: avenue N sits near lat 49.0024 +
// N·0.00181 and street S near lng -122.8900 + (S−120)·0.00279, so
// "13245 72 Ave" lands on the right block in Newton. Every email uses a
// reserved .example domain and every phone a fictional 555-01xx number —
// nothing here can reach a real person even with providers connected.

const latOfAve = (ave) => 49.0024 + ave * 0.00181;
const lngOfStreet = (st) => -122.89 + (st - 120) * 0.00279;

// [neighbourhood, avenue, first street, households: [[name, ...housemates]]]
const BLOCKS = [
  ['Newton', 72, 132, [
    ['Harjit Gill', 'Simran Gill'], ['Maya Chen'], ['Tom Riley'], ['Gurpreet Sandhu', 'Navdeep Sandhu'],
    ['Ana Souza'], ['Dev Patel'], ['Rosa Delgado'],
  ]],
  ['Whalley', 104, 134, [
    ['Jasmine Wong'], ['Kwame Mensah', 'Efua Mensah'], ['Liam O’Connor'], ['Priya Nair'],
    ['Daniel Kim'], ['Fatima Rahimi'], ['Marco Bianchi'],
  ]],
  ['Guildford', 101, 150, [
    ['Hannah Lee'], ['Arjun Mehta', 'Kavya Mehta'], ['Sofia Petrova'], ['James Okafor'],
    ['Mei Lin'], ['Carlos Reyes'], ['Aisha Khan'],
  ]],
  ['Fleetwood', 84, 160, [
    ['Ben Thompson', 'Claire Thompson'], ['Manpreet Dhaliwal'], ['Yuki Tanaka'], ['Olivia Brown'],
    ['Ravi Shankar'], ['Grace Kim'], ['Noah Wilson'],
  ]],
  ['Cloverdale', 58, 176, [
    ['Emma Fraser'], ['Jack Morrison'], ['Isabel Cruz', 'Miguel Cruz'], ['Sam Ortiz'],
    ['Leah Goldberg'], ['Owen Price'], ['Zara Ali'],
  ]],
  ['South Surrey', 20, 152, [
    ['Charlotte Hughes'], ['Victor Nguyen', 'Linh Nguyen'], ['Peter Andersen'], ['Nina Kapoor'],
    ['George Bell'], ['Helen Park'], ['Ali Hassan'],
  ]],
];

// Rating per household position, cycled — a believable early-campaign spread.
const RATING_CYCLE = ['1', '2', null, '3', '1', '4D', null, '2', '4B', '3', '1', null, '4', '2', '4F', '1', '3', '4N', null, '2', '4C'];

const emailOf = (name) => `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.org`;

export const buildSample = () => {
  const people = [];
  let n = 0;
  for (const [hood, ave, street, households] of BLOCKS) {
    households.forEach((members, i) => {
      // Alternate sides: odd numbers north, even south, walking east.
      const offset = 13 + i * 12;
      const house = street * 100 + offset + (i % 2 === 0 ? 0 : 1);
      const side = house % 2 === 1 ? 1 : -1;
      const lat = latOfAve(ave) + side * 0.00009;
      const lng = lngOfStreet(street + offset / 100);
      members.forEach((name, j) => {
        const rating = RATING_CYCLE[n % RATING_CYCLE.length];
        n += 1;
        people.push({
          key: name,
          name,
          hood,
          address: `${house} ${ave} Ave`,
          city: 'Surrey',
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
          phone: n % 4 === 0 ? null : `604-555-01${String(n % 100).padStart(2, '0')}`,
          email: j === 0 && n % 3 !== 0 ? emailOf(name) : null,
          rating,
          channel: n % 5 === 0 ? 'phone' : 'door',
        });
      });
    });
  }

  const tags = {
    'Maya Chen': ['VIP', 'endorser'], 'Kwame Mensah': ['business'], 'Hannah Lee': ['VIP'],
    'Emma Fraser': ['host'], 'Charlotte Hughes': ['donor-prospect'], 'Fatima Rahimi': ['faith'],
  };
  const roles = [
    ['Sam Ortiz', 'doorknocking'], ['Sam Ortiz', 'driver'],
    ['Gurpreet Sandhu', 'translation', 'Punjabi'], ['Gurpreet Sandhu', 'community_committee', 'Newton'],
    ['Priya Nair', 'phoning'], ['Priya Nair', 'data_entry'],
    ['Daniel Kim', 'zone_house_captain'], ['Mei Lin', 'translation', 'Mandarin'],
    ['Ben Thompson', 'scrutineer'], ['Emma Fraser', 'event_hosting'], ['Jack Morrison', 'burmashave'],
  ];
  const gifts = [
    ['Maya Chen', 25000, 'monthly', 'card'],           // superstar ($250/mo)
    ['Hannah Lee', 10000, 'monthly', 'card'],          // star ($100/mo)
    ['Charlotte Hughes', 100000, 'one-time', 'cheque'], // star ($1K)
    ['Kwame Mensah', 50000, 'one-time', 'etransfer'],
    ['Arjun Mehta', 80000, 'one-time', 'card'],
    ['Arjun Mehta', 70000, 'one-time', 'card'],        // $1,500 crosses the municipal cap → flagged
    ['Peter Andersen', 5000, 'one-time', 'cash'],
    ['Leah Goldberg', 2500, 'monthly', 'card'],
  ];
  const signs = [
    ['Harjit Gill', 'lawn', 'installed'], ['Maya Chen', 'lawn', 'installed'], ['Hannah Lee', 'large', 'requested'],
    ['Ben Thompson', 'lawn', 'requested'], ['Emma Fraser', 'lawn', 'installed'],
    [null, 'billboard', 'installed', 'King George Blvd & 88 Ave', latOfAve(88), lngOfStreet(137.2)],
  ];
  const media = [
    { name: 'Surrey Now-Leader desk (sample)', email: 'newsdesk@surreynow.example', tags: ['media'] },
    { name: 'Rita Sandhu — radio (sample)', email: 'rita@radio.example', tags: ['media'], socials: { x: '@ritasandhu_sample' } },
    { name: 'Daniel Ruiz — TV (sample)', email: 'druiz@tv.example', tags: ['media'] },
  ];
  // Who knows whom (ext/relationships): Priya Nair, a sample volunteer, and
  // her people; Gurpreet's and Sam's; a few more. [a, b, kind, note, b was
  // brought in by a].
  const relationships = [
    ['Priya Nair', 'Jasmine Wong', 'neighbour', 'Same block'],
    ['Priya Nair', 'Liam O’Connor', 'neighbour'],
    ['Priya Nair', 'Daniel Kim', 'friend'],
    ['Priya Nair', 'Fatima Rahimi', 'community'],
    ['Priya Nair', 'Maya Chen', 'work'],
    ['Priya Nair', 'Sofia Petrova', 'friend', null, true],
    ['Gurpreet Sandhu', 'Navdeep Sandhu', 'family'],
    ['Gurpreet Sandhu', 'Harjit Gill', 'community'],
    ['Gurpreet Sandhu', 'Manpreet Dhaliwal', 'family'],
    ['Gurpreet Sandhu', 'Ravi Shankar', 'community'],
    ['Sam Ortiz', 'Jack Morrison', 'friend'],
    ['Sam Ortiz', 'Emma Fraser', 'neighbour'],
    ['Sam Ortiz', 'Owen Price', 'community'],
    ['Maya Chen', 'Hannah Lee', 'friend'],
    ['Maya Chen', 'Kwame Mensah', 'work'],
    ['Emma Fraser', 'Charlotte Hughes', 'community'],
  ];
  const subscribers = ['maya.chen@example.org', 'hannah.lee@example.org', 'charlotte.hughes@example.org', 'supporter.one@example.org', 'supporter.two@example.org'];

  // Newton turf: the 72 Ave block, padded.
  const newton = people.filter((p) => p.hood === 'Newton');
  const lats = newton.map((p) => p.lat);
  const lngs = newton.map((p) => p.lng);
  const pad = 0.0012;
  const turf = {
    name: 'Newton — 72 Ave (sample)',
    polygon: [
      [Math.max(...lats) + pad, Math.min(...lngs) - pad], [Math.max(...lats) + pad, Math.max(...lngs) + pad],
      [Math.min(...lats) - pad, Math.max(...lngs) + pad], [Math.min(...lats) - pad, Math.min(...lngs) - pad],
    ],
  };

  return { people, tags, roles, gifts, signs, media, subscribers, turf, relationships };
};
