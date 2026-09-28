// HardverApró figyelő: ntfy.sh push értesítés új RTX 4070 Ti Super / RTX 5070 Ti hirdetésekről.
// Alapja: Rudesz/hardverapro-red-figyelo (a hirdetéslista-feldolgozó rész onnan származik).
// Futtatás: NTFY_TOPIC=<topic> node watch.mjs   (próba, küldés és mentés nélkül: DRY_RUN=1 node watch.mjs)

import { readFile, writeFile } from 'node:fs/promises';

// >>> ITT ÁLLÍTSD BE: a Hardveraprón keress rá, állítsd be a szűrőket (videokártya kategória,
// >>> maximum ár), rendezd a találatokat a legújabb szerint, és másold be az oldal URL-jét.
const LIST_URLS = [
  'https://hardverapro.hu/aprok/hardver/videokartya/nvidia/geforce_40xx/keres.php?stext=4070+ti+super&stcid_text=&stcid=&stmid_text=&stmid=&minprice=&maxprice=420000&cmpid_text=&usrid_text=&usrid=&__buying=1&__buying=0&stext_none=&noiced=1&__brandnew=1&__brandnew=0',
  'https://hardverapro.hu/aprok/hardver/videokartya/nvidia/geforce_50xx_sorozat/keres.php?stext=5070+ti&stcid_text=&stcid=&stmid_text=&stmid=&minprice=&maxprice=420000&cmpid_text=&usrid_text=&usrid=&__buying=1&__buying=0&stext_none=&noiced=1&__brandnew=1&__brandnew=0',
];

// Ennél drágább hirdetésről nem küld értesítést (Ft). Ha nincs ár a hirdetésben, átengedi.
const MAX_PRICE = 400_000;

// Modell a címben: 4070 Ti Super (4070 Ti S, 4070TiS is) vagy 5070 Ti.
const MODEL =
  /(?<!\d)4070[\s._-]?ti[\s._-]?(?:super|s)(?![a-z])|(?<!\d)5070[\s._-]?ti(?![a-z])/i;

// Nem különálló kártya (gépek, laptopok) kizárása.
const EXCLUDE = /laptop|notebook|\bpc\b|komplett|konfig|szerver/i;

// Fehér kártyára utaló szavak. Csak jelölés: a nem fehér kártyáról is jön értesítés,
// mert sok hirdető nem írja ki a színt.
const WHITE = /feh[eé]r|white|\bice\b|aero|\bsnow\b|frost/i;

// Figyelmeztető szavak (javított, hibás, sérült).
const PROBLEM = /jav[ií]tott|hib[aá]s|t[oö]r[oö]tt|alkatr[eé]sz|s[eé]r[uü]lt/i;

const STATE_FILE = new URL('./seen.json', import.meta.url);
const NTFY_URL = 'https://ntfy.sh/';
const USER_AGENT = 'Mozilla/5.0 (compatible; hardverapro-gpu-figyelo/1.0)';
const DRY_RUN = process.env.DRY_RUN === '1';
const NTFY_TOPIC = process.env.NTFY_TOPIC;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchList(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'hu' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw err;
      console.warn(`Letöltési hiba (${err.message}), újrapróbálás 30 mp múlva...`);
      await sleep(30_000);
    }
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

// Minden hirdetés egy <li class="media ..." data-uadid="123"> blokk (Rudesz szkriptje alapján).
function parseAds(html) {
  const starts = [...html.matchAll(/<li class="media([^"]*)" data-uadid="(\d+)"/g)];
  return starts
    .map((start, i) => {
      const chunk = html.slice(start.index, starts[i + 1]?.index ?? html.length);
      const heading = chunk.match(/uad-col-title">\s*<h1>\s*<a href="([^"]+)">([^<]*)<\/a>/);
      if (!heading) return null;
      const price = chunk.match(/class="uad-price[^"]*">\s*<span class="text-nowrap">([^<]*)</)?.[1];
      const city = chunk.match(/class="uad-cities">([^<]*)</)?.[1];
      return {
        id: start[2],
        link: heading[1],
        title: decodeEntities(heading[2]).trim(),
        price: price ? decodeEntities(price).trim() : null,
        city: city ? decodeEntities(city).trim() : null,
        iced: start[1].includes('uad-status-iced'),
        wanted: price?.trim() === 'Keresem',
      };
    })
    .filter(Boolean);
}

function priceNumber(ad) {
  if (!ad.price) return NaN;
  const digits = ad.price.replace(/\D/g, '');
  return digits ? Number(digits) : NaN;
}

function isMatch(ad) {
  if (ad.iced || ad.wanted) return false;
  if (!MODEL.test(ad.title) || EXCLUDE.test(ad.title)) return false;
  const price = priceNumber(ad);
  return Number.isNaN(price) || price <= MAX_PRICE;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveState(state) {
  if (DRY_RUN) return;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function notify(message) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${message.title}\n  ${message.message.replaceAll('\n', '\n  ')}\n  -> ${message.click}`);
    return;
  }
  const res = await fetch(NTFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: NTFY_TOPIC, ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
}

function adMessage(ad) {
  const white = WHITE.test(ad.title);
  const problem = PROBLEM.test(ad.title);
  const lines = [ad.title, ad.city].filter(Boolean);
  if (problem) lines.push('FIGYELEM: a cím javított/hibás/sérült szót tartalmaz!');
  return {
    title: `${white ? 'FEHÉR? ' : ''}Új GPU – ${ad.price ?? 'ár nélkül'}`,
    message: lines.join('\n'),
    click: ad.link,
    tags: [white ? 'white_circle' : 'desktop_computer', ...(problem ? ['warning'] : [])],
    priority: white ? 5 : 4,
  };
}

async function main() {
  if (!DRY_RUN && !NTFY_TOPIC) throw new Error('Hiányzik a NTFY_TOPIC környezeti változó.');
  if (LIST_URLS.some((url) => url.startsWith('IDE_MASOLD_BE'))) {
    throw new Error('Először írd be a keresési URL-eket a LIST_URLS listába.');
  }

  const matchesById = new Map();
  let totalAds = 0;
  for (const url of LIST_URLS) {
    const ads = parseAds(await fetchList(url));
    if (ads.length === 0) {
      throw new Error(`0 hirdetés ezen az oldalon: ${url} (megváltozott az oldal szerkezete, vagy blokkolják a lekérést).`);
    }
    totalAds += ads.length;
    for (const ad of ads.filter(isMatch)) matchesById.set(ad.id, ad);
  }
  const matches = [...matchesById.values()];
  const now = new Date().toISOString();
  let state = await loadState();

  // Első futás: a már fent lévő hirdetéseket csak elmentjük, és egy összefoglalót küldünk.
  if (state === null) {
    await notify({
      title: 'HardverApró figyelő elindult',
      message:
        `Jelenleg ${matches.length} találat van fent:\n` +
        matches.map((ad) => `• ${ad.title} – ${ad.price ?? '?'}`).join('\n'),
      click: LIST_URLS[0],
      tags: ['white_check_mark'],
    });
    state = Object.fromEntries(matches.map((ad) => [ad.id, { title: ad.title, firstSeen: now }]));
    await saveState(state);
    console.log(`Inicializálva: ${totalAds} hirdetés, ${matches.length} találat elmentve.`);
    return;
  }

  const fresh = matches.filter((ad) => !state[ad.id]);
  console.log(`${totalAds} hirdetés, ${matches.length} találat, ${fresh.length} új.`);

  try {
    for (const ad of fresh) {
      await notify(adMessage(ad));
      // Csak sikeres küldés után jelöljük látottnak, így hiba esetén a következő futás újrapróbálja.
      state[ad.id] = { title: ad.title, firstSeen: now };
      console.log(`Elküldve: ${ad.title} (${ad.price ?? 'ár nélkül'})`);
    }
  } finally {
    await saveState(state);
  }
}

main().catch((err) => {
  console.error(`Hiba: ${err.message}`);
  process.exitCode = 1;
});
