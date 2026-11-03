// @codedna
// description: Reads the ABC melody-and-chords plan of YuE2 and lets one chord at a time be changed without touching anything else.
//
// exports: isChord | parsePlan | setChord | setChords | planSummary
// used_by: public/abc-edit.mjs
//                   public/chord-bed.mjs
//                   public/chord-presets.mjs
//                   public/yue2-ui.mjs
// rules:   Pure functions, no I/O. Only chord symbols of the FIRST voice are editable (the singer); header lines, text annotations and notes are never rewritten. setChord returns a new string and throws on an invalid chord.
// agent:   claude-sonnet-5-5 | anthropic | 2026-10-11 | s_20261011_yue2 | Created from a real YuE2 plan (header M/L/Q/K, two voices, "% section" comments, chords in quotes above the vocal bars).
const CHORD = /^[A-G][#b]?[A-Za-z0-9#b+\-°ø()]*(\/[A-G][#b]?)?$/;

/** A chord symbol such as D, Bm, F#m7, Cmaj7, G/B, Asus4: at most 12 characters, never a quote. */
export const isChord = value => typeof value === 'string' && value.length <= 12 && CHORD.test(value);

const isHeaderLine = line => /^[A-Za-z]:/.test(line);

/**
 * Parse a plan: the header values and every editable chord, in order, with its section and bar.
 * Returns { header: { bpm, meter, key, unit }, singer, sections: [{ name, slots }], slots: [{ id, section, bar, chord, start, end }] }.
 */
export function parsePlan(abc) {
  const text = String(abc || '').replace(/\r\n/g, '\n');
  const header = {};
  const slots = [];
  const sections = [];
  let singer = null,
    voice = null,
    inBody = false,
    section = null,
    barsInSection = 0,
    offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!inBody) {
      const head = /^([A-Za-z]):\s*(.*)$/.exec(line);
      if (head) {
        if (head[1] === 'M') header.meter = head[2].trim();
        if (head[1] === 'L') header.unit = head[2].trim();
        if (head[1] === 'Q') {
          const tempo = /=\s*(\d+)/.exec(head[2]);
          if (tempo) header.bpm = Number(tempo[1]);
        }
        if (head[1] === 'V') {
          const name = /^(\S+)/.exec(head[2])?.[1];
          if (name && !singer) singer = name;
        }
        if (head[1] === 'K') {
          header.key = head[2].trim();
          inBody = true;
        }
      }
      continue;
    }
    const comment = /^%\s*(.+)$/.exec(line);
    if (comment) {
      section = { name: comment[1].trim(), slots: [] };
      sections.push(section);
      barsInSection = 0;
      continue;
    }
    const voiceLine = /^V:\s*(\S+)/.exec(line);
    if (voiceLine) {
      voice = voiceLine[1];
      continue;
    }
    if (isHeaderLine(line) || !line.trim() || voice !== singer) continue;
    if (!section) {
      section = { name: 'intro', slots: [] };
      sections.push(section);
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) break;
        const content = line.slice(i + 1, close);
        if (isChord(content)) {
          const slot = {
            id: slots.length,
            section: section.name,
            bar: barsInSection + 1,
            chord: content,
            start: lineStart + i + 1,
            end: lineStart + close,
          };
          slots.push(slot);
          section.slots.push(slot);
        }
        i = close;
      } else if (c === '|') barsInSection++;
    }
  }
  return { header, singer, sections, slots };
}

/** Replace chord number `id` and nothing else; throws when the chord is not valid or the plan has no such chord. */
export function setChord(abc, id, chord) {
  const text = String(abc).replace(/\r\n/g, '\n');
  const plan = parsePlan(text);
  const slot = plan.slots[id];
  if (!slot) throw new Error('Chord not found in the plan.');
  if (!isChord(chord)) throw new Error('Invalid chord: write for example D, Bm, F#m7, G/B.');
  return text.slice(0, slot.start) + chord + text.slice(slot.end);
}

/** Replace several chords at once: `changes` maps a chord number to its new symbol. Throws if any chord is invalid. */
export function setChords(abc, changes) {
  const text = String(abc).split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const plan = parsePlan(text);
  let result = text;
  // from the last chord to the first, so the positions of the earlier ones stay valid
  for (const id of [...changes.keys()].sort((a, b) => b - a)) {
    const slot = plan.slots[id];
    const chord = changes.get(id);
    if (!slot) throw new Error('Chord not found in the plan.');
    if (!isChord(chord)) throw new Error('Invalid chord: ' + chord);
    result = result.slice(0, slot.start) + chord + result.slice(slot.end);
  }
  return result;
}

/** A one-line description of the plan for lists and details. */
export function planSummary(abc) {
  const { header, slots } = parsePlan(abc);
  const distinct = [...new Set(slots.map(s => s.chord))];
  return [
    header.key && `key ${header.key}`,
    header.bpm && `${header.bpm} BPM`,
    header.meter && header.meter,
    distinct.length && `chords: ${distinct.slice(0, 8).join(' ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Keep only the chords of a plan: the singer's bars become the chords over rests and the instrument's bars whole-bar silences,
 * the same shape as a chord bed. A bar with several chords shares its length between them when it divides evenly, otherwise
 * it keeps its first chord. YuE2 then writes the melody over those chords.
 */
export function chordsOnly(abc) {
  const text = String(abc || '')
    .split(String.fromCharCode(13, 10))
    .join(String.fromCharCode(10));
  const plan = parsePlan(text);
  const meter = /^(\d+)\/(\d+)$/.exec(plan.header.meter || '');
  const unit = /^(\d+)\/(\d+)$/.exec(plan.header.unit || '');
  if (!meter || !unit || !plan.singer)
    throw new Error('This plan has no tempo and meter to read the chords from.');
  const units = Math.round(((Number(meter[1]) / Number(meter[2])) * Number(unit[2])) / Number(unit[1]));
  if (!Number.isInteger(units) || units < 1)
    throw new Error('This plan has no tempo and meter to read the chords from.');
  const out = [];
  let inBody = false;
  let voice = null;
  for (const line of text.split('\n')) {
    if (!inBody) {
      out.push(line);
      if (/^K:/.test(line)) inBody = true;
      continue;
    }
    const voiceLine = /^V:\s*(\S+)/.exec(line);
    if (voiceLine) voice = voiceLine[1];
    if (voiceLine || /^%/.test(line) || !line.trim() || /^[A-Za-z]:/.test(line)) {
      out.push(line);
      continue;
    }
    const bars = line.split('|').filter(bar => bar.trim() !== '');
    if (voice !== plan.singer) {
      out.push(`Z${bars.length}|`);
      continue;
    }
    out.push(
      bars
        .map(bar => {
          const chords = [...bar.matchAll(/"([^"]*)"/g)].map(m => m[1]).filter(isChord);
          if (!chords.length) return `z${units}`;
          const share = units % chords.length === 0 ? units / chords.length : 0;
          if (!share) return `"${chords[0]}"z${units}`;
          return chords.map(chord => `"${chord}"z${share}`).join('');
        })
        .join('|') + '|'
    );
  }
  return out.join('\n');
}
