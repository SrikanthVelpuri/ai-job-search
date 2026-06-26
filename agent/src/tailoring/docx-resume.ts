/**
 * docx-resume.ts — reliable Word (.docx) rendering of the ATS-safe resume.
 *
 * Many ATS upload widgets parse .docx far more reliably than a raw .txt (and far
 * more reliably than a two-column LaTeX PDF). We therefore render the SAME
 * deterministic single-column text that ats-resume.ts produces into a real Word
 * document using the well-tested `docx` library — no hand-rolled OOXML.
 *
 * The plain-text resume is the single source of truth (it owns the no-fabrication
 * rules + section ordering + JD-relevance skill reordering). This module only
 * re-renders that text into Word paragraphs, so .txt and .docx never diverge.
 *
 * Text grammar emitted by ats-resume.ts (and parsed here):
 *   line 1            → name              → bold title
 *   line 2 (if "a|b") → contact line      → muted single line
 *   "LABEL" + "----"  → section header    → Heading 2
 *   "- text"          → bullet            → bullet list item
 *   "x | y"           → entry headline     → bold line (experience/education)
 *   anything else     → body paragraph
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

/** True for a horizontal rule line (the dashes under a section header). */
function isRule(line: string): boolean {
  return /^-+$/.test(line.trim());
}

/** True for an ALL-CAPS section label (the line above a rule). */
function isSectionLabel(line: string): boolean {
  return /^[A-Z][A-Z &/]+$/.test(line.trim());
}

/**
 * Parse the deterministic ATS plain-text resume into Word paragraphs. Exported so
 * it can be unit-tested independently of file IO.
 */
export function atsTextToParagraphs(text: string): Paragraph[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Paragraph[] = [];
  // Small state machine for the header block: 0 = expect name, 1 = expect contact, 2 = body.
  let state = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "") continue;
    if (isRule(trimmed)) continue; // rule lines are consumed by the header that precedes them

    // Section header = ALL-CAPS label immediately followed by a rule line.
    const next = (lines[i + 1] ?? "").trim();
    if (isSectionLabel(trimmed) && isRule(next)) {
      out.push(new Paragraph({ text: trimmed, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }));
      state = 2;
      continue;
    }

    if (state === 0) {
      // Name → bold 16pt title line.
      out.push(new Paragraph({ children: [new TextRun({ text: trimmed, bold: true, size: 32 })] }));
      state = 1;
      continue;
    }

    if (state === 1) {
      state = 2;
      if (trimmed.includes(" | ")) {
        // Contact line → muted single line, then fall through to body for everything after.
        out.push(new Paragraph({ children: [new TextRun({ text: trimmed, color: "555555" })] }));
        continue;
      }
      // Not a contact line — fall through and render as a body line below.
    }

    if (trimmed.startsWith("- ")) {
      out.push(new Paragraph({ text: trimmed.slice(2), bullet: { level: 0 } }));
      continue;
    }
    if (trimmed.includes(" | ")) {
      // Experience / education entry headline → bold.
      out.push(new Paragraph({ children: [new TextRun({ text: trimmed, bold: true })] }));
      continue;
    }
    out.push(new Paragraph({ text: trimmed }));
  }

  return out;
}

/**
 * Render the ATS resume text into a .docx byte buffer. ATS-friendly defaults:
 * single column, a common sans-serif body font, 11pt.
 */
export async function buildResumeDocx(text: string): Promise<Buffer> {
  const doc = new Document({
    creator: "ai-job-search",
    title: "Resume",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } }, // 22 half-points = 11pt
    },
    sections: [{ properties: {}, children: atsTextToParagraphs(text) }],
  });
  return Packer.toBuffer(doc);
}
