'use strict';

/**
 * Gemeinsame Design-Tokens fuer den Word-Export (docx v9.7.1).
 *
 * Wird von Paket 6 (Dokumentrahmen) sowie Paket 3/4/5 (Listen/Tabellen/
 * Medien) konsumiert. Alle Farben sind bereits als docx-taugliche Hex-Werte
 * ohne '#' in Grossbuchstaben hinterlegt (siehe lib/colors.js#toDocxColor).
 */

const {
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  LevelFormat,
  PageOrientation,
  ShadingType,
} = require('docx');

const FONT_BODY = 'Calibri';
const FONT_MONO = 'Consolas';

const COLOR = {
  accent: '1D6FE8',
  text: '1A1918',
  muted: '666666',
  rule: 'D8D8D8',
  codeBg: 'F4F4F5',
  thBg: 'EAF1FC',
  quoteBar: '1D6FE8',
};

// A4 hoch (twip, 1 cm = 566.9291... twip -> 21 cm/29.7 cm gerundet auf
// Standard-A4-Werte), Rand 2 cm (1134 twip).
const PAGE = {
  widthTwip: 11906,
  heightTwip: 16838,
  marginTwip: 1134,
  contentWidthTwip: 9638,
  contentWidthPt: 481.9,
  contentWidthPx: 642,
};

const SPACING = {
  paraAfter: 120,
  paraLine: 276,
  headingBefore: 240,
  headingAfter: 120,
  blockAfter: 200,
  listAfter: 60,
};

/**
 * ISectionPropertiesOptions (Seitenformat/Raender) fuer docx v9.
 * Wird von Paket 6 direkt als `properties.page` bzw. als Section-Property
 * uebernommen (section.properties = SECTION_PROPERTIES).
 */
const SECTION_PROPERTIES = {
  page: {
    size: {
      width: PAGE.widthTwip,
      height: PAGE.heightTwip,
      orientation: PageOrientation.PORTRAIT,
    },
    margin: {
      top: PAGE.marginTwip,
      bottom: PAGE.marginTwip,
      left: PAGE.marginTwip,
      right: PAGE.marginTwip,
    },
  },
};

/**
 * IStylesOptions fuer docx v9. Ueberschriften 1-3 in Akzentfarbe (siehe
 * Story 7 / Architektur). Enthaelt die vom Vertrag geforderten
 * paragraphStyles: 'Quote', 'CodeBlock', 'Meta', 'TitlePageTitle',
 * 'TitlePageMeta', 'TableHeader'.
 */
const STYLES = {
  default: {
    document: {
      run: { font: FONT_BODY, size: 22, color: COLOR.text }, // 11pt = 22 half-points
      paragraph: { spacing: { after: SPACING.paraAfter, line: SPACING.paraLine } },
    },
    heading1: {
      run: { font: FONT_BODY, size: 32, bold: true, color: COLOR.accent },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
    heading2: {
      run: { font: FONT_BODY, size: 28, bold: true, color: COLOR.accent },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
    heading3: {
      run: { font: FONT_BODY, size: 24, bold: true, color: COLOR.accent },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
    heading4: {
      run: { font: FONT_BODY, size: 22, bold: true, color: COLOR.text },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
    heading5: {
      run: { font: FONT_BODY, size: 22, bold: true, italics: true, color: COLOR.text },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
    heading6: {
      run: { font: FONT_BODY, size: 22, italics: true, color: COLOR.muted },
      paragraph: {
        spacing: { before: SPACING.headingBefore, after: SPACING.headingAfter },
      },
    },
  },
  paragraphStyles: [
    {
      id: 'Quote',
      name: 'Quote',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_BODY, italics: true, color: COLOR.muted },
      paragraph: {
        spacing: { after: SPACING.blockAfter },
        indent: { left: 360 },
        border: {
          left: { style: BorderStyle.SINGLE, size: 12, color: COLOR.quoteBar, space: 8 },
        },
      },
    },
    {
      id: 'CodeBlock',
      name: 'Code Block',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_MONO, size: 20, color: COLOR.text },
      paragraph: {
        spacing: { after: SPACING.blockAfter },
        shading: { type: ShadingType.CLEAR, fill: COLOR.codeBg, color: 'auto' },
      },
    },
    {
      id: 'Meta',
      name: 'Meta',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_BODY, size: 18, color: COLOR.muted },
      paragraph: { spacing: { after: SPACING.blockAfter } },
    },
    {
      id: 'TitlePageTitle',
      name: 'Title Page Title',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_BODY, size: 56, bold: true, color: COLOR.text },
      paragraph: {
        alignment: AlignmentType.CENTER,
        spacing: { after: SPACING.headingAfter },
      },
    },
    {
      id: 'TitlePageMeta',
      name: 'Title Page Meta',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_BODY, size: 22, color: COLOR.muted },
      paragraph: {
        alignment: AlignmentType.CENTER,
        spacing: { after: SPACING.paraAfter },
      },
    },
    {
      id: 'TableHeader',
      name: 'Table Header',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: FONT_BODY, size: 20, bold: true, color: COLOR.text },
      paragraph: { spacing: { after: 40 } },
    },
  ],
};

/**
 * Einrueckung fuer Listenebene 0..8 (twip). Klemmt level auf 0..8, wirft nie.
 * @param {number} level
 * @returns {{left:number, hanging:number}}
 */
function LIST_INDENT(level) {
  let lvl = Number.isFinite(level) ? Math.trunc(level) : 0;
  if (lvl < 0) lvl = 0;
  if (lvl > 8) lvl = 8;
  return { left: 360 + 360 * lvl, hanging: 360 };
}

const ORDERED_FORMAT_CYCLE = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
const BULLET_CHAR_CYCLE = ['•', '◦', '▪']; // •, ◦, ▪

/**
 * Baut die 9 ILevelsOptions (0..8) fuer eine Nummerierungsreferenz.
 * @param {'ordered'|'bullet'} kind
 * @returns {object[]}
 */
function buildLevels(kind) {
  const levels = [];
  for (let level = 0; level < 9; level += 1) {
    const indent = LIST_INDENT(level);
    if (kind === 'ordered') {
      const format = ORDERED_FORMAT_CYCLE[level % 3];
      levels.push({
        level,
        format,
        text: '%' + (level + 1) + '.',
        alignment: AlignmentType.START,
        style: {
          paragraph: { indent: { left: indent.left, hanging: indent.hanging } },
        },
      });
    } else {
      const char = BULLET_CHAR_CYCLE[level % 3];
      levels.push({
        level,
        format: LevelFormat.BULLET,
        text: char,
        alignment: AlignmentType.START,
        style: {
          paragraph: { indent: { left: indent.left, hanging: indent.hanging } },
        },
      });
    }
  }
  return levels;
}

/**
 * Erzeugt eine neue NumberingRegistry-Instanz. Eine Instanz gehoert zu genau
 * einem Dokument. Jede via allocate() erzeugte Referenz startet eine eigene
 * Zaehlung (behebt das dokumentweite Durchlaufen der ol-Nummerierung).
 * @returns {{allocate:function(string):string, buildConfig:function():object}}
 */
function createNumberingRegistry() {
  let orderedCount = 0;
  let bulletCount = 0;
  const references = []; // { reference, kind }

  return {
    /**
     * @param {'ordered'|'bullet'} kind
     * @returns {string} z.B. 'ol-7' / 'ul-3'
     */
    allocate(kind) {
      if (kind === 'ordered') {
        orderedCount += 1;
        const reference = `ol-${orderedCount}`;
        references.push({ reference, kind });
        return reference;
      }
      if (kind === 'bullet') {
        bulletCount += 1;
        const reference = `ul-${bulletCount}`;
        references.push({ reference, kind });
        return reference;
      }
      throw new TypeError(`Unbekannter Listentyp: ${String(kind)}`);
    },
    /**
     * @returns {{config: Array<{reference:string, levels:object[]}>}}
     */
    buildConfig() {
      return {
        config: references.map(({ reference, kind }) => ({
          reference,
          levels: buildLevels(kind),
        })),
      };
    },
  };
}

module.exports = {
  FONT_BODY,
  FONT_MONO,
  COLOR,
  PAGE,
  SPACING,
  SECTION_PROPERTIES,
  STYLES,
  LIST_INDENT,
  createNumberingRegistry,
};
