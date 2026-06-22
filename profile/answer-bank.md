# ATS Screening Answer Bank

> **Purpose (design.md §2.1).** This is the linchpin of unattended apply. Greenhouse / Lever /
> Ashby attach custom screening questions to each posting. The screening-answer generator matches
> each question to an entry here so the agent can answer **without fabricating**.
>
> **The no-fabrication rule (guardrails.md §2).** If a question is not covered here with high
> confidence, the answer set is flagged `needsHuman` and the job is routed to human review — it is
> never auto-answered with a guess. `TODO_SETUP` entries below are *not yet answerable* and will
> flag the application until you fill them in (via `/setup` or by editing this file).

## Format

Each entry has a canonical question, the matching answer, and a confidence. The generator does
fuzzy keyword matching against the question label; keep the **keywords** line rich.

---

## Work authorization & sponsorship (HIGH confidence — from profile.json)

### Are you legally authorized to work in the United States?
- **keywords:** authorized, legally, work, eligible, employment, United States, US
- **answer:** Yes
- **confidence:** high

### Will you now or in the future require sponsorship for an employment visa (e.g., H-1B)?
- **keywords:** sponsorship, visa, immigration, H-1B, future, require, need, status
- **answer:** Yes
- **confidence:** high
- **note:** Current status is H-1B; a transfer/new petition is required. Always answer honestly.

### What is your current work authorization status?
- **keywords:** current, status, authorization, immigration, work permit
- **answer:** H-1B visa holder (requires sponsorship transfer)
- **confidence:** high

### Do you now or will you in the future require visa sponsorship to work in the US? (Yes/No)
- **keywords:** require, sponsorship, future, yes/no
- **answer:** Yes
- **confidence:** high

## Location & relocation (HIGH confidence — from preferences)

### Are you willing to relocate?
- **keywords:** relocate, relocation, willing, move, open to
- **answer:** Yes — open to relocation anywhere in the United States.
- **confidence:** high

### Are you open to remote / hybrid / onsite?
- **keywords:** remote, hybrid, onsite, in-office, work arrangement, preference
- **answer:** Open to remote, hybrid, or onsite arrangements.
- **confidence:** high

### Where are you currently located?
- **keywords:** located, current location, based, city
- **answer:** TODO_SETUP
- **confidence:** low
- **note:** Fill current city/state via /setup. Until then this flags `needsHuman`.

## EEO / voluntary self-identification (HIGH confidence — honest decline defaults)

### Gender
- **keywords:** gender, sex
- **answer:** I don't wish to answer
- **confidence:** high

### Race / ethnicity
- **keywords:** race, ethnicity, ethnic
- **answer:** I don't wish to answer
- **confidence:** high

### Hispanic or Latino?
- **keywords:** hispanic, latino, latina, latinx
- **answer:** I don't wish to answer
- **confidence:** high

### Veteran status
- **keywords:** veteran, military, protected veteran, armed forces
- **answer:** I am not a protected veteran
- **confidence:** high

### Disability status
- **keywords:** disability, disabled, impairment, accommodation status
- **answer:** I don't wish to answer
- **confidence:** high

## Logistics (HIGH/MEDIUM confidence)

### How did you hear about this role / us?
- **keywords:** how did you hear, source, referral, found, learn about
- **answer:** Company careers page
- **confidence:** medium

### When can you start / what is your availability / notice period?
- **keywords:** start date, availability, notice period, when can you start, earliest
- **answer:** Available with standard two weeks' notice; flexible on start date.
- **confidence:** medium

### Do you have a portfolio / GitHub / LinkedIn?
- **keywords:** portfolio, github, linkedin, website, profile link
- **answer:** TODO_SETUP
- **confidence:** low
- **note:** Provide links via /setup; until then this flags `needsHuman`.

## Compensation (LOW confidence — DO NOT auto-answer)

### What are your salary expectations / desired compensation?
- **keywords:** salary, compensation, expectation, desired, pay, comp, base
- **answer:** TODO_SETUP
- **confidence:** low
- **note:** No salary floor is set in profile.json (salaryFloorUSD = null). Compensation answers
  always flag `needsHuman` until you set an expectation — never auto-fill a number.

## Years of experience (LOW confidence — DO NOT auto-answer)

### How many years of experience do you have with X?
- **keywords:** years of experience, how many years, years working, YOE
- **answer:** TODO_SETUP
- **confidence:** low
- **note:** Experience is empty in profile.json. These flag `needsHuman` until the work history is
  populated via /setup — never guess a number of years.

---

## Free-text questions (e.g. "Why do you want to work here?")

Free-text motivational questions are **not answered from this bank**. They are routed to the
tailoring stage (the existing `/apply` drafter), which writes a grounded, company-specific answer.
Anything the drafter cannot ground in real profile data flags `needsHuman`.
