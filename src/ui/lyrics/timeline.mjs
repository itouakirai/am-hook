// Values measured in the web components captured in research/resources.json.
export const behavior = Object.freeze({
  lineLead: 250, instrumentalThreshold: 9000, scrollDuration: 350,
  scrollMargin: 55, scrollResumeDelay: 4500, scrollIntentWindow: 150,
  emphasisDuration: 1000, emphasisMaxLength: 7, localizationDuration: 600,
});

export function displayRows(song) {
  const rows = [];
  const gap = (begin, end) => ({ kind:'instrumental',begin,end,key:`gap:${begin}` });
  if (song.sections[0]?.begin > behavior.instrumentalThreshold) rows.push(gap(0,song.sections[0].begin-1));
  song.sections.forEach((section,index) => {
    rows.push(...section.lines.map(line => ({kind:'lyric',...line})));
    const end = rows.at(-1)?.end;
    const next = song.sections[index+1]?.begin;
    if (next-end > behavior.instrumentalThreshold) rows.push(gap(end+1,next-1));
  });
  if (rows.length) rows.push({ kind:'credits', key:'credits', begin:rows.at(-1).end+1, end:Number.MAX_VALUE });
  return rows;
}

export function currentRow(rows, time) {
  const ahead = time + behavior.lineLead;
  let index = -1;
  for (let i=0;i<rows.length;i++) {
    if (rows[i].begin <= ahead && rows[i].end >= ahead) index = i;
  }
  if (index < 0) index = rows.findIndex(row => ahead < row.begin)-1;
  return index;
}

export const clamp = value => Math.max(0,Math.min(1,value));
export const easeScroll = value => value < .5 ? 2*value*value : 1-(-2*value+2)**2/2;
export const emphasized = token => token.end-token.begin >= behavior.emphasisDuration && token.text.length <= behavior.emphasisMaxLength;
export const validTokens = voice => voice.tokens.filter(token=>token.begin !== 0 || token.end !== 0);

/** Animation time is elapsed wall time since line activation, as in the reference.
 * The original web component does not seek this animation to media time.
 */
export function wordProgress(token, firstBegin, elapsed) {
  return -20 + 120*clamp((elapsed-(token.begin-firstBegin))/(token.end-token.begin || 1));
}
