/**
 * Generates lightweight placeholder imagery into public/media/seed/.
 *
 * Why not real photos or a stock-image URL?
 *   * A third-party image host makes the first run of the app depend on someone
 *     else's uptime, and the SIH demo happens on conference wifi.
 *   * Section 6 asks for lazy-loaded, responsive, low-bandwidth media. A ~4 KB
 *     SVG demonstrates that far better than a 2 MB JPEG does.
 *
 * Real deployments replace these by uploading through the CMS, which writes to
 * MinIO/S3 and sets MediaAsset.storageKey + url. These files only back the
 * seeded rows, so `url` points at /media/seed/*.svg.
 *
 *   node scripts/generate-placeholder-media.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("public/media/seed");

/** Deterministic PRNG so re-running produces byte-identical files. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} opts
 * @param {string} opts.title       Short label rendered in the corner.
 * @param {[number,number]} opts.from Gradient start.
 * @param {[number,number]} opts.to   Gradient end.
 * @param {number} opts.seed
 * @param {boolean} [opts.aurora]     Draw aurora ribbons.
 * @param {boolean} [opts.ice]        Draw ice-floe / crevasse banding.
 */
function auroraSvg({ title, from, to, seed, aurora = true, ice = false }) {
  const rnd = mulberry32(seed);
  const W = 1600;
  const H = 900;
  const id = `g${seed}`;

  // A few soft ribbons across the upper sky.
  let ribbons = "";
  if (aurora) {
    for (let i = 0; i < 3; i++) {
      const y = 120 + i * 90 + rnd() * 50;
      const amp = 60 + rnd() * 70;
      const op = (0.20 - i * 0.05).toFixed(2);
      ribbons += `<path d="M -50 ${y}
        C ${W * 0.25} ${y - amp}, ${W * 0.55} ${y + amp}, ${W + 50} ${y - amp * 0.6}"
        fill="none" stroke="url(#${id}ribbon)" stroke-width="${70 + rnd() * 60}"
        stroke-linecap="round" opacity="${op}"/>`;
    }
  }

  // Horizontal banding stands in for sea ice / glacier crevasse texture.
  let bands = "";
  if (ice) {
    for (let i = 0; i < 9; i++) {
      const y = H * 0.62 + i * 26 + rnd() * 14;
      const h = 5 + rnd() * 11;
      bands += `<rect x="0" y="${y.toFixed(1)}" width="${W}" height="${h.toFixed(1)}"
        fill="#ffffff" opacity="${(0.05 + rnd() * 0.07).toFixed(3)}"/>`;
    }
  }

  // Sparse "stars".
  let stars = "";
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W;
    const y = rnd() * H * 0.55;
    const r = 0.7 + rnd() * 1.5;
    stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}"
      fill="#fff" opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="rgb(${from.join(",")})"/>
      <stop offset="100%" stop-color="rgb(${to.join(",")})"/>
    </linearGradient>
    <linearGradient id="${id}ribbon" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3CD8FF"/>
      <stop offset="55%" stop-color="#7C5CFF"/>
      <stop offset="100%" stop-color="#3CD8FF" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="${id}vig" cx="0.5" cy="0.42" r="0.78">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#${id})"/>
  ${stars}
  ${ribbons}
  <rect x="0" y="${H * 0.6}" width="${W}" height="${H * 0.4}" fill="#04070E" opacity="0.35"/>
  ${bands}
  <rect width="${W}" height="${H}" fill="url(#${id}vig)"/>
  <text x="44" y="${H - 44}" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif"
        font-size="30" font-weight="600" fill="#F2F5F9" opacity="0.82">${title}</text>
</svg>
`;
}

/** A document-cover placeholder for reports / datasets / publications. */
function docSvg({ title, kind, seed }) {
  const W = 1200;
  const H = 1500;
  const rnd = mulberry32(seed);
  const id = `d${seed}`;
  let lines = "";
  for (let i = 0; i < 16; i++) {
    const y = 470 + i * 46;
    const w = 320 + rnd() * 620;
    lines += `<rect x="120" y="${y}" width="${w.toFixed(0)}" height="18" rx="9"
      fill="#8A93A6" opacity="${(0.16 + rnd() * 0.14).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title} cover placeholder">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0%" stop-color="#0E1626"/>
      <stop offset="100%" stop-color="#131C30"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#${id})"/>
  <rect x="0" y="0" width="${W}" height="360" fill="url(#${id}accent)"/>
  <rect x="0" y="0" width="${W}" height="360" fill="#3CD8FF" opacity="0.14"/>
  <rect x="0" y="352" width="${W}" height="8" fill="#3CD8FF"/>
  <text x="120" y="150" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="26"
        font-weight="700" letter-spacing="6" fill="#3CD8FF">${kind}</text>
  <text x="120" y="240" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="52"
        font-weight="700" fill="#F2F5F9">${title.length > 26 ? title.slice(0, 26) + "…" : title}</text>
  ${lines}
  <rect x="120" y="${H - 150}" width="260" height="52" rx="26" fill="#7C5CFF" opacity="0.85"/>
  <text x="250" y="${H - 116}" text-anchor="middle" font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif"
        font-size="24" font-weight="600" fill="#fff">NCPOR</text>
</svg>
`;
}

const PALETTES = {
  antarctica: { from: [12, 22, 44], to: [58, 122, 168], ice: true },
  arctic: { from: [14, 26, 52], to: [86, 156, 196], ice: true },
  himalaya: { from: [18, 20, 46], to: [124, 92, 255], ice: true },
  southern: { from: [10, 18, 40], to: [40, 120, 170], ice: false },
};

const images = [
  ["antarctica-hero", "Bharati Station, Antarctica", "antarctica"],
  ["antarctica-ice-shelf", "Brunt ice shelf crevasse field", "antarctica"],
  ["antarctica-aerial", "Aerial survey over the Ronne ice shelf", "antarctica"],
  ["arctic-hero", "Ny-Alesund, Svalbard", "arctic"],
  ["arctic-sea-ice", "Sea-ice floe mosaic, Arctic Ocean", "arctic"],
  ["arctic-sky", "Polar night over Kongsfjorden", "arctic"],
  ["himalaya-hero", "Dakshin Gangotri Glacier", "himalaya"],
  ["himalaya-moraine", "Moraine ridge above the glacier", "himalaya"],
  ["himalaya-camp", "Automatic weather station camp", "himalaya"],
  ["southern-hero", "Southern Ocean research vessel", "southern"],
  ["southern-ctd", "CTD rosette ready for deployment", "southern"],
  ["southern-waves", "Wave conditions in the Southern Ocean", "southern"],
];

const docs = [
  ["report-glacier-mass-balance", "Glacier Mass Balance Report", "REPORT"],
  ["report-antarctic-biodiversity", "Antarctic Biodiversity Report", "REPORT"],
  ["dataset-ctd-profiles", "CTD Cast Profiles", "DATASET"],
  ["dataset-sea-ice-concentration", "Sea-Ice Concentration", "DATASET"],
  ["dataset-glacier-fab", "Glacier Surface Elevation", "DATASET"],
  ["pub-antarctic-early-careers", "Early Career Researchers at the Poles", "PUBLICATION"],
  ["pub-sea-ice-outlook", "Antarctic Sea-Ice Outlook", "PUBLICATION"],
];

await mkdir(OUT_DIR, { recursive: true });

let count = 0;
for (const [name, title, palette] of images) {
  const p = PALETTES[palette];
  const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 7);
  await writeFile(
    path.join(OUT_DIR, `${name}.svg`),
    auroraSvg({ title, from: p.from, to: p.to, seed, ice: p.ice }),
    "utf8",
  );
  count++;
}

for (const [name, title, kind] of docs) {
  const seed = [...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 11);
  await writeFile(path.join(OUT_DIR, `${name}.svg`), docSvg({ title, kind, seed }), "utf8");
  count++;
}

console.log(`[media] wrote ${count} placeholder files to public/media/seed/`);

// --- Sample data files -----------------------------------------------------
// Small, real, downloadable files so the researcher's download flow and the
// dataset detail page have genuine content to serve on a fresh clone.

const ctdCsv = `# IndoPolaris sample dataset — CTD cast profiles
# Southern Ocean Carbon Export Expedition, station SOV-07
# Columns are self-describing; units in the header.
depth_m,temperature_C,salinity_psu,oxygen_ml_l,chlorophyll_ug_l
0.0,-1.842,34.612,6.94,0.081
2.0,-1.836,34.618,6.91,0.084
5.0,-1.821,34.629,6.88,0.092
10.0,-1.798,34.641,6.79,0.118
25.0,-1.744,34.668,6.51,0.164
50.0,-1.702,34.684,6.22,0.211
75.0,-1.688,34.691,5.98,0.243
100.0,-1.671,34.702,5.81,0.262
150.0,-1.652,34.718,5.64,0.238
200.0,-1.641,34.729,5.52,0.187
`;

const seaIceCsv = `# IndoPolaris sample dataset — sea-ice concentration
# Arctic Sea-Ice Dynamics Campaign, Ny-Alesund
# concentration and extent are fractions / km^2
date,concentration_fraction,extent_km2,mean_ice_age_days
2024-03-01,0.712,146200,58
2024-04-01,0.684,139800,63
2024-05-01,0.651,131400,71
2024-06-01,0.588,118900,84
2024-07-01,0.402,74300,102
2024-08-01,0.187,31500,131
2024-09-01,0.094,14200,158
`;

const glacierCsv = `# IndoPolaris sample dataset — glacier surface elevation change
# Dakshin Gangotri Glacier mass balance, 2019-2024
# dh is elevation change relative to the 2019 reference surface, in metres
survey_year,zone,area_km2,dh_mean_m,dh_std_m
2019,upper,11.4,0.00,0.00
2019,middle,18.7,0.00,0.00
2019,lower,24.2,0.00,0.00
2021,upper,11.1,-1.84,0.42
2021,middle,18.3,-2.97,0.55
2021,lower,23.9,-4.12,0.68
2024,upper,10.6,-4.91,0.51
2024,middle,17.4,-7.63,0.72
2024,lower,23.1,-11.28,0.94
`;

for (const [name, body] of [
  ["dataset-ctd-profiles.csv", ctdCsv],
  ["dataset-sea-ice-concentration.csv", seaIceCsv],
  ["dataset-glacier-fab.csv", glacierCsv],
]) {
  await writeFile(path.join(OUT_DIR, name), body, "utf8");
  count++;
}

console.log(`[media] wrote ${count} files total to public/media/seed/`);

