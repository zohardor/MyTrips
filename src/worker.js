// Cloudflare Worker for "הטיולים שלי"
// - Static files in /public are served directly by Cloudflare (see wrangler.jsonc).
// - /api/ai-plan builds or revises a trip plan with Claude. Prototype: admins only.
//
// Secrets / variables (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   AI_PROVIDER         "gemini" or "claude" (set in wrangler.jsonc)
//   GEMINI_API_KEY      secret, from aistudio.google.com (free tier)
//   GEMINI_MODEL        optional, defaults to GEMINI_DEFAULT_MODEL below
//   GEMINI_FALLBACK_MODEL optional, used when the main model is busy or out of quota
//   ANTHROPIC_API_KEY   secret, from console.anthropic.com (paid)
//   SUPABASE_URL        plain variable (also set in wrangler.jsonc)
//   SUPABASE_ANON_KEY   plain variable (also set in wrangler.jsonc)

const MODEL = 'claude-sonnet-5-5';
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const GEMINI_FALLBACK_MODEL = 'gemini-flash-lite-latest';
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CZK', 'HUF', 'ILS'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai-plan') return handlePlan(request, env);
    return env.ASSETS.fetch(request);
  }
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}
});

async function handlePlan(request, env) {
  if (request.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
  const provider = (env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'claude')).toLowerCase();
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!env[keyName]) return json({error: 'not_configured', message: `חסר מפתח ${keyName} בהגדרות ה-Worker.`}, 500);

  // 1. who is calling? verify the Supabase session token
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({error: 'unauthorized'}, 401);
  const sbHeaders = {apikey: env.SUPABASE_ANON_KEY, authorization: 'Bearer ' + token};
  const userRes = await fetch(env.SUPABASE_URL + '/auth/v1/user', {headers: sbHeaders});
  if (!userRes.ok) return json({error: 'unauthorized'}, 401);

  // 2. prototype gate: admins only
  const adminRes = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/is_admin', {
    method: 'POST', headers: {...sbHeaders, 'content-type': 'application/json'}, body: '{}'
  });
  if (!adminRes.ok || (await adminRes.json()) !== true)
    return json({error: 'forbidden', message: 'התכנון עם AI זמין כרגע רק למנהלים.'}, 403);

  // 3. validate input
  let body;
  try { body = await request.json(); } catch { return json({error: 'bad_request'}, 400); }
  const req = String(body.request || '').trim().slice(0, 2000);
  const days = Math.min(21, Math.max(1, parseInt(body.days, 10) || 5));
  const travelers = Math.min(20, Math.max(1, parseInt(body.travelers, 10) || 2));
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(body.start_date || '') ? body.start_date : '';
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const currentPlan = body.plan && typeof body.plan === 'object' ? body.plan : null;
  if (!req) return json({error: 'bad_request', message: 'כתבו מה אתם מחפשים.'}, 400);

  // 4. conversation for Claude
  const messages = [];
  const first = history.length ? history[0].text : req;
  messages.push({role: 'user', content:
    `בקשת הטיול: ${String(first).slice(0, 2000)}\n` +
    `מספר ימים: ${days}\nמספר נוסעים: ${travelers}\n` +
    (startDate ? `תאריך יציאה: ${startDate}\n` : 'תאריך יציאה: לא נקבע\n')});
  for (const h of history.slice(1)) {
    const text = String(h.text || '').slice(0, 2000);
    if (!text) continue;
    messages.push({role: h.role === 'assistant' ? 'assistant' : 'user', content: text});
  }
  if (currentPlan) {
    messages.push({role: 'assistant', content: 'זו התוכנית הנוכחית:\n' + JSON.stringify(currentPlan).slice(0, 30000)});
    messages.push({role: 'user', content: 'בקשת שינוי: ' + req + '\nהחזר את התוכנית המלאה המעודכנת.'});
  }
  // the API needs alternating roles; merge any accidental repeats
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else merged.push({...m});
  }
  if (merged[0].role !== 'user') merged.unshift({role: 'user', content: req});

  // 5. ask the model
  let raw;
  try {
    raw = provider === 'gemini' ? await callGemini(env, merged) : await callClaude(env, merged);
  } catch (e) {
    return json({error: 'ai_error', message: e.userMessage || 'שירות ה-AI החזיר שגיאה. נסו שוב בעוד דקה.', detail: String(e.message || '').slice(0, 300)}, 502);
  }
  if (!raw) return json({error: 'no_plan', message: 'לא התקבלה תוכנית. נסו לנסח את הבקשה אחרת.'}, 502);
  return json({plan: sanitizePlan(raw, days), provider});
}

class AIError extends Error { constructor(msg, userMessage) { super(msg); this.userMessage = userMessage; } }

// Claude: web search for current info, then the structured plan tool
async function callClaude(env, messages) {
  let data, convo = messages;
  for (let round = 0; round < 4; round++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({
        model: MODEL, max_tokens: 14000, system: SYSTEM_PROMPT + CLAUDE_EXTRA, messages: convo,
        tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: 5}, PLAN_TOOL],
        tool_choice: {type: 'auto'}
      })
    });
    data = await resp.json();
    if (!resp.ok) throw new AIError((data && data.error && data.error.message) || ('HTTP ' + resp.status));
    // long searches can pause the turn; continue it
    if (data.stop_reason === 'pause_turn') { convo = [...convo, {role: 'assistant', content: data.content}]; continue; }
    break;
  }
  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'create_trip_plan');
  return toolUse ? toolUse.input : null;
}

// Gemini: JSON output that follows the same schema (no web search on this path).
// The free tier is often busy (HTTP 503 "high demand"), so: retry with backoff, then fall back to a lighter model.
async function callGemini(env, messages) {
  const models = [env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL, env.GEMINI_FALLBACK_MODEL || GEMINI_FALLBACK_MODEL]
    .filter((m, i, arr) => m && arr.indexOf(m) === i);
  const body = JSON.stringify({
    systemInstruction: {parts: [{text: SYSTEM_PROMPT + GEMINI_EXTRA}]},
    contents: messages.map(m => ({role: m.role === 'assistant' ? 'model' : 'user', parts: [{text: m.content}]})),
    generationConfig: {responseMimeType: 'application/json', responseJsonSchema: PLAN_TOOL.input_schema, maxOutputTokens: 16000}
  });
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, attempt * 2000 + Math.random() * 1000));
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY}, body
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        const cand = data.candidates && data.candidates[0];
        const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || '').join('');
        if (!text) { lastErr = new AIError('empty response' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '')); continue; }
        try { return JSON.parse(text); }
        catch { lastErr = new AIError('invalid JSON from ' + model, 'התשובה מ-Gemini נקטעה. נסו שוב, או בקשו פחות ימים.'); continue; }
      }
      const msg = (data.error && data.error.message) || ('HTTP ' + resp.status);
      if (resp.status === 503 || resp.status === 500) {          // busy: retry, then next model
        lastErr = new AIError(msg, 'Gemini עמוס כרגע. נסו שוב בעוד כמה דקות.');
        continue;
      }
      if (resp.status === 429) {                                 // quota for this model: try the next one
        lastErr = new AIError(msg, 'נגמרה המכסה החינמית של Gemini לעכשיו. נסו שוב מאוחר יותר.');
        break;
      }
      if (resp.status === 404) { lastErr = new AIError(msg, 'המודל של Gemini לא נמצא. בדקו את GEMINI_MODEL.'); break; }
      throw new AIError(msg);                                    // anything else: don't hammer the API
    }
  }
  throw lastErr || new AIError('Gemini failed');
}

function sanitizePlan(p, days) {
  const s = v => String(v ?? '').slice(0, 400);
  const dest = p.destination || {};
  return {
    destination: {
      city: s(dest.city), country: s(dest.country),
      code: /^[A-Z]{3}$/.test(dest.airport_code || '') ? dest.airport_code : '',
      lat: isFinite(dest.lat) ? +dest.lat : null, lon: isFinite(dest.lon) ? +dest.lon : null,
      currency: CURRENCIES.includes(dest.price_currency) ? dest.price_currency : 'EUR'
    },
    summary: s(p.summary),
    reply: s(p.reply),
    days: (Array.isArray(p.days) ? p.days : []).slice(0, days).map((d, i) => ({
      day: i + 1,
      title: s(d.title),
      items: (Array.isArray(d.items) ? d.items : []).slice(0, 12).map(it => ({
        time: /^\d{1,2}:\d{2}$/.test(it.time || '') ? it.time : '',
        name: s(it.name), kind: ['attraction','market','restaurant','cafe','walk','other'].includes(it.kind) ? it.kind : 'other',
        area: s(it.area), description: s(it.description),
        price: isFinite(it.price_per_person) ? Math.max(0, +it.price_per_person) : 0,
        url: /^https?:\/\//.test(it.url || '') ? s(it.url) : ''
      }))
    })),
    daily_food_budget: isFinite(p.daily_food_budget_per_person) ? Math.max(0, +p.daily_food_budget_per_person) : null,
    daily_transport: isFinite(p.daily_transport_per_person) ? Math.max(0, +p.daily_transport_per_person) : null,
    saving_tips: (Array.isArray(p.saving_tips) ? p.saving_tips : []).slice(0, 6).map(s),
    flights: sanitizeFlights(p.flights),
    hotels: sanitizeHotels(p.hotels, days),
    tips: (Array.isArray(p.tips) ? p.tips : []).slice(0, 8).map(s)
  };
}

const num = v => (isFinite(v) && +v >= 0 ? +v : 0);
const range = r => {
  const a = num(r && r.min), b = num(r && r.max);
  return {min: Math.min(a, b || a), max: Math.max(a, b)};
};
function sanitizeFlights(f) {
  f = f || {};
  return {
    currency: CURRENCIES.includes(f.currency) ? f.currency : 'USD',
    options: (Array.isArray(f.options) ? f.options : []).slice(0, 5).map(o => ({
      label: String(o.label ?? '').slice(0, 120),
      airlines: (Array.isArray(o.airlines) ? o.airlines : []).slice(0, 5).map(a => String(a).slice(0, 60)),
      stops: Math.min(3, Math.max(0, parseInt(o.stops, 10) || 0)),
      duration_hours: num(o.duration_hours),
      price: range(o.round_trip_price_per_person),
      note: String(o.note ?? '').slice(0, 300)
    })).filter(o => o.label && o.price.max > 0),
    note: String(f.note ?? '').slice(0, 300)
  };
}
function sanitizeHotels(h, days) {
  h = h || {};
  return {
    currency: CURRENCIES.includes(h.currency) ? h.currency : 'EUR',
    areas: (Array.isArray(h.areas) ? h.areas : []).slice(0, 5).map(a => ({
      name: String(a.name ?? '').slice(0, 80),
      why: String(a.why ?? '').slice(0, 300),
      near_days: (Array.isArray(a.near_days) ? a.near_days : []).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= days).slice(0, days),
      hotels: (Array.isArray(a.hotels) ? a.hotels : []).slice(0, 4).map(x => ({
        name: String(x.name ?? '').slice(0, 120),
        level: ['budget', 'mid', 'luxury'].includes(x.level) ? x.level : 'mid',
        price: range(x.price_per_night),
        note: String(x.note ?? '').slice(0, 200)
      })).filter(x => x.name && x.price.max > 0)
    })).filter(a => a.name && a.hotels.length)
  };
}

const SYSTEM_PROMPT = `You are the trip planner inside a Hebrew travel-planning website for Israeli travelers flying from Tel Aviv.
Build a realistic, day-by-day plan.

Rules:
- All user-facing text (titles, descriptions, tips, reply) in natural Hebrew. Place names may include the local/English name in parentheses.
- Use real, well-known places. Do not invent places.
- Group each day geographically to limit travel time. Keep a humane pace: 3-5 main stops a day plus meals.
- Include markets, lunch and dinner suggestions every day (kind "market", "restaurant" or "cafe"). Prefer places with a good local reputation over tourist traps.
- price_per_person is a typical adult entry price or meal cost, as an estimate. Use 0 for free places.
- All prices use ONE currency: the local currency if it is EUR, USD, GBP, CZK or HUF; otherwise USD. Put it in destination.price_currency.
- airport_code is the IATA code of the main airport (for example LHR for London). lat/lon are the city center.
- First and last day: account for flight arrival/departure with a lighter schedule.
- If the user asks for a change, return the full updated plan, and in "reply" say briefly in Hebrew what changed.

Flights (flights): 2-4 realistic options from Tel Aviv (Ben Gurion, TLV) to the destination for the trip month.
- Include direct options only on routes that really have direct flights, naming the airlines that operate them. Add one-stop options when they are typically cheaper.
- round_trip_price_per_person is a typical economy round-trip range in USD for that season. These are estimates; the site tells users to check live prices.

Hotels (hotels): 3-4 neighborhoods that suit THIS itinerary, each with "why" in Hebrew and near_days listing the plan days it is closest to.
- For each neighborhood list 3-4 long-established, well-known hotels across levels (budget / mid / luxury). Prefer stable hotels and chains over small new places.
- price_per_night is a typical range for a standard double room in the trip month, in hotels.currency (the same currency as destination.price_currency).

Budget: daily_food_budget_per_person and daily_transport_per_person (local transport) in destination.price_currency, plus 3-5 concrete saving_tips in Hebrew.`;

const CLAUDE_EXTRA = `
- Return the plan ONLY by calling the create_trip_plan tool.
- When unsure whether a place is still open or what it costs, use web_search to check.`;

const GEMINI_EXTRA = `
- Return only the JSON object that matches the schema.
- You cannot browse the web: prefer long-established, well-known places, and avoid places you are not confident still operate.`;

const PLAN_TOOL = {
  name: 'create_trip_plan',
  description: 'Return the complete trip plan to the website.',
  input_schema: {
    type: 'object',
    required: ['destination', 'summary', 'days', 'reply', 'flights', 'hotels', 'daily_food_budget_per_person', 'daily_transport_per_person'],
    properties: {
      destination: {
        type: 'object',
        required: ['city', 'country', 'airport_code', 'lat', 'lon', 'price_currency'],
        properties: {
          city: {type: 'string'}, country: {type: 'string'},
          airport_code: {type: 'string', description: 'IATA code, 3 capital letters'},
          lat: {type: 'number'}, lon: {type: 'number'},
          price_currency: {type: 'string', enum: CURRENCIES}
        }
      },
      summary: {type: 'string', description: 'Two or three Hebrew sentences describing the trip'},
      reply: {type: 'string', description: 'Short Hebrew chat reply to the user'},
      daily_food_budget_per_person: {type: 'number', description: 'Typical daily food spend per person, in price_currency'},
      daily_transport_per_person: {type: 'number', description: 'Typical daily local transport per person, in price_currency'},
      saving_tips: {type: 'array', items: {type: 'string'}},
      flights: {
        type: 'object',
        required: ['currency', 'options'],
        properties: {
          currency: {type: 'string', enum: CURRENCIES},
          note: {type: 'string', description: 'Short Hebrew note about flights on this route'},
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['label', 'airlines', 'stops', 'round_trip_price_per_person'],
              properties: {
                label: {type: 'string', description: 'Hebrew, e.g. "טיסה ישירה בחברה מסורתית"'},
                airlines: {type: 'array', items: {type: 'string'}},
                stops: {type: 'integer'},
                duration_hours: {type: 'number', description: 'One-way flight time'},
                round_trip_price_per_person: {type: 'object', required: ['min', 'max'], properties: {min: {type: 'number'}, max: {type: 'number'}}},
                note: {type: 'string'}
              }
            }
          }
        }
      },
      hotels: {
        type: 'object',
        required: ['currency', 'areas'],
        properties: {
          currency: {type: 'string', enum: CURRENCIES},
          areas: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'why', 'hotels'],
              properties: {
                name: {type: 'string', description: 'Neighborhood name'},
                why: {type: 'string', description: 'One Hebrew sentence'},
                near_days: {type: 'array', items: {type: 'integer'}},
                hotels: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'level', 'price_per_night'],
                    properties: {
                      name: {type: 'string'},
                      level: {type: 'string', enum: ['budget', 'mid', 'luxury']},
                      price_per_night: {type: 'object', required: ['min', 'max'], properties: {min: {type: 'number'}, max: {type: 'number'}}},
                      note: {type: 'string', description: 'Short Hebrew note'}
                    }
                  }
                }
              }
            }
          }
        }
      },
      days: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'items'],
          properties: {
            title: {type: 'string', description: 'Hebrew theme of the day, a few words'},
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'kind', 'description'],
                properties: {
                  time: {type: 'string', description: 'HH:MM'},
                  name: {type: 'string'},
                  kind: {type: 'string', enum: ['attraction', 'market', 'restaurant', 'cafe', 'walk', 'other']},
                  area: {type: 'string', description: 'Neighborhood'},
                  description: {type: 'string', description: 'One Hebrew sentence'},
                  price_per_person: {type: 'number'},
                  url: {type: 'string', description: 'Official website if known'}
                }
              }
            }
          }
        }
      },
      tips: {type: 'array', items: {type: 'string'}}
    }
  }
};
