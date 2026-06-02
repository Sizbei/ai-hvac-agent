import type { KnowledgeBaseEntry } from "./router-types";

/**
 * Deterministic HVAC intent knowledge base.
 *
 * Encodes the 53-intent catalog from docs/KNOWLEDGE-BASE-CATALOG.md verbatim.
 * Pure data: canned responses follow safety rules (no DIY repair steps, no
 * pricing/scheduling promises). The router consumes this to resolve common
 * messages without an LLM call.
 *
 * Review-mandated overrides applied during encoding:
 *  1. Reference/account intents that need live backend data are FALLBACK_LLM
 *     (account-check-status, account-provide-reference, account-change-appointment,
 *     scheduling-reschedule, scheduling-cancel). Their original canned text is
 *     preserved in notes.
 *  2. Emergency entries carry requiredQualifiers so a bare noun never triggers them.
 *  3. "em heat" / "emergency heat" / "aux heat" are whitelisted via negationGuards
 *     on emergency entries (heat-pump emergency-heat mode is a normal setting).
 */
export const KNOWLEDGE_BASE: readonly KnowledgeBaseEntry[] = [
  // ─── Category 1 — EMERGENCY / SAFETY ───────────────────────────────────────
  {
    id: "emergency-gas-smell",
    category: "emergency",
    title: "Gas smell / suspected gas leak",
    triggerKeywords: [
      "gas smell",
      "smell gas",
      "gas leak",
      "rotten eggs",
      "smell of gas",
      "propane smell",
      "natural gas",
    ],
    negationGuards: [
      "no gas smell",
      "gas furnace",
      "gas stove",
      "gas line is fine",
      "em heat",
      "emergency heat",
      "aux heat",
    ],
    requiredQualifiers: ["smell", "leak", "odor", "rotten eggs"],
    action: "ESCALATE",
    cannedResponse:
      "A gas smell can be dangerous — please leave your home right now, avoid using any switches, phones, or flames inside, and once you're safely outside call your gas utility's emergency line or 911. I'm flagging this as an emergency so our team can follow up right away.",
    infoNeeded: [],
    issueTypeMapping: "other",
    urgencyHint: "emergency",
    notes:
      "Highest priority. Do not ask them to inspect the furnace. Distinguish from heating-strange-smell-startup (a brief burning/dusty smell on first furnace startup is normal-ish and is NOT a gas emergency). Bare 'gas' (e.g. 'gas furnace') must NOT trigger; require pairing with smell/leak/odor.",
  },
  {
    id: "emergency-carbon-monoxide",
    category: "emergency",
    title: "Carbon monoxide alarm / CO symptoms",
    triggerKeywords: [
      "carbon monoxide",
      "co alarm",
      "co detector",
      "co2 alarm",
      "co2 detector",
    ],
    negationGuards: ["em heat", "emergency heat", "aux heat"],
    // Require an actual danger signal — NOT the subject words "co"/"carbon
    // monoxide" themselves (the co→carbon-monoxide alias would otherwise make
    // every CO mention escalate, including informational questions).
    requiredQualifiers: [
      "alarm",
      "detector",
      "going off",
      "beeping",
      "dizzy",
      "nausea",
      "headache",
      "poisoning",
    ],
    action: "ESCALATE",
    cannedResponse:
      "A carbon monoxide alarm is a serious emergency — please get everyone (and pets) outside to fresh air immediately and call 911 once you're out. I'm marking this urgent so our team can follow up right away.",
    infoNeeded: [],
    issueTypeMapping: "other",
    urgencyHint: "emergency",
    notes:
      "CO symptoms (dizzy/nausea/headache + furnace) should also escalate. Never tell them to reset the alarm or check the unit. 'co' alone can be noise; require alarm/detector/poisoning context.",
  },
  {
    id: "emergency-electrical-burning-smell",
    category: "emergency",
    title: "Electrical / burning smell or smoke from HVAC",
    triggerKeywords: [
      "burning smell",
      "smell burning",
      "burning plastic",
      "electrical smell",
      "smoke",
      "melting",
      "sparks",
      "hot wires",
    ],
    negationGuards: ["em heat", "emergency heat", "aux heat"],
    requiredQualifiers: ["burning", "smoke", "smell", "sparks"],
    action: "ESCALATE",
    cannedResponse:
      "A burning or electrical smell — or any smoke — is a fire risk. Please turn off the system at the thermostat or breaker if you can do so safely, leave the area, and call 911 if you see smoke or flames. I'm flagging this as an emergency for our team.",
    infoNeeded: [],
    issueTypeMapping: "other",
    urgencyHint: "emergency",
    notes:
      "Ambiguity with startup dust smell is the main risk; 'burning plastic', 'smoke', 'sparks', 'won't go away' push it to emergency. Brief 'burning/dusty smell when furnace first turns on' → see heating-strange-smell-startup. When genuinely unclear → FALLBACK_LLM.",
  },
  {
    id: "emergency-flooding",
    category: "emergency",
    title: "Active flooding / major water from HVAC",
    triggerKeywords: [
      "flooding",
      "pouring water",
      "water everywhere",
      "burst",
      "gushing",
      "flood",
    ],
    negationGuards: ["em heat", "emergency heat", "aux heat"],
    requiredQualifiers: [
      "flooding",
      "flood",
      "burst",
      "pouring",
      "everywhere",
      "gushing",
    ],
    action: "ESCALATE",
    cannedResponse:
      "That sounds like a serious leak. If you can safely reach it, shut off the water supply to the unit and turn off power to it at the breaker, then move valuables away from the water. I'm flagging this as urgent so our team can respond quickly — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "water_leak",
    urgencyHint: "emergency",
    notes:
      "Distinguish from routine cooling-water-leak (slow drip = high, not emergency). 'Burst', 'flooding', 'pouring', 'everywhere', 'through the ceiling' = emergency. A small drip/condensation is cooling-water-leak.",
  },
  {
    id: "emergency-no-heat-freezing",
    category: "emergency",
    title: "No heat in freezing / dangerously cold conditions",
    triggerKeywords: [
      "no heat",
      "freezing",
      "below freezing",
      "pipes freeze",
      "freezing in here",
      "frozen pipes",
      "newborn",
      "elderly",
      "baby",
    ],
    negationGuards: ["em heat", "emergency heat", "aux heat"],
    requiredQualifiers: [
      "freezing",
      "below freezing",
      "pipes freeze",
      "frozen pipes",
      "newborn",
      "elderly",
      "baby",
    ],
    action: "ESCALATE",
    cannedResponse:
      "No heat in freezing weather is an emergency, especially with vulnerable family members at home — please keep everyone warm with blankets and layers and use safe backup heat if you have it. I'm flagging this as urgent so our team can prioritize you. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "emergency",
    notes:
      "Per system prompt, 'no heat in freezing weather' is explicitly emergency. Without the freezing/vulnerable qualifier, route to heating-not-heating (high). 'no heat' alone in mild weather is heating-not-heating, not emergency. Never suggest unsafe space-heater/oven workarounds — only 'safe backup heat if you have it.'",
  },
  {
    id: "emergency-no-cooling-extreme-heat-vulnerable",
    category: "emergency",
    title: "No cooling in extreme heat with vulnerable people",
    triggerKeywords: [
      "no ac",
      "no cooling",
      "ac out",
      "heat wave",
      "heat advisory",
      "extreme heat",
      "dangerously hot",
      "elderly",
      "infant",
      "newborn",
      "medical condition",
    ],
    negationGuards: ["em heat", "emergency heat", "aux heat"],
    requiredQualifiers: [
      "heat wave",
      "heat advisory",
      "extreme heat",
      "dangerously hot",
      "105",
      "elderly",
      "infant",
      "newborn",
      "medical condition",
    ],
    action: "ESCALATE",
    cannedResponse:
      "No cooling in extreme heat can be a health risk for vulnerable people — please move to the coolest room, hydrate, and use fans or a cooling center if you can. I'm flagging this as urgent so our team can prioritize you. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "emergency",
    notes:
      "Mirror of the no-heat case. Plain 'AC not cooling' → cooling-not-cooling (high). The heat-wave/vulnerable qualifier is the discriminator.",
  },

  // ─── Category 2 — COOLING ISSUES ───────────────────────────────────────────
  {
    id: "cooling-not-cooling",
    category: "cooling",
    title: "AC running but not cooling / blowing warm air",
    triggerKeywords: [
      "not cooling",
      "blows warm air",
      "warm air",
      "not cold",
      "wont cool",
      "still hot",
      "lukewarm air",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "I'm sorry your AC isn't keeping up — that's frustrating in this weather. I can get a technician out to look at it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "high",
    notes:
      "If they mention extreme heat + vulnerable people → re-route to emergency-no-cooling-extreme-heat-vulnerable. 'blowing cold air' from a HEATING system is the opposite problem → heating-blowing-cold.",
  },
  {
    id: "cooling-wont-turn-on",
    category: "cooling",
    title: "AC won't turn on at all",
    triggerKeywords: [
      "ac wont turn on",
      "wont start",
      "not starting",
      "completely dead",
      "nothing happens",
      "wont kick on",
      "no power",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Sorry your AC won't start — let's get a technician out to diagnose it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "high",
    notes:
      "Overlaps with thermostat-dead; if the customer attributes it to a blank/dead thermostat, route to thermostat-blank instead.",
  },
  {
    id: "cooling-water-leak",
    category: "cooling",
    title: "AC leaking / dripping water indoors",
    triggerKeywords: [
      "ac leaking water",
      "leaking water",
      "dripping water",
      "water under",
      "drip pan",
      "puddle",
      "condensate",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A leaking AC should be looked at before it causes water damage. If it's safe, place a towel or bucket under the drip and I'll get a technician scheduled. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "water_leak",
    urgencyHint: "high",
    notes:
      "Volume is the discriminator vs emergency-flooding. Large volume / 'pouring' / 'flooding' → emergency-flooding. 'no hot water' is heating, not a leak. No DIY beyond 'catch the drip.'",
  },
  {
    id: "cooling-frozen-coil-ice",
    category: "cooling",
    title: "Ice / frozen coil on AC unit",
    triggerKeywords: [
      "ice on",
      "frozen coil",
      "froze up",
      "ice buildup",
      "frost on",
      "frozen line",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Ice on the unit usually means it needs attention before it's damaged — it's best to turn the cooling off and let it thaw while we get a technician out. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "medium",
    notes:
      "'Turn it off to let it thaw' is operational guidance, not a repair instruction — acceptable. Don't tell them to add refrigerant or open the unit. 'frozen pipes' in a heating context → emergency-no-heat-freezing.",
  },
  {
    id: "cooling-short-cycling",
    category: "cooling",
    title: "AC short cycling (turns on/off repeatedly)",
    triggerKeywords: [
      "turning on and off",
      "on and off",
      "short cycle",
      "short cycling",
      "cycles constantly",
      "keeps shutting off",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Short cycling like that can stress the system, so it's worth having checked. I can arrange a technician visit — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "medium",
    notes:
      "Same phrasing as heating short-cycling; disambiguate on cooling/AC vs furnace/heat keywords. If neither is clear → FALLBACK_LLM.",
  },
  {
    id: "cooling-noises",
    category: "cooling",
    title: "AC making unusual noises",
    triggerKeywords: [
      "grinding",
      "buzzing",
      "rattling",
      "banging",
      "screeching",
      "clicking",
      "loud noise",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Unusual noises are worth checking before they turn into a bigger problem. I can get a technician out to take a look — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "strange_noises",
    urgencyHint: "medium",
    notes:
      "Maps to strange_noises (not cooling_not_working). Disambiguate on ac/cooling/outdoor unit/compressor context; noise from a furnace → heating-noises. Loud banging + 'stop using it' tone could be escalated; otherwise medium.",
  },
  {
    id: "cooling-outdoor-unit-not-running",
    category: "cooling",
    title: "Outdoor condenser/fan not running",
    triggerKeywords: [
      "outdoor unit",
      "outside fan",
      "condenser",
      "fan not spinning",
      "fan not turning",
      "unit outside not running",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "If the outdoor unit isn't running, the system can't cool properly and should be inspected. I can schedule a technician — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "high",
    notes:
      "Distinct from indoor airflow issues (weak airflow at vents → airquality-weak-airflow). Don't advise poking the fan.",
  },
  {
    id: "cooling-refrigerant-concern",
    category: "cooling",
    title: 'Low refrigerant / "needs a recharge"',
    triggerKeywords: ["freon", "refrigerant", "recharge", "low on coolant"],
    action: "COLLECT_INFO",
    cannedResponse:
      "Refrigerant levels need to be checked and handled by a licensed technician. I can set up a visit to diagnose it properly — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "medium",
    notes:
      "Customer self-diagnosis may be wrong — frozen coil/airflow can mimic this. Never quote refrigerant pricing or confirm a recharge is needed (that's a tech diagnosis). Refrigerant handling is regulated — emphasize licensed tech.",
  },

  // ─── Category 3 — HEATING ISSUES ───────────────────────────────────────────
  {
    id: "heating-not-heating",
    category: "heating",
    title: "Furnace running but house not warming",
    triggerKeywords: [
      "not getting warm",
      "still cold",
      "not heating",
      "no real heat",
      "wont warm up",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Sorry you're not getting the heat you need — let's get a technician out to diagnose it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "Escalate if freezing weather / vulnerable occupants are mentioned. 'blowing cold air' → heating-blowing-cold; freezing-temp qualifier → emergency-no-heat-freezing.",
  },
  {
    id: "heating-wont-ignite",
    category: "heating",
    title: "Furnace won't ignite / won't start",
    triggerKeywords: [
      "wont ignite",
      "wont start",
      "wont light",
      "no ignition",
      "wont fire up",
      "clicks but",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A furnace that won't ignite needs a technician's eye — I can get a visit scheduled. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "If any gas smell is mentioned, immediately escalate (emergency-gas-smell) instead. Pilot-specific → heating-pilot-out. Never give relight instructions.",
  },
  {
    id: "heating-pilot-out",
    category: "heating",
    title: "Pilot light out",
    triggerKeywords: [
      "pilot light",
      "pilot out",
      "pilot went out",
      "relight pilot",
      "pilot keeps going out",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Relighting a pilot can involve gas, so it's safest to let a technician handle it — and if you ever smell gas, leave and call your gas company. I can schedule a visit; what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "Per 'no DIY repair instructions,' do NOT give relight steps. Pair with gas-safety reminder. 'water heater pilot' overlaps with heating-no-hot-water; gas smell → emergency. If it's a water heater pilot, heating_not_working is acceptable (no dedicated water-heater enum).",
  },
  {
    id: "heating-blowing-cold",
    category: "heating",
    title: "Furnace blowing cold air",
    triggerKeywords: ["blowing cold air", "blows cold", "cold air"],
    action: "COLLECT_INFO",
    cannedResponse:
      "Cold air when you're calling for heat usually means something needs attention — I can get a technician out. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "Critical disambiguation from cooling (warm air = AC; cold air = furnace). Must key on heat/furnace context, NOT AC. If 'AC' appears, do not match this.",
  },
  {
    id: "heating-short-cycling",
    category: "heating",
    title: "Furnace short cycling",
    triggerKeywords: [
      "turning on and off",
      "short cycle",
      "cycles on and off",
      "kicks on then shuts off",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Short cycling can wear out the system, so it's good to have it checked. I can arrange a technician visit — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "medium",
    notes:
      "Same phrasing as cooling-short-cycling — disambiguate on heat vs AC. If neither heat nor AC context is present → FALLBACK_LLM.",
  },
  {
    id: "heating-strange-smell-startup",
    category: "heating",
    title: "Smell when heat first turns on (seasonal/dust)",
    triggerKeywords: [
      "smell when",
      "dusty smell",
      "goes away",
      "first turns on",
      "this season",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes:
      "Deliberately FALLBACK_LLM. The line between 'harmless first-of-season dust burn-off' and 'dangerous burning smell' is too risky to canned-answer. HIGH overlap with emergency-electrical-burning-smell — 'burning plastic'/'smoke'/'persistent' must escalate, NOT match here. Let the LLM probe (persistent? plastic? smoke?) before deciding.",
  },
  {
    id: "heating-no-hot-water",
    category: "heating",
    title: "Water heater — no hot water",
    triggerKeywords: [
      "no hot water",
      "water heater",
      "hot water",
      "cold water only",
      "water heater not heating",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "No hot water is a real hassle — I can get a technician out to look at your water heater. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "No dedicated water-heater enum; heating_not_working is the closest. 'water leak from water heater' → could be water_leak/emergency-flooding; 'pilot out on water heater' → heating-pilot-out. If the company doesn't service water heaters, candidate for FALLBACK_LLM or a business-scope answer — confirm scope with engineering.",
  },
  {
    id: "heating-heat-pump-issue",
    category: "heating",
    title: "Heat pump not heating / stuck in defrost / auxiliary heat",
    triggerKeywords: [
      "heat pump",
      "defrost mode",
      "aux heat",
      "auxiliary heat",
      "emergency heat",
      "em heat",
      "heat pump iced",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Heat pumps can act up in a few different ways — let's get a technician to diagnose it properly. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "Important negation guard: 'emergency heat' / 'em heat' is an HVAC mode, NOT a safety emergency. The emergency router must whitelist this phrase so it doesn't trigger ESCALATE. 'iced over' overlaps with cooling-frozen-coil-ice.",
  },
  {
    id: "heating-noises",
    category: "heating",
    title: "Furnace making unusual noises",
    triggerKeywords: [
      "banging",
      "rumbling",
      "squealing",
      "rattling",
      "clanking",
      "loud noise",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Unusual furnace noises are worth checking before they get worse. I can get a technician out — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "strange_noises",
    urgencyHint: "medium",
    notes:
      "Maps to strange_noises. Disambiguate on furnace/heater/heat context. A loud 'boom/bang' on startup with gas smell → emergency-gas-smell.",
  },

  // ─── Category 4 — AIR QUALITY / AIRFLOW ────────────────────────────────────
  {
    id: "airquality-musty-smell",
    category: "air_quality",
    title: "Musty / moldy smell from vents",
    triggerKeywords: [
      "musty smell",
      "moldy",
      "mildew",
      "stale smell",
      "smell from vents",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A musty smell from the vents is something we can check out — it's often related to moisture or the ducts. I can schedule a technician; what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes:
      "Only match musty/moldy/mildew — burning/gas/electrical smells must route to emergency intents.",
  },
  {
    id: "airquality-weak-airflow",
    category: "air_quality",
    title: "Weak / low airflow from vents",
    triggerKeywords: [
      "weak airflow",
      "low airflow",
      "barely any air",
      "no air from vents",
      "weak air",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Weak airflow can have a few causes, sometimes as simple as a clogged filter. I can get a technician to take a look — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "medium",
    notes:
      "Mentioning 'clogged filter' is informational, not a repair instruction. 'outdoor fan not spinning' → cooling-outdoor-unit-not-running. Overlaps with maintenance-filter.",
  },
  {
    id: "airquality-excessive-dust",
    category: "air_quality",
    title: "Excessive dust in home",
    triggerKeywords: [
      "excessive dust",
      "too much dust",
      "dust from vents",
      "dust everywhere",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Excess dust can sometimes point to filtration or duct issues — a technician can assess it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes: "Could also be a duct-cleaning lead (maintenance-duct-cleaning).",
  },
  {
    id: "airquality-humidity",
    category: "air_quality",
    title: "Humidity problems (too humid / too dry)",
    triggerKeywords: [
      "too humid",
      "humidity",
      "too dry",
      "sticky air",
      "humidifier",
      "dehumidifier",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Indoor humidity issues are something we can help with — a technician can evaluate your system and options. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes:
      "humidity + water = could be a leak, but usually distinct. Don't recommend a specific product or quote a humidifier install price.",
  },
  {
    id: "airquality-uneven-temps",
    category: "air_quality",
    title: "Uneven temperatures room to room",
    triggerKeywords: [
      "some rooms",
      "uneven",
      "hot and cold",
      "upstairs warmer",
      "one room",
      "wont cool that room",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Uneven temperatures usually come down to airflow, ductwork, or balancing — a technician can pinpoint it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes:
      "Could be a zoning/airflow/duct issue; not an emergency. Overlaps with airflow/duct intents; air_quality is the closest enum.",
  },

  // ─── Category 5 — THERMOSTAT ───────────────────────────────────────────────
  {
    id: "thermostat-blank",
    category: "thermostat",
    title: "Thermostat blank / dead screen",
    triggerKeywords: [
      "thermostat blank",
      "blank screen",
      "dead screen",
      "no display",
      "thermostat off",
      "screen blank",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A blank thermostat can stop the whole system from running — sometimes it's batteries, but it's worth a proper check. I can get a technician out; what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes:
      "'Sometimes it's batteries' is a gentle hint, not a repair walk-through. A blank thermostat can cause cooling-wont-turn-on/no heat — prefer this intent when the screen is the stated symptom. If combined with no-heat-in-freezing, escalate.",
  },
  {
    id: "thermostat-unresponsive",
    category: "thermostat",
    title: "Thermostat unresponsive / buttons not working",
    triggerKeywords: [
      "thermostat not responding",
      "unresponsive",
      "buttons do nothing",
      "wont change temp",
      "frozen thermostat",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "If the thermostat isn't responding, the system can't be controlled properly — let's have a technician check it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes:
      "'frozen' here means UI-frozen, not iced — disambiguate on thermostat keyword.",
  },
  {
    id: "thermostat-wrong-reading",
    category: "thermostat",
    title: "Thermostat showing wrong temperature",
    triggerKeywords: [
      "wrong temperature",
      "wrong temp",
      "reading is off",
      "inaccurate",
      "shows wrong",
      "temp is off",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A thermostat reading that's off can throw off your whole system — a technician can check the sensor and placement. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes: "Could be a sensor/placement issue; low risk.",
  },
  {
    id: "thermostat-wont-hold-schedule",
    category: "thermostat",
    title: "Thermostat won't hold settings / schedule",
    triggerKeywords: [
      "wont hold",
      "keeps resetting",
      "schedule doesnt stick",
      "changes on its own",
      "wont keep schedule",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "If your thermostat won't hold its schedule, a technician can check the settings and wiring. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "low",
    notes:
      "Smart-thermostat behavior/learning could explain it → see thermostat-smart-setup.",
  },
  {
    id: "thermostat-smart-setup",
    category: "thermostat",
    title: "Smart thermostat installation / setup help",
    triggerKeywords: [
      "smart thermostat",
      "nest",
      "ecobee",
      "honeywell home",
      "install thermostat",
      "setup thermostat",
      "upgrade thermostat",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "We can help with smart thermostat installation and setup — a technician will make sure it's wired and configured correctly for your system. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "installation",
    urgencyHint: "low",
    notes:
      "Maps to installation (not thermostat_issue) since it's a new install. Never give wiring/DIY instructions even if they ask 'how do I wire it.'",
  },

  // ─── Category 6 — MAINTENANCE / TUNE-UP ────────────────────────────────────
  {
    id: "maintenance-tuneup",
    category: "maintenance",
    title: "Annual tune-up / maintenance check",
    triggerKeywords: [
      "tune-up",
      "tune up",
      "maintenance check",
      "annual service",
      "yearly service",
      "service my system",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Happy to set up a tune-up to keep your system running smoothly. I just need a couple of details — what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "maintenance",
    urgencyHint: "low",
    notes:
      "'service' alone overlaps with scheduling/business; pair with maintenance/tune-up/annual.",
  },
  {
    id: "maintenance-filter",
    category: "maintenance",
    title: "Filter replacement / what size filter",
    triggerKeywords: [
      "air filter",
      "filter replacement",
      "change filter",
      "filter size",
      "what size filter",
      "dirty filter",
    ],
    action: "ANSWER",
    cannedResponse:
      "Most home filters should be checked monthly and changed every 1-3 months. The right size is printed on the edge of your current filter (like 16x25x1) — if you'd like, I can schedule a technician to handle it during a visit.",
    infoNeeded: [],
    issueTypeMapping: "maintenance",
    urgencyHint: "low",
    notes:
      "Borderline DIY, but 'check the label for the size + change every 1-3 months' is general guidance, not a repair instruction — acceptable. 'weak airflow' can stem from filter → airquality-weak-airflow. If they then want a tech, transition to COLLECT_INFO (address).",
  },
  {
    id: "maintenance-duct-cleaning",
    category: "maintenance",
    title: "Duct cleaning",
    triggerKeywords: [
      "duct cleaning",
      "clean my ducts",
      "air ducts cleaned",
      "ductwork cleaning",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "We can arrange a duct cleaning for you. To get started, what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "maintenance",
    urgencyHint: "low",
    notes:
      "'dusty house' → airquality-excessive-dust. Don't quote duct-cleaning pricing.",
  },
  {
    id: "maintenance-seasonal-prep",
    category: "maintenance",
    title: "Seasonal prep (AC for summer / furnace for winter)",
    triggerKeywords: [
      "ready for summer",
      "before winter",
      "seasonal",
      "prep my",
      "winterize",
      "get ready for",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Seasonal prep is a great way to avoid surprises — I can schedule that for you. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "maintenance",
    urgencyHint: "low",
    notes:
      "Effectively a tune-up variant; can share canned logic with maintenance-tuneup.",
  },

  // ─── Category 7 — SCHEDULING / BOOKING / DISPATCH ──────────────────────────
  {
    id: "scheduling-book-visit",
    category: "scheduling",
    title: "Book a service visit (issue not yet specified)",
    triggerKeywords: [
      "book",
      "schedule",
      "appointment",
      "set up a visit",
      "come out",
      "send a technician",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "I'd be glad to set that up. First, can you tell me what HVAC issue you're experiencing so I can route the right technician?",
    infoNeeded: ["issueType", "urgency", "address"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "This is the 'entry' scheduling intent. Once they describe the issue, hand off to the matching issue intent's slot collection. Very generic — if an issue is also described, classify the issue first. Don't promise a time.",
  },
  {
    id: "scheduling-earliest-availability",
    category: "scheduling",
    title: "Earliest availability / how soon",
    triggerKeywords: [
      "earliest",
      "how soon",
      "soonest",
      "availability",
      "anything today",
      "when can you come",
    ],
    action: "ANSWER",
    cannedResponse:
      "Once your request is submitted, our team reviews it right away and reaches out to confirm the soonest available time — we aim to follow up within about 2 hours. If you describe your issue, I can get the request started.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "The 'within 2 hours follow-up' wording matches GUIDE.md's success-page promise. Time-pressure may signal an emergency — check emergency triggers first. Never promise an arrival time.",
  },
  {
    id: "scheduling-after-hours",
    category: "scheduling",
    title: "After-hours / weekend / 24-7 availability",
    triggerKeywords: [
      "after hours",
      "weekend",
      "at night",
      "24/7",
      "overnight",
      "holiday",
    ],
    // "extra CHARGE / FEE for after hours" is a pricing question
    // (logistics-after-hours-fee), not an availability question.
    negationGuards: [
      "charge",
      "fee",
      "cost more",
      "extra for",
      "surcharge",
      "overtime",
    ],
    action: "ANSWER",
    cannedResponse:
      "We offer support around the clock, and after-hours or weekend visits depend on availability — submit your request and our team will confirm the soonest time. If it's an emergency like a gas smell or no heat in freezing weather, please tell me right away.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "GUIDE.md references '24/7 availability messaging' on the landing page. Paired with an emergency → escalate first. Don't over-promise specific weekend slots.",
  },
  {
    id: "scheduling-how-long-until-tech",
    category: "scheduling",
    title: "How long until a technician arrives",
    triggerKeywords: [
      "how long",
      "wait time",
      "eta",
      "how long until",
      "time to arrive",
    ],
    // "how long does a furnace/system LAST" is a lifespan question
    // (replacement-lifespan), not a wait-time question.
    negationGuards: [
      "how long does",
      "how long should",
      "how long will my",
      "lifespan",
      "last",
      "to install",
      "to replace",
    ],
    action: "ANSWER",
    cannedResponse:
      "After you submit a request, our team typically follows up within about 2 hours to confirm timing, and they'll give you an arrival window then. I can't promise an exact arrival time from here, but I can get your request started.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Explicitly disclaims exact ETAs per the no-scheduling-promise rule. Similar to scheduling-earliest-availability.",
  },
  {
    id: "scheduling-reschedule",
    category: "scheduling",
    title: "Reschedule an existing appointment",
    triggerKeywords: [
      "reschedule",
      "move my appointment",
      "change my appointment",
      "different day",
      "push back",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "OVERRIDE #1: FALLBACK_LLM (reference-lookup the deterministic layer can't do; COLLECT_INFO would dead-end). Original canned text: 'I can help get that updated. Do you have your reference number (it looks like REF-XXXXX), and what new day or time works better for you?' Overlaps with account-change-appointment; both are existing-request territory needing a reference lookup.",
  },
  {
    id: "scheduling-cancel",
    category: "scheduling",
    title: "Cancel an appointment / request",
    triggerKeywords: [
      "cancel",
      "cancel my appointment",
      "dont need",
      "cancel the visit",
      "cancel request",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "OVERRIDE #1: FALLBACK_LLM (reference-lookup the deterministic layer can't do). Original canned text: 'No problem — I can help with that. What's your reference number (like REF-XXXXX) so I can pull up the right request?' If 'cancel' appears mid-intake (no booked job exists), treat as conversational reset, not a cancellation.",
  },

  // ─── Category 8 — BUSINESS INFO / FAQ ──────────────────────────────────────
  {
    id: "faq-service-area",
    category: "faq",
    title: 'Service area / "do you serve <city>"',
    triggerKeywords: [
      "service area",
      "do you serve",
      "cover my area",
      "in my area",
      "come out to",
      "service my zip",
    ],
    action: "ANSWER",
    cannedResponse:
      "We serve a wide local area. If you share your address or zip code, I can pass it along so our team can confirm coverage — and we can start a request if you have an HVAC issue.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "The catalog can't know the real coverage map. Keep the answer non-committal and route to confirmation. If the org has a hard service-area list, this could be data-driven later.",
  },
  {
    id: "faq-business-hours",
    category: "faq",
    title: "Business hours",
    triggerKeywords: [
      "hours",
      "open",
      "when are you open",
      "what time",
      "closing time",
    ],
    // "what time will the TECH arrive" is an arrival-window question, not a
    // business-hours question.
    negationGuards: ["tech arrive", "technician arrive", "the tech come"],
    action: "ANSWER",
    cannedResponse:
      "Our team is available to take requests around the clock, and a representative follows up to confirm scheduling. If you have an HVAC issue, I can start a request anytime.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Keep generic if exact hours aren't configured. 'are you open weekends' → scheduling-after-hours. 24/7 intake messaging aligns with GUIDE.md.",
  },
  {
    id: "faq-phone-number",
    category: "faq",
    title: "Phone number / how to reach a person",
    triggerKeywords: [
      "phone number",
      "your number",
      "call you",
      "contact number",
      "how do i call",
    ],
    action: "ANSWER",
    cannedResponse:
      "You can reach our team using the 'Talk to a Human' option in the chat, which shows our phone number. Would you like me to help start a service request in the meantime?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Close to account-speak-to-human — that one is about escalation, this is just the number. Points to the existing 'Talk to a Human' escalation path (GUIDE.md) rather than hardcoding a number the catalog may not have.",
  },
  {
    id: "faq-licensed-insured",
    category: "faq",
    title: "Are you licensed / insured / certified",
    triggerKeywords: [
      "licensed",
      "insured",
      "certified",
      "bonded",
      "credentials",
    ],
    action: "ANSWER",
    cannedResponse:
      "Great question — our team can confirm the licensing and insurance details for your area when they follow up. Is there an HVAC issue I can help you with today?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Non-committal by design: per-org licensing/insurance data does not exist yet, so we must NOT assert 'licensed and insured' as fact (legal liability across tenants). Make this org-data-driven before claiming specifics.",
  },
  {
    id: "faq-install-vs-repair",
    category: "faq",
    title: "Do you do installations vs repairs",
    triggerKeywords: [
      "installation",
      "install",
      "replace system",
      "new unit",
      "new system",
      "repair only",
    ],
    // More specific install/replacement intents take precedence: cost/sizing
    // (pricing-*, replacement-*), rebates (efficiency-*), and specific
    // equipment (mini-split, boiler, IAQ products).
    negationGuards: [
      "how much",
      "cost",
      "price",
      "rebate",
      "rebates",
      "incentive",
      "incentives",
      "tax credit",
      "mini split",
      "minisplit",
      "ductless",
      "boiler",
      "uv light",
      "air purifier",
      "humidifier",
      "what size",
      "how long does",
      "repair or replace",
      "second opinion",
    ],
    action: "ANSWER",
    cannedResponse:
      "We handle both repairs and new installations. If you're considering an install or replacement, I can start a request and a technician will assess your needs. What's the service address?",
    infoNeeded: [],
    issueTypeMapping: "installation",
    urgencyHint: "low",
    notes:
      "Crosses into the installation issueType when they want to proceed. A concrete install request → installation issueType + COLLECT_INFO. Don't quote install pricing.",
  },
  {
    id: "faq-brands-serviced",
    category: "faq",
    title: "Brands serviced",
    triggerKeywords: [
      "brands",
      "service carrier",
      "trane",
      "lennox",
      "goodman",
      "rheem",
      "mitsubishi",
    ],
    // Mini-split / boiler / IAQ-product "do you service/install X" route to the
    // dedicated equipment-* intents.
    negationGuards: ["mini split", "minisplit", "ductless", "boiler", "uv light", "air purifier"],
    action: "ANSWER",
    cannedResponse:
      "Our technicians service all major HVAC brands and most makes and models. Do you have an issue with your system I can help start a request for?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "A brand name alone may appear within an issue description — only treat as this FAQ if they ask whether you service it. 'All major brands' is a safe generic; confirm org reality.",
  },
  {
    id: "faq-payment-methods",
    category: "faq",
    title: "Payment methods",
    triggerKeywords: [
      "payment",
      "pay with",
      "credit card",
      "take cards",
      "accept check",
      "apple pay",
    ],
    action: "ANSWER",
    cannedResponse:
      "Our team can walk you through accepted payment options when they confirm your service. For now, I can help you start a request — what HVAC issue are you having?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "'financing' → faq-financing; 'how much' → faq-pricing. Keep generic unless payment methods are configured.",
  },
  {
    id: "faq-financing",
    category: "faq",
    title: "Financing options",
    triggerKeywords: [
      "financing",
      "finance",
      "payment plan",
      "monthly payments",
    ],
    action: "ANSWER",
    cannedResponse:
      "Financing options may be available, especially for new installations — our team can review the details with you. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Financing usually pairs with installation interest. Don't state specific rates/terms.",
  },
  {
    id: "faq-warranty",
    category: "faq",
    title: "Warranty / guarantee",
    triggerKeywords: ["warranty", "guarantee", "guaranteed", "under warranty"],
    // Personalized coverage/registration questions route to the dedicated
    // warranty.* intents (which need a live lookup), and workmanship/"guarantee
    // your work" routes to trust-guarantee.
    negationGuards: [
      "covered under warranty",
      "is my warranty",
      "is my system under warranty",
      "still under warranty",
      "register my warranty",
      "warranty registration",
      "guarantee your work",
      "warranty on the labor",
      "warranty your repairs",
    ],
    action: "ANSWER",
    cannedResponse:
      "Our work is backed by a satisfaction guarantee, and a technician can confirm any manufacturer warranty on your specific equipment. Can I help start a service request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "'is MY unit under warranty' is account/equipment-specific (CRM territory), not a generic policy answer → may warrant FALLBACK_LLM or human.",
  },
  {
    id: "faq-pricing",
    category: "faq",
    title: 'Pricing / cost / "how much"',
    triggerKeywords: [
      "how much",
      "price",
      "cost",
      "service call fee",
      "estimate cost",
      "ballpark",
      "quote",
    ],
    action: "ANSWER",
    cannedResponse:
      "Pricing depends on what your system needs, so our technician provides a clear quote after assessing it in person — I'm not able to give prices from here. If you describe your issue, I can get a request started so they can follow up.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Strict no-pricing rule (system prompt). The canned response must explain a technician provides the quote. Disambiguate from scheduling 'how soon' phrasing; guard against 'how' + time words.",
  },

  // ─── Category 9 — EXISTING REQUEST / ACCOUNT ───────────────────────────────
  {
    id: "account-check-status",
    category: "account",
    title: "Check status of an existing request",
    triggerKeywords: [
      "status of my request",
      "any update",
      "still coming",
      "did my request",
      "check my request",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "OVERRIDE #1: FALLBACK_LLM (reference number isn't a standard slot and the deterministic layer can't look up live status; COLLECT_INFO would dead-end). Original canned text: 'I can help check on that. What's your reference number (it looks like REF-XXXXX)?' After collecting the ref this likely becomes a human handoff or FALLBACK_LLM.",
  },
  {
    id: "account-provide-reference",
    category: "account",
    title: "Customer provides a reference number",
    triggerKeywords: [
      "ref-",
      "reference number is",
      "my ref is",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "OVERRIDE #1: FALLBACK_LLM. Detect the reference pattern deterministically (regex ref-?\\s*[a-z0-9]{4,}), but acting on it (lookup, status, changes) needs backend data → defer to LLM/human flow. The router's job here is just to recognize it and route, not answer. A bare number could be a phone/zip — require the 'ref' token or 'REF-' prefix.",
  },
  {
    id: "account-change-appointment",
    category: "account",
    title: "Change details of an existing appointment",
    triggerKeywords: [
      "change my appointment",
      "update my appointment",
      "change the address on",
      "update my request",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "OVERRIDE #1: FALLBACK_LLM (reference-lookup the deterministic layer can't do; COLLECT_INFO would dead-end). Original canned text: 'I can help update your request. What's your reference number (like REF-XXXXX), and what would you like to change?' Overlaps with scheduling-reschedule; both need a reference lookup.",
  },
  {
    id: "account-update-contact",
    category: "account",
    title: "Update contact info (mid-intake)",
    triggerKeywords: [
      "my phone is",
      "my email is",
      "my name is",
      "use this address",
      "update my",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Got it, I've noted that. Is there anything else you'd like to add or change before we continue?",
    infoNeeded: ["name", "phone", "email", "address"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "During active intake this is normal slot-filling — the router should update the matching slot (name/phone/email/address) and continue, NOT treat it as a topic change. Validate email/phone format at the boundary.",
  },
  {
    id: "account-speak-to-human",
    category: "account",
    title: "Request a human agent",
    triggerKeywords: [
      "speak to a human",
      "talk to a person",
      "real person",
      "representative",
      "agent",
      "human",
      "someone real",
    ],
    action: "ESCALATE",
    cannedResponse:
      "Of course — you can reach our team directly using the 'Talk to a Human' button in the chat header, which connects you with a real person. I'm flagging this so someone follows up with you.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Maps to the existing escalation path (GUIDE.md 'Talk to a Human' → marks session escalated). Per system prompt, also trigger this on detected frustration or >15 turns. 'are you a bot?' is meta-are-you-bot, not necessarily a handoff request.",
  },

  // ─── Category 11 — PRICING / ESTIMATES ─────────────────────────────────────
  // Cost intents customers type constantly. We never quote specific numbers
  // (per-company, and a real price needs a diagnosis/assessment) — we set
  // expectations and route to a request. ANSWER = low-harm informational.
  {
    id: "pricing-free-estimate",
    category: "pricing",
    title: "Free estimates / quotes",
    triggerKeywords: [
      "free estimate",
      "free quote",
      "free consultation",
      "do you charge for a quote",
      "charge to come out",
      "cost to come give a price",
    ],
    negationGuards: ["diagnostic", "service call", "repair"],
    action: "ANSWER",
    cannedResponse:
      "Estimates for a new system or replacement are typically free, while repair visits usually carry a diagnostic fee. I can have our team confirm the details for your situation — would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Industry split: replacement/install estimates free; repair visits carry a diagnostic fee (see pricing-diagnostic-fee). Don't promise it's free for a repair. Per-company policy — keep neutral.",
  },
  {
    id: "pricing-diagnostic-fee",
    category: "pricing",
    title: "Service call / diagnostic fee",
    triggerKeywords: [
      "diagnostic fee",
      "service call fee",
      "service call charge",
      "trip charge",
      "trip fee",
      "charge just to show up",
      "cost to diagnose",
      "how much to come out",
    ],
    action: "ANSWER",
    cannedResponse:
      "Repair visits usually include a diagnostic (service call) fee to cover the technician coming out and finding the problem. The exact amount and whether it's credited toward an approved repair varies — I can have our team confirm it for you. Want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Don't state a specific dollar amount (per-company). Mention the fee is often credited to an approved repair — see pricing-fee-waived.",
  },
  {
    id: "pricing-fee-waived",
    category: "pricing",
    title: "Diagnostic fee waived/applied to repair",
    triggerKeywords: [
      "fee waived",
      "fee applied",
      "fee credited",
      "applied to the repair",
      "count toward the repair",
      "still pay the fee if you fix it",
      "waived with repair",
    ],
    action: "ANSWER",
    cannedResponse:
      "In many cases the diagnostic fee is credited toward the cost of an approved repair, so you're not paying twice. Our team can confirm how it works for your visit — would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Common practice but per-company; keep it conditional ('in many cases').",
  },
  {
    id: "pricing-cost-to-replace",
    category: "pricing",
    title: "Cost to replace a whole system",
    triggerKeywords: [
      "cost to replace",
      "how much for a new system",
      "price for a new furnace",
      "price for a new ac",
      "new unit cost",
      "replace my whole system cost",
      "ballpark for a new",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: a real replacement number needs sizing/home assessment; the LLM can explain the ranges/factors and steer toward an estimate booking without committing to a price. Don't hardcode a number.",
  },
  {
    id: "pricing-discounts",
    category: "pricing",
    title: "Discounts / specials / coupons",
    triggerKeywords: [
      "discount",
      "coupon",
      "current specials",
      "any promotions",
      "senior discount",
      "military discount",
      "veteran discount",
      "first responder discount",
    ],
    action: "ANSWER",
    cannedResponse:
      "We may have seasonal promotions and discounts (for example for seniors, military, or first responders) — our team can tell you what's currently available. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Promotions are time-sensitive and per-company; never name a specific percentage or promo. Keep conditional.",
  },
  {
    id: "pricing-second-opinion",
    category: "pricing",
    title: "Second opinion on another quote",
    triggerKeywords: [
      "second opinion",
      "another company said",
      "another contractor quoted",
      "verify another quote",
      "double check this quote",
    ],
    action: "ANSWER",
    cannedResponse:
      "We're happy to take a look and give you an honest second opinion on another company's diagnosis or quote. I can start a request so our team can follow up — would you like that?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Many companies offer free second opinions on a written competitor diagnosis. Keep it welcoming, no price promise.",
  },

  // ─── Category 12 — MEMBERSHIP / MAINTENANCE PLANS ──────────────────────────
  {
    id: "membership-explainer",
    category: "membership",
    title: "Maintenance plan / membership — what is it",
    triggerKeywords: [
      "maintenance plan",
      "service plan",
      "membership",
      "service agreement",
      "comfort club",
      "what do members get",
      "whats included in the plan",
    ],
    negationGuards: ["cancel my membership", "am i a member"],
    action: "ANSWER",
    cannedResponse:
      "A maintenance plan typically includes scheduled tune-ups, priority scheduling, and discounts on repairs to keep your system running efficiently and catch problems early. Our team can walk you through what's included and the cost — would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Per-company benefits/pricing — describe typical inclusions generically, don't quote a price. 'Am I a member?' is membership-account (FALLBACK_LLM).",
  },
  {
    id: "membership-worth-it",
    category: "membership",
    title: "Is a maintenance plan worth it",
    triggerKeywords: [
      "is the plan worth it",
      "worth getting the plan",
      "benefit of the membership",
      "will the plan save me money",
      "why join the plan",
    ],
    action: "ANSWER",
    cannedResponse:
      "Regular maintenance helps your system run more efficiently, last longer, and avoid surprise breakdowns — and plan members often get repair discounts and priority service. Our team can go over the specifics so you can decide. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Value framing only; no savings guarantee with a hard number.",
  },
  {
    id: "membership-account",
    category: "membership",
    title: "Membership status / enrollment / next visit",
    triggerKeywords: [
      "am i a member",
      "sign up for the plan",
      "join the membership",
      "enroll in the plan",
      "my next tune up",
      "when is my included service",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: enrollment = lead capture; 'am I a member / next visit' needs a live account lookup. Deterministic layer can't resolve either.",
  },

  // ─── Category 13 — EFFICIENCY / REBATES / INCENTIVES ───────────────────────
  // Time-sensitive content. NOTE: the federal Section 25C tax credit expired
  // 12/31/2025 — do NOT claim an active federal tax credit. Steer to current
  // utility/state rebates and a human for specifics.
  {
    id: "efficiency-rebates",
    category: "efficiency",
    title: "Rebates / incentives for a new system",
    triggerKeywords: [
      "rebate",
      "rebates",
      "incentive",
      "incentives",
      "utility rebate",
      "energy rebate",
      "heat pump rebate",
    ],
    action: "ANSWER",
    cannedResponse:
      "There are often utility or state rebates available for high-efficiency equipment like heat pumps, and the amounts change over time. Our team can point you to what currently applies in your area — would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Time-sensitive. Don't name specific dollar amounts or claim the expired federal 25C credit. Reviewed: 2026-06. Utility/state rebates and HEEHRA may apply; defer specifics to the team.",
  },
  {
    id: "efficiency-tax-credit",
    category: "efficiency",
    title: "Tax credit for a new system",
    triggerKeywords: [
      "tax credit",
      "tax write off",
      "federal tax credit",
      "write off a new furnace",
      "write off a new ac",
    ],
    action: "ANSWER",
    cannedResponse:
      "Tax credits and incentives for HVAC equipment change year to year, so I'd point you to a tax professional for what currently applies. Our team can also tell you about any utility or manufacturer rebates available right now — want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "The federal 25C credit expired 12/31/2025 — do NOT assert an active federal credit. Redirect to a tax professional + current rebates. Reviewed: 2026-06.",
  },
  {
    id: "efficiency-savings",
    category: "efficiency",
    title: "Energy savings / SEER / efficiency questions",
    triggerKeywords: [
      "lower my energy bill",
      "lower my electric bill",
      "save on energy",
      "more efficient system",
      "what seer should i get",
      "high efficiency unit",
      "energy analysis",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: SEER2/AFUE and efficiency-vs-cost tradeoffs are nuanced and home-specific; let the LLM explain and offer an assessment rather than a canned line.",
  },

  // ─── Category 14 — REPLACEMENT / SYSTEM AGE / SIZING ───────────────────────
  {
    id: "replacement-lifespan",
    category: "replacement",
    title: "System lifespan / how long does it last",
    triggerKeywords: [
      "how long does a furnace last",
      "how long does an ac last",
      "lifespan of",
      "how long should my system last",
      "how old is too old",
      "average life of",
    ],
    action: "ANSWER",
    cannedResponse:
      "As a rough guide, furnaces often last about 15–20 years and air conditioners and heat pumps about 10–15 years, depending on use and maintenance. If yours is in that range and giving you trouble, our team can assess whether repair or replacement makes more sense. Want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "General lifespan ranges are stable, safe to state. Bridges to replacement-repair-or-replace.",
  },
  {
    id: "replacement-repair-or-replace",
    category: "replacement",
    title: "Should I repair or replace",
    triggerKeywords: [
      "repair or replace",
      "fix or replace",
      "worth fixing",
      "worth repairing",
      "should i replace",
      "time to replace",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: the repair-vs-replace call depends on age, repair cost, frequency, and efficiency — too situational for a canned answer. LLM can explain factors (e.g. the 50%/$5k rules) and recommend an assessment.",
  },
  {
    id: "replacement-sizing",
    category: "replacement",
    title: "What size system do I need",
    triggerKeywords: [
      "what size ac",
      "what size furnace",
      "how many tons",
      "how many btus",
      "size for my house",
      "bigger unit cool better",
    ],
    action: "ANSWER",
    cannedResponse:
      "The right size isn't just about square footage — a proper sizing (a Manual J load calculation) accounts for your home's insulation, windows, and layout, so a bigger unit isn't automatically better. Our team can do that assessment for you. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Correct the 'bigger is better' myth; point to Manual J + an assessment. No specific tonnage.",
  },
  {
    id: "replacement-consultation",
    category: "replacement",
    title: "New install / replacement consultation",
    triggerKeywords: [
      "quote for a new system",
      "new install quote",
      "replacement consultation",
      "come measure for a new",
      "install a new system",
      "looking to replace my",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: a new-install/replacement consultation is a sales/estimate appointment distinct from a repair intake; let the LLM gather context and route appropriately rather than forcing the repair slot flow.",
  },

  // ─── Category 15 — EQUIPMENT TYPES / IAQ PRODUCTS ──────────────────────────
  {
    id: "equipment-minisplit",
    category: "equipment",
    title: "Ductless mini-split service/install",
    triggerKeywords: [
      "mini split",
      "minisplit",
      "ductless",
      "ductless system",
      "add ac without ducts",
      "no ductwork",
    ],
    action: "ANSWER",
    cannedResponse:
      "Yes — ductless mini-splits are a great option for spaces without ductwork, additions, or zoning specific rooms, and our team can help with installation or service. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Per-company capability assumed yes for a full-service HVAC shop. If it's a problem with an existing mini-split, the LLM/issue flow can take over.",
  },
  {
    id: "equipment-boiler",
    category: "equipment",
    title: "Boiler / radiator / hydronic heat",
    triggerKeywords: [
      "boiler",
      "radiator",
      "radiators",
      "hydronic",
      "hot water heat",
      "baseboard heat",
      "steam heat",
    ],
    negationGuards: ["water heater", "no hot water from my tap"],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: not every HVAC shop services boilers/hydronic; let the LLM confirm scope and gather symptoms rather than asserting capability or forcing a forced-air assumption.",
  },
  {
    id: "equipment-iaq-products",
    category: "equipment",
    title: "IAQ products — UV light, air purifier, humidifier",
    triggerKeywords: [
      "uv light",
      "air purifier",
      "air scrubber",
      "whole home humidifier",
      "whole house humidifier",
      "dehumidifier",
      "better filtration",
      "media filter",
      "air cleaner",
    ],
    action: "ANSWER",
    cannedResponse:
      "We can help improve your indoor air quality with add-ons like UV lights, whole-home air purifiers, humidifiers, and upgraded filtration. Our team can recommend what fits your system — would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Distinct from the air_quality category (which is SYMPTOMS like musty smell/dust). This is the buy/install-a-product intent.",
  },

  // ─── Category 16 — SERVICE LOGISTICS / VISIT EXPECTATIONS ──────────────────
  {
    id: "logistics-arrival-window",
    category: "service_logistics",
    title: "Arrival window / what time will the tech come",
    triggerKeywords: [
      "what time will the tech",
      "arrival window",
      "appointment window",
      "exact time or a window",
      "heads up before arrival",
      "when will the technician arrive",
    ],
    action: "ANSWER",
    cannedResponse:
      "We typically give an arrival window rather than an exact minute, and you'll usually get a heads-up (a call or text) when the technician is on the way. For the specific timing of an existing appointment, our team can confirm — want me to help with that?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "General explainer is static; a specific ETA for a booked job needs dispatch (handle via team/LLM).",
  },
  {
    id: "logistics-be-home",
    category: "service_logistics",
    title: "Do I need to be home",
    triggerKeywords: [
      "need to be home",
      "have to be home",
      "be there for the appointment",
      "come if im at work",
      "someone has to be there",
    ],
    action: "ANSWER",
    cannedResponse:
      "Usually an adult needs to be home to give the technician access and approve any work, but you can also leave a contact number if you'll be out. Our team can note any special access instructions for your visit. Anything you'd like me to pass along?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Per-company but the 'adult to grant access' norm is safe.",
  },
  {
    id: "logistics-prepare",
    category: "service_logistics",
    title: "How to prepare for the visit / pets",
    triggerKeywords: [
      "how should i prepare",
      "prepare for the visit",
      "what do you need from me",
      "clear around the unit",
      "i have a dog",
      "put my pets away",
      "have pets",
    ],
    action: "ANSWER",
    cannedResponse:
      "Just clear easy access to your indoor and outdoor units and jot down what you've noticed about the problem. If you have pets, securing them in a separate room during the visit is appreciated for everyone's safety. Anything else I can help with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Combines visit-prep and pets — both static, low-harm.",
  },
  {
    id: "logistics-same-day-vs-emergency",
    category: "service_logistics",
    title: "Same-day vs emergency / can someone come today",
    triggerKeywords: [
      "can someone come today",
      "same day",
      "same day service",
      "come out today",
      "is this an emergency or can it wait",
      "do you do same day",
    ],
    negationGuards: ["gas smell", "carbon monoxide", "flooding", "sparks", "burning smell"],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: same-day availability is live; and judging emergency-vs-can-wait depends on the symptom. Negation guards keep true hazards routing to the emergency entries instead.",
  },
  {
    id: "logistics-after-hours-fee",
    category: "service_logistics",
    title: "After-hours / weekend / emergency fee",
    triggerKeywords: [
      "after hours fee",
      "after hours charge",
      "weekend charge",
      "extra charge for after hours",
      "emergency service fee",
      "overtime charge",
      "cost more at night",
    ],
    action: "ANSWER",
    cannedResponse:
      "After-hours, weekend, and emergency visits can carry an additional charge, and the amount varies. Our team can confirm the specifics for the time you need — would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Per-company surcharge; don't state an amount. Keep conditional ('can carry').",
  },

  // ─── Category 17 — TRUST / GUARANTEES / CREDENTIALS ────────────────────────
  {
    id: "trust-guarantee",
    category: "trust",
    title: "Satisfaction / workmanship guarantee",
    triggerKeywords: [
      "guarantee your work",
      "satisfaction guarantee",
      "money back guarantee",
      "warranty on the labor",
      "warranty your repairs",
      "if im not satisfied",
      "if the problem comes back",
    ],
    action: "ANSWER",
    cannedResponse:
      "We stand behind our work and want you to be satisfied — our team can walk you through the specific labor and satisfaction guarantees that apply to your service. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Distinct from faq-warranty (manufacturer/equipment). This is workmanship/satisfaction. Per-company terms — keep general.",
  },
  {
    id: "trust-technicians",
    category: "trust",
    title: "Are technicians vetted / background-checked",
    triggerKeywords: [
      "background checked",
      "background check",
      "are your techs vetted",
      "drug tested",
      "can i trust who you send",
      "licensed technicians",
      "insured technicians",
    ],
    negationGuards: ["are you licensed and insured"],
    action: "ANSWER",
    cannedResponse:
      "Our technicians are trained, licensed professionals, and we take who comes into your home seriously. Our team can share more about our hiring and vetting standards if you'd like — anything else I can help with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Reassurance without over-promising specifics that vary by company (e.g. don't assert drug-testing as fact). faq-licensed-insured covers the company-level license/insurance question.",
  },

  // ─── Category 18 — WARRANTY (detail intents beyond faq-warranty) ───────────
  {
    id: "warranty-coverage-check",
    category: "warranty",
    title: "Is my repair/system covered under warranty",
    triggerKeywords: [
      "covered under warranty",
      "still under warranty",
      "is my warranty",
      "warranty cover this",
      "warranty cover parts and labor",
      "is my system under warranty",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: whether a SPECIFIC system/repair is covered needs the equipment/install date and a live lookup. faq-warranty answers the general 'do you offer warranties' question; this is the personalized coverage check.",
  },
  {
    id: "warranty-registration",
    category: "warranty",
    title: "Warranty registration",
    triggerKeywords: [
      "register my warranty",
      "warranty registration",
      "did you register my warranty",
      "register the manufacturer warranty",
      "do i need to register",
    ],
    action: "ANSWER",
    cannedResponse:
      "Manufacturer warranties usually need to be registered within a set window after installation to get full coverage. If we installed your system our team can confirm it was registered, or help you do it — would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "'Did you register MINE' is a live lookup, but the general guidance + offer-to-help is safe to canned-answer.",
  },

  // ─── Category 19 — REFRIGERANT (R-410A / R-22 phaseout) ────────────────────
  {
    id: "refrigerant-phaseout",
    category: "refrigerant",
    title: "Refrigerant phaseout (R-410A / R-22 / Freon)",
    triggerKeywords: [
      "r410a",
      "r 410a",
      "r22",
      "r 22",
      "freon being phased out",
      "refrigerant phase out",
      "refrigerant ban",
      "refrigerant changing",
    ],
    action: "ANSWER",
    cannedResponse:
      "If your current system uses R-410A or older R-22, you can keep running and servicing it — the phaseout applies to the refrigerant used in brand-new equipment, not to existing systems. If you're ever replacing the system, newer low-impact refrigerants come standard. Anything else I can help with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Date-stamped fact (reviewed 2026-06): new equipment must use low-GWP refrigerant (R-32/R-454B) since 1/1/2025; existing R-410A/R-22 systems are fine to service. Reassure, don't push replacement.",
  },
  {
    id: "refrigerant-recharge",
    category: "refrigerant",
    title: "Recharge / add refrigerant (Freon) cost",
    triggerKeywords: [
      "recharge my ac",
      "add freon",
      "add refrigerant",
      "low on refrigerant",
      "low on freon",
      "top off the freon",
      "refrigerant so expensive",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM: a low charge almost always means a LEAK (recharging alone is a temporary fix needing diagnosis), and pricing is per-company/phaseout-driven. Let the LLM explain the leak point and steer to a diagnostic visit; don't quote a price.",
  },

  // ─── Category 10 — CONVERSATIONAL / META ───────────────────────────────────
  {
    id: "meta-greeting",
    category: "meta",
    title: "Greeting / hello",
    triggerKeywords: [
      "hi",
      "hello",
      "hey",
      "good morning",
      "good afternoon",
      "yo",
      "hiya",
    ],
    action: "ANSWER",
    cannedResponse:
      "Hi! I'm an AI HVAC assistant — I can help describe your issue and get a technician dispatched. I might not get everything right, so you can tap “Talk to a Human” anytime. What heating, cooling, or air quality issue are you having?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Mirrors the system-prompt greeting and discloses it's an AI with a human option (transparency / trust). Only match standalone greetings (short message, no issue keywords) — 'hi my AC is broken' must route to the issue.",
  },
  {
    id: "meta-thanks",
    category: "meta",
    title: "Thanks",
    triggerKeywords: ["thanks", "thank you", "appreciate", "thx", "ty"],
    action: "ANSWER",
    cannedResponse:
      "You're welcome! Is there anything else about your heating or cooling I can help with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Don't let a trailing 'thanks' override an unresolved issue in the same message ('thanks but it's still broken' still contains an issue → don't close out).",
  },
  {
    id: "meta-goodbye",
    category: "meta",
    title: "Goodbye / closing",
    triggerKeywords: [
      "bye",
      "goodbye",
      "thats all",
      "im done",
      "see ya",
      "no thanks",
    ],
    action: "ANSWER",
    cannedResponse:
      "Take care! If anything comes up with your heating or cooling, I'm here anytime. Stay comfortable!",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "'I'm done waiting / frustrated' → could be meta-frustration.",
  },
  {
    id: "meta-are-you-bot",
    category: "meta",
    title: '"Are you a bot / real?"',
    triggerKeywords: [
      "are you a bot",
      "are you real",
      "are you human",
      "is this ai",
      "robot",
      "talking to a person",
    ],
    action: "ANSWER",
    cannedResponse:
      "I'm an AI assistant here to help you describe your HVAC issue and get a technician dispatched. If you'd prefer a real person, just tap 'Talk to a Human' in the chat. What can I help with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Be transparent (it's an AI). May precede a handoff request — if they then ask for a human, route to account-speak-to-human.",
  },
  {
    id: "meta-frustration",
    category: "meta",
    title: "Frustration / anger",
    triggerKeywords: [
      "ridiculous",
      "unacceptable",
      "useless",
      "frustrated",
      "angry",
      "terrible service",
      "worst",
    ],
    action: "ESCALATE",
    cannedResponse:
      "I'm really sorry for the frustration — that's the last thing I want for you. Let me connect you with a real person; you can tap 'Talk to a Human' in the chat header and our team will take care of you.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "System prompt: escalate on frustration. Acknowledge empathy first. Borderline cases (mild annoyance still describing an issue) → FALLBACK_LLM so the LLM can de-escalate and keep helping rather than prematurely punting.",
  },
  {
    id: "meta-gibberish-empty",
    category: "meta",
    title: "Gibberish / empty / nonsense",
    triggerKeywords: [],
    action: "ANSWER",
    cannedResponse:
      "Sorry, I didn't quite catch that. Could you tell me what heating or cooling issue you're having so I can help?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Detect deterministically (length, alpha-ratio): message empty after normalization, or no alphabetic words / no dictionary tokens, or only punctuation/emoji. A single real word like 'AC' or 'heat' is NOT gibberish. Don't burn an LLM call on noise. If the same user sends gibberish repeatedly, consider escalation.",
  },
  {
    id: "meta-non-hvac-redirect",
    category: "meta",
    title: "Non-HVAC request → polite redirect",
    triggerKeywords: [
      "plumbing",
      "toilet",
      "roofing",
      "electrician",
      "refrigerator",
      "fridge",
      "garage door",
      "weather",
      "taxes",
      "appliance repair",
    ],
    action: "REDIRECT",
    cannedResponse:
      "I specialize in heating, cooling, and air quality, so that's outside what I can help with — you'd want a specialist for that. Is there an HVAC issue I can help you with?",
    infoNeeded: [],
    issueTypeMapping: "other",
    urgencyHint: null,
    notes:
      "Follows the system-prompt redirect script almost verbatim. Careful negation/overlap guards: 'refrigerant'/'freon' = HVAC (cooling), NOT a fridge; 'water heater' = in scope (heating); 'electrical/burning smell' = HVAC emergency, not electrician work. Mismatching these is the biggest risk in this intent → when uncertain, FALLBACK_LLM.",
  },
];

/** O(1) lookup of a knowledge base entry by its id. */
export const KNOWLEDGE_BASE_BY_ID: Readonly<Record<string, KnowledgeBaseEntry>> =
  Object.fromEntries(KNOWLEDGE_BASE.map((entry) => [entry.id, entry]));
