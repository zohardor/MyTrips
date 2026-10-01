// Shared by index.html and login.html: airport coordinates and the small route chart.
// airport coordinates [lat, lon]
const AIRPORTS = {
  TLV:[32.011,34.886], BCN:[41.297,2.078], MAD:[40.472,-3.561], FCO:[41.800,12.239], CDG:[49.010,2.548],
  LHR:[51.470,-0.454], AMS:[52.308,4.764], ATH:[37.936,23.947], LIS:[38.774,-9.134], VIE:[48.110,16.570],
  PRG:[50.101,14.260], BUD:[47.437,19.256], JFK:[40.640,-73.779]
};
function distKm(a, b){
  const R = 6371, r = Math.PI/180;
  const dLat = (b[0]-a[0])*r, dLon = (b[1]-a[1])*r;
  const h = Math.sin(dLat/2)**2 + Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
// Draws a small route chart: dotted graticule, TLV on the east, an arc bowing poleward like a great circle.
function routeSVG(code, W, H, opts){
  opts = opts || {};
  const A = AIRPORTS.TLV, B = AIRPORTS[code] || opts.coords || [A[0] + 8, A[1] - 22];
  const pad = opts.pad || 34;
  const midLat = (A[0] + B[0]) / 2, k = Math.cos(midLat * Math.PI/180);
  const dx = Math.abs(A[1] - B[1]) * k || 1, dy = Math.abs(A[0] - B[0]) || 0;
  const sc = Math.min((W - pad*2) / dx, (H - pad*1.6) / Math.max(dy, dx*0.25));
  const cxLon = (A[1] + B[1]) / 2, cyLat = (A[0] + B[0]) / 2;
  const P = ([la, lo]) => [W/2 + (lo - cxLon)*k*sc, H/2 + 8 - (la - cyLat)*sc];
  const pa = P(A), pb = P(B);
  const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
  const len = Math.hypot(pb[0]-pa[0], pb[1]-pa[1]);
  const lift = Math.min(H*0.42, len*0.22 + 10);
  const c = [mx, my - lift];
  let grid = '';
  const span = Math.max(Math.abs(A[1]-B[1]), Math.abs(A[0]-B[0]));
  const step = opts.step || (span > 60 ? 20 : span > 25 ? 10 : 5);
  const lon0 = Math.floor((cxLon - (W/2)/(k*sc)) / step) * step, lon1 = cxLon + (W/2)/(k*sc);
  for (let lo = lon0; lo <= lon1; lo += step) { const x = P([0, lo])[0]; if (x < 0 || x > W) continue; grid += `<line class="rt-grid" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}"/>`; }
  const la0 = Math.floor((cyLat - (H/2)/sc) / step) * step, la1 = cyLat + (H/2)/sc + step;
  for (let la = la0; la <= la1; la += step) { const y = P([la, 0])[1]; if (y > 0 && y < H) grid += `<line class="rt-grid" x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`; }
  const d = `M${pa[0].toFixed(1)},${pa[1].toFixed(1)} Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${pb[0].toFixed(1)},${pb[1].toFixed(1)}`;
  // plane at 82% of the curve, rotated along the tangent
  const t = .82, q = (p0, p1, p2) => (1-t)*(1-t)*p0 + 2*(1-t)*t*p1 + t*t*p2;
  const px = q(pa[0], c[0], pb[0]), py = q(pa[1], c[1], pb[1]);
  const tx = 2*(1-t)*(c[0]-pa[0]) + 2*t*(pb[0]-c[0]), ty = 2*(1-t)*(c[1]-pa[1]) + 2*t*(pb[1]-c[1]);
  const ang = Math.atan2(ty, tx) * 180/Math.PI;
  const r = opts.r || 5;
  const plane = opts.plane === false ? '' :
    `<path class="rt-plane" transform="translate(${px.toFixed(1)},${py.toFixed(1)}) rotate(${ang.toFixed(1)}) scale(${opts.planeScale || 1})" d="M8,0 L-6,-6 L-3,0 L-6,6 Z"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    ${grid}<path class="rt-arc ghost" d="${d}"/><path class="rt-arc" d="${d}"/>
    <circle class="rt-pt" cx="${pa[0].toFixed(1)}" cy="${pa[1].toFixed(1)}" r="${r}"/>
    <circle class="rt-pt dest" cx="${pb[0].toFixed(1)}" cy="${pb[1].toFixed(1)}" r="${r}"/>${plane}</svg>`;
}

// destination names for pages that don't load the full planner data
const PLACE_NAMES = {
  BCN:['ברצלונה','ספרד'], MAD:['מדריד','ספרד'], FCO:['רומא','איטליה'], CDG:['פריז','צרפת'], LHR:['לונדון','בריטניה'],
  AMS:['אמסטרדם','הולנד'], ATH:['אתונה','יוון'], LIS:['ליסבון','פורטוגל'], VIE:['וינה','אוסטריה'], PRG:['פראג','צ׳כיה'],
  BUD:['בודפשט','הונגריה'], JFK:['ניו יורק','ארה״ב']
};

// Coordinates and display code for a trip: built-in destination, or one the AI planner located (state.geo)
function tripCoords(st){
  if (AIRPORTS[st.dest]) return AIRPORTS[st.dest];
  const g = st.geo;
  return g && isFinite(g.lat) && isFinite(g.lon) ? [+g.lat, +g.lon] : null;
}
function tripCode(st){
  if (st.dest !== 'OTHER') return st.dest;
  return (st.geo && /^[A-Z]{3}$/.test(st.geo.code || '')) ? st.geo.code : (st.custom || '???');
}
