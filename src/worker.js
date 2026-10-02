// Cloudflare Worker for "הטיולים שלי"
// - Static files in /public are served directly by Cloudflare (see wrangler.jsonc).
// - /api/ai-plan builds or revises a trip plan with Claude. Prototype: admins only.
//
// Secrets / variables (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   AI_PROVIDER         "gemini" or "claude" (set in wrangler.jsonc)
//   GEMINI_API_KEY      secret, from aistudio.google.com (free tier)
//   GEMINI_MODEL        optional, defaults to GEMINI_DEFAULT_MODEL below
//   ANTHROPIC_API_KEY   secret, from console.anthropic.com (paid)
//   SUPABASE_URL        plain variable (also set in wrangler.jsonc)
//   SUPABASE_ANON_KEY   plain variable (also set in wrangler.jsonc)

const MODEL = 'claude-sonnet-5-5';
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
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
        model: MODEL, max_tokens: 8000, system: SYSTEM_PROMPT + CLAUDE_EXTRA, messages: convo,
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

// Gemini: JSON output that follows the same schema (no web search on this path)
async function callGemini(env, messages) {
  const model = env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY},
    body: JSON.stringify({
      systemInstruction: {parts: [{text: SYSTEM_PROMPT + GEMINI_EXTRA}]},
      contents: messages.map(m => ({role: m.role === 'assistant' ? 'model' : 'user', parts: [{text: m.content}]})),
      generationConfig: {responseMimeType: 'application/json', responseJsonSchema: PLAN_TOOL.input_schema, maxOutputTokens: 12000}
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data.error && data.error.message) || ('HTTP ' + resp.status);
    if (resp.status === 429) throw new AIError(msg, 'נגמרה המכסה החינמית של Gemini לעכשיו. נסו שוב מאוחר יותר.');
    if (resp.status === 404) throw new AIError(msg, 'המודל של Gemini לא נמצא. בדקו את GEMINI_MODEL.');
    throw new AIError(msg);
  }
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || '').join('');
  if (!text) throw new AIError('empty response' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
  try { return JSON.parse(text); }
  catch { throw new AIError('invalid JSON from model', 'התשובה מ-Gemini נקטעה. נסו שוב, או בקשו פחות ימים.'); }
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
    tips: (Array.isArray(p.tips) ? p.tips : []).slice(0, 8).map(s)
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
- If the user asks for a change, return the full updated plan, and in "reply" say briefly in Hebrew what changed.`;

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
    required: ['destination', 'summary', 'days', 'reply'],
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
