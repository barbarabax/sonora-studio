// @codedna
// description: The YuE2 plan engraved as sheet music (abcjs, loaded on first use); a click on a note reports where it is, and the notes light up as the plan plays.
//
// exports: renderScore | followScore
// used_by: public/yue2-ui.mjs
// related: public/vendor/abcjs-basic-min.js — abcjs 6.4.4 (MIT); public/abc-edit.mjs locateNote — turns the clicked character into section/voice/bar/note
// rules:   The script is loaded once from this server only (CSP script-src 'self'). The text given to abcjs is the plan with \n line ends,
//          so the character offsets abcjs reports match locateNote. Nothing here changes the plan; following the music only changes a CSS class.
// agent:   claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_midi | Created for the "spartito vero" request (YuE2-Studio engraves its scores too).
//          claude-opus-5-5 | anthropic | 2026-10-15 | s_20261015_follow | The score follows the playback (abcjs setTiming).
let loading = null;
function abcjs() {
  if (window.ABCJS) return Promise.resolve(window.ABCJS);
  loading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/abcjs-basic-min.js';
    script.onload = () => resolve(window.ABCJS);
    script.onerror = () => reject(new Error('I cannot load the score.'));
    document.head.append(script);
  });
  return loading;
}

let timings = []; // [{ ms, elements }] of the score drawn last, for followScore
let lit = [];

/**
 * Draw `abc` into `element`. onNote(charIndex) is called when a note or rest is clicked.
 * @returns the text that was drawn (with \n line ends)
 */
export async function renderScore(element, abc, onNote) {
  const ABCJS = await abcjs();
  const text = String(abc || '').replace(/\r\n/g, '\n');
  lit = [];
  const [tune] = ABCJS.renderAbc(element, text, {
    responsive: 'resize',
    add_classes: true,
    paddingtop: 4,
    paddingbottom: 4,
    staffwidth: 740,
    wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: 4 },
    clickListener: elem => {
      if (Number.isInteger(elem?.startChar) && elem.el_type === 'note') onNote?.(elem.startChar);
    },
  });
  // when each note starts, from abcjs's own timing of the tune (the tempo of its Q: line)
  try {
    timings = (tune?.setTiming() || [])
      .filter(event => event.type === 'event' && Array.isArray(event.elements))
      .map(event => ({ ms: event.milliseconds, elements: event.elements.flat().filter(Boolean) }));
  } catch {
    timings = [];
  }
  return text;
}

/**
 * Light up the notes sounding at `seconds` on the score drawn last and keep them in view; null clears the light.
 * Rules: only the CSS class changes, the drawing is never redone while the music plays.
 */
export function followScore(seconds, scroller) {
  for (const el of lit) el.classList.remove('score-playing');
  lit = [];
  if (seconds === null || !timings.length) return;
  const ms = seconds * 1000;
  let i = timings.length - 1;
  while (i > 0 && timings[i].ms > ms) i--;
  const at = timings[i].ms;
  // every voice that starts a note at this moment (voice and instrument together)
  for (const event of timings) if (event.ms === at) for (const el of event.elements) lit.push(el);
  for (const el of lit) el.classList.add('score-playing');
  const first = lit[0];
  if (first && scroller) {
    const box = first.getBoundingClientRect(),
      view =
        scroller === document.scrollingElement
          ? { top: 0, bottom: innerHeight, height: innerHeight }
          : scroller.getBoundingClientRect();
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40)
      scroller.scrollTop += box.top - view.top - view.height / 3;
  }
}
