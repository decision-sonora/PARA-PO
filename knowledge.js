'use strict';
// ============================================================================
// PARA-PO knowledge base: Zamboanga City places for the assistant and the tourist guide.
//
// HOW TO EXTEND: add a line with add(name, type, { aliases, blurb, tips, tags, area, q, explore, goLabel }).
//   type    : barangay | school | mall | hospital | transport | civic | tourist | food | stay
//   aliases : other spellings, short names and abbreviations people type
//   blurb   : one short factual sentence (only what you are sure about)
//   tips    : short practical tips
//   tags    : for tourist guide filters: top beach nature heritage religion waterfront food shopping stay family budget evening culture
//   q       : the search text used when a tourist taps "Get me there" (defaults to the name)
//   explore : true = shows up in the tourist guide
// This is starter data written from general knowledge. Please verify names and details, and never add
// opening hours, prices or phone numbers here: they go stale and the assistant is told not to quote them.
// ============================================================================

// ---------- text matching helpers ----------
const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')       // Niño -> nino
    .replace(/\bsta\.?(?=\s|$)/g, 'santa')                  // Sta. Maria -> santa maria
    .replace(/\bsto\.?(?=\s|$)/g, 'santo')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function withinOneEdit(a, b) { // true when a and b differ by at most one insertion, deletion or substitution
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (a.length < b.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

// ---------- entity store ----------
const ents = [];
const slug = (s) => norm(s).replace(/ /g, '-');
function add(name, type, o = {}) {
    const aliases = new Set([name, ...(o.aliases || [])].map(norm).filter(a => a.length >= 3));
    ents.push({
        id: slug(name), name, type,
        aliases: [...aliases],
        blurb: o.blurb || '', tips: o.tips || [], tags: o.tags || [],
        q: o.q || `${name}, Zamboanga City`, area: o.area || '',
        explore: !!o.explore, goLabel: o.goLabel || ''
    });
}

// ---------- the 98 barangays of Zamboanga City ----------
const BARANGAYS = [
    'Arena Blanco', 'Ayala', 'Baliwasan', 'Baluno', 'Boalan', 'Bolong', 'Buenavista', 'Bunguiao', 'Busay', 'Cabaluay',
    'Cabatangan', 'Cacao', 'Calabasa', 'Calarian', 'Camino Nuevo', 'Campo Islam', 'Canelar', 'Capisan', 'Cawit', 'Culianan',
    'Curuan', 'Dita', 'Divisoria', 'Dulian (Upper Bunguiao)', 'Dulian (Upper Pasonanca)', 'Guisao', 'Guiwan', 'Kasanyangan',
    'La Paz', 'Labuan', 'Lamisahan', 'Landang Gua', 'Landang Laum', 'Lanzones', 'Lapakan', 'Latuan (Curuan)', 'Licomo', 'Limaong',
    'Limpapa', 'Lubigan', 'Lumayang', 'Lumbangan', 'Lunzuran', 'Maasin', 'Malagutay', 'Mampang', 'Manalipa', 'Mangusu',
    'Manicahan', 'Mariki', 'Mercedes', 'Muti', 'Pamucutan', 'Pangapuyan', 'Panubigan', 'Pasilmanta', 'Pasobolong', 'Pasonanca',
    'Patalon', 'Putik', 'Quiniput', 'Recodo', 'Rio Hondo', 'Salaan', 'San Jose Cawa-Cawa', 'San Jose Gusu', 'San Roque', 'Sangali',
    'Santa Barbara', 'Santa Catalina', 'Santa Maria', 'Santo Niño', 'Sibulao (Curuan)', 'Sinubung', 'Sinunoc', 'Tagasilay', 'Taguiti', 'Talabaan',
    'Talisayan', 'Talon-Talon', 'Taluksangay', 'Tetuan', 'Tictapul', 'Tigbalabag', 'Tigtabon', 'Tolosa', 'Tugbungan', 'Tulungatung',
    'Tumaga', 'Tumalutab', 'Tumitus', 'Victoria', 'Vitali', 'Zambowood', 'Zone I', 'Zone II', 'Zone III', 'Zone IV'
];
const BARANGAY_ALIASES = {
    'Sinunoc': ['Sinunuc', 'Sinnunuc', 'Sinonoc'],
    'Talon-Talon': ['Talon'],
    'Zone I': ['Zone 1'], 'Zone II': ['Zone 2'], 'Zone III': ['Zone 3'], 'Zone IV': ['Zone 4'],
    'Santo Niño': ['Sto Nino'],
    'San Jose Cawa-Cawa': ['San Jose Cawacawa', 'Cawa-Cawa Barangay'],
    'Taluksangay': ['Taluksangai'],
    'Tulungatung': ['Tulungatong'],
    'Pasonanca': ['Pasonanka'],
    'Guiwan': ['Giwan']
};
// Only notes that are well known. Barangays without a note are still recognised as barangays.
const BARANGAY_NOTES = {
    'Pasilmanta': 'Located on Sacol Island, reached by boat.',
    'Tigtabon': 'An island barangay, reached by boat.',
    'Curuan': 'Far north coast of the city, a long ride from downtown. Its barangays include Latuan and Sibulao.',
    'Sibulao': 'On the Curuan side of the city, a long trip from downtown.',
    'Latuan': 'On the Curuan side of the city, a long trip from downtown.',
    'Baliwasan': 'Home of Western Mindanao State University (WMSU).',
    'Pasonanca': 'Home of Pasonanca Park.',
    'Taluksangay': 'Home of the Taluksangay Mosque.',
    'Santa Catalina': 'Home of the Zamboanga City Medical Center (ZCMC).',
    'Ayala': 'On the west side of the city, a long ride from downtown.',
    'Zone I': 'One of the four downtown (poblacion) zones.',
    'Zone II': 'One of the four downtown (poblacion) zones.',
    'Zone III': 'One of the four downtown (poblacion) zones.',
    'Zone IV': 'One of the four downtown (poblacion) zones.'
};
for (const b of BARANGAYS) {
    const base = b.replace(/\s*\(.*\)\s*/, '').trim();
    add(b, 'barangay', {
        aliases: [base, ...(BARANGAY_ALIASES[base] || [])],
        blurb: BARANGAY_NOTES[base] || '',
        q: `${base}, Zamboanga City`
    });
}

// ---------- schools ----------
add('Western Mindanao State University', 'school', { aliases: ['WMSU', 'WMSU Normal Road'], area: 'Baliwasan', blurb: 'State university on Normal Road, Baliwasan.' });
add('Ateneo de Zamboanga University', 'school', { aliases: ['Ateneo', 'ADZU', 'Ateneo de Zamboanga'], blurb: 'Private Jesuit university on La Purisima Street.' });
add('Universidad de Zamboanga', 'school', { aliases: ['UZ', 'Universidad de Zamboanga University'], blurb: 'Private university in the city center.' });
add('Zamboanga Peninsula Polytechnic State University', 'school', { aliases: ['ZPPSU', 'ZCSPC', 'Zamboanga City State Polytechnic College'], blurb: 'State university, formerly Zamboanga City State Polytechnic College.' });
add('Zamboanga State College of Marine Sciences and Technology', 'school', { aliases: ['ZSCMST', 'Marine Sciences'], blurb: 'State college for marine sciences and fisheries.' });
add('Pilar College of Zamboanga City', 'school', { aliases: ['Pilar College'], blurb: 'Private college.' });
add('Southern City Colleges', 'school', { aliases: ['SCC'], blurb: 'Private college.' });
add('Brent International School Zamboanga', 'school', { aliases: ['Brent School', 'Brent International School'], blurb: 'Private school.' });
add('Zamboanga Chong Hua High School', 'school', { aliases: ['Chong Hua', 'Chong Hua High School', 'Zamboanga Chong Hua'], blurb: 'Private Chinese-Filipino high school.' });
add('Regional Science High School for Region IX', 'school', { aliases: ['RSHS IX', 'RSHS', 'Regional Science High School', 'Regional Science High School IX', 'Region IX Science High School'], blurb: 'Public science high school for Region IX.' });
add('Don Pablo Lorenzo Memorial National High School', 'school', { aliases: ['Don Pablo', 'Don Pablo Memorial National High School', 'Don Pablo Lorenzo Memorial High School', 'DPLMNHS', 'Don Pablo High School'], blurb: 'Public national high school.' });
add('Zamboanga City High School Main', 'school', { aliases: ['ZCHS Main', 'ZCHS', 'Zamboanga City High School', 'Zamboanga City High School - Main'], blurb: 'Public high school (main campus).' });
add('Zamboanga City High School West', 'school', { aliases: ['ZCHS West', 'Zamboanga City High School - West', 'ZCNHS West', 'Zamboanga City National High School West'], blurb: 'Public high school (west campus).' });
add('Zamboanga City School of Arts and Trades', 'school', { aliases: ['ZCSAT', 'School of Arts and Trades'], blurb: 'Public technical-vocational high school.' });

// ---------- malls, markets and shopping ----------
add('KCC Mall de Zamboanga', 'mall', { aliases: ['KCC', 'KCC Mall'], area: 'Gov. Camins Avenue', explore: true, tags: ['shopping', 'family'], blurb: 'Large air-conditioned mall with shops, food and a cinema.', tips: ['A common landmark for jeepney directions in the city.'], goLabel: '' });
add('SM City Mindpro', 'mall', { aliases: ['SM Mindpro', 'Mindpro', 'SM Zamboanga', 'SM City Zamboanga'], explore: true, tags: ['shopping', 'family'], blurb: 'SM mall with shops, food and a cinema, a short way from KCC Mall.' });
add('City Mall Tetuan', 'mall', { aliases: ['Citymall Tetuan', 'City Mall'], area: 'Tetuan', explore: true, tags: ['shopping', 'family'], blurb: 'Neighborhood mall in Tetuan.' });
add('Southway Square', 'mall', { aliases: ['Southway Square Mall', 'Southway'], explore: true, tags: ['shopping'], blurb: 'Shopping mall.' });
add('Canelar Barter Trade Center', 'mall', { aliases: ['Canelar Barter Trade', 'Barter Trade', 'Barter Trade Center', 'Canelar Barter'], area: 'Canelar', explore: true, tags: ['shopping', 'culture', 'budget'], blurb: 'Market known for imported goods and bargain shopping.', tips: ['Bring cash and compare prices before buying.'] });

// ---------- hospitals ----------
add('Zamboanga City Medical Center', 'hospital', { aliases: ['ZCMC', 'ZCMC Hospital'], area: 'Santa Catalina', blurb: 'The main government hospital, on Dr. D. Evangelista Street in Santa Catalina.' });
add('Brent Hospital and Colleges', 'hospital', { aliases: ['Brent Hospital', 'Brent'], blurb: 'Private hospital.' });
add('Zamboanga Doctors Hospital', 'hospital', { aliases: ['Zamboanga Doctors', 'Doctors Hospital'], blurb: 'Private hospital.' });
add('Ciudad Medical Zamboanga', 'hospital', { aliases: ['Ciudad Medical'], blurb: 'Private hospital.' });
add('Mindanao Central Sanitarium', 'hospital', { aliases: ['MCS'], blurb: 'Hospital.' });

// ---------- transport and civic ----------
add('Zamboanga International Airport', 'transport', { aliases: ['Airport', 'Zamboanga Airport', 'ZAM Airport'], blurb: 'The city airport, reached via Airport Road.' });
add('Zamboanga Integrated Bus Terminal', 'transport', { aliases: ['Integrated Bus Terminal', 'Bus Terminal', 'IBT'], area: 'Canelar', blurb: 'Bus terminal for trips out of the city.' });
add('Zamboanga City Port', 'transport', { aliases: ['Zamboanga Port', 'Zamboanga Seaport', 'Seaport', 'Port of Zamboanga'], blurb: 'Seaport for ferries and boats to other islands.', tips: ['Confirm ferry schedules with the operator before you travel.'] });
add('Zamboanga City Hall', 'civic', { aliases: ['City Hall'], blurb: 'American-era city hall in the downtown area.' });
add('Zamboanga City Tourism Office', 'civic', { aliases: ['City Tourism Office', 'Tourism Office', 'City Tourism Operations Office'], blurb: 'The city office for official tourism information.', tips: ['Ask them for current boat, guide and event information.'] });

// ---------- tourist spots ----------
add('Fort Pilar Shrine', 'tourist', {
    aliases: ['Fort Pilar', 'Real Fuerza de Nuestra Senora del Pilar de Zaragoza', 'Pilar Shrine', 'Zamboanga Regional Museum', 'Zamboanga Museum'],
    explore: true, tags: ['top', 'heritage', 'religion', 'waterfront', 'budget'],
    blurb: 'A 17th-century Spanish fort by the sea and a shrine to Our Lady of the Pilar, with the regional museum on the grounds.',
    tips: ['Fiesta Pilar is celebrated around October 12.', 'Dress modestly at the shrine.'],
    q: 'Fort Pilar'
});
add('Paseo del Mar', 'tourist', {
    aliases: ['Paseo'], explore: true, tags: ['top', 'waterfront', 'evening', 'food', 'family', 'budget'],
    blurb: 'Seaside promenade near Fort Pilar, popular for evening walks, sea breeze and local snacks.',
    tips: ['Best in the late afternoon and evening.'], q: 'Paseo del Mar'
});
add('Plaza Pershing', 'tourist', {
    aliases: ['Pershing Plaza'], explore: true, tags: ['heritage', 'budget', 'family'],
    blurb: 'Historic downtown plaza named after General John Pershing.', q: 'Plaza Pershing'
});
add('Metropolitan Cathedral of the Immaculate Conception', 'tourist', {
    aliases: ['Metropolitan Cathedral', 'Zamboanga Cathedral', 'Cathedral', 'Immaculate Conception Cathedral'],
    explore: true, tags: ['heritage', 'religion'],
    blurb: 'The main Catholic cathedral of the city, in the downtown area.',
    tips: ['Dress modestly and keep quiet during Mass.'], q: 'Zamboanga Metropolitan Cathedral'
});
add('Cawa-Cawa Boulevard', 'tourist', {
    aliases: ['Cawa Cawa Boulevard', 'Cawa-Cawa', 'Cawa Cawa'], explore: true, tags: ['waterfront', 'evening', 'budget', 'family'],
    blurb: 'Seaside boulevard popular for sunset views and evening hangouts.', q: 'Cawa-Cawa Boulevard'
});
add('R.T. Lim Boulevard', 'tourist', {
    aliases: ['RT Lim Boulevard', 'R.T. Lim Blvd', 'RT Lim', 'Lim Boulevard'], explore: true, tags: ['waterfront', 'evening', 'budget', 'family'],
    blurb: 'Long waterfront boulevard, popular for walks, jogging and sunsets.', q: 'R.T. Lim Boulevard'
});
add('Pasonanca Park', 'tourist', {
    aliases: ['Pasonanca Natural Park', 'Pasonanca Tree House', 'Tree House'], area: 'Pasonanca', explore: true, tags: ['top', 'nature', 'family', 'budget'],
    blurb: 'Large nature park in the uplands with the famous Pasonanca Tree House, swimming pools and picnic areas. Cooler than downtown.',
    tips: ['Bring water and wear walking shoes.'], q: 'Pasonanca Park'
});
add('Great Santa Cruz Island', 'tourist', {
    aliases: ['Santa Cruz Island', 'Sta Cruz Island', 'Pink Sand Beach', 'Pink Beach', 'Great Sta Cruz'], explore: true, tags: ['top', 'beach', 'nature', 'family'],
    blurb: 'Island famed for its pink sand (from crushed red coral) and clear water, in a protected marine area. Reached by boat.',
    tips: ['Boats usually leave from the downtown waterfront. Confirm the departure point, schedule, fees and rules with the City Tourism Office or the boat operator.', 'Bring cash, water and sun protection, and take your trash back.'],
    q: 'Paseo del Mar', goLabel: 'Get me to the waterfront (boat area)'
});
add('Little Santa Cruz Island', 'tourist', {
    aliases: ['Little Sta Cruz Island'], explore: true, tags: ['beach', 'nature'],
    blurb: 'Smaller sandy island near the Great Santa Cruz Island. Reached by boat.',
    tips: ['Ask the boat operator whether it is included in your trip.'], q: 'Paseo del Mar', goLabel: 'Get me to the waterfront (boat area)'
});
add('Taluksangay Mosque', 'tourist', {
    aliases: ['Taluksangay Mosque', 'Taluksangay'], area: 'Taluksangay', explore: true, tags: ['heritage', 'religion', 'culture'],
    blurb: 'Historic mosque in Taluksangay, a coastal community with a strong Sama heritage.',
    tips: ['Dress modestly, remove your shoes, and ask permission before taking photos of people.'], q: 'Taluksangay Mosque'
});
add('Yakan Weaving Village', 'tourist', {
    aliases: ['Yakan Village', 'Yakan Weaving', 'Yakan Weaving Center'], explore: true, tags: ['culture', 'shopping', 'heritage'],
    blurb: 'Where you can see traditional Yakan weaving and buy handwoven cloth and crafts.',
    tips: ['Ask the price before you buy and be respectful when taking photos of weavers.'], q: 'Yakan Weaving Village'
});
add('Merloquet Falls', 'tourist', {
    aliases: ['Merloquet', 'Merloquet Waterfalls'], explore: true, tags: ['nature'],
    blurb: 'Scenic waterfalls on the far Curuan side of the city. A long trip from downtown.',
    tips: ['Plan your transport and return trip ahead, and check conditions before you go.'], q: 'Merloquet Falls'
});
add('Vinta Boats', 'tourist', {
    aliases: ['Vinta', 'Vintas', 'Regatta de Zamboanga'], explore: true, tags: ['culture', 'waterfront'],
    blurb: 'Colorful traditional sailboats of the Sama seafaring communities, seen near the waterfront and in the Regatta races during the Hermosa Festival.'
});
add('Zamboanga Hermosa Festival', 'tourist', {
    aliases: ['Hermosa Festival', 'Fiesta Pilar', 'Hermosa'], explore: true, tags: ['culture', 'heritage', 'top'],
    blurb: 'The big city festival in October, around the Feast of Our Lady of the Pilar (October 12), with street events and vinta races.',
    tips: ['Book lodging early if you plan to visit in October and check the event dates with the City Tourism Office.'],
    q: 'Fort Pilar', goLabel: 'Get me to Fort Pilar'
});

// ---------- food ----------
add('Curacha', 'food', {
    aliases: ['Curacha Alavar', 'spanner crab'], explore: true, tags: ['food', 'top'],
    blurb: 'The city\'s signature dish: a spanner crab, often cooked in a rich spicy sauce.',
    tips: ['Ask the price first, since it is sold by weight.'], q: 'Alavar Seafood Restaurant'
});
add('Alavar Seafood Restaurant', 'food', {
    aliases: ['Alavar'], explore: true, tags: ['food'],
    blurb: 'A well-known seafood restaurant associated with the curacha dish.', q: 'Alavar Seafood Restaurant'
});
add('Satti', 'food', {
    aliases: ['Satti Zamboanga', 'Sati'], explore: true, tags: ['food', 'budget', 'evening'],
    blurb: 'Grilled skewered meat served with a spicy sauce and rice cakes, a local breakfast and snack favorite.',
    q: 'Paseo del Mar', goLabel: 'Get me to Paseo del Mar (food stalls)'
});

// ---------- places to stay (check current rates and availability) ----------
add('Lantaka Hotel', 'stay', { aliases: ['Lantaka'], explore: true, tags: ['stay', 'waterfront'], blurb: 'Hotel by the sea, close to Fort Pilar and Paseo del Mar.', tips: ['Check current rates and availability.'], q: 'Lantaka Hotel' });
add('Garden Orchid Hotel', 'stay', { aliases: ['Garden Orchid'], explore: true, tags: ['stay'], blurb: 'Well-known hotel in the city.', tips: ['Check current rates and availability.'], q: 'Garden Orchid Hotel' });
add('Grand Astoria Hotel', 'stay', { aliases: ['Grand Astoria', 'Astoria Hotel'], explore: true, tags: ['stay'], blurb: 'Well-known hotel in the city.', tips: ['Check current rates and availability.'], q: 'Grand Astoria Hotel' });
add('Marcian Garden Hotel', 'stay', { aliases: ['Marcian Garden', 'Marcian Hotel'], explore: true, tags: ['stay'], blurb: 'Well-known hotel in the city.', tips: ['Check current rates and availability.'], q: 'Marcian Garden Hotel' });

if (BARANGAYS.length !== 98) console.warn(`[knowledge] expected 98 barangays, found ${BARANGAYS.length}`);

// ---------- itinerary building blocks the assistant may use ----------
const ITINERARY_IDEAS = [
    'Downtown heritage half-day: Plaza Pershing, the Metropolitan Cathedral, Fort Pilar (with the regional museum), then Paseo del Mar for sunset and satti.',
    'Island day: Great Santa Cruz Island by boat from the waterfront (confirm boat, fees and weather with the City Tourism Office), back in time for dinner at Paseo del Mar.',
    'Nature half-day: Pasonanca Park and the Tree House, cooler air, good for families.',
    'Culture and shopping half-day: Yakan Weaving Village, Taluksangay Mosque (modest dress), then Canelar Barter Trade Center.',
    'Far trip (needs planning): Merloquet Falls on the Curuan side, which is a long ride from downtown.',
    'Sunset walk: Cawa-Cawa Boulevard or R.T. Lim Boulevard.'
];

// ---------- recommendation by topic ----------
const INTENT = /\b(recommend|recommendation|suggest|where to go|what to see|things to do|tourist|tourists|tourism|visit|visiting|sightseeing|itinerary|day trip|vacation|travel|pasyal|mamasyal|ipasyal|turista|puntahan|mapuntahan|famous|must try|must visit|best place|top spots|attractions?)\b/;
const TAG_WORDS = [
    [/\b(beach|beaches|island|islands|isla|snorkel|snorkeling|swim|swimming|pink sand)\b/, 'beach'],
    [/\b(park|nature|waterfall|waterfalls|falls|hike|hiking|trek|forest|cool weather)\b/, 'nature'],
    [/\b(church|cathedral|mosque|shrine|pray|prayer|simbahan|simba|religious)\b/, 'religion'],
    [/\b(history|historic|historical|heritage|fort|museum|spanish)\b/, 'heritage'],
    [/\b(culture|cultural|yakan|weaving|vinta|festival|festivals|hermosa)\b/, 'culture'],
    [/\b(food|eat|eating|kain|kumain|restaurant|seafood|curacha|satti|hungry|lunch|dinner|breakfast|snack|snacks|pagkain)\b/, 'food'],
    [/\b(shop|shopping|mall|malls|pasalubong|souvenir|souvenirs)\b/, 'shopping'],
    [/\b(hotel|hotels|stay|lodging|accommodation|sleep|tulog|room)\b/, 'stay'],
    [/\b(sunset|waterfront|boulevard|promenade|stroll|seaside)\b/, 'waterfront'],
    [/\b(kids|kid|family|children|bata|toddler)\b/, 'family'],
    [/\b(budget|free|cheap|mura|libre|affordable)\b/, 'budget'],
    [/\b(night|gabi|evening)\b/, 'evening']
];

function recommend(t) {
    const want = new Set();
    for (const [re, tag] of TAG_WORDS) if (re.test(t)) want.add(tag);
    const intent = INTENT.test(t);
    if (!intent && !want.size) return [];
    const scored = ents.filter(e => e.explore).map(e => {
        let s = e.tags.includes('top') ? 1 : 0;
        for (const w of want) if (e.tags.includes(w)) s += 3;
        return { e, s };
    }).filter(x => want.size ? x.s >= 3 : x.s >= 1);
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 6).map(x => x.e);
}

// ---------- hint for the assistant ----------
const TYPE_LABEL = { barangay: 'barangay of Zamboanga City', school: 'school', mall: 'mall or market', hospital: 'hospital', transport: 'transport', civic: 'civic office', tourist: 'tourist spot', food: 'local food', stay: 'place to stay' };
function describe(e) {
    return `- ${e.name} (${TYPE_LABEL[e.type] || e.type}${e.area ? ', ' + e.area : ''})` +
        (e.blurb ? `: ${e.blurb}` : '') +
        (e.tips.length ? ` Tips: ${e.tips.join(' ')}` : '');
}

function buildHint(message) {
    const t = norm(message);
    if (!t) return '';
    const padded = ' ' + t + ' ';
    let matched = [];
    const seen = new Set();
    const take = (e, alias) => { if (!seen.has(e.id) && matched.length < 8) { seen.add(e.id); matched.push({ e, alias: alias || '' }); } };
    for (const e of ents) {
        const hit = e.aliases.filter(a => padded.includes(' ' + a + ' ')).sort((x, y) => y.length - x.length)[0];
        if (hit) take(e, hit);
    }
    // "Zamboanga City High School West" should not also match the shorter "Zamboanga City High School"
    matched = matched.filter(m => !matched.some(o => o !== m && o.alias.length > m.alias.length && (' ' + o.alias + ' ').includes(' ' + m.alias + ' ')));
    matched = matched.slice(0, 6).map(m => m.e);
    if (matched.length < 6) { // forgive one-letter typos in single-word names ("Taluksangai", "Mercedez")
        const words = [...new Set(t.split(' ').filter(w => w.length >= 6))];
        for (const e of ents) {
            if (matched.length >= 6) break;
            if (matched.includes(e)) continue;
            if (e.aliases.some(a => !a.includes(' ') && a.length >= 6 && words.some(w => w !== a && withinOneEdit(w, a)))) matched.push(e);
        }
    }
    const intent = INTENT.test(t);
    // suggestions only when the person asks for ideas, or names no place at all
    const have = new Set(matched.map(e => e.id));
    const recs = (intent || !matched.length) ? recommend(t).filter(e => !have.has(e.id)) : [];
    const lines = [];
    if (matched.length) lines.push('PLACES MENTIONED:', ...matched.map(describe));
    if (recs.length) lines.push('SUGGESTED SPOTS FOR THIS REQUEST (pick the best 3 to 5):', ...recs.map(describe));
    if (intent) lines.push('ITINERARY IDEAS:', ...ITINERARY_IDEAS.map(s => '- ' + s));
    if (!lines.length) return '';
    return '\n\nSERVER-VERIFIED PLACE DATA FOR THIS QUESTION (use these facts; do not add hours, prices, phone numbers or street addresses):\n' + lines.join('\n');
}

// ---------- compact index placed in the assistant's instructions ----------
function promptIndex() {
    const names = (type) => ents.filter(e => e.type === type);
    const short = (e) => {
        const ab = e.aliases.filter(a => a.length <= 8 && a !== norm(e.name) && !a.includes(' ')).slice(0, 2).map(a => a.toUpperCase());
        return ab.length ? `${e.name} (${ab.join('/')})` : e.name;
    };
    const lines = [];
    lines.push(`BARANGAYS OF ZAMBOANGA CITY (all ${BARANGAYS.length}): ${BARANGAYS.join(', ')}.`);
    lines.push(`SCHOOLS: ${names('school').map(short).join('; ')}.`);
    lines.push(`MALLS AND MARKETS: ${names('mall').map(e => e.name).join('; ')}.`);
    lines.push(`HOSPITALS: ${names('hospital').map(short).join('; ')}.`);
    lines.push(`TRANSPORT AND CIVIC: ${[...names('transport'), ...names('civic')].map(e => e.name).join('; ')}.`);
    lines.push('ROADS: Governor Camins Avenue, Maria Clara Lobregat Highway, Veterans Avenue, La Purisima Street, Nuñez Extension, Airport Road, Normal Road, R.T. Lim Boulevard, Cawa-Cawa Boulevard.');
    lines.push('TOURIST SPOTS (short facts):');
    for (const e of names('tourist')) lines.push(`- ${e.name}: ${e.blurb}`);
    lines.push('LOCAL FOOD:');
    for (const e of names('food')) lines.push(`- ${e.name}: ${e.blurb}`);
    lines.push(`PLACES TO STAY (well-known; rates change): ${names('stay').map(e => e.name).join('; ')}.`);
    lines.push('ITINERARY BUILDING BLOCKS:');
    for (const s of ITINERARY_IDEAS) lines.push('- ' + s);
    return lines.join('\n');
}

// ---------- tourist guide data for the passenger page ----------
const CATEGORIES = [
    { id: 'all', label: 'All', tags: [] },
    { id: 'top', label: '⭐ Top picks', tags: ['top'] },
    { id: 'beach', label: '🏝️ Beaches and islands', tags: ['beach'] },
    { id: 'nature', label: '🌿 Nature and parks', tags: ['nature'] },
    { id: 'heritage', label: '🏛️ Heritage and faith', tags: ['heritage', 'religion', 'culture'] },
    { id: 'waterfront', label: '🌅 Sunset and waterfront', tags: ['waterfront'] },
    { id: 'food', label: '🍤 Food', tags: ['food'] },
    { id: 'shopping', label: '🛍️ Shopping', tags: ['shopping'] },
    { id: 'stay', label: '🛏️ Stay', tags: ['stay'] }
];
function listPlaces() {
    return ents.filter(e => e.explore).map(e => ({
        id: e.id, name: e.name, type: e.type, tags: e.tags, blurb: e.blurb, tips: e.tips, q: e.q, goLabel: e.goLabel
    }));
}

module.exports = { buildHint, promptIndex, listPlaces, CATEGORIES, norm, _ents: ents };
