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
      // NOTE: "gas furnace"/"gas stove" are NOT guarded — a bare appliance
      // mention has no gas trigger to match anyway (see triggerKeywords), and
      // guarding them suppressed real leaks like "my gas furnace smells like
      // rotten eggs" / "I smell gas from my gas furnace" (the most common way a
      // customer reports a leak). Escalating a genuine gas smell wins.
      "gas line is fine",
      "em heat",
      "emergency heat",
      "aux heat",
    ],
    requiredQualifiers: ["smell", "leak", "odor", "rotten eggs"],
    action: "ESCALATE",
    cannedResponse:
      "A gas smell can be dangerous. Please leave your home right now, avoid using any switches, phones, or flames inside, and once you're safely outside call your gas utility's emergency line or 911. I'm flagging this as an emergency so our team can follow up right away.",
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
    // Sales/install questions ("do you install a co detector") name the product
    // but are NOT emergencies; a real alarm never asks about buying one.
    negationGuards: [
      "em heat",
      "emergency heat",
      "aux heat",
      "do you install",
      "do you sell",
      "do you offer",
      "do you carry",
      "can you install",
      "want to install",
      "need to install",
    ],
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
      "A carbon monoxide alarm is a serious emergency. Please get everyone (and pets) outside to fresh air immediately and call 911 once you're out. I'm marking this urgent so our team can follow up right away.",
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
      "sparking",
      "hot wires",
    ],
    negationGuards: [
      "em heat",
      "emergency heat",
      "aux heat",
      "do you install",
      "do you sell",
      "do you offer",
      "do you carry",
      "can you install",
      "want to install",
      "need to install",
    ],
    requiredQualifiers: ["burning", "smoke", "smell", "sparks", "sparking"],
    action: "ESCALATE",
    cannedResponse:
      "A burning or electrical smell, or any smoke, is a fire risk. Please turn off the system at the thermostat or breaker if you can do so safely, leave the area, and call 911 if you see smoke or flames. I'm flagging this as an emergency for our team.",
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
    // Past-tense resolution ("burst pipe fixed last month, do you do tune-ups")
    // is a history mention, not an active emergency. Guards are anchored to a
    // PAST + already-resolved phrasing so active reports ("need the burst pipe
    // fixed, water everywhere") are unaffected.
    negationGuards: [
      "em heat",
      "emergency heat",
      "aux heat",
      "fixed last",
      "was fixed",
      "already fixed",
      "pipe fixed",
    ],
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
      "That sounds like a serious leak. If you can safely reach it, shut off the water supply to the unit and turn off power to it at the breaker, then move valuables away from the water. I'm flagging this as urgent so our team can respond quickly. What's the service address?",
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
    negationGuards: [
      "em heat",
      "emergency heat",
      "aux heat",
      // Refrigeration appliances use "freezer"/"freezing" in a non-weather
      // sense ("freezer not freezing", "walk-in freezer"). Those are a
      // refrigeration repair, NOT a no-heat-in-freezing-weather emergency.
      "freezer",
      "walk in freezer",
      "walk-in freezer",
      "reach in freezer",
      "reach-in freezer",
    ],
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
      "No heat in freezing weather is an emergency, especially with vulnerable family members at home. Please keep everyone warm with blankets and layers and use safe backup heat if you have it. I'm flagging this as urgent so our team can prioritize you. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "emergency",
    notes:
      "Per system prompt, 'no heat in freezing weather' is explicitly emergency. Without the freezing/vulnerable qualifier, route to heating-not-heating (high). 'no heat' alone in mild weather is heating-not-heating, not emergency. Never suggest unsafe space-heater/oven workarounds; only 'safe backup heat if you have it.'",
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
      "No cooling in extreme heat can be a health risk for vulnerable people. Please move to the coolest room, hydrate, and use fans or a cooling center if you can. I'm flagging this as urgent so our team can prioritize you. What's the service address?",
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
    negationGuards: [
      // Commercial refrigeration ("walk-in cooler not cooling", "display case")
      // is its own service line (refrigeration-not-cooling), not residential AC.
      "walk in cooler",
      "walk-in cooler",
      "walk in freezer",
      "walk-in freezer",
      "reach in cooler",
      "reach-in cooler",
      "reach in freezer",
      "reach-in freezer",
      "display case",
      "beverage cooler",
      "freezer",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "I'm sorry your AC isn't keeping up. That's frustrating in this weather. I can get a technician out to look at it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "high",
    notes:
      "If they mention extreme heat + vulnerable people → re-route to emergency-no-cooling-extreme-heat-vulnerable. 'blowing cold air' from a HEATING system is the opposite problem → heating-blowing-cold. negationGuards keep commercial-refrigeration phrasing off this residential-AC intent (→ refrigeration-not-cooling).",
  },
  {
    id: "cooling-wont-turn-on",
    category: "cooling",
    title: "AC won't turn on / is down",
    triggerKeywords: [
      "ac wont turn on",
      "wont start",
      "not starting",
      "completely dead",
      "nothing happens",
      "wont kick on",
      "no power",
      // "down" is a very common way to say the system isn't running. These are
      // SUBSTRING-matched (multi-word), so they catch "my office AC is completely
      // down", "the AC is down", "cooling is down". Each fragment is specific
      // enough that unrelated "down" (calm down, slow down) can't match.
      "ac is down",
      "ac down",
      "completely down",
      "cooling is down",
    ],
    negationGuards: [
      // The generic "completely down" trigger must not steal a HEATING or
      // refrigeration "down" complaint — those have their own intents. Scoped to
      // explicit heating/refrigeration phrasing (not a bare "heat", which appears
      // in legit cooling phrasings like "no AC in this heat" or "heat pump").
      "heat is down",
      "heating is down",
      "no heat",
      "not heating",
      "furnace",
      "boiler",
      // Refrigeration units — use the specific multi-word forms (a bare "walk in"
      // would wrongly fire on "can someone walk in and check my AC").
      "walk in cooler",
      "walk-in cooler",
      "walk in freezer",
      "walk-in freezer",
      "reach in cooler",
      "reach-in cooler",
      "reach in freezer",
      "reach-in freezer",
      "freezer",
      "display case",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Sorry your AC won't start. Let's get a technician out to diagnose it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "high",
    notes:
      "Overlaps with thermostat-dead; if the customer attributes it to a blank/dead thermostat, route to thermostat-blank instead. negationGuards keep heating/refrigeration 'down' phrasing off this residential-AC intent.",
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
      "Ice on the unit usually means it needs attention before it's damaged. It's best to turn the cooling off and let it thaw while we get a technician out. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "medium",
    notes:
      "'Turn it off to let it thaw' is operational guidance, not a repair instruction (acceptable). Don't tell them to add refrigerant or open the unit. 'frozen pipes' in a heating context → emergency-no-heat-freezing.",
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
      "Short cycling like that can stress the system, so it's worth having checked. I can arrange a technician visit. What's the service address?",
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
      "Unusual noises are worth checking before they turn into a bigger problem. I can get a technician out to take a look. What's the service address?",
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
      "If the outdoor unit isn't running, the system can't cool properly and should be inspected. I can schedule a technician. What's the service address?",
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
      "Refrigerant levels need to be checked and handled by a licensed technician. I can set up a visit to diagnose it properly. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "cooling_not_working",
    urgencyHint: "medium",
    notes:
      "Customer self-diagnosis may be wrong; frozen coil/airflow can mimic this. Never quote refrigerant pricing or confirm a recharge is needed (that's a tech diagnosis). Refrigerant handling is regulated, so emphasize licensed tech.",
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
      // "down" phrasing, anchored to heat/furnace. Avoid bare "heat down" —
      // it collides with "turn the heat down" (a working system). A bare
      // "system is down" stays on the cooling intent.
      "heat is down",
      "heating is down",
      "furnace is down",
      "furnace down",
      // "no heat" is the most common bare phrasing for a non-working furnace; in
      // mild weather (no freezing/vulnerable qualifier) it belongs here, not the
      // emergency intent (which requires that qualifier).
      "no heat",
      "no heating",
    ],
    negationGuards: [
      // Commercial cooking equipment ("oven not heating", "fryer not heating")
      // is the commercial-appliance service line, not a furnace heating call.
      "oven",
      "fryer",
      "range",
      "grill",
      "griddle",
      "holding cabinet",
      "commercial appliance",
      "restaurant equipment",
      // A boiler heating complaint is owned by boiler-issue.
      "boiler",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "Sorry you're not getting the heat you need. Let's get a technician out to diagnose it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "Escalate if freezing weather / vulnerable occupants are mentioned. 'blowing cold air' → heating-blowing-cold; freezing-temp qualifier → emergency-no-heat-freezing. negationGuards keep commercial-appliance ('oven','fryer') and boiler phrasing off the furnace intent (→ commercial-appliance-issue / boiler-issue).",
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
      "A furnace that won't ignite needs a technician's eye. I can get a visit scheduled. What's the service address?",
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
      "Relighting a pilot can involve gas, so it's safest to let a technician handle it, and if you ever smell gas, leave and call your gas company. I can schedule a visit; what's the service address?",
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
      "Cold air when you're calling for heat usually means something needs attention. I can get a technician out. What's the service address?",
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
      "Short cycling can wear out the system, so it's good to have it checked. I can arrange a technician visit. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "medium",
    notes:
      "Same phrasing as cooling-short-cycling; disambiguate on heat vs AC. If neither heat nor AC context is present → FALLBACK_LLM.",
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
      "Deliberately FALLBACK_LLM. The line between 'harmless first-of-season dust burn-off' and 'dangerous burning smell' is too risky to canned-answer. HIGH overlap with emergency-electrical-burning-smell: 'burning plastic'/'smoke'/'persistent' must escalate, NOT match here. Let the LLM probe (persistent? plastic? smoke?) before deciding.",
  },
  {
    id: "heating-no-hot-water",
    category: "heating",
    title: "Water heater: no hot water",
    triggerKeywords: [
      "no hot water",
      "water heater",
      "hot water",
      "cold water only",
      "water heater not heating",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "No hot water is a real hassle. I can get a technician out to look at your water heater. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "heating_not_working",
    urgencyHint: "high",
    notes:
      "No dedicated water-heater enum; heating_not_working is the closest. 'water leak from water heater' → could be water_leak/emergency-flooding; 'pilot out on water heater' → heating-pilot-out. If the company doesn't service water heaters, candidate for FALLBACK_LLM or a business-scope answer; confirm scope with engineering.",
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
      "Heat pumps can act up in a few different ways. Let's get a technician to diagnose it properly. What's the service address?",
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
      "Unusual furnace noises are worth checking before they get worse. I can get a technician out. What's the service address?",
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
      "A musty smell from the vents is something we can check out. It's often related to moisture or the ducts. I can schedule a technician; what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "air_quality",
    urgencyHint: "low",
    notes:
      "Only match musty/moldy/mildew; burning/gas/electrical smells must route to emergency intents.",
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
      "Weak airflow can have a few causes, sometimes as simple as a clogged filter. I can get a technician to take a look. What's the service address?",
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
      "Excess dust can sometimes point to filtration or duct issues, and a technician can assess it. What's the service address?",
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
      "Indoor humidity issues are something we can help with. A technician can evaluate your system and options. What's the service address?",
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
      "Uneven temperatures usually come down to airflow, ductwork, or balancing, and a technician can pinpoint it. What's the service address?",
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
      "A blank thermostat can stop the whole system from running. Sometimes it's batteries, but it's worth a proper check. I can get a technician out; what's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes:
      "'Sometimes it's batteries' is a gentle hint, not a repair walk-through. A blank thermostat can cause cooling-wont-turn-on/no heat, so prefer this intent when the screen is the stated symptom. If combined with no-heat-in-freezing, escalate.",
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
      "If the thermostat isn't responding, the system can't be controlled properly. Let's have a technician check it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes:
      "'frozen' here means UI-frozen, not iced; disambiguate on thermostat keyword.",
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
      "A thermostat reading that's off can throw off your whole system, and a technician can check the sensor and placement. What's the service address?",
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
      "We can help with smart thermostat installation and setup. A technician will make sure it's wired and configured correctly for your system. What's the service address?",
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
      "Happy to set up a tune-up to keep your system running smoothly. I just need a couple of details. What's the service address?",
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
      "Most home filters should be checked monthly and changed every 1-3 months. The right size is printed on the edge of your current filter (like 16x25x1). If you'd like, I can schedule a technician to handle it during a visit.",
    infoNeeded: [],
    issueTypeMapping: "maintenance",
    urgencyHint: "low",
    notes:
      "Borderline DIY, but 'check the label for the size + change every 1-3 months' is general guidance, not a repair instruction (acceptable). 'weak airflow' can stem from filter → airquality-weak-airflow. If they then want a tech, transition to COLLECT_INFO (address).",
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
      "Seasonal prep is a great way to avoid surprises, and I can schedule that for you. What's the service address?",
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
      "This is the 'entry' scheduling intent. Once they describe the issue, hand off to the matching issue intent's slot collection. Very generic: if an issue is also described, classify the issue first. Don't promise a time.",
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
      "Once your request is submitted, our team reviews it right away and reaches out to confirm the soonest available time. For an emergency, we're available any time, day or night. If you describe your issue, I can get the request started.",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "No fixed follow-up time is promised (the site states emergency service is 24/7, not a 2-hour callback). Time-pressure may signal an emergency, so check emergency triggers first. Never promise an arrival time.",
  },
  {
    id: "scheduling-after-hours",
    category: "scheduling",
    title: "After-hours / weekend / 24-7 availability",
    triggerKeywords: [
      "after hours",
      "weekend",
      "weekends",
      "at night",
      "24/7",
      "overnight",
      "holiday",
    ],
    // "extra CHARGE / FEE for after hours" is a pricing question
    // (logistics-after-hours-fee), not an availability question. Multi-word so
    // unrelated uses of "charge"/"fee" don't suppress availability questions.
    negationGuards: [
      "charge for",
      "fee for",
      "extra charge",
      "extra fee",
      "cost more",
      "surcharge",
      "overtime",
    ],
    action: "ANSWER",
    cannedResponse:
      "We offer support around the clock, and after-hours or weekend visits depend on availability. Submit your request and our team will confirm the soonest time. If it's an emergency like a gas smell or no heat in freezing weather, please tell me right away.",
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
    // (replacement-lifespan), not a wait-time question. Keep these multi-word —
    // a bare "last" would wrongly suppress "the last tech took 4 hours".
    negationGuards: [
      "how long does",
      "how long should",
      "how long will my",
      "how long do",
      "lifespan",
      "to install",
      "to replace",
    ],
    action: "ANSWER",
    cannedResponse:
      "After you submit a request, our team follows up to confirm timing and give you an arrival window. I can't promise an exact arrival time from here, but I can get your request started, and for an emergency we're available any time, day or night.",
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
    // The specific "move/change my appointment" phrases moved to
    // account-data-reschedule (a real identified-customer hand-off) to avoid a
    // compound trip with that intent. The bare "reschedule" verb + day-change
    // phrasings stay here as a catch-all for an unidentified mention; the route
    // still maps this intentId to the reschedule hand-off for an identified one.
    triggerKeywords: [
      "reschedule",
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
      "OVERRIDE #1: FALLBACK_LLM (reference-lookup the deterministic layer can't do). Original canned text: 'No problem, I can help with that. What's your reference number (like REF-XXXXX) so I can pull up the right request?' If 'cancel' appears mid-intake (no booked job exists), treat as conversational reset, not a cancellation.",
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
      "We serve a wide local area. If you share your address or zip code, I can pass it along so our team can confirm coverage, and we can start a request if you have an HVAC issue.",
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
      "Close to account-speak-to-human; that one is about escalation, this is just the number. Points to the existing 'Talk to a Human' escalation path (GUIDE.md) rather than hardcoding a number the catalog may not have.",
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
      "Great question. Our team can confirm the licensing and insurance details for your area when they follow up. Is there an HVAC issue I can help you with today?",
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
      "installations",
      "install",
      "installs",
      "replace system",
      "new unit",
      "new system",
      "repair only",
    ],
    // More specific install/replacement intents take precedence: cost-to-replace
    // (pricing-cost-to-replace), rebates (efficiency-*), sizing/lifespan
    // (replacement-*), and specific equipment (mini-split, boiler, IAQ
    // products). Cost guards stay MULTI-WORD so a generic "how much does an
    // install cost" still reaches this install-capable entry rather than a
    // routing black hole.
    negationGuards: [
      "how much for a new",
      "cost to replace",
      "cost for a new",
      "price for a new",
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
      "A brand name alone may appear within an issue description; only treat as this FAQ if they ask whether you service it. 'All major brands' is a safe generic; confirm org reality.",
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
      "amex",
    ],
    action: "ANSWER",
    cannedResponse:
      "Our team can walk you through accepted payment options when they confirm your service. For now, I can help you start a request. What HVAC issue are you having?",
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
      "Financing options may be available, especially for new installations, and our team can review the details with you. Would you like me to start a request so they can follow up?",
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
    triggerKeywords: ["warranty", "warranties", "guarantee", "guaranteed", "under warranty"],
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
      "warranty on labor",
      "labor warranty",
      "parts and labor warranty",
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
      "Pricing depends on what your system needs, so our technician provides a clear quote after assessing it in person. I'm not able to give prices from here. If you describe your issue, I can get a request started so they can follow up.",
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
      "OVERRIDE #1: FALLBACK_LLM. Detect the reference pattern deterministically (regex ref-?\\s*[a-z0-9]{4,}), but acting on it (lookup, status, changes) needs backend data → defer to LLM/human flow. The router's job here is just to recognize it and route, not answer. A bare number could be a phone/zip, so require the 'ref' token or 'REF-' prefix.",
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
      "During active intake this is normal slot-filling: the router should update the matching slot (name/phone/email/address) and continue, NOT treat it as a topic change. Validate email/phone format at the boundary.",
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
      "Of course. You can reach our team directly using the 'Talk to a Human' button in the chat header, which connects you with a real person. I'm flagging this so someone follows up with you.",
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
      "Estimates for a new system or replacement are typically free, while repair visits usually carry a diagnostic fee. I can have our team confirm the details for your situation. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Industry split: replacement/install estimates free; repair visits carry a diagnostic fee (see pricing-diagnostic-fee). Don't promise it's free for a repair. Per-company policy, so keep neutral.",
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
      "Repair visits usually include a diagnostic (service call) fee to cover the technician coming out and finding the problem. The exact amount and whether it's credited toward an approved repair varies, so I can have our team confirm it for you. Want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Don't state a specific dollar amount (per-company). Mention the fee is often credited to an approved repair (see pricing-fee-waived).",
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
      "In many cases the diagnostic fee is credited toward the cost of an approved repair, so you're not paying twice. Our team can confirm how it works for your visit. Would you like me to start a request?",
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
      "We sometimes run seasonal promotions and may offer discounts for certain groups, and our team can tell you what's currently available for your situation. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Promotions are time-sensitive and per-company; never name a specific percentage, promo, or guarantee a discount category exists (e.g. don't promise senior/military). Keep conditional.",
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
      "We're happy to take a look and give you an honest second opinion on another company's diagnosis or quote. I can start a request so our team can follow up. Would you like that?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Many companies offer free second opinions on a written competitor diagnosis. Keep it welcoming, no price promise.",
  },

  // ─── Category 12 — MEMBERSHIP / MAINTENANCE PLANS ──────────────────────────
  {
    id: "membership-explainer",
    category: "membership",
    title: "Maintenance plan / membership: what is it",
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
      "A maintenance plan typically includes scheduled tune-ups, priority scheduling, and discounts on repairs to keep your system running efficiently and catch problems early. Our team can walk you through what's included and the cost. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Per-company benefits/pricing: describe typical inclusions generically, don't quote a price. 'Am I a member?' is membership-account (FALLBACK_LLM).",
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
      "Regular maintenance helps your system run more efficiently, last longer, and avoid surprise breakdowns, and plan members often get repair discounts and priority service. Our team can go over the specifics so you can decide. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes: "Value framing only; no savings guarantee with a hard number.",
  },
  {
    id: "membership-account",
    category: "membership",
    title: "Membership enrollment (sign up / join)",
    // Status / next-visit phrases ("am i a member", "my next tune up", "when is
    // my included service") moved to the account_data intents (real identified-
    // customer reads). This entry now owns only ENROLLMENT intent (lead capture),
    // which still defers to the LLM. Removing the overlap also prevents a compound
    // trip (the same phrase scoring in both 'membership' and 'account_data').
    triggerKeywords: [
      "sign up for the plan",
      "join the membership",
      "enroll in the plan",
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
      "There are often utility or state rebates available for high-efficiency equipment like heat pumps, and the amounts change over time. Our team can point you to what currently applies in your area. Would you like me to start a request so they can follow up?",
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
      "Tax credits and incentives for HVAC equipment change year to year, so I'd point you to a tax professional for what currently applies. Our team can also tell you about any utility or manufacturer rebates available right now. Want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "The federal 25C credit expired 12/31/2025; do NOT assert an active federal credit. Redirect to a tax professional + current rebates. Reviewed: 2026-06.",
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
      "FALLBACK_LLM: the repair-vs-replace call depends on age, repair cost, frequency, and efficiency, which is too situational for a canned answer. LLM can explain factors (e.g. the 50%/$5k rules) and recommend an assessment.",
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
      "The right size isn't just about square footage. A proper sizing (a Manual J load calculation) accounts for your home's insulation, windows, and layout, so a bigger unit isn't automatically better. Our team can do that assessment for you. Would you like me to start a request?",
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
      "Yes, ductless mini-splits are a great option for spaces without ductwork, additions, or zoning specific rooms, and our team can help with installation or service. Would you like me to start a request so they can follow up?",
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
      "boilers",
      "radiator",
      "radiators",
      "hydronic",
      "hot water heat",
      "baseboard heat",
      "steam heat",
    ],
    negationGuards: [
      "water heater",
      "no hot water from my tap",
      // A SPECIFIC boiler symptom is a repair intake (boiler-issue,
      // COLLECT_INFO), not this generic "do you work on boilers?" capability
      // question. Guarding these here keeps equipment-boiler from competing as
      // a low-score runner-up and dragging boiler-issue's confidence below the
      // ACT_THRESHOLD.
      "boiler no heat",
      "boiler not heating",
      "boiler not working",
      "boiler leaking",
      "boiler leak",
      "no heat from boiler",
      "boiler wont fire",
      "boiler not firing",
      "boiler is leaking",
    ],
    action: "FALLBACK_LLM",
    cannedResponse: "",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "FALLBACK_LLM for the generic capability question ('do you work on boilers?'). A specific boiler SYMPTOM is guarded off to boiler-issue (COLLECT_INFO). Spears DOES service boilers, but the generic question still benefits from LLM context-gathering rather than asserting a forced-air assumption.",
  },
  {
    id: "equipment-iaq-products",
    category: "equipment",
    title: "IAQ products: UV light, air purifier, humidifier",
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
      "We can help improve your indoor air quality with add-ons like UV lights, whole-home air purifiers, humidifiers, and upgraded filtration. Our team can recommend what fits your system. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Distinct from the air_quality category (which is SYMPTOMS like musty smell/dust). This is the buy/install-a-product intent.",
  },

  // ─── Category 15b — COMMERCIAL SERVICE LINES (refrigeration / ice / appliance) ──
  // Spears Services is "THE Commercial Repair Experts" — beyond forced-air HVAC
  // they service commercial refrigeration, ice machines, boilers, and commercial
  // kitchen appliances. These intents route the natural phrasing for those
  // symptoms to a repair intake (COLLECT_INFO) instead of the non-HVAC redirect.
  // Brand-agnostic copy; brands are named only where natural (ice machines).
  {
    id: "refrigeration-not-cooling",
    category: "refrigeration",
    title: "Walk-in cooler / reach-in freezer / display case not cooling",
    triggerKeywords: [
      "walk in cooler",
      "walk-in cooler",
      "walk in freezer",
      "walk-in freezer",
      "reach in cooler",
      "reach-in cooler",
      "reach in freezer",
      "reach-in freezer",
      "display case",
      "beverage cooler",
      "cooler not cooling",
      "freezer not freezing",
      "cooler not cold",
      "freezer not cold",
      "walk in not cooling",
      "refrigeration",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "A cooler or freezer that isn't holding temperature can put your product at risk fast. Let's get a technician out to look at it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "refrigeration",
    urgencyHint: "high",
    notes:
      "Commercial + residential refrigeration. Distinct from a residential AC (cooling category). 'beverage cooler'/'display case'/'walk-in' are unambiguous commercial-refrigeration signals. If a temperature-loss emergency with perishable inventory is described, the LLM/urgency flow can raise urgency.",
  },
  {
    id: "ice-machine-issue",
    category: "refrigeration",
    title: "Commercial ice machine not making ice / leaking",
    triggerKeywords: [
      "ice machine",
      "ice maker",
      "icemaker",
      "not making ice",
      "no ice",
      "ice machine leaking",
      "ice machine not working",
      "hoshizaki",
      "manitowoc",
      "scotsman",
      "koolaire",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "We repair and service commercial ice machines, including Hoshizaki, Manitowoc, and Scotsman, and can set up preventative maintenance too. Let's get a technician out. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "ice_machine",
    urgencyHint: "high",
    notes:
      "Commercial only. Brands named because Spears explicitly services Hoshizaki/Manitowoc/Scotsman/Koolaire. A residential fridge ice maker is NOT this, but 'ice machine'/'ice maker' phrasing is dominated by commercial units, and the refrigeration-not-cooling intent covers residential cooling failures.",
  },
  {
    id: "boiler-issue",
    category: "heating",
    title: "Boiler not heating / leaking (gas/electric/oil)",
    triggerKeywords: [
      "boiler no heat",
      "boiler not heating",
      "boiler not working",
      "boiler leaking",
      "boiler is leaking",
      "boiler leak",
      "no heat from boiler",
      "boiler wont fire",
      "boiler not firing",
      "radiator not heating",
      "no hot water heat",
    ],
    negationGuards: ["water heater", "no hot water from my tap"],
    action: "COLLECT_INFO",
    cannedResponse:
      "We service gas, electric, and oil boilers, both repairs and preventative maintenance. Let's get a technician out to look at it. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "boiler",
    urgencyHint: "high",
    notes:
      "Spears services boilers (residential + commercial), so a SPECIFIC boiler SYMPTOM is a repair intake, distinct from the generic equipment-boiler 'do you work on boilers?' capability question, which stays FALLBACK_LLM. negationGuards exclude domestic-hot-water/'water heater' which is a different appliance.",
  },
  {
    id: "commercial-appliance-issue",
    category: "equipment",
    title: "Commercial kitchen appliance repair (oven / fryer / range / grill)",
    triggerKeywords: [
      "commercial oven",
      "commercial range",
      "commercial fryer",
      "deep fryer",
      "commercial grill",
      "griddle",
      "holding cabinet",
      "oven wont heat",
      "oven not heating",
      "fryer not heating",
      "range not working",
      "commercial appliance",
      "restaurant equipment",
    ],
    action: "COLLECT_INFO",
    cannedResponse:
      "We repair commercial kitchen equipment: ranges, ovens, fryers, grills, and holding cabinets. Let's get a technician out to get you back up and running. What's the service address?",
    infoNeeded: ["address"],
    issueTypeMapping: "commercial_appliance",
    urgencyHint: "high",
    notes:
      "Commercial only. 'commercial'/'restaurant'/'deep fryer'/'holding cabinet' disambiguate from a residential range (which would be out of scope / non-HVAC). Brand-agnostic; Spears services True/Whirlpool/Frigidaire/etc but kitchen-line brands aren't asserted in copy.",
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
      "We typically give an arrival window rather than an exact minute, and you'll usually get a heads-up (a call or text) when the technician is on the way. For the specific timing of an existing appointment, our team can confirm. Want me to help with that?",
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
    notes: "Combines visit-prep and pets; both static, low-harm.",
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
      "After-hours, weekend, and emergency visits can carry an additional charge, and the amount varies. Our team can confirm the specifics for the time you need. Would you like me to start a request?",
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
      "We stand behind our work and want you to be satisfied. Our team can walk you through the specific labor and satisfaction guarantees that apply to your service. Would you like me to start a request so they can follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Distinct from faq-warranty (manufacturer/equipment). This is workmanship/satisfaction. Per-company terms, so keep general.",
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
      "We take who comes into your home seriously, and our team can share information about our technicians' training, licensing, and background-screening standards. Would you like me to have someone follow up?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Must NOT assert 'licensed professionals' / drug-testing as fact; per-org data doesn't exist (legal liability across tenants), same convention as faq-licensed-insured. Offer to follow up instead. faq-licensed-insured covers the company-level license/insurance question.",
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
      "Manufacturer warranties usually need to be registered within a set window after installation to get full coverage. If we installed your system our team can confirm it was registered, or help you do it. Would you like me to start a request?",
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
      "If your current system uses R-410A or older R-22, you can keep running and servicing it. The phaseout applies to the refrigerant used in brand-new equipment, not to existing systems. If you're ever replacing the system, newer low-impact refrigerants come standard. Anything else I can help with?",
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

  // ─── Category 20 — SELF-CHECK / DE-ESCALATION ──────────────────────────────
  // Low-harm ANSWER intents that offer a SAFE basic check (thermostat batteries,
  // breaker/fuse, furnace switch, filter) for "nothing happens" symptoms before
  // we dispatch — often saving a wasted truck roll. Strictly limited to those
  // checks: NEVER open the unit, touch wiring/refrigerant/gas, or relight
  // anything. Every canned response ends with "if that doesn't help, we'll get a
  // technician out." Category "selfcheck" is unlisted in CATEGORY_PRIORITY, so it
  // takes the lowest priority — it can NEVER outrank an issue (cooling-wont-turn-on,
  // thermostat-blank) or an emergency intent. Emergencies also short-circuit the
  // router before this scores, so a no-heat-in-freezing case still escalates.
  {
    id: "selfcheck-no-power",
    category: "selfcheck",
    title: "Self-check: no power / nothing happens before dispatch",
    // Triggers are deliberately the phrasings the issue intents do NOT already
    // own AND that do not substring-overlap their triggers. The strong
    // "no power"/"nothing happens"/"completely dead"/"ac wont turn on" phrases
    // belong to cooling-wont-turn-on (and the heating intents) — repeating them
    // (or a substring like "wont turn on" inside "ac wont turn on") would make
    // BOTH score and trip the router's compound-message detector, sending a clean
    // "my AC won't turn on, nothing happens" straight to FALLBACK_LLM and
    // WEAKENING the dispatch path. So we fill only the gaps those entries miss
    // (a bare "system dead" / "won't come on" with no AC/heat context); with
    // AC/heat context the issue intent correctly wins and we stay silent.
    triggerKeywords: [
      "system dead",
      "no response",
      "wont power on",
      "wont come on",
      "wont power up",
    ],
    // Defensive: if a freezing / no-heat hazard is in the message, don't offer a
    // self-check — let the emergency/issue intents own it. (Emergencies already
    // short-circuit first; this is belt-and-suspenders.)
    negationGuards: [
      "freezing",
      "no heat",
      "gas smell",
      "smell gas",
      "burning smell",
      "carbon monoxide",
      "sparks",
    ],
    action: "ANSWER",
    cannedResponse:
      "Before we send anyone out, a couple of safe things are worth a quick look: try fresh batteries in the thermostat, check that the breaker (or fuse) for your HVAC hasn't tripped, and make sure the switch on the side of the furnace is on. If none of that brings it back to life, no worries, we'll get a technician out to you. Want me to start a request?",
    infoNeeded: [],
    issueTypeMapping: "other",
    urgencyHint: "medium",
    notes:
      "Lowest-priority category by design; only fires when no issue/emergency intent matches more strongly (e.g. a bare 'nothing happens' with no AC/heat context). 'no power'/'nothing happens'/'completely dead' WITH ac/heat context route to cooling-wont-turn-on/heating intents (priority 2) instead, which is correct. Safe checks ONLY: batteries, breaker/fuse, furnace switch. Never open the unit or touch wiring/gas/refrigerant.",
  },
  {
    id: "selfcheck-thermostat-blank",
    // Same category as the authoritative thermostat-blank ON PURPOSE: the router's
    // compound-message detector defers to the LLM only when 2+ DISTINCT non-meta
    // categories score — sharing "thermostat" guarantees these two siblings never
    // trip it (so "thermostat dead, screen is off" stays answerable instead of
    // falling back). Ranking is then by score within the shared priority:
    // thermostat-blank (COLLECT_INFO) owns the strong "blank screen"/"no display"
    // phrasings and still wins those; this self-check only wins the gentler
    // "is blank / is dead / screen is off" phrasings it would otherwise miss.
    category: "thermostat",
    title: "Self-check: blank/dead thermostat, try batteries first",
    triggerKeywords: [
      "thermostat dead",
      "screen is off",
      "thermostat is blank",
      "thermostat is dead",
      "screen went dark",
    ],
    // Keep the existing thermostat-blank (COLLECT_INFO, priority 2) authoritative;
    // this is the lower-priority self-check sibling for the same symptom. Guard
    // against any hazard context bleeding in.
    negationGuards: [
      "freezing",
      "no heat",
      "gas smell",
      "burning smell",
      "carbon monoxide",
    ],
    action: "ANSWER",
    cannedResponse:
      "A blank thermostat is very often just dead batteries. If yours takes them, popping in a fresh set is a safe first thing to try. It's also worth checking that the breaker for your HVAC hasn't tripped. If the screen stays dark after that, we'll get a technician out to take a look. Would you like me to start a request?",
    infoNeeded: [],
    issueTypeMapping: "thermostat_issue",
    urgencyHint: "medium",
    notes:
      "Sibling of thermostat-blank (COLLECT_INFO). That entry stays authoritative (priority 2 beats this selfcheck default-priority entry whenever both match). This one catches the gentler 'maybe just batteries' framing / phrasings the issue entry's substring triggers miss (e.g. 'thermostat is blank'). Batteries + breaker check ONLY: no wiring/DIY walk-through.",
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
      "Hi! I'm an AI HVAC assistant, here to help describe your issue and get a technician dispatched. I might not get everything right, so you can tap “Talk to a Human” anytime. What heating, cooling, or air quality issue are you having?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Mirrors the system-prompt greeting and discloses it's an AI with a human option (transparency / trust). Only match standalone greetings (short message, no issue keywords); 'hi my AC is broken' must route to the issue.",
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
      "Be transparent (it's an AI). May precede a handoff request; if they then ask for a human, route to account-speak-to-human.",
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
      "I'm really sorry for the frustration. That's the last thing I want for you. Let me connect you with a real person; you can tap 'Talk to a Human' in the chat header and our team will take care of you.",
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
    title: "Out-of-scope request → polite redirect",
    triggerKeywords: [
      "plumbing",
      "toilet",
      "clogged drain",
      "roofing",
      "roof",
      "electrician",
      "electrical wiring",
      "garage door",
      "weather",
      "taxes",
    ],
    action: "REDIRECT",
    cannedResponse:
      "We handle HVAC, refrigeration, ice machines, boilers, and commercial appliance repair, but that one's outside our wheelhouse, so you'd want a specialist for it. Is there a heating, cooling, refrigeration, or commercial equipment issue I can help you with?",
    infoNeeded: [],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "Redirects ONLY genuinely out-of-scope work (plumbing-only, roofing, electrical-only, etc). Spears' in-scope lines (HVAC, refrigeration (coolers/freezers/display cases), ice machines, boilers, commercial appliances) are owned by their own COLLECT_INFO intents and MUST NOT appear here (removing 'refrigerator'/'fridge'/'appliance repair' fixed a defect where Spears' core business was being redirected away). Careful overlap guards: 'refrigerant'/'freon' = HVAC (cooling), NOT a fridge; 'water heater' = a separate appliance; 'electrical/burning smell' = HVAC emergency, not electrician work. When uncertain, FALLBACK_LLM. issueTypeMapping is null so a spurious redirect never stamps a bogus issue type.",
  },

  // ─── Category 16 — ACCOUNT DATA (identified-customer reads, v1) ─────────────
  // These five answer ACCOUNT-SPECIFIC questions ("my balance / my membership /
  // my next visit / my appointment", and a reschedule REQUEST) by reading the
  // customer's own records. They carry action ACCOUNT_LOOKUP: the router only
  // RECOGNIZES them and surfaces the intentId — the chat route enforces the
  // identity gate (an unidentified session gets the normal identify/intake path,
  // NEVER another customer's data) and dispatches to src/lib/ai/account-tools.ts.
  // category 'account_data' is priority 4 (lowest tier, == meta) so they can
  // NEVER outrank an emergency, a real issue, or booking. cannedResponse is the
  // unidentified-session ask (used by the route when no customer is resolved);
  // the identified reply is assembled deterministically from the tool result.
  {
    id: "account-data-membership-status",
    category: "account_data",
    title: "Membership status — am I a member / what plan",
    triggerKeywords: [
      "am i a member",
      "am i on the plan",
      "do i have a membership",
      "what plan am i on",
      "what is my plan",
      "am i enrolled",
    ],
    action: "ACCOUNT_LOOKUP",
    cannedResponse:
      "I can check that for you. What's the email or phone number on your account?",
    infoNeeded: ["email", "phone"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "ACCOUNT_LOOKUP → getMembershipSummary(orgId, customerId). Only fires for an identified session; otherwise the route asks for a contact to identify (the cannedResponse). Distinct from membership-explainer (generic 'what is a plan', ANSWER).",
  },
  {
    id: "account-data-next-visit",
    category: "account_data",
    title: "Upcoming maintenance visit — when is my next visit",
    triggerKeywords: [
      "when is my next visit",
      "next maintenance visit",
      "when is my included service",
      "next service visit",
    ],
    action: "ACCOUNT_LOOKUP",
    cannedResponse:
      "I can look that up. What's the email or phone number on your account?",
    infoNeeded: ["email", "phone"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "ACCOUNT_LOOKUP → getNextVisit(orgId, customerId). Reads the soonest scheduled/generated membership_visit. Identity-gated by the route.",
  },
  {
    id: "account-data-balance",
    category: "account_data",
    title: "Invoice balance — what do I owe / my balance",
    triggerKeywords: [
      "what do i owe",
      "my balance",
      "do i owe anything",
      "outstanding balance",
      "my invoice",
      "unpaid invoice",
      "my account balance",
    ],
    action: "ACCOUNT_LOOKUP",
    cannedResponse:
      "I can check your balance. What's the email or phone number on your account?",
    infoNeeded: ["email", "phone"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "ACCOUNT_LOOKUP → getOpenBalance(orgId, customerId). States the EXISTING open-invoice balance only (a fact about past transactions) — NEVER an estimate/quote. May mention the portal link when active. Identity-gated by the route.",
  },
  {
    id: "account-data-appointment-status",
    category: "account_data",
    title: "Appointment status — is my appointment still on / when is my tech",
    triggerKeywords: [
      "when is my technician",
      "when is my tech coming",
      "when is my tech arriving",
    ],
    action: "ACCOUNT_LOOKUP",
    cannedResponse:
      "I can check on that. What's the email or phone number on your account?",
    infoNeeded: ["email", "phone"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "ACCOUNT_LOOKUP → getUpcomingAppointment(orgId, customerId). Reports scheduledDate + arrival window + status of the soonest upcoming request. Identity-gated by the route. Does NOT promise/commit a new time.",
  },
  {
    id: "account-data-reschedule",
    category: "account_data",
    title: "Reschedule request — staff hand-off (not a self-booking)",
    triggerKeywords: [
      "reschedule my visit",
      "reschedule my tech",
      "push my visit",
      "need a different time for my visit",
    ],
    action: "ACCOUNT_LOOKUP",
    cannedResponse:
      "I can pass that along to our team. What's the email or phone number on your account?",
    infoNeeded: ["email", "phone"],
    issueTypeMapping: null,
    urgencyHint: null,
    notes:
      "ACCOUNT_LOOKUP → requestReschedule(orgId, customerId, detail). Records a STAFF HAND-OFF (request note) and tells the customer a human will follow up — it is NOT a booking and never mutates the schedule (the bot must not say booked/scheduled/confirmed). Identity-gated by the route.",
  },
];

/** O(1) lookup of a knowledge base entry by its id. */
export const KNOWLEDGE_BASE_BY_ID: Readonly<Record<string, KnowledgeBaseEntry>> =
  Object.fromEntries(KNOWLEDGE_BASE.map((entry) => [entry.id, entry]));
