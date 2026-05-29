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
      "Yes — our technicians are licensed and our company is insured. Is there an HVAC issue I can help you with today?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Confirm with engineering that 'licensed and insured' is accurate for the org before shipping this canned claim.",
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
      "mini split",
    ],
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
