/**
 * resume-export.ts — convert a markdown resume to an ATS-friendly DOCX, and a PDF that is a
 * pixel-exact render of that DOCX.
 *
 *   tsx src/tooling/resume-export.ts <input.md> [outDir]
 *
 * RELIABILITY MODEL (single source of truth):
 *   markdown ──(docx lib)──► DOCX  ──(Microsoft Word, COM)──► PDF
 *
 * There is exactly ONE renderer of record: Word. The DOCX is generated deterministically from a
 * focused markdown parser, then Word renders the SAME DOCX to PDF, so the PDF can never disagree
 * with the DOCX. The old independent LaTeX/pdflatex PDF path (different fonts, different page
 * count, escaping + ligature pitfalls) has been removed.
 *
 * The markdown parser supports only the constructs a resume uses (headings, bold/italic, bullets,
 * links, a contact line, rules). Anything else is REPORTED as a warning rather than silently
 * dropped — see detectUnsupportedMarkdown(). PDF rendering requires Microsoft Word (Windows COM);
 * if Word is unavailable the DOCX is still produced and a warning is returned.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

// ── Inline tokenizer (handles **bold**, *italic*, [text](url)) ─────────────────────────────────
type Token = { kind: "text" | "bold" | "italic"; text: string } | { kind: "link"; text: string; url: string };

function tokenizeInline(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > i) tokens.push({ kind: "text", text: s.slice(i, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "italic", text: m[2] });
    else if (m[3] !== undefined && m[4] !== undefined) tokens.push({ kind: "link", text: m[3], url: m[4] });
    i = m.index + m[0].length;
  }
  if (i < s.length) tokens.push({ kind: "text", text: s.slice(i) });
  return tokens;
}

// ── Unsupported-construct detector (never silently drop content) ────────────────────────────────
/**
 * Scan for markdown the focused parser does NOT render faithfully. Returns human-readable
 * warnings (with line numbers). Empty array = every construct in the file is supported.
 */
export function detectUnsupportedMarkdown(md: string): string[] {
  const warnings: string[] = [];
  const lines = md.split(/\r?\n/);
  let inFence = false;
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      warnings.push(`line ${n}: fenced code block (\`\`\`) is not rendered`);
      return;
    }
    if (inFence) return;
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*:?-{3,}:?\s*\|/.test(line)) warnings.push(`line ${n}: table row is not rendered`);
    if (/^\s*>\s/.test(line)) warnings.push(`line ${n}: blockquote (>) is not rendered`);
    if (/^\s*\d+\.\s/.test(line)) warnings.push(`line ${n}: ordered list (1.) renders as a plain paragraph, not a numbered list`);
    if (/^\s{2,}[-*+]\s/.test(line)) warnings.push(`line ${n}: nested/indented bullet flattens to a top-level bullet`);
    if (/!\[[^\]]*\]\([^)]*\)/.test(line)) warnings.push(`line ${n}: image is not rendered`);
    if (/`[^`]+`/.test(line)) warnings.push(`line ${n}: inline code (\`...\`) loses its monospace styling`);
    if (/\*\*\*[^*]+\*\*\*/.test(line)) warnings.push(`line ${n}: combined bold+italic (***...***) is not parsed`);
    if (/\[[^\]]*\*\*[^\]]*\]\([^)]*\)|\*\*\[[^\]]+\]\([^)]*\)\*\*/.test(line)) warnings.push(`line ${n}: link nested inside bold may not style correctly`);
    if (/^#{4,}\s/.test(line)) warnings.push(`line ${n}: heading deeper than ### (#### ...) is treated as a paragraph`);
    if (/<[a-zA-Z/][^>]*>/.test(line)) warnings.push(`line ${n}: raw HTML tag is not rendered`);
  });
  return warnings;
}

// ── Block model ────────────────────────────────────────────────────────────────────────────────
type Block =
  | { type: "name"; text: string }
  | { type: "headline"; text: string }
  | { type: "contact"; text: string }
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "subbold"; text: string }
  | { type: "italic"; text: string }
  | { type: "bullet"; text: string }
  | { type: "para"; text: string };

function parseResume(md: string): Block[] {
  const blocks: Block[] = [];
  let sawSection = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("# ")) { blocks.push({ type: "name", text: line.slice(2).trim() }); continue; }
    if (line.startsWith("## ")) { sawSection = true; blocks.push({ type: "h2", text: line.slice(3).trim() }); continue; }
    if (line.startsWith("### ")) { blocks.push({ type: "h3", text: line.slice(4).trim() }); continue; }
    if (line.startsWith("- ")) { blocks.push({ type: "bullet", text: line.slice(2).trim() }); continue; }
    const wholeBold = /^\*\*(.+)\*\*$/.exec(line);
    if (wholeBold && wholeBold[1]) {
      blocks.push(sawSection ? { type: "subbold", text: wholeBold[1] } : { type: "headline", text: wholeBold[1] });
      continue;
    }
    const wholeItalic = /^\*(.+)\*$/.exec(line);
    if (wholeItalic && wholeItalic[1]) { blocks.push({ type: "italic", text: wholeItalic[1] }); continue; }
    if (!sawSection && line.includes("|")) { blocks.push({ type: "contact", text: line }); continue; }
    blocks.push({ type: "para", text: line });
  }
  return blocks;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────────────────────
function runsForDocx(text: string): (TextRun | ExternalHyperlink)[] {
  return tokenizeInline(text).map((t) => {
    if (t.kind === "link") return new ExternalHyperlink({ link: t.url, children: [new TextRun({ text: t.text, style: "Hyperlink" })] });
    return new TextRun({ text: t.text, bold: t.kind === "bold", italics: t.kind === "italic" });
  });
}

function buildDocx(blocks: Block[]): Document {
  const children: Paragraph[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "name":
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: b.text.toUpperCase(), bold: true, size: 36 })] }));
        break;
      case "headline":
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [new TextRun({ text: b.text, bold: true, size: 22, color: "333333" })] }));
        break;
      case "contact":
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: runsForDocx(b.text) }));
        break;
      case "h2":
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 60 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "888888", space: 2 } }, children: [new TextRun({ text: b.text.toUpperCase(), bold: true, size: 24 })] }));
        break;
      case "h3":
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 140, after: 30 }, children: [new TextRun({ text: b.text, bold: true, size: 22 })] }));
        break;
      case "subbold":
        children.push(new Paragraph({ spacing: { before: 80, after: 20 }, children: [new TextRun({ text: b.text, bold: true, italics: true, size: 20 })] }));
        break;
      case "italic":
        children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: b.text, italics: true, size: 18, color: "555555" })] }));
        break;
      case "bullet":
        children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 20 }, children: runsForDocx(b.text) }));
        break;
      case "para":
        children.push(new Paragraph({ spacing: { after: 60 }, children: runsForDocx(b.text) }));
        break;
    }
  }
  return new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 20 } } } },
    numbering: { config: [{ reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 180 } } } }] }] },
    sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }],
  });
}

// ── PDF via Microsoft Word (the only PDF renderer; pixel-exact to the DOCX) ─────────────────────
/**
 * Render a DOCX to PDF using Word's COM automation (Windows + Microsoft Word). Returns true on
 * success. Throws nothing — returns false if Word is unavailable so the DOCX is still delivered.
 */
function renderPdfViaWord(docxPath: string, pdfPath: string): { ok: boolean; error?: string } {
  const docxAbs = path.resolve(docxPath).replace(/'/g, "''");
  const pdfAbs = path.resolve(pdfPath).replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$w=New-Object -ComObject Word.Application",
    "$w.Visible=$false",
    `$d=$w.Documents.Open('${docxAbs}')`,
    `$d.SaveAs([ref]'${pdfAbs}',[ref]17)`, // 17 = wdFormatPDF
    "$d.Close()",
    "$w.Quit()",
    "Write-Output 'OK'",
  ].join("; ");
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "pipe" });
    return fs.existsSync(pdfPath) ? { ok: true } : { ok: false, error: "Word ran but produced no PDF" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

// ── DOCX-only conversion (no Word; for tests + callers that only need the .docx) ────────────────
/** markdown → DOCX bytes, deterministically. Does NOT render a PDF (no Word dependency). */
export async function markdownToDocxBuffer(md: string): Promise<Buffer> {
  return Packer.toBuffer(buildDocx(parseResume(md)));
}

/** Expose the parsed block model so tests can assert structure. */
export function parseResumeBlocks(md: string): Array<{ type: string; text: string }> {
  return parseResume(md);
}

// ── Orchestration ────────────────────────────────────────────────────────────────────────────
export async function exportResume(inputMd: string, outDir: string): Promise<{ docx: string; pdf: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const md = fs.readFileSync(inputMd, "utf8");

  // Reliability gate: surface anything the parser can't render faithfully.
  for (const w of detectUnsupportedMarkdown(md)) warnings.push(`unsupported markdown — ${w}`);

  const blocks = parseResume(md);
  const base = path.basename(inputMd).replace(/\.md$/i, "");
  fs.mkdirSync(outDir, { recursive: true });

  // DOCX — the source of truth.
  const docxPath = path.join(outDir, `${base}.docx`);
  const buffer = await Packer.toBuffer(buildDocx(blocks));
  fs.writeFileSync(docxPath, buffer);

  // PDF — Word renders the same DOCX, so it can never disagree with it.
  const pdfPath = path.join(outDir, `${base}.pdf`);
  const r = renderPdfViaWord(docxPath, pdfPath);
  if (!r.ok) warnings.push(`PDF not produced (Microsoft Word unavailable): ${r.error}. DOCX is still the deliverable; open it in Word and Save As PDF.`);

  return { docx: docxPath, pdf: r.ok ? pdfPath : null, warnings };
}

// CLI
const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]).endsWith(path.normalize("tooling/resume-export.ts")) : false;
if (invokedDirectly) {
  const input = process.argv[2];
  const outDir = process.argv[3] ?? (input ? path.dirname(input) : ".");
  if (!input || !fs.existsSync(input)) {
    console.error("usage: tsx src/tooling/resume-export.ts <input.md> [outDir]");
    process.exit(1);
  }
  exportResume(input, outDir).then((r) => {
    console.log(`DOCX: ${r.docx}`);
    console.log(`PDF:  ${r.pdf ?? "(not produced — see warnings)"}`);
    if (!r.warnings.length) console.log("✓ no unsupported markdown; DOCX↔PDF are the same render");
    for (const w of r.warnings) console.log(`  ⚠️  ${w}`);
  });
}
