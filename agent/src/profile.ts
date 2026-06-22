/**
 * profile.ts — load + validate the machine-readable profile, watchlist, and answer bank.
 *
 * profile.json is a structured *projection* of the prose profile files under
 * `.claude/skills/job-application-assistant/` (design §2.1). It is validated with zod so a
 * malformed profile fails fast rather than producing garbage applications.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./config.js";
import type { Profile, Watchlist } from "./types.js";

const profileSchema = z.object({
  identity: z.object({ name: z.string().min(1), headline: z.string(), summary: z.string() }),
  contact: z.object({
    email: z.string().email(),
    phone: z.string().nullable(),
    location: z.string(),
    linkedin: z.string().nullable(),
    github: z.string().nullable(),
    website: z.string().nullable(),
  }),
  workAuthorization: z.object({
    status: z.string(),
    authorizedToWorkUS: z.boolean(),
    requiresSponsorship: z.boolean(),
  }),
  languages: z.array(z.string()),
  education: z.array(
    z.object({
      degree: z.string(),
      field: z.string(),
      institution: z.string(),
      start: z.string(),
      end: z.string(),
      notes: z.string().optional(),
    }),
  ),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      location: z.string(),
      start: z.string(),
      end: z.string().nullable(),
      bullets: z.array(z.string()),
    }),
  ),
  skills: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()),
    domain: z.array(z.string()),
    tools: z.array(z.string()),
  }),
  certifications: z.array(z.string()),
  publications: z.array(z.string()),
  awards: z.array(z.string()),
  preferences: z.object({
    titles: z.array(z.string()),
    seniority: z.array(z.string()),
    remotePreference: z.enum(["remote-only", "hybrid-ok", "onsite-ok", "open"]),
    relocateAnywhere: z.boolean(),
    salaryFloorUSD: z.number().nullable(),
    sectors: z.array(z.string()),
    dealbreakers: z.array(z.string()),
    excludeCompanies: z.array(z.string()),
  }),
  eeo: z.object({
    gender: z.string(),
    race: z.string(),
    veteranStatus: z.string(),
    disabilityStatus: z.string(),
    hispanicLatino: z.string(),
  }),
  incompleteFields: z.array(z.string()),
});

const watchlistSchema = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      tier: z.enum(["clean_ats", "workday", "custom_site"]),
      ats: z.enum(["greenhouse", "lever", "ashby", "workday", "other"]),
      handle: z.string().optional(),
      notes: z.string().optional(),
      sponsorsH1B: z.boolean().optional(),
      verified: z.boolean().optional(),
      enabled: z.boolean(),
    }),
  ),
});

export const PROFILE_PATH = path.join(REPO_ROOT, "profile", "profile.json");
export const WATCHLIST_PATH = path.join(REPO_ROOT, "profile", "watchlist.json");
export const ANSWER_BANK_PATH = path.join(REPO_ROOT, "profile", "answer-bank.md");

/** True for any string still carrying a /setup placeholder sentinel. */
export const SETUP_SENTINEL = "TODO_SETUP";

export function loadProfile(filePath: string = PROFILE_PATH): Profile {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.$schema; // tolerate the editor-hint key
  const parsed = profileSchema.parse(raw);
  return parsed as Profile;
}

export function loadWatchlist(filePath: string = WATCHLIST_PATH): Watchlist {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete raw.$comment;
  const parsed = watchlistSchema.parse(raw);
  return parsed as Watchlist;
}

export function loadAnswerBank(filePath: string = ANSWER_BANK_PATH): string {
  return fs.readFileSync(filePath, "utf8");
}

/** Returns the list of profile fields still using a TODO_SETUP placeholder. */
export function pendingSetupFields(profile: Profile): string[] {
  const pending = new Set(profile.incompleteFields);
  const flat = JSON.stringify(profile);
  if (flat.includes(SETUP_SENTINEL)) {
    // Surface the literal sentinel locations too.
    for (const [k, v] of Object.entries(profile.contact)) {
      if (typeof v === "string" && v.includes(SETUP_SENTINEL)) pending.add(`contact.${k}`);
    }
    for (const [k, v] of Object.entries(profile.identity)) {
      if (typeof v === "string" && v.includes(SETUP_SENTINEL)) pending.add(`identity.${k}`);
    }
  }
  return [...pending];
}
