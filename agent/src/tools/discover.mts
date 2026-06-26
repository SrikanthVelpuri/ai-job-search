/**
 * discover.mts — watchlist discovery + live verification (re-runnable build tool).
 *
 * Goal: grow profile/watchlist.json toward the "top ML/AI companies that are OPEN"
 * target WITHOUT fabricating ATS handles. We author REAL company names (facts), then
 * discover each company's actual ATS + board slug by probing the public Greenhouse /
 * Lever / Ashby JSON APIs. Only handles the API confirms (≥1 live posting) are kept.
 *
 * Two discovery sources feed the same verify step:
 *   1. Curated names (NAMES + MORE_NAMES below) — always.
 *   2. Adzuna long-tail — if ADZUNA_APP_ID / ADZUNA_APP_KEY are set, mine open US AI/ML
 *      postings for employer names beyond the curated set. Inert (skipped) without a key.
 *
 * "Open" = verified board currently returns ≥1 senior/staff/lead AI/ML role (seniority
 * token AND an AI/ML keyword in the title), matching the sourcing prefilter.
 *
 * It also merges a curated SOURCING_ONLY set (major AI/ML H-1B sponsors with no public
 * clean-ATS board — Workday/custom) as enabled:false rows, sourced via Adzuna / applied attended.
 *
 * Outputs (never overwrites watchlist.json in place):
 *   profile/watchlist.discovered.json — per-company audit (found/not, counts, samples)
 *   profile/watchlist.proposed.json   — existing entries + newly verified + sourcing-only, deduped
 *
 * Run: npx tsx agent/src/tools/discover.mts
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", ".."); // agent/src/tools -> repo root
const PROFILE = path.join(REPO_ROOT, "profile");
const WATCHLIST = path.join(PROFILE, "watchlist.json");

// ── matching rules (mirror config.ts; precise tokens only — no bare "ml" so "AML" etc. don't match) ──
const SENIORITY = ["senior", "sr.", "sr ", "staff", "lead", "principal", "distinguished"];
const KEYWORDS = [
  "machine learning", "machine-learning", "ml engineer", "ml platform", "ml infrastructure",
  "ml infra", "ml ops", "mlops", "ml scientist", "ml architect", "ml/ai", "ai/ml",
  "ai engineer", "applied scientist", "research engineer", "research scientist", "applied ml",
  "artificial intelligence", "deep learning", "ai architect", "ai platform", "ai infrastructure",
  "llm", "genai", "generative ai", "computer vision", " nlp ", "recommendation", "perception",
];

// ── REAL company names (facts). Handles are discovered + verified, never asserted here. ──
const NAMES: string[] = [
  // foundation / applied LLM
  "xAI", "Character AI", "Inflection AI", "AI21 Labs", "Contextual AI", "Imbue", "Sakana AI",
  "Reka AI", "Liquid AI", "World Labs", "Luma AI", "Runway", "ElevenLabs", "Suno", "Stability AI",
  "Adept", "Cresta", "Sierra", "Decagon", "Harvey", "Hebbia", "Writer", "Jasper", "Tome", "Gamma",
  "Typeface", "Copy.ai", "Sana", "You.com", "Exa", "Elicit", "Consensus",
  // AI infra / serving / compute / observability
  "Modal", "Replicate", "Baseten", "Anyscale", "Fireworks AI", "Lambda", "CoreWeave", "Groq",
  "SambaNova Systems", "Cerebras", "Modular", "Predibase", "Outerbounds", "Weights & Biases", "Comet",
  "Arize AI", "WhyLabs", "Fiddler AI", "Galileo", "Patronus AI", "Humanloop", "LangChain", "LlamaIndex",
  "deepset", "Pinecone", "Weaviate", "Qdrant", "Chroma", "Zilliz", "Marqo", "Vectara", "Unstructured",
  "Nomic AI", "Cleanlab", "OctoAI",
  // data / ML platforms
  "Confluent", "Fivetran", "dbt Labs", "Airbyte", "Dagster", "Prefect", "Astronomer", "Tecton", "Hex",
  "Sigma Computing", "Census", "Hightouch", "Monte Carlo", "Atlan", "Coalesce", "Cloudflare", "Elastic",
  "MongoDB", "Cockroach Labs", "Temporal", "Supabase", "Neon", "PlanetScale", "Hasura",
  // devtools / AI coding
  "GitLab", "Replit", "Sourcegraph", "Tabnine", "Codeium", "Anysphere", "Cognition AI", "Augment Code",
  "Poolside", "Magic AI", "Warp", "Vercel", "Netlify", "Render", "Railway", "Retool", "Linear",
  "Webflow", "Grammarly",
  // product / fintech / SaaS (AI-forward, clean ATS)
  "Brex", "Mercury", "Plaid", "Rippling", "Deel", "Gusto", "Airtable", "Vanta", "Discord", "Coinbase",
  "Robinhood", "Affirm", "Chime", "Instacart", "DoorDash", "Lyft", "Dropbox", "Asana", "Box", "Twilio",
  "Okta", "HashiCorp", "Upstart", "Pagaya",
  // autonomy / robotics / defense
  "Aurora", "Nuro", "Applied Intuition", "Waabi", "Figure AI", "Skild AI", "Physical Intelligence",
  "Anduril", "Shield AI", "Saronic", "Vannevar Labs", "Skydio", "Wayve", "Helsing",
  // health / bio AI
  "Insitro", "Recursion", "Genesis Therapeutics", "Xaira Therapeutics", "EvolutionaryScale", "Profluent",
  "Cradle", "Generate Biomedicines", "Iambic Therapeutics", "Latent Labs", "Abridge", "Ambience Healthcare",
  "Hippocratic AI", "OpenEvidence", "Tempus", "PathAI", "Cleerly", "Suki AI", "Notable",
  // labeling / data / vision
  "Surge AI", "Labelbox", "Snorkel AI", "V7", "Encord", "Roboflow", "Voxel51",
  // agents / support AI / search
  "Ada", "Forethought", "Observe.AI", "PolyAI", "Replicant", "Lindy", "MultiOn", "Vespa",
];

// ── second batch (new real candidates, added this pass) ──
const MORE_NAMES: string[] = [
  // AI media / voice / video
  "Twelve Labs", "Black Forest Labs", "Ideogram", "Krea", "Captions", "HeyGen", "Synthesia", "Descript",
  "Cartesia", "Hume AI", "Deepgram", "AssemblyAI", "Speechmatics", "Sesame", "Photoroom", "Pika",
  "Higgsfield", "Tavus",
  // AI infra / compute / cloud
  "Crusoe", "Lightning AI", "fal", "Nebius", "Hyperbolic", "Voltage Park", "Vast.ai", "TensorWave",
  "Foundry", "Parasail", "RunPod", "Beam", "Substrate",
  // vector / RAG / data infra
  "ClickHouse", "Turbopuffer", "LanceDB", "Activeloop", "StarTree", "Materialize", "Redpanda",
  "RisingWave", "MotherDuck", "Estuary", "Decodable", "StreamNative", "Imply", "Tinybird", "Timescale",
  "SingleStore", "Aerospike", "DataStax",
  // agents / automation / enterprise AI
  "Crew AI", "Relevance AI", "Stack AI", "Dust", "Ema", "Maven AGI", "Moveworks", "Aisera", "Crescendo",
  "11x", "Artisan", "Lorikeet", "Gradial", "Tektonic", "Parloa", "Cognigy", "Kore.ai", "Credal", "Guru",
  // coding AI
  "Qodo", "Continue", "Tabby", "Greptile", "CodeRabbit", "Mintlify", "Sweep", "Zencoder", "Tessl",
  "Factory AI", "Reflection AI", "Cline",
  // data / analytics
  "Omni", "Lightdash", "Metabase", "Cube", "Datafold", "Secoda", "Preset",
  // ML platform / labeling / RLHF
  "Mercor", "Invisible", "Turing", "Micro1", "Handshake AI", "Pareto", "Sapien", "Prolific", "Toloka",
  "iMerit", "Sama", "Datology AI",
  // robotics / physical AI
  "1X Technologies", "Apptronik", "Agility Robotics", "Collaborative Robotics", "Dexterity",
  "Bright Machines", "Path Robotics", "Gecko Robotics", "Chef Robotics", "Field AI", "Sanctuary AI",
  "Machina Labs", "Dexory",
  // AV
  "Kodiak Robotics", "Gatik", "May Mobility", "Stack AV", "Oxa", "Pony.ai", "WeRide", "Plus",
  "Avride", "Bot Auto",
  // defense
  "Mach Industries", "Castelion", "Hadrian", "Epirus", "Chaos Industries",
  // health / bio AI
  "Insilico Medicine", "Chai Discovery", "Noetik", "Enveda", "Valence Labs", "Periodic Labs",
  "Lila Sciences", "Future House", "Arc Institute",
  // security AI
  "Abnormal AI", "Cyera", "Chainguard", "Semgrep", "Socket", "Lakera", "Snyk", "Wiz",
  "Protect AI", "Dropzone AI",
  // fintech AI
  "Sardine", "Unit21", "Rogo", "Brightwave", "Parafin",
];

// Optional slug hints for tricky handles (still verified before use; never asserted blindly).
const EXTRA: Record<string, string[]> = {
  "xAI": ["xai"],
  "Character AI": ["character", "characterai"],
  "AI21 Labs": ["ai21", "ai21labs"],
  "Weights & Biases": ["wandb", "weightsandbiases"],
  "dbt Labs": ["dbtlabs", "getdbt"],
  "Cockroach Labs": ["cockroachlabs"],
  "You.com": ["you", "youcom"],
  "Copy.ai": ["copyai", "copy-ai"],
  "Observe.AI": ["observeai", "observe-ai"],
  "SambaNova Systems": ["sambanova", "sambanovasystems"],
  "Lambda": ["lambdalabs", "lambda"],
  "Comet": ["cometml", "comet-ml"],
  "Anysphere": ["anysphere", "cursor"],
  "Cognition AI": ["cognition", "cognitionai", "cognition-labs"],
  "Magic AI": ["magic", "magicai"],
  "Physical Intelligence": ["physicalintelligence", "physical-intelligence"],
  "Figure AI": ["figure", "figureai"],
  "Hippocratic AI": ["hippocratic", "hippocraticai"],
  "Ambience Healthcare": ["ambience", "ambiencehealthcare"],
  "Applied Intuition": ["appliedintuition"],
  "Skild AI": ["skild", "skildai"],
  "EvolutionaryScale": ["evolutionaryscale"],
  "Xaira Therapeutics": ["xaira", "xairatherapeutics"],
  "Genesis Therapeutics": ["genesistherapeutics", "genesis"],
  "Generate Biomedicines": ["generatebiomedicines"],
  "Iambic Therapeutics": ["iambic", "iambictherapeutics"],
  "Suki AI": ["suki", "sukiai"],
  "Snorkel AI": ["snorkel", "snorkelai"],
  "Surge AI": ["surgeai", "surge", "surgehq"],
  // new this pass
  "1X Technologies": ["1x", "1x-technologies"],
  "Collaborative Robotics": ["collaborativerobotics"],
  "Agility Robotics": ["agilityrobotics"],
  "Abnormal AI": ["abnormalsecurity", "abnormal"],
  "Black Forest Labs": ["blackforestlabs", "bfl"],
  "Twelve Labs": ["twelvelabs"],
  "Hume AI": ["hume", "humeai"],
  "fal": ["fal", "fal-ai"],
  "Lightning AI": ["lightningai", "lightning-ai"],
  "Crew AI": ["crewai"],
  "Relevance AI": ["relevanceai"],
  "Field AI": ["fieldai"],
  "Sanctuary AI": ["sanctuary", "sanctuaryai"],
  "Chai Discovery": ["chaidiscovery", "chai"],
  "Insilico Medicine": ["insilico", "insilicomedicine"],
  "Pony.ai": ["pony", "ponyai"],
  "May Mobility": ["maymobility"],
  "Kodiak Robotics": ["kodiak", "kodiakrobotics"],
  "Stack AV": ["stackav"],
  "Bot Auto": ["botauto"],
  "Mach Industries": ["machindustries"],
  "Arc Institute": ["arcinstitute", "arc"],
  "Future House": ["futurehouse"],
  "Valence Labs": ["valencelabs", "valence"],
  "Periodic Labs": ["periodiclabs"],
  "Lila Sciences": ["lilasciences", "lila"],
  "Cube": ["cubedev", "cube"],
  "Protect AI": ["protectai"],
  "Dropzone AI": ["dropzoneai", "dropzone"],
  "Kore.ai": ["koreai", "kore"],
  "Datology AI": ["datologyai", "datology"],
};

// Curated major AI/ML H-1B sponsors WITHOUT a public clean-ATS board (Workday/custom).
// enabled:false → sourcing-only via Adzuna, apply attended (design §2.5). Excludes Amazon and seed dups.
const SOURCING_ONLY_NAMES: string[] = [
  "IBM", "Adobe", "Intel", "Qualcomm", "Oracle", "SAP", "ServiceNow", "Cisco", "Intuit", "PayPal",
  "Block", "Capital One", "Visa", "Mastercard", "AMD", "Palantir", "Tesla", "Uber", "Airbnb",
  "LinkedIn", "Spotify", "Snap", "TikTok", "Bloomberg",
];

// ── helpers ──
function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
function canon(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function slugVariants(name: string): string[] {
  const lower = name.toLowerCase().replace(/&/g, " and ").replace(/[.,'’]/g, "");
  const words = lower.split(/[^a-z0-9+]+/).filter(Boolean);
  const tailNoise = new Set(["ai", "labs", "lab", "inc", "llc", "technologies", "technology", "io", "app", "hq", "systems", "therapeutics", "biomedicines", "healthcare", "and"]);
  const dropped = words.filter((w) => !tailNoise.has(w));
  return uniq([words.join(""), words.join("-"), dropped.join(""), dropped.join("-")]).filter(Boolean);
}

// recruiter / aggregator noise to drop from Adzuna employer names
const NOISE = /confidential|recruit|staffing|talent|consult|agency|jobot|cybercoders|robert half|insight global|teksystems|motion recruitment|dice|ziprecruiter|get it/i;

// ── HTTP ──
const TIMEOUT_MS = 9000;
async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": "job-apply-agent/0.1 (watchlist discovery)", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeGreenhouse(slug: string): Promise<string[] | null> {
  const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`);
  const jobs = j?.jobs;
  if (Array.isArray(jobs) && jobs.length) return jobs.map((x: any) => x?.title).filter(Boolean);
  return null;
}
async function probeLever(slug: string): Promise<string[] | null> {
  const j = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (Array.isArray(j) && j.length) return j.map((x: any) => x?.text).filter(Boolean);
  return null;
}
const ASHBY_QUERY =
  "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { title } } }";
async function probeAshby(slug: string): Promise<string[] | null> {
  const j = await getJson("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variables: { organizationHostedJobsPageName: slug }, query: ASHBY_QUERY }),
  });
  const jp = j?.data?.jobBoard?.jobPostings;
  if (Array.isArray(jp) && jp.length) return jp.map((x: any) => x?.title).filter(Boolean);
  return null;
}
async function probeSmartRecruiters(slug: string): Promise<string[] | null> {
  const j = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`);
  const content = j?.content;
  if (Array.isArray(content) && content.length) return content.map((x: any) => x?.name).filter(Boolean);
  return null;
}
async function probeWorkable(slug: string): Promise<string[] | null> {
  const j = await getJson(`https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [] }),
  });
  const results = j?.results;
  if (Array.isArray(results) && results.length) return results.map((x: any) => x?.title).filter(Boolean);
  return null;
}

interface Found {
  ats: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workable";
  handle: string;
  titles: string[];
}
async function resolve(name: string): Promise<Found | null> {
  const variants = uniq([...(EXTRA[name] ?? []), ...slugVariants(name)]);
  for (const v of variants) {
    const t = await probeGreenhouse(v);
    if (t) return { ats: "greenhouse", handle: v, titles: t };
  }
  for (const v of variants) {
    const t = await probeLever(v);
    if (t) return { ats: "lever", handle: v, titles: t };
  }
  for (const v of variants) {
    for (const cand of uniq([v, cap(v)])) {
      const t = await probeAshby(cand);
      if (t) return { ats: "ashby", handle: cand, titles: t };
    }
  }
  for (const v of variants) {
    const t = await probeSmartRecruiters(v);
    if (t) return { ats: "smartrecruiters", handle: v, titles: t };
  }
  for (const v of variants) {
    const t = await probeWorkable(v);
    if (t) return { ats: "workable", handle: v, titles: t };
  }
  return null;
}

function matchOpen(titles: string[]): { count: number; samples: string[] } {
  let count = 0;
  const samples: string[] = [];
  for (const title of titles) {
    const lt = ` ${title.toLowerCase()} `;
    const sen = SENIORITY.some((s) => lt.includes(s));
    const kw = KEYWORDS.some((k) => lt.includes(k));
    if (sen && kw) {
      count++;
      if (samples.length < 3) samples.push(title);
    }
  }
  return { count, samples };
}

// ── Adzuna long-tail (inert without a key) ──
async function adzunaCompanies(appId: string, appKey: string): Promise<string[]> {
  const queries = [
    "machine learning engineer", "staff machine learning", "ml platform engineer",
    "ml infrastructure engineer", "applied scientist", "ai engineer",
    "principal machine learning", "research engineer machine learning",
  ];
  const names = new Set<string>();
  for (const q of queries) {
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        app_id: appId, app_key: appKey, what: q, results_per_page: "50", "content-type": "application/json",
      });
      const j = await getJson(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${params.toString()}`);
      const results = j?.results;
      if (!Array.isArray(results) || !results.length) break;
      for (const r of results) {
        const c = (r?.company?.display_name ?? "").trim();
        if (c && !NOISE.test(c)) names.add(c);
      }
    }
  }
  return [...names];
}

// ── other aggregators (each inert until its key/affid is set) ──
const AGG_QUERIES = [
  "machine learning engineer", "staff machine learning engineer", "ml platform engineer",
  "ml infrastructure engineer", "applied scientist", "senior ai engineer",
  "principal machine learning", "research engineer machine learning",
];

async function joobleCompanies(key: string): Promise<string[]> {
  const names = new Set<string>();
  for (const q of AGG_QUERIES) {
    for (let page = 1; page <= 3; page++) {
      const j = await getJson(`https://jooble.org/api/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: q, location: "United States", page: String(page) }),
      });
      const jobs = j?.jobs;
      if (!Array.isArray(jobs) || !jobs.length) break;
      for (const r of jobs) {
        const c = (r?.company ?? "").trim();
        if (c && !NOISE.test(c)) names.add(c);
      }
    }
  }
  return [...names];
}

async function careerjetCompanies(affid: string): Promise<string[]> {
  const names = new Set<string>();
  for (const q of AGG_QUERIES) {
    const params = new URLSearchParams({
      keywords: q, location: "USA", affid, user_ip: "11.22.33.44",
      user_agent: "ai-job-search/0.1", pagesize: "99", page: "1",
    });
    const j = await getJson(`https://public.api.careerjet.net/search?${params.toString()}`);
    for (const r of (j?.jobs ?? [])) {
      const c = (r?.company ?? "").trim();
      if (c && !NOISE.test(c)) names.add(c);
    }
  }
  return [...names];
}

async function jsearchCompanies(key: string): Promise<string[]> {
  const host = "jsearch.p.rapidapi.com";
  const names = new Set<string>();
  for (const q of AGG_QUERIES) {
    const params = new URLSearchParams({ query: `${q} in United States`, page: "1", num_pages: "1", country: "us" });
    const j = await getJson(`https://${host}/search?${params.toString()}`, {
      headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
    });
    for (const r of (j?.data ?? [])) {
      const c = (r?.employer_name ?? "").trim();
      if (c && !NOISE.test(c)) names.add(c);
    }
  }
  return [...names];
}

async function museCompanies(key: string): Promise<string[]> {
  const names = new Set<string>();
  for (const cat of ["Data and Analytics", "Software Engineering", "Data Science"]) {
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({ api_key: key, category: cat, page: String(page) });
      const j = await getJson(`https://www.themuse.com/api/public/jobs?${params.toString()}`);
      const results = j?.results;
      if (!Array.isArray(results) || !results.length) break;
      for (const r of results) {
        const c = (r?.company?.name ?? "").trim();
        if (c && !NOISE.test(c)) names.add(c);
      }
    }
  }
  return [...names];
}

// ── simple concurrency pool ──
async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

interface DiscoverRow {
  name: string;
  found: boolean;
  ats?: string;
  handle?: string;
  total?: number;
  matching?: number;
  samples?: string[];
}

async function main() {
  const watchlist = JSON.parse(readFileSync(WATCHLIST, "utf8")) as { $comment?: string; companies: any[] };
  const existing = new Set(watchlist.companies.map((c) => canon(c.name)));

  // Aggregator long-tail discovery — each source inert until its key/affid is set.
  const aggNames: string[] = [];
  const ADZ_ID = process.env.ADZUNA_APP_ID, ADZ_KEY = process.env.ADZUNA_APP_KEY;
  if (ADZ_ID?.trim() && ADZ_KEY?.trim()) {
    const n = await adzunaCompanies(ADZ_ID.trim(), ADZ_KEY.trim());
    console.log(`Adzuna: ${n.length} employers with open AI/ML roles`);
    aggNames.push(...n);
  }
  if (process.env.JOOBLE_API_KEY?.trim()) {
    const n = await joobleCompanies(process.env.JOOBLE_API_KEY.trim());
    console.log(`Jooble: ${n.length} employers`);
    aggNames.push(...n);
  }
  if (process.env.CAREERJET_AFFID?.trim()) {
    const n = await careerjetCompanies(process.env.CAREERJET_AFFID.trim());
    console.log(`Careerjet: ${n.length} employers`);
    aggNames.push(...n);
  }
  const RAPID = process.env.JSEARCH_RAPIDAPI_KEY ?? process.env.RAPIDAPI_KEY;
  if (RAPID?.trim()) {
    const n = await jsearchCompanies(RAPID.trim());
    console.log(`JSearch (LinkedIn/Indeed via Google Jobs): ${n.length} employers`);
    aggNames.push(...n);
  }
  if (process.env.MUSE_API_KEY?.trim()) {
    const n = await museCompanies(process.env.MUSE_API_KEY.trim());
    console.log(`The Muse: ${n.length} employers`);
    aggNames.push(...n);
  }
  const aggUnique = uniq(aggNames);
  if (!aggUnique.length) {
    console.log("No aggregator keys set (ADZUNA_APP_ID/KEY · JOOBLE_API_KEY · CAREERJET_AFFID · JSEARCH_RAPIDAPI_KEY · MUSE_API_KEY) — using curated names + 5 ATS probes only.");
  }

  const candidates = uniq([...NAMES, ...MORE_NAMES, ...aggUnique]).filter((n) => !existing.has(canon(n)));
  console.log(`Probing ${candidates.length} candidates across greenhouse/lever/ashby/smartrecruiters/workable (excluding ${existing.size} already in watchlist)...`);

  const rows: DiscoverRow[] = await pool(candidates, 8, async (name) => {
    const f = await resolve(name);
    if (!f) return { name, found: false };
    const m = matchOpen(f.titles);
    console.log(`  ✓ ${name} — ${f.ats}/${f.handle} (${f.titles.length} roles, ${m.count} senior/staff AI-ML)`);
    return { name, found: true, ats: f.ats, handle: f.handle, total: f.titles.length, matching: m.count, samples: m.samples };
  });

  const found = rows.filter((r) => r.found);
  const open = found.filter((r) => (r.matching ?? 0) > 0).sort((a, b) => (b.matching ?? 0) - (a.matching ?? 0));

  writeFileSync(path.join(PROFILE, "watchlist.discovered.json"), JSON.stringify(rows, null, 2));

  // verified clean-ATS additions
  const additions = found.map((r) => ({
    name: r.name,
    tier: "clean_ats" as const,
    ats: r.ats,
    handle: r.handle,
    verified: true,
    enabled: true,
    notes: `Discovered + verified via public ${r.ats} API; ${r.matching} senior/staff/lead AI/ML role(s) open at probe time.`,
  }));

  // sourcing-only (Workday/custom) — only those not already present and not just verified clean
  const addedNames = new Set([...existing, ...additions.map((a) => canon(a.name))]);
  const sourcingOnly = SOURCING_ONLY_NAMES.filter((n) => !addedNames.has(canon(n))).map((name) => ({
    name,
    tier: "custom_site" as const,
    ats: "other" as const,
    verified: false,
    enabled: false,
    sponsorsH1B: true,
    notes: "Major AI/ML H-1B sponsor; Workday or custom careers site (no public clean-ATS board) — source via Adzuna, apply attended. Tier/endpoint to confirm.",
  }));

  const proposed = {
    $comment: `${watchlist.$comment ?? ""} | discover.mts pass: +${additions.length} live-verified clean_ats, +${sourcingOnly.length} sourcing-only (Workday/custom).`,
    companies: [...watchlist.companies, ...additions, ...sourcingOnly],
  };
  writeFileSync(path.join(PROFILE, "watchlist.proposed.json"), JSON.stringify(proposed, null, 2));

  const cleanEnabled = proposed.companies.filter((c: any) => c.tier === "clean_ats" && c.enabled).length;
  console.log("\n──────── SUMMARY ────────");
  console.log(`Candidates probed:          ${candidates.length}  (curated + ${aggUnique.length} from aggregators)`);
  console.log(`Newly verified clean-ATS:   ${found.length}`);
  console.log(`  └─ with OPEN senior/staff AI-ML roles now: ${open.length}`);
  console.log(`Sourcing-only rows added:   ${sourcingOnly.length} (Workday/custom, enabled:false)`);
  console.log(`\nWatchlist: ${watchlist.companies.length} -> ${proposed.companies.length} total  (${cleanEnabled} enabled clean-ATS boards)`);
  console.log(`\nTop newly-open boards by matching role count:`);
  for (const r of open.slice(0, 30)) {
    console.log(`  ${String(r.matching).padStart(3)}  ${r.name} (${r.ats}/${r.handle})  e.g. "${r.samples?.[0] ?? ""}"`);
  }
  console.log(`\nWrote profile/watchlist.discovered.json (audit) and profile/watchlist.proposed.json (merge candidate).`);
}

main().catch((e) => {
  console.error("discover failed:", e);
  process.exit(1);
});
