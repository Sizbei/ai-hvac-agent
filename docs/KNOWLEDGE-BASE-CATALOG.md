# Knowledge Base Catalog (research output)

> Source: domain-expert subagent. Encoded into `src/lib/ai/knowledge-base.ts`. 53 intents across 10 categories.

---

I now have everything I need. The exact constraints are locked in:

- **`issueType` enum (the ONLY legal values):** `heating_not_working`, `cooling_not_working`, `thermostat_issue`, `air_quality`, `strange_noises`, `water_leak`, `maintenance`, `installation`, `other`
- **`urgency` enum:** `low`, `medium`, `high`, `emergency`
- **Required slots before SUBMIT:** `issueType`, `urgency`, `address`. Optional: `name`, `phone`, `email`.
- **System-prompt rules:** never give DIY repair steps, never promise pricing/scheduling, redirect non-HVAC, escalate to human on frustration or >15 turns.

Here is the complete catalog.

---

# HVAC Deterministic Answers & Actions Catalog

This catalog defines a deterministic "answers & actions" layer that resolves common customer messages **without an LLM call**. It maps each intent to a fixed action, a canned response, the slots still needed, and the exact `issueType` / `urgency` enum values from `src/lib/ai/extraction-schema.ts`. Anything not confidently matched falls back to Qwen.

**Hard constraints honored throughout (from `system-prompt.ts`):**
- Never give DIY repair instructions.
- Never promise pricing or scheduling specifics.
- Redirect non-HVAC requests politely.
- Escalate to a human on safety issues, explicit requests, frustration, or long conversations.
- Keep responses warm and concise (1-3 sentences).

> Note on `issueType` enum: there is **no dedicated `emergency` issueType**. Emergencies are encoded via `urgencyHint: 'emergency'` plus the closest issueType (`heating_not_working`, `cooling_not_working`, `water_leak`, or `other` for gas/CO/electrical). The router should treat the **`ESCALATE` action** — not the issueType — as the safety signal.

---

## MATCHING STRATEGY (recommended for the deterministic router)

### 1. Normalization pipeline (apply before any matching)
1. Lowercase the entire message.
2. Trim and collapse internal whitespace.
3. Strip punctuation **except** `#`, `+`, and digits (needed for reference numbers, phone, "co2"/"co").
4. Normalize common contractions/typos via an alias map: `ac`/`a/c`/`a.c.`→`air conditioner`, `furnace`/`heater`, `temp`→`temperature`, `thermo`/`tstat`→`thermostat`, `co`/`co2`/`carbon monoxide`→`carbon monoxide`, `cant`→`cant`/`can't` (treat as same), `wont`/`won't` same, `noheat`→`no heat`.
5. Keep a copy of the raw message for the LLM fallback payload.

### 2. Scoring model
- Each intent has weighted **`triggerKeywords`** (multi-word phrases score higher than single tokens).
- Score = sum of matched keyword weights, with phrase matches (e.g., `"gas smell"`) weighted ~3x single tokens (e.g., `"gas"`).
- Apply **negation guards**: if a negation precedes a keyword (`"no gas smell"`, `"alarm is NOT going off"`), suppress that intent's safety match and lower confidence.
- Compute a normalized **confidence** in [0,1] = (top intent score) / (top score + runner-up score + smoothing constant). This captures both absolute evidence and separation from the next-best intent.

### 3. Priority ordering (evaluate in this order, short-circuit on safety)
1. **EMERGENCY/SAFETY first, always.** If any emergency trigger fires above its (low) threshold, immediately `ESCALATE` regardless of other matches. Safety beats everything — false positives here are acceptable; false negatives are not.
2. **EXISTING REQUEST / ACCOUNT** (reference number pattern `ref-?\w+`, "my appointment", "speak to a human").
3. **Issue intents** (cooling/heating/air quality/thermostat).
4. **Maintenance / scheduling / FAQ / business info.**
5. **Conversational / meta** (greetings, thanks) — lowest priority so they don't shadow a real issue mentioned in the same message.

### 4. Confidence thresholds
- `confidence ≥ 0.70` → act on the matched intent deterministically.
- `0.45 ≤ confidence < 0.70` → act **only** for `ANSWER`/FAQ-type intents where a wrong canned answer is low-harm; otherwise `FALLBACK_LLM`.
- `confidence < 0.45` → `FALLBACK_LLM`.
- **Emergency override:** emergency intents use a much lower threshold (~0.25) AND bypass the "must beat runner-up" rule — if a gas/CO/burning/flooding token appears, escalate.

### 5. Multi-intent messages
- If two non-emergency intents both clear threshold and are far apart in score, take the higher one but pass the full message to the next `COLLECT_INFO` turn.
- If they are close in score (ambiguous), `FALLBACK_LLM` — the LLM disambiguates better than canned text.
- If **any** emergency intent co-occurs with a non-emergency one, the emergency wins (e.g., "my AC is broken and I smell something burning" → escalate).

### 6. COLLECT_INFO interaction with known slots (don't re-ask)
- The router receives the session's current extraction state (`issueType`, `urgency`, `address`, `name`, `phone`, `email`).
- When an intent's `infoNeeded` lists a slot **already filled**, drop it from the ask.
- After classifying an issue intent, set `issueType`/`urgencyHint` into state, then ask **only for the first still-missing required slot** (priority: `address` > `urgency` if not inferable > confirm). Required set is `issueType, urgency, address`.
- When all three required slots are present, the next deterministic step is **`SUBMIT`** (show confirmation card) regardless of which intent triggered it.
- Phone/email/name are optional — never block submission on them; offer once, don't nag.

### 7. When in doubt, fall back
The router is a cost optimizer, not the brain. If normalization is messy, confidence is low, the message is long/compound, or it matches a known-ambiguous pattern (see final section), emit `FALLBACK_LLM` and let Qwen handle it. A wrong canned answer is worse than a cheap LLM call.

---

## Category 1 — EMERGENCY / SAFETY

All emergency intents → `action: ESCALATE`, `urgencyHint: emergency`. They must surface a human/phone path immediately and never give repair or "go investigate" instructions. The canned text follows a "get to safety + we're escalating" pattern. **No LLM call.**

---

### `emergency-gas-smell`
- **category:** emergency
- **title:** Gas smell / suspected gas leak
- **examplePhrasings:**
  - "I smell gas near my furnace"
  - "there's a strong gas smell in my house"
  - "smells like rotten eggs by the heater"
  - "i think i have a gas leak"
  - "natural gas odor in the basement"
  - "gas smell wont go away"
  - "i smell propane"
- **triggerKeywords:** `gas smell`, `smell gas`, `gas leak`, `rotten eggs`, `smell of gas`, `propane smell`, `natural gas` (ambiguous: bare `gas` alone — e.g., "gas furnace" — must NOT trigger; require pairing with smell/leak/odor)
- **action:** ESCALATE
- **cannedResponse:** "A gas smell can be dangerous — please leave your home right now, avoid using any switches, phones, or flames inside, and once you're safely outside call your gas utility's emergency line or 911. I'm flagging this as an emergency so our team can follow up right away."
- **infoNeeded:** (none deterministically — safety first; capture address only after they're safe)
- **issueTypeMapping:** other
- **urgencyHint:** emergency
- **notes:** Highest priority. Do not ask them to inspect the furnace. Distinguish from `heating-strange-smell-startup` (a brief burning/dusty smell on first furnace startup is normal-ish and is NOT a gas emergency).

---

### `emergency-carbon-monoxide`
- **category:** emergency
- **title:** Carbon monoxide alarm / CO symptoms
- **examplePhrasings:**
  - "my carbon monoxide detector is going off"
  - "CO alarm beeping"
  - "co2 detector going off near the furnace"
  - "we feel dizzy and the CO alarm sounded"
  - "carbon monoxide alarm wont stop"
  - "headache and nausea, think it's the furnace"
- **triggerKeywords:** `carbon monoxide`, `co alarm`, `co detector`, `co2 alarm` (colloquial), `co2 detector` (ambiguous: "co" can be noise; require alarm/detector/poisoning context)
- **action:** ESCALATE
- **cannedResponse:** "A carbon monoxide alarm is a serious emergency — please get everyone (and pets) outside to fresh air immediately and call 911 once you're out. I'm marking this urgent so our team can follow up right away."
- **infoNeeded:** (none deterministically — safety first)
- **issueTypeMapping:** other
- **urgencyHint:** emergency
- **notes:** CO symptoms (dizzy/nausea/headache + furnace) should also escalate. Never tell them to reset the alarm or check the unit.

---

### `emergency-electrical-burning-smell`
- **category:** emergency
- **title:** Electrical / burning smell or smoke from HVAC
- **examplePhrasings:**
  - "burning smell coming from my furnace"
  - "smells like burning plastic from the vents"
  - "i see smoke from my AC unit"
  - "electrical burning smell from the heater"
  - "something is burning and the breaker tripped"
  - "smells like hot wires / melting"
- **triggerKeywords:** `burning smell`, `smell burning`, `burning plastic`, `electrical smell`, `smoke`, `melting`, `sparks`, `hot wires` (ambiguous: brief "burning/dusty smell when furnace first turns on" → see `heating-strange-smell-startup`; persistent/plastic/smoke = emergency)
- **action:** ESCALATE
- **cannedResponse:** "A burning or electrical smell — or any smoke — is a fire risk. Please turn off the system at the thermostat or breaker if you can do so safely, leave the area, and call 911 if you see smoke or flames. I'm flagging this as an emergency for our team."
- **infoNeeded:** (none deterministically)
- **issueTypeMapping:** other
- **urgencyHint:** emergency
- **notes:** Ambiguity with startup dust smell is the main risk; "burning plastic", "smoke", "sparks", "won't go away" push it to emergency. When genuinely unclear → `FALLBACK_LLM`.

---

### `emergency-flooding`
- **category:** emergency
- **title:** Active flooding / major water from HVAC
- **examplePhrasings:**
  - "water is flooding out of my furnace"
  - "my AC is pouring water all over the floor"
  - "the water heater burst and there's water everywhere"
  - "flooding from the HVAC unit in the attic, coming through the ceiling"
  - "boiler is leaking a lot of water fast"
- **triggerKeywords:** `flooding`, `pouring water`, `water everywhere`, `burst`, `gushing`, `flood` (ambiguous: a small drip/condensation is `cooling-water-leak`, not an emergency — require flood/burst/pouring/everywhere)
- **action:** ESCALATE
- **cannedResponse:** "That sounds like a serious leak. If you can safely reach it, shut off the water supply to the unit and turn off power to it at the breaker, then move valuables away from the water. I'm flagging this as urgent so our team can respond quickly — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** water_leak
- **urgencyHint:** emergency
- **notes:** Distinguish from routine `cooling-water-leak` (slow drip = high, not emergency). "Burst", "flooding", "pouring", "everywhere", "through the ceiling" = emergency.

---

### `emergency-no-heat-freezing`
- **category:** emergency
- **title:** No heat in freezing / dangerously cold conditions
- **examplePhrasings:**
  - "no heat and it's below freezing outside"
  - "furnace is dead and it's freezing in here, we have a newborn"
  - "heat is out and the pipes might freeze"
  - "no heat, it's like 10 degrees, elderly parent at home"
  - "house is freezing, heater completely stopped"
- **triggerKeywords:** `no heat` + `freezing`/`below freezing`/`pipes freeze`/`newborn`/`elderly`/`baby`, `freezing in here`, `frozen pipes` (ambiguous: "no heat" alone in mild weather is `heating-not-heating` at high, not emergency — the cold/vulnerable-person qualifier is what escalates)
- **action:** ESCALATE
- **cannedResponse:** "No heat in freezing weather is an emergency, especially with vulnerable family members at home — please keep everyone warm with blankets and layers and use safe backup heat if you have it. I'm flagging this as urgent so our team can prioritize you. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** emergency
- **notes:** Per system prompt, "no heat in freezing weather" is explicitly emergency. Without the freezing/vulnerable qualifier, route to `heating-not-heating` (high). Never suggest unsafe space-heater/oven workarounds — only "safe backup heat if you have it."

---

### `emergency-no-cooling-extreme-heat-vulnerable`
- **category:** emergency
- **title:** No cooling in extreme heat with vulnerable people
- **examplePhrasings:**
  - "no AC and it's 105 outside, my mother is elderly"
  - "cooling is out, heat wave, we have an infant"
  - "house is dangerously hot and AC died, someone here has a medical condition"
  - "no air conditioning during a heat advisory, elderly at home"
- **triggerKeywords:** `no ac`/`no cooling`/`ac out` + `heat wave`/`heat advisory`/`105`/`extreme heat`/`elderly`/`infant`/`newborn`/`medical condition`/`dangerously hot` (ambiguous: plain "AC not cooling" is `cooling-not-cooling` at high — extreme-heat + vulnerable qualifier escalates)
- **action:** ESCALATE
- **cannedResponse:** "No cooling in extreme heat can be a health risk for vulnerable people — please move to the coolest room, hydrate, and use fans or a cooling center if you can. I'm flagging this as urgent so our team can prioritize you. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** emergency
- **notes:** Mirror of the no-heat case. Plain "AC not cooling" → `cooling-not-cooling` (high). The heat-wave/vulnerable qualifier is the discriminator.

---

## Category 2 — COOLING ISSUES

Default `issueTypeMapping: cooling_not_working` unless noted (noises→`strange_noises`, leaks→`water_leak`). Default `urgencyHint: high` for "no cooling" per system prompt ("AC out in extreme heat" / discomfort), `medium` for noises/efficiency. These are `COLLECT_INFO` — we recognized the issue and now need the address.

---

### `cooling-not-cooling`
- **category:** cooling
- **title:** AC running but not cooling / blowing warm air
- **examplePhrasings:**
  - "my AC is running but not cooling the house"
  - "air conditioner just blows warm air"
  - "ac on but house still hot"
  - "cool air isn't coming out, it's lukewarm"
  - "a/c not keeping up, never reaches set temp"
  - "ac blowing hot air"
- **triggerKeywords:** `not cooling`, `blows warm air`, `warm air`, `not cold`, `wont cool`, `still hot`, `lukewarm air`, `ac` + `warm`/`hot` (ambiguous: "blowing cold air" from a HEATING system is the opposite problem → `heating-blowing-cold`)
- **action:** COLLECT_INFO
- **cannedResponse:** "I'm sorry your AC isn't keeping up — that's frustrating in this weather. I can get a technician out to look at it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** high
- **notes:** If they mention extreme heat + vulnerable people → re-route to `emergency-no-cooling-extreme-heat-vulnerable`.

---

### `cooling-wont-turn-on`
- **category:** cooling
- **title:** AC won't turn on at all
- **examplePhrasings:**
  - "my AC won't turn on at all"
  - "nothing happens when I set the thermostat to cool"
  - "air conditioner is completely dead"
  - "ac unit not starting"
  - "outside unit won't kick on"
- **triggerKeywords:** `ac wont turn on`, `wont start`, `not starting`, `completely dead`, `nothing happens`, `wont kick on`, `no power` + `ac` (ambiguous: blank thermostat → `thermostat-blank`; if they say the thermostat screen is dead, prefer thermostat intent)
- **action:** COLLECT_INFO
- **cannedResponse:** "Sorry your AC won't start — let's get a technician out to diagnose it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** high
- **notes:** Overlaps with thermostat-dead; if the customer attributes it to a blank/dead thermostat, route to `thermostat-blank` instead.

---

### `cooling-water-leak`
- **category:** cooling
- **title:** AC leaking / dripping water indoors
- **examplePhrasings:**
  - "my AC is leaking water inside the house"
  - "water dripping from the indoor AC unit"
  - "puddle under the air handler"
  - "ac drip pan overflowing"
  - "condensation leaking from the ceiling vent"
- **triggerKeywords:** `ac leaking water`, `leaking water`, `dripping water`, `water under`, `drip pan`, `puddle`, `condensate` (ambiguous: large volume / "pouring"/"flooding" → `emergency-flooding`; "no hot water" is heating, not a leak)
- **action:** COLLECT_INFO
- **cannedResponse:** "A leaking AC should be looked at before it causes water damage. If it's safe, place a towel or bucket under the drip and I'll get a technician scheduled. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** water_leak
- **urgencyHint:** high
- **notes:** Volume is the discriminator vs `emergency-flooding`. No DIY beyond "catch the drip."

---

### `cooling-frozen-coil-ice`
- **category:** cooling
- **title:** Ice / frozen coil on AC unit
- **examplePhrasings:**
  - "there's ice on my AC unit"
  - "the refrigerant line is frozen / covered in ice"
  - "ice buildup on the indoor coil"
  - "my ac froze up"
  - "frost all over the outdoor unit"
- **triggerKeywords:** `ice on`, `frozen coil`, `froze up`, `ice buildup`, `frost on`, `frozen line` (ambiguous: "frozen pipes" in a heating context → `emergency-no-heat-freezing`; here it's the AC/refrigerant)
- **action:** COLLECT_INFO
- **cannedResponse:** "Ice on the unit usually means it needs attention before it's damaged — it's best to turn the cooling off and let it thaw while we get a technician out. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** medium
- **notes:** "Turn it off to let it thaw" is operational guidance, not a repair instruction — acceptable. Don't tell them to add refrigerant or open the unit.

---

### `cooling-short-cycling`
- **category:** cooling
- **title:** AC short cycling (turns on/off repeatedly)
- **examplePhrasings:**
  - "my AC keeps turning on and off"
  - "ac short cycles every few minutes"
  - "cooling cycles on and off constantly"
  - "compressor kicks on then shuts off right away"
- **triggerKeywords:** `turning on and off`, `on and off`, `short cycle`, `short cycling`, `cycles constantly`, `keeps shutting off` (ambiguous: also applies to heating → see `heating-short-cycling`; key off `ac`/`cooling`/`compressor` context)
- **action:** COLLECT_INFO
- **cannedResponse:** "Short cycling like that can stress the system, so it's worth having checked. I can arrange a technician visit — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** medium
- **notes:** Same phrasing as heating short-cycling; disambiguate on cooling/AC vs furnace/heat keywords. If neither is clear → `FALLBACK_LLM`.

---

### `cooling-noises`
- **category:** cooling
- **title:** AC making unusual noises
- **examplePhrasings:**
  - "my air conditioner is making a loud grinding noise"
  - "ac is buzzing / rattling"
  - "banging sound from the outdoor unit"
  - "screeching noise when the ac runs"
  - "humming and clicking from the compressor"
- **triggerKeywords:** `grinding`, `buzzing`, `rattling`, `banging`, `screeching`, `clicking`, `loud noise` + `ac`/`cooling`/`outdoor unit`/`compressor` (ambiguous: noise from a furnace → `heating-noises`; both map to `strange_noises`)
- **action:** COLLECT_INFO
- **cannedResponse:** "Unusual noises are worth checking before they turn into a bigger problem. I can get a technician out to take a look — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** strange_noises
- **urgencyHint:** medium
- **notes:** Maps to `strange_noises` (not cooling_not_working). Loud banging + "stop using it" tone could be escalated; otherwise medium.

---

### `cooling-outdoor-unit-not-running`
- **category:** cooling
- **title:** Outdoor condenser/fan not running
- **examplePhrasings:**
  - "the outside fan isn't spinning"
  - "outdoor unit isn't running but the inside blows"
  - "condenser fan not turning"
  - "the big unit outside is silent"
- **triggerKeywords:** `outdoor unit`, `outside fan`, `condenser`, `fan not spinning`, `fan not turning`, `unit outside not running` (ambiguous: weak airflow at vents → `airquality-weak-airflow`)
- **action:** COLLECT_INFO
- **cannedResponse:** "If the outdoor unit isn't running, the system can't cool properly and should be inspected. I can schedule a technician — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** high
- **notes:** Distinct from indoor airflow issues. Don't advise poking the fan.

---

### `cooling-refrigerant-concern`
- **category:** cooling
- **title:** Low refrigerant / "needs a recharge"
- **examplePhrasings:**
  - "i think my ac is low on freon"
  - "does my ac need a refrigerant recharge"
  - "ac low on refrigerant"
  - "can you recharge my ac"
- **triggerKeywords:** `freon`, `refrigerant`, `recharge`, `low on coolant` (ambiguous: customer self-diagnosis may be wrong — frozen coil/airflow can mimic this)
- **action:** COLLECT_INFO
- **cannedResponse:** "Refrigerant levels need to be checked and handled by a licensed technician. I can set up a visit to diagnose it properly — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** cooling_not_working
- **urgencyHint:** medium
- **notes:** Never quote refrigerant pricing or confirm a recharge is needed (that's a tech diagnosis). Refrigerant handling is regulated — emphasize licensed tech.

---

## Category 3 — HEATING ISSUES

Default `issueTypeMapping: heating_not_working`. Default `urgencyHint: high` for no-heat (per "heating out in cold weather"), `medium` for noises/efficiency. `COLLECT_INFO` → need address.

---

### `heating-not-heating`
- **category:** heating
- **title:** Furnace running but house not warming
- **examplePhrasings:**
  - "my furnace is running but the house isn't getting warm"
  - "heat is on but it's still cold"
  - "furnace blows but no real heat"
  - "heater running, house won't warm up"
- **triggerKeywords:** `not getting warm`, `still cold`, `not heating`, `no real heat`, `wont warm up` + `furnace`/`heat`/`heater` (ambiguous: "blowing cold air" → `heating-blowing-cold`; freezing-temp qualifier → `emergency-no-heat-freezing`)
- **action:** COLLECT_INFO
- **cannedResponse:** "Sorry you're not getting the heat you need — let's get a technician out to diagnose it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** Escalate if freezing weather / vulnerable occupants are mentioned.

---

### `heating-wont-ignite`
- **category:** heating
- **title:** Furnace won't ignite / won't start
- **examplePhrasings:**
  - "my furnace won't ignite when I turn the heat on"
  - "furnace won't start up"
  - "heater clicks but won't light"
  - "no ignition on the furnace"
  - "furnace dead, won't fire up"
- **triggerKeywords:** `wont ignite`, `wont start`, `wont light`, `no ignition`, `wont fire up`, `clicks but` + `furnace`/`heater` (ambiguous: gas smell present → `emergency-gas-smell`; pilot-specific → `heating-pilot-out`)
- **action:** COLLECT_INFO
- **cannedResponse:** "A furnace that won't ignite needs a technician's eye — I can get a visit scheduled. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** If any gas smell is mentioned, immediately escalate instead. Never give relight instructions.

---

### `heating-pilot-out`
- **category:** heating
- **title:** Pilot light out
- **examplePhrasings:**
  - "the pilot light on my furnace went out"
  - "pilot light keeps going out"
  - "can't relight the pilot"
  - "water heater pilot is out"
- **triggerKeywords:** `pilot light`, `pilot out`, `pilot went out`, `relight pilot`, `pilot keeps going out` (ambiguous: "water heater pilot" overlaps with `heating-no-hot-water`; gas smell → emergency)
- **action:** COLLECT_INFO
- **cannedResponse:** "Relighting a pilot can involve gas, so it's safest to let a technician handle it — and if you ever smell gas, leave and call your gas company. I can schedule a visit; what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** Per "no DIY repair instructions," do NOT give relight steps. Pair with gas-safety reminder. If it's a water heater pilot, still heating_not_working is acceptable (no dedicated water-heater enum).

---

### `heating-blowing-cold`
- **category:** heating
- **title:** Furnace blowing cold air
- **examplePhrasings:**
  - "my furnace is blowing cold air"
  - "heat is set to warm but cold air comes out"
  - "heater only blows cold"
  - "vents blowing cold air in heat mode"
- **triggerKeywords:** `blowing cold air`, `blows cold`, `cold air` + `heat`/`furnace`/`heater` (ambiguous: opposite of `cooling-not-cooling` "blowing warm air" — must key on heat/furnace context, NOT AC)
- **action:** COLLECT_INFO
- **cannedResponse:** "Cold air when you're calling for heat usually means something needs attention — I can get a technician out. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** Critical disambiguation from cooling (warm air = AC; cold air = furnace). If "AC" appears, do not match this.

---

### `heating-short-cycling`
- **category:** heating
- **title:** Furnace short cycling
- **examplePhrasings:**
  - "my furnace keeps turning on and off"
  - "heater short cycles"
  - "furnace cycles on and off every couple minutes"
  - "heat kicks on then shuts off quickly"
- **triggerKeywords:** `turning on and off`, `short cycle`, `cycles on and off`, `kicks on then shuts off` + `furnace`/`heat`/`heater` (ambiguous: same phrasing as `cooling-short-cycling` — disambiguate on heat vs AC)
- **action:** COLLECT_INFO
- **cannedResponse:** "Short cycling can wear out the system, so it's good to have it checked. I can arrange a technician visit — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** medium
- **notes:** If neither heat nor AC context is present → `FALLBACK_LLM`.

---

### `heating-strange-smell-startup`
- **category:** heating
- **title:** Smell when heat first turns on (seasonal/dust)
- **examplePhrasings:**
  - "there's a dusty/burning smell when the furnace first turns on"
  - "heater smells like dust the first time I run it this season"
  - "slight burning smell when heat starts, goes away"
  - "musty smell when I first turned the heat on"
- **triggerKeywords:** `smell when` + `heat`/`furnace` + `first`/`turns on`/`startup`/`this season`, `dusty smell`, `goes away` (ambiguous: HIGH overlap with `emergency-electrical-burning-smell` — "burning plastic"/"smoke"/"persistent" must escalate, NOT match here)
- **action:** FALLBACK_LLM
- **cannedResponse:** (none — deferred to LLM)
- **infoNeeded:** —
- **issueTypeMapping:** air_quality
- **urgencyHint:** low
- **notes:** **Deliberately FALLBACK_LLM.** The line between "harmless first-of-season dust burn-off" and "dangerous burning smell" is too risky to canned-answer. Let the LLM probe (persistent? plastic? smoke?) before deciding. Safer to spend the LLM call than to wrongly reassure someone about a real fire/CO hazard.

---

### `heating-no-hot-water`
- **category:** heating
- **title:** Water heater — no hot water
- **examplePhrasings:**
  - "my water heater stopped producing hot water"
  - "no hot water in the house"
  - "water heater not heating"
  - "only cold water from the taps"
  - "hot water ran out and won't come back"
- **triggerKeywords:** `no hot water`, `water heater`, `hot water`, `cold water only`, `water heater not heating` (ambiguous: "water leak from water heater" → could be `water_leak`/`emergency-flooding`; "pilot out on water heater" → `heating-pilot-out`)
- **action:** COLLECT_INFO
- **cannedResponse:** "No hot water is a real hassle — I can get a technician out to look at your water heater. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** No dedicated water-heater enum; `heating_not_working` is the closest. If the company doesn't service water heaters, this is a candidate for `FALLBACK_LLM` or a business-scope answer — confirm scope with engineering.

---

### `heating-heat-pump-issue`
- **category:** heating
- **title:** Heat pump not heating / stuck in defrost / auxiliary heat
- **examplePhrasings:**
  - "my heat pump isn't heating"
  - "heat pump running constantly but not warm"
  - "heat pump stuck in defrost mode"
  - "aux heat / emergency heat keeps coming on"
  - "outdoor heat pump iced over in winter"
- **triggerKeywords:** `heat pump`, `defrost mode`, `aux heat`, `auxiliary heat`, `emergency heat`/`em heat`, `heat pump iced` (ambiguous: "emergency heat" mode is NOT a safety emergency — do not escalate on the word "emergency" here; "iced over" overlaps with `cooling-frozen-coil-ice`)
- **action:** COLLECT_INFO
- **cannedResponse:** "Heat pumps can act up in a few different ways — let's get a technician to diagnose it properly. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** heating_not_working
- **urgencyHint:** high
- **notes:** Important negation guard: "emergency heat" / "em heat" is an HVAC mode, **not** a safety emergency. The emergency router must whitelist this phrase so it doesn't trigger `ESCALATE`.

---

### `heating-noises`
- **category:** heating
- **title:** Furnace making unusual noises
- **examplePhrasings:**
  - "my furnace is making a loud banging noise"
  - "rumbling sound from the furnace"
  - "furnace squeals when it starts"
  - "rattling / clanking from the heater"
- **triggerKeywords:** `banging`, `rumbling`, `squealing`, `rattling`, `clanking`, `loud noise` + `furnace`/`heater`/`heat` (ambiguous: loud bang on ignition + gas could be delayed-ignition; if gas mentioned → escalate)
- **action:** COLLECT_INFO
- **cannedResponse:** "Unusual furnace noises are worth checking before they get worse. I can get a technician out — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** strange_noises
- **urgencyHint:** medium
- **notes:** Maps to `strange_noises`. A loud "boom/bang" on startup with gas smell → `emergency-gas-smell`.

---

## Category 4 — AIR QUALITY / AIRFLOW

Default `issueTypeMapping: air_quality`. `urgencyHint: low`-`medium`. `COLLECT_INFO`.

---

### `airquality-musty-smell`
- **category:** air_quality
- **title:** Musty / moldy smell from vents
- **examplePhrasings:**
  - "musty smell coming from my air vents"
  - "vents smell moldy"
  - "moldy / mildew odor when the AC runs"
  - "stale smell from the ducts"
- **triggerKeywords:** `musty smell`, `moldy`, `mildew`, `stale smell`, `smell from vents` + musty/mold (ambiguous: "burning" smell → emergency/startup; "gas/rotten egg" → emergency)
- **action:** COLLECT_INFO
- **cannedResponse:** "A musty smell from the vents is something we can check out — it's often related to moisture or the ducts. I can schedule a technician; what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** air_quality
- **urgencyHint:** low
- **notes:** Only match musty/moldy/mildew — burning/gas/electrical smells must route to emergency intents.

---

### `airquality-weak-airflow`
- **category:** air_quality
- **title:** Weak / low airflow from vents
- **examplePhrasings:**
  - "the airflow from my vents is very weak"
  - "barely any air coming out of the vents"
  - "weak airflow throughout the house"
  - "vents barely blowing"
- **triggerKeywords:** `weak airflow`, `low airflow`, `barely any air`, `no air from vents`, `weak air` (ambiguous: "outdoor fan not spinning" → `cooling-outdoor-unit-not-running`; could also just need a filter → mention in canned)
- **action:** COLLECT_INFO
- **cannedResponse:** "Weak airflow can have a few causes, sometimes as simple as a clogged filter. I can get a technician to take a look — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** air_quality
- **urgencyHint:** medium
- **notes:** Mentioning "clogged filter" is informational, not a repair instruction. Overlaps with `maintenance-filter`.

---

### `airquality-excessive-dust`
- **category:** air_quality
- **title:** Excessive dust in home
- **examplePhrasings:**
  - "there's excessive dust in my house even after cleaning"
  - "so much dust, I think it's from the HVAC"
  - "dust everywhere coming from the vents"
- **triggerKeywords:** `excessive dust`, `too much dust`, `dust from vents`, `dust everywhere` (ambiguous: low risk, but overlaps with filter/duct cleaning maintenance)
- **action:** COLLECT_INFO
- **cannedResponse:** "Excess dust can sometimes point to filtration or duct issues — a technician can assess it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** air_quality
- **urgencyHint:** low
- **notes:** Could also be a duct-cleaning lead (`maintenance-duct-cleaning`).

---

### `airquality-humidity`
- **category:** air_quality
- **title:** Humidity problems (too humid / too dry)
- **examplePhrasings:**
  - "my house is too humid even with the AC on"
  - "air is way too dry in winter"
  - "high humidity inside, feels sticky"
  - "need a humidifier / dehumidifier looked at"
- **triggerKeywords:** `too humid`, `humidity`, `too dry`, `sticky air`, `humidifier`, `dehumidifier` (ambiguous: humidity + water = could be a leak, but usually distinct)
- **action:** COLLECT_INFO
- **cannedResponse:** "Indoor humidity issues are something we can help with — a technician can evaluate your system and options. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** air_quality
- **urgencyHint:** low
- **notes:** Don't recommend a specific product or quote a humidifier install price.

---

### `airquality-uneven-temps`
- **category:** air_quality
- **title:** Uneven temperatures room to room
- **examplePhrasings:**
  - "some rooms are hot and some are cold"
  - "upstairs is way warmer than downstairs"
  - "one room never gets cool"
  - "uneven heating/cooling around the house"
- **triggerKeywords:** `some rooms`, `uneven`, `hot and cold`, `upstairs warmer`, `one room`, `wont cool that room` (ambiguous: could be a zoning/airflow/duct issue; not an emergency)
- **action:** COLLECT_INFO
- **cannedResponse:** "Uneven temperatures usually come down to airflow, ductwork, or balancing — a technician can pinpoint it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** air_quality
- **urgencyHint:** low
- **notes:** Overlaps with airflow/duct intents; air_quality is the closest enum.

---

## Category 5 — THERMOSTAT

Default `issueTypeMapping: thermostat_issue`, `urgencyHint: medium`. Mostly `COLLECT_INFO`; smart-thermostat setup is a softer case.

---

### `thermostat-blank`
- **category:** thermostat
- **title:** Thermostat blank / dead screen
- **examplePhrasings:**
  - "my thermostat screen is blank"
  - "thermostat display is dead / no display"
  - "nothing on the thermostat screen"
  - "tstat went blank"
- **triggerKeywords:** `thermostat blank`, `blank screen`, `dead screen`, `no display`, `thermostat off`, `screen blank` (ambiguous: a blank thermostat can cause `cooling-wont-turn-on`/no heat — prefer this intent when the screen is the stated symptom)
- **action:** COLLECT_INFO
- **cannedResponse:** "A blank thermostat can stop the whole system from running — sometimes it's batteries, but it's worth a proper check. I can get a technician out; what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** thermostat_issue
- **urgencyHint:** medium
- **notes:** "Sometimes it's batteries" is a gentle hint, not a repair walk-through. If combined with no-heat-in-freezing, escalate.

---

### `thermostat-unresponsive`
- **category:** thermostat
- **title:** Thermostat unresponsive / buttons not working
- **examplePhrasings:**
  - "my thermostat isn't responding"
  - "buttons on the thermostat do nothing"
  - "thermostat frozen, won't change temp"
  - "touchscreen thermostat not reacting"
- **triggerKeywords:** `thermostat not responding`, `unresponsive`, `buttons do nothing`, `wont change temp`, `frozen thermostat` (ambiguous: "frozen" overlaps with ice intents — key on thermostat context)
- **action:** COLLECT_INFO
- **cannedResponse:** "If the thermostat isn't responding, the system can't be controlled properly — let's have a technician check it. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** thermostat_issue
- **urgencyHint:** medium
- **notes:** "Frozen" here means UI-frozen, not iced — disambiguate on thermostat keyword.

---

### `thermostat-wrong-reading`
- **category:** thermostat
- **title:** Thermostat showing wrong temperature
- **examplePhrasings:**
  - "my thermostat shows the wrong temperature"
  - "thermostat reads 80 but it's cold in here"
  - "temp reading is way off"
  - "thermostat inaccurate"
- **triggerKeywords:** `wrong temperature`, `wrong temp`, `reading is off`, `inaccurate`, `shows wrong`, `temp is off` (ambiguous: could be a sensor/placement issue; low risk)
- **action:** COLLECT_INFO
- **cannedResponse:** "A thermostat reading that's off can throw off your whole system — a technician can check the sensor and placement. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** thermostat_issue
- **urgencyHint:** medium
- **notes:** —

---

### `thermostat-wont-hold-schedule`
- **category:** thermostat
- **title:** Thermostat won't hold settings / schedule
- **examplePhrasings:**
  - "my thermostat won't hold the schedule"
  - "thermostat keeps resetting to a different temp"
  - "programmed schedule doesn't stick"
  - "thermostat changes on its own"
- **triggerKeywords:** `wont hold`, `keeps resetting`, `schedule doesnt stick`, `changes on its own`, `wont keep schedule` (ambiguous: smart-thermostat behavior/learning could explain it → see setup intent)
- **action:** COLLECT_INFO
- **cannedResponse:** "If your thermostat won't hold its schedule, a technician can check the settings and wiring. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** thermostat_issue
- **urgencyHint:** low
- **notes:** —

---

### `thermostat-smart-setup`
- **category:** thermostat
- **title:** Smart thermostat installation / setup help
- **examplePhrasings:**
  - "can you install a Nest thermostat for me"
  - "i need help setting up my ecobee"
  - "want to upgrade to a smart thermostat"
  - "how do I wire a smart thermostat"
- **triggerKeywords:** `smart thermostat`, `nest`, `ecobee`, `honeywell home`, `install thermostat`, `setup thermostat`, `upgrade thermostat` (ambiguous: install request leans toward `installation` issueType; "how do I wire" is a DIY ask → must not give wiring steps)
- **action:** COLLECT_INFO
- **cannedResponse:** "We can help with smart thermostat installation and setup — a technician will make sure it's wired and configured correctly for your system. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** installation
- **urgencyHint:** low
- **notes:** Maps to `installation` (not thermostat_issue) since it's a new install. Never give wiring/DIY instructions even if they ask "how do I wire it."

---

## Category 6 — MAINTENANCE / TUNE-UP

Default `issueTypeMapping: maintenance`, `urgencyHint: low`. `COLLECT_INFO`.

---

### `maintenance-tuneup`
- **category:** maintenance
- **title:** Annual tune-up / maintenance check
- **examplePhrasings:**
  - "I'd like to schedule an annual HVAC tune-up"
  - "book a maintenance check for my system"
  - "time for my yearly service"
  - "want a tune up before summer"
- **triggerKeywords:** `tune-up`, `tune up`, `maintenance check`, `annual service`, `yearly service`, `service my system` (ambiguous: "service" alone overlaps with scheduling/business; pair with maintenance/tune-up/annual)
- **action:** COLLECT_INFO
- **cannedResponse:** "Happy to set up a tune-up to keep your system running smoothly. I just need a couple of details — what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** maintenance
- **urgencyHint:** low
- **notes:** —

---

### `maintenance-filter`
- **category:** maintenance
- **title:** Filter replacement / what size filter
- **examplePhrasings:**
  - "I need help replacing my air filter"
  - "what size filter does my system need"
  - "how often should I change my filter"
  - "where do I buy the right filter"
  - "my filter is dirty, should I replace it"
- **triggerKeywords:** `air filter`, `filter replacement`, `change filter`, `filter size`, `what size filter`, `dirty filter` (ambiguous: "weak airflow" can stem from filter → `airquality-weak-airflow`)
- **action:** ANSWER
- **cannedResponse:** "Most home filters should be checked monthly and changed every 1-3 months. The right size is printed on the edge of your current filter (like 16x25x1) — if you'd like, I can schedule a technician to handle it during a visit."
- **infoNeeded:** (none — pure FAQ-style answer)
- **issueTypeMapping:** maintenance
- **urgencyHint:** low
- **notes:** This is borderline DIY, but "check the label for the size + change every 1-3 months" is general guidance, not a repair instruction — acceptable. If they then want a tech, transition to `COLLECT_INFO` (address).

---

### `maintenance-duct-cleaning`
- **category:** maintenance
- **title:** Duct cleaning
- **examplePhrasings:**
  - "do you do duct cleaning"
  - "i want my air ducts cleaned"
  - "schedule a duct cleaning"
  - "ductwork cleaning service"
- **triggerKeywords:** `duct cleaning`, `clean my ducts`, `air ducts cleaned`, `ductwork cleaning` (ambiguous: "dusty house" → `airquality-excessive-dust`)
- **action:** COLLECT_INFO
- **cannedResponse:** "We can arrange a duct cleaning for you. To get started, what's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** maintenance
- **urgencyHint:** low
- **notes:** Don't quote duct-cleaning pricing.

---

### `maintenance-seasonal-prep`
- **category:** maintenance
- **title:** Seasonal prep (AC for summer / furnace for winter)
- **examplePhrasings:**
  - "i want to get my AC ready for summer"
  - "furnace check before winter"
  - "seasonal tune up for heating"
  - "get my system ready for the cold"
- **triggerKeywords:** `ready for summer`, `before winter`, `seasonal`, `prep my`, `winterize`, `get ready for` + season (ambiguous: overlaps with `maintenance-tuneup`)
- **action:** COLLECT_INFO
- **cannedResponse:** "Seasonal prep is a great way to avoid surprises — I can schedule that for you. What's the service address?"
- **infoNeeded:** address
- **issueTypeMapping:** maintenance
- **urgencyHint:** low
- **notes:** Effectively a tune-up variant; can share canned logic with `maintenance-tuneup`.

---

## Category 7 — SCHEDULING / BOOKING / DISPATCH

**Critical policy:** never promise specific times, dates, or "a tech will be there by X." Bookings become a service request; timing is confirmed by the team. `issueTypeMapping` is usually `null` until an issue is named (then inherit). `urgencyHint: null` unless stated.

---

### `scheduling-book-visit`
- **category:** scheduling
- **title:** Book a service visit (issue not yet specified)
- **examplePhrasings:**
  - "i want to book a service visit"
  - "can I schedule an appointment"
  - "need to set up a technician visit"
  - "book someone to come out"
- **triggerKeywords:** `book`, `schedule`, `appointment`, `set up a visit`, `come out`, `send a technician` (ambiguous: very generic — if an issue is also described, classify the issue first)
- **action:** COLLECT_INFO
- **cannedResponse:** "I'd be glad to set that up. First, can you tell me what HVAC issue you're experiencing so I can route the right technician?"
- **infoNeeded:** issueType, urgency, address
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** This is the "entry" scheduling intent. Once they describe the issue, hand off to the matching issue intent's slot collection. Don't promise a time.

---

### `scheduling-earliest-availability`
- **category:** scheduling
- **title:** Earliest availability / how soon
- **examplePhrasings:**
  - "what's the earliest you can come out"
  - "how soon can someone get here"
  - "do you have anything today"
  - "soonest appointment available"
- **triggerKeywords:** `earliest`, `how soon`, `soonest`, `availability`, `anything today`, `when can you come` (ambiguous: time-pressure may signal an emergency — check emergency triggers first)
- **action:** ANSWER
- **cannedResponse:** "Once your request is submitted, our team reviews it right away and reaches out to confirm the soonest available time — we aim to follow up within about 2 hours. If you describe your issue, I can get the request started."
- **infoNeeded:** (none — but nudge toward issue collection)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** The "within 2 hours follow-up" wording matches GUIDE.md's success-page promise. Never promise an arrival time.

---

### `scheduling-after-hours`
- **category:** scheduling
- **title:** After-hours / weekend / 24-7 availability
- **examplePhrasings:**
  - "are you open on weekends"
  - "do you do after hours service"
  - "can someone come out at night"
  - "is this 24/7"
- **triggerKeywords:** `after hours`, `weekend`, `at night`, `24/7`, `overnight`, `holiday` (ambiguous: paired with an emergency → escalate first)
- **action:** ANSWER
- **cannedResponse:** "We offer support around the clock, and after-hours or weekend visits depend on availability — submit your request and our team will confirm the soonest time. If it's an emergency like a gas smell or no heat in freezing weather, please tell me right away."
- **infoNeeded:** (none)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** GUIDE.md references "24/7 availability messaging" on the landing page. Don't over-promise specific weekend slots.

---

### `scheduling-how-long-until-tech`
- **category:** scheduling
- **title:** How long until a technician arrives
- **examplePhrasings:**
  - "how long until a tech gets here"
  - "what's the wait time"
  - "how long do I have to wait"
  - "eta on the technician"
- **triggerKeywords:** `how long`, `wait time`, `eta`, `how long until`, `time to arrive` (ambiguous: similar to earliest-availability)
- **action:** ANSWER
- **cannedResponse:** "After you submit a request, our team typically follows up within about 2 hours to confirm timing, and they'll give you an arrival window then. I can't promise an exact arrival time from here, but I can get your request started."
- **infoNeeded:** (none)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Explicitly disclaims exact ETAs per the no-scheduling-promise rule.

---

### `scheduling-reschedule`
- **category:** scheduling
- **title:** Reschedule an existing appointment
- **examplePhrasings:**
  - "i need to reschedule my appointment"
  - "can I move my visit to another day"
  - "change the time of my service"
  - "push my appointment back"
- **triggerKeywords:** `reschedule`, `move my appointment`, `change my appointment`, `different day`, `push back` (ambiguous: overlaps with `account-change-appointment`; both are "existing request" territory)
- **action:** COLLECT_INFO
- **cannedResponse:** "I can help get that updated. Do you have your reference number (it looks like REF-XXXXX), and what new day or time works better for you?"
- **infoNeeded:** (reference number — not a standard slot)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Reference number isn't in the slot set (`issueType/urgency/address/name/phone/email`). This likely needs a lookup the deterministic layer can't do → strong `FALLBACK_LLM` or human-handoff candidate if no reference flow exists. Confirm with engineering.

---

### `scheduling-cancel`
- **category:** scheduling
- **title:** Cancel an appointment / request
- **examplePhrasings:**
  - "i want to cancel my appointment"
  - "cancel my service request"
  - "i don't need the visit anymore"
  - "please cancel REF-12345"
- **triggerKeywords:** `cancel`, `cancel my appointment`, `dont need`, `cancel the visit`, `cancel request` (ambiguous: "cancel" could be mid-flow ("cancel, start over") vs canceling a booked job)
- **action:** COLLECT_INFO
- **cannedResponse:** "No problem — I can help with that. What's your reference number (like REF-XXXXX) so I can pull up the right request?"
- **infoNeeded:** (reference number)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Same reference-lookup caveat as reschedule. If "cancel" appears mid-intake (no booked job exists), treat as conversational reset, not a cancellation.

---

## Category 8 — BUSINESS INFO / FAQ

Mostly `action: ANSWER`, `issueTypeMapping: null`, `urgencyHint: null`, `infoNeeded: []`. **Hard rule: never quote prices.**

---

### `faq-service-area`
- **category:** faq
- **title:** Service area / "do you serve <city>"
- **examplePhrasings:**
  - "do you serve <city>"
  - "are you in my area"
  - "what areas do you cover"
  - "do you come out to <zip code>"
  - "is my town in your service area"
- **triggerKeywords:** `service area`, `do you serve`, `cover my area`, `in my area`, `come out to`, `service my zip` (ambiguous: a specific city/zip is dynamic data the static catalog may not know)
- **action:** ANSWER
- **cannedResponse:** "We serve a wide local area. If you share your address or zip code, I can pass it along so our team can confirm coverage — and we can start a request if you have an HVAC issue."
- **infoNeeded:** (optionally address)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** The catalog can't know the real coverage map. Keep the answer non-committal and route to confirmation. If the org has a hard service-area list, this could be data-driven later.

---

### `faq-business-hours`
- **category:** faq
- **title:** Business hours
- **examplePhrasings:**
  - "what are your hours"
  - "when are you open"
  - "are you open right now"
  - "what time do you close"
- **triggerKeywords:** `hours`, `open`, `when are you open`, `what time`, `closing time` (ambiguous: "are you open weekends" → `scheduling-after-hours`)
- **action:** ANSWER
- **cannedResponse:** "Our team is available to take requests around the clock, and a representative follows up to confirm scheduling. If you have an HVAC issue, I can start a request anytime."
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Keep generic if exact hours aren't configured. 24/7 intake messaging aligns with GUIDE.md.

---

### `faq-phone-number`
- **category:** faq
- **title:** Phone number / how to reach a person
- **examplePhrasings:**
  - "what's your phone number"
  - "how do I call you"
  - "can I get a number to call"
  - "contact number"
- **triggerKeywords:** `phone number`, `your number`, `call you`, `contact number`, `how do i call` (ambiguous: close to `account-speak-to-human` — that one is about escalation, this is just the number)
- **action:** ANSWER
- **cannedResponse:** "You can reach our team using the 'Talk to a Human' option in the chat, which shows our phone number. Would you like me to help start a service request in the meantime?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Points to the existing "Talk to a Human" escalation path (GUIDE.md) rather than hardcoding a number the catalog may not have.

---

### `faq-licensed-insured`
- **category:** faq
- **title:** Are you licensed / insured / certified
- **examplePhrasings:**
  - "are you licensed and insured"
  - "are your techs certified"
  - "do you have insurance"
  - "is your company bonded"
- **triggerKeywords:** `licensed`, `insured`, `certified`, `bonded`, `credentials` (ambiguous: none significant)
- **action:** ANSWER
- **cannedResponse:** "Yes — our technicians are licensed and our company is insured. Is there an HVAC issue I can help you with today?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Confirm with engineering that "licensed and insured" is accurate for the org before shipping this canned claim.

---

### `faq-install-vs-repair`
- **category:** faq
- **title:** Do you do installations vs repairs
- **examplePhrasings:**
  - "do you do new installations or just repairs"
  - "can you install a new AC unit"
  - "do you replace whole systems"
  - "is this repair only"
- **triggerKeywords:** `installation`, `install`, `replace system`, `new unit`, `new system`, `repair only` (ambiguous: a concrete install request → `installation` issueType + COLLECT_INFO)
- **action:** ANSWER
- **cannedResponse:** "We handle both repairs and new installations. If you're considering an install or replacement, I can start a request and a technician will assess your needs. What's the service address?"
- **infoNeeded:** (address if they want to proceed with install)
- **issueTypeMapping:** installation
- **urgencyHint:** low
- **notes:** Crosses into the `installation` issueType when they want to proceed. Don't quote install pricing.

---

### `faq-brands-serviced`
- **category:** faq
- **title:** Brands serviced
- **examplePhrasings:**
  - "do you service Carrier units"
  - "what brands do you work on"
  - "can you fix a Trane / Lennox / Goodman"
  - "do you work on Mitsubishi mini splits"
- **triggerKeywords:** `brands`, `service carrier`, `trane`, `lennox`, `goodman`, `rheem`, `mitsubishi`, `mini split` (ambiguous: a brand name alone may appear within an issue description — only treat as this FAQ if they ask whether you service it)
- **action:** ANSWER
- **cannedResponse:** "Our technicians service all major HVAC brands and most makes and models. Do you have an issue with your system I can help start a request for?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** "All major brands" is a safe generic; confirm org reality.

---

### `faq-payment-methods`
- **category:** faq
- **title:** Payment methods
- **examplePhrasings:**
  - "what payment methods do you accept"
  - "do you take credit cards"
  - "can I pay with card / check"
  - "do you accept Apple Pay"
- **triggerKeywords:** `payment`, `pay with`, `credit card`, `take cards`, `accept check`, `apple pay` (ambiguous: "financing" → `faq-financing`; "how much" → `faq-pricing`)
- **action:** ANSWER
- **cannedResponse:** "Our team can walk you through accepted payment options when they confirm your service. For now, I can help you start a request — what HVAC issue are you having?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Keep generic unless payment methods are configured.

---

### `faq-financing`
- **category:** faq
- **title:** Financing options
- **examplePhrasings:**
  - "do you offer financing"
  - "can I finance a new system"
  - "payment plans available?"
  - "any financing for a new furnace"
- **triggerKeywords:** `financing`, `finance`, `payment plan`, `monthly payments` (ambiguous: financing usually pairs with `installation` interest)
- **action:** ANSWER
- **cannedResponse:** "Financing options may be available, especially for new installations — our team can review the details with you. Would you like me to start a request so they can follow up?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Don't state specific rates/terms.

---

### `faq-warranty`
- **category:** faq
- **title:** Warranty / guarantee
- **examplePhrasings:**
  - "do you offer a warranty on repairs"
  - "is the work guaranteed"
  - "what's your warranty"
  - "is my unit still under warranty"
- **triggerKeywords:** `warranty`, `guarantee`, `guaranteed`, `under warranty` (ambiguous: "is MY unit under warranty" is account/equipment-specific, not a generic policy answer)
- **action:** ANSWER
- **cannedResponse:** "Our work is backed by a satisfaction guarantee, and a technician can confirm any manufacturer warranty on your specific equipment. Can I help start a service request?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** If they ask about THEIR unit's warranty status, that's equipment-specific (CRM territory) → may warrant `FALLBACK_LLM` or human.

---

### `faq-pricing`
- **category:** faq
- **title:** Pricing / cost / "how much"
- **examplePhrasings:**
  - "how much does it cost to fix an AC"
  - "what's your service call fee"
  - "how much for a new furnace"
  - "ballpark price for a repair"
  - "do you charge for an estimate"
- **triggerKeywords:** `how much`, `price`, `cost`, `service call fee`, `estimate cost`, `ballpark`, `quote` (ambiguous: "free estimate?" is still pricing; "how much longer/how soon" is scheduling, not price — guard against `how` + time words)
- **action:** ANSWER
- **cannedResponse:** "Pricing depends on what your system needs, so our technician provides a clear quote after assessing it in person — I'm not able to give prices from here. If you describe your issue, I can get a request started so they can follow up."
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** **Strict no-pricing rule (system prompt).** The canned response must explain a technician provides the quote. Disambiguate from scheduling "how soon" phrasing.

---

## Category 9 — EXISTING REQUEST / ACCOUNT

These touch data the deterministic layer usually can't look up. Many are `FALLBACK_LLM` or human-handoff candidates. `issueTypeMapping: null`.

---

### `account-check-status`
- **category:** account
- **title:** Check status of an existing request
- **examplePhrasings:**
  - "what's the status of my request"
  - "is my technician still coming"
  - "any update on my service request"
  - "did my request go through"
- **triggerKeywords:** `status of my request`, `any update`, `still coming`, `did my request`, `check my request` (ambiguous: "status" generic; pair with my-request/my-appointment)
- **action:** COLLECT_INFO
- **cannedResponse:** "I can help check on that. What's your reference number (it looks like REF-XXXXX)?"
- **infoNeeded:** (reference number)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Reference number isn't a standard extraction slot and the deterministic layer can't look up live status. After collecting the ref, this likely becomes a human handoff or `FALLBACK_LLM`. Confirm whether a status-lookup flow exists.

---

### `account-provide-reference`
- **category:** account
- **title:** Customer provides a reference number
- **examplePhrasings:**
  - "my reference number is REF-12345"
  - "ref-98765"
  - "here's my reference: REF-ABCDE"
- **triggerKeywords:** regex `ref-?\s*[a-z0-9]{4,}`, `reference number is`, `my ref is` (ambiguous: a bare number could be a phone/zip — require the `ref` token or `REF-` prefix)
- **action:** FALLBACK_LLM
- **cannedResponse:** (none — deferred)
- **infoNeeded:** —
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Detect the reference pattern deterministically, but acting on it (lookup, status, changes) needs backend data → defer to LLM/human flow. The router's job here is just to *recognize* it and route, not answer.

---

### `account-change-appointment`
- **category:** account
- **title:** Change details of an existing appointment
- **examplePhrasings:**
  - "i need to change my appointment time"
  - "can you update my appointment"
  - "change the address on my request"
  - "add a phone number to my request"
- **triggerKeywords:** `change my appointment`, `update my appointment`, `change the address on`, `update my request` (ambiguous: overlaps with `scheduling-reschedule`; both need a reference lookup)
- **action:** COLLECT_INFO
- **cannedResponse:** "I can help update your request. What's your reference number (like REF-XXXXX), and what would you like to change?"
- **infoNeeded:** (reference number)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Reference-lookup caveat applies. Likely human/LLM handoff after collecting the ref.

---

### `account-update-contact`
- **category:** account
- **title:** Update contact info (mid-intake)
- **examplePhrasings:**
  - "actually my phone number is 555-123-4567"
  - "update my email to x@y.com"
  - "my name is John Smith"
  - "use this address instead: 123 Main St"
- **triggerKeywords:** `my phone is`, `my email is`, `my name is`, `use this address`, `update my` + contact field (ambiguous: this is often just slot-filling during normal intake, not a separate intent)
- **action:** COLLECT_INFO
- **cannedResponse:** "Got it, I've noted that. Is there anything else you'd like to add or change before we continue?"
- **infoNeeded:** (whichever slot they're updating: name/phone/email/address)
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** During active intake this is normal slot-filling — the router should update the matching slot (name/phone/email/address) and continue, NOT treat it as a topic change. Validate email/phone format at the boundary.

---

### `account-speak-to-human`
- **category:** account
- **title:** Request a human agent
- **examplePhrasings:**
  - "i want to speak to a human"
  - "can I talk to a real person"
  - "get me a representative"
  - "stop the bot, I need a person"
  - "transfer me to an agent"
- **triggerKeywords:** `speak to a human`, `talk to a person`, `real person`, `representative`, `agent`, `human`, `someone real` (ambiguous: "are you a bot?" is `meta-are-you-bot`, not necessarily a handoff request)
- **action:** ESCALATE
- **cannedResponse:** "Of course — you can reach our team directly using the 'Talk to a Human' button in the chat header, which connects you with a real person. I'm flagging this so someone follows up with you."
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Maps to the existing escalation path (GUIDE.md "Talk to a Human" → marks session `escalated`). Per system prompt, also trigger this on detected frustration or >15 turns.

---

## Category 10 — CONVERSATIONAL / META

Lowest priority (don't shadow real issues). Mix of `ANSWER`, `REDIRECT`, `ESCALATE`, `FALLBACK_LLM`.

---

### `meta-greeting`
- **category:** meta
- **title:** Greeting / hello
- **examplePhrasings:**
  - "hi", "hello", "hey there", "good morning", "yo", "hi there"
- **triggerKeywords:** `hi`, `hello`, `hey`, `good morning`, `good afternoon`, `yo`, `hiya` (ambiguous: only match if the message is *just* a greeting — "hi my AC is broken" must route to the issue)
- **action:** ANSWER
- **cannedResponse:** "Hi! I'm your HVAC assistant. What heating, cooling, or air quality issue can I help you with today?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Mirrors the system-prompt greeting. Only match standalone greetings (short message, no issue keywords).

---

### `meta-thanks`
- **category:** meta
- **title:** Thanks
- **examplePhrasings:**
  - "thanks", "thank you", "appreciate it", "thx", "ty"
- **triggerKeywords:** `thanks`, `thank you`, `appreciate`, `thx`, `ty` (ambiguous: "thanks but it's still broken" still contains an issue → don't close out)
- **action:** ANSWER
- **cannedResponse:** "You're welcome! Is there anything else about your heating or cooling I can help with?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Don't let a trailing "thanks" override an unresolved issue in the same message.

---

### `meta-goodbye`
- **category:** meta
- **title:** Goodbye / closing
- **examplePhrasings:**
  - "bye", "goodbye", "that's all", "I'm done", "see ya"
- **triggerKeywords:** `bye`, `goodbye`, `thats all`, `im done`, `see ya`, `no thanks` (ambiguous: "I'm done waiting / frustrated" → could be `meta-frustration`)
- **action:** ANSWER
- **cannedResponse:** "Take care! If anything comes up with your heating or cooling, I'm here anytime. Stay comfortable!"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** —

---

### `meta-are-you-bot`
- **category:** meta
- **title:** "Are you a bot / real?"
- **examplePhrasings:**
  - "are you a bot", "are you a robot", "am I talking to a real person", "is this AI", "are you human"
- **triggerKeywords:** `are you a bot`, `are you real`, `are you human`, `is this ai`, `robot`, `talking to a person` (ambiguous: may precede a handoff request → if "I want a human" follows, escalate)
- **action:** ANSWER
- **cannedResponse:** "I'm an AI assistant here to help you describe your HVAC issue and get a technician dispatched. If you'd prefer a real person, just tap 'Talk to a Human' in the chat. What can I help with?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Be transparent (it's an AI). If they then ask for a human, route to `account-speak-to-human`.

---

### `meta-frustration`
- **category:** meta
- **title:** Frustration / anger
- **examplePhrasings:**
  - "this is ridiculous"
  - "I've been waiting forever, this is unacceptable"
  - "you people are useless"
  - "I'm so frustrated, nothing is working"
  - "worst service ever"
- **triggerKeywords:** `ridiculous`, `unacceptable`, `useless`, `frustrated`, `angry`, `terrible service`, `worst`, profanity (ambiguous: mild frustration about the issue vs anger at the company; profanity may be venting, not a handoff demand)
- **action:** ESCALATE
- **cannedResponse:** "I'm really sorry for the frustration — that's the last thing I want for you. Let me connect you with a real person; you can tap 'Talk to a Human' in the chat header and our team will take care of you."
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** System prompt: escalate on frustration. Acknowledge empathy first. Borderline cases (mild annoyance still describing an issue) → `FALLBACK_LLM` so the LLM can de-escalate and keep helping rather than prematurely punting.

---

### `meta-gibberish-empty`
- **category:** meta
- **title:** Gibberish / empty / nonsense
- **examplePhrasings:**
  - "asdfghjkl", "...", "????", "lkjsdf", "" (empty), "😀😀😀"
- **triggerKeywords:** message is empty after normalization, or no alphabetic words / no dictionary tokens, or only punctuation/emoji (ambiguous: a single real word like "AC" or "heat" is NOT gibberish)
- **action:** ANSWER
- **cannedResponse:** "Sorry, I didn't quite catch that. Could you tell me what heating or cooling issue you're having so I can help?"
- **infoNeeded:** []
- **issueTypeMapping:** null
- **urgencyHint:** null
- **notes:** Detect deterministically (length, alpha-ratio). Don't burn an LLM call on noise. If the same user sends gibberish repeatedly, consider escalation.

---

### `meta-non-hvac-redirect`
- **category:** meta
- **title:** Non-HVAC request → polite redirect
- **examplePhrasings:**
  - "can you fix my leaky toilet"
  - "do you do electrical work / roofing / plumbing"
  - "what's the weather today"
  - "can you help me with my taxes"
  - "fix my refrigerator"
  - "my garage door is broken"
- **triggerKeywords:** strong non-HVAC nouns: `plumbing`, `toilet`, `roofing`, `electrician` (general), `refrigerator`/`fridge`, `garage door`, `weather`, `taxes`, `appliance repair` (ambiguous: "refrigerant" ≠ "refrigerator"; "water heater" IS in scope; "electrical burning smell" is an HVAC emergency, not electrician work)
- **action:** REDIRECT
- **cannedResponse:** "I specialize in heating, cooling, and air quality, so that's outside what I can help with — you'd want a specialist for that. Is there an HVAC issue I can help you with?"
- **infoNeeded:** []
- **issueTypeMapping:** other (or null)
- **urgencyHint:** null
- **notes:** Follows the system-prompt redirect script almost verbatim. **Careful negation/overlap guards:** "refrigerant"/"freon" = HVAC (cooling), NOT a fridge; "water heater" = in scope (heating); "electrical/burning smell" = HVAC emergency. Mismatching these is the biggest risk in this intent → when uncertain, `FALLBACK_LLM`.

---

## GENUINE AMBIGUITY CASES → prefer `FALLBACK_LLM`

These are patterns where a wrong canned answer is high-harm or high-likelihood, so the router should defer to Qwen rather than guess:

1. **Burning/smell severity (safety-critical).** "Slight burning smell when the heat first turns on" (often normal dust burn-off) vs "burning plastic smell / smoke" (fire hazard). Wrongly reassuring a real hazard is unacceptable → `heating-strange-smell-startup` is intentionally `FALLBACK_LLM`. When in doubt, lean toward escalation, not reassurance.

2. **"No heat/cooling" + ambiguous conditions.** "No heat" without weather context, or "it's a bit chilly" — the line between `high` and `emergency` depends on freezing temps and vulnerable occupants the customer may only imply. Let the LLM probe.

3. **Short cycling / noises without system context.** "It keeps turning on and off" with no mention of AC vs furnace — `cooling-short-cycling` and `heating-short-cycling` are indistinguishable. Defer unless cooling/heating keywords are present.

4. **Self-diagnoses that are often wrong.** "I need a refrigerant recharge," "I think my compressor is bad," "it's definitely the capacitor." The stated cause may be incorrect; canned text could validate a wrong diagnosis. Collect the issue generically or defer.

5. **Reference-number / account actions.** Status checks, reschedules, cancels, "is my tech still coming" all require live backend data the deterministic layer doesn't have. Recognize the reference pattern, then `FALLBACK_LLM` or human handoff — never fabricate a status.

6. **"My unit's" warranty / coverage / brand-specific questions.** Equipment-specific (CRM territory). Generic policy answers are fine; specific entitlements are not → defer.

7. **Compound / multi-intent messages.** "My AC is leaking and making noise and how much will it cost" — multiple intents with conflicting actions (COLLECT_INFO + ANSWER). If scores are close, defer.

8. **Frustration vs venting.** Mild annoyance while still cooperating ("ugh this is annoying, anyway my furnace…") should NOT trigger premature human escalation. Clear hostility/"useless"/"unacceptable" should. The gray zone → `FALLBACK_LLM`.

9. **Non-HVAC vs HVAC homophones/overlaps.** "refrigerant" vs "refrigerator," "electrical burning smell" (HVAC emergency) vs "fix my wiring" (electrician), "water heater" (in scope) vs general plumbing. High misclassification risk → guard keywords tightly and defer when unsure.

10. **Service-area / hours / pricing specifics the catalog can't truly know.** Generic non-committal answers are provided above, but if the customer pushes for a specific city's coverage, exact hours, or a real number, defer to the LLM or human rather than over-promising.

---

## Summary for the implementing engineer

- **Total intents:** 53 across 10 categories (Emergency 6, Cooling 9, Heating 10, Air Quality 5, Thermostat 5, Maintenance 4, Scheduling 6, FAQ 11, Account 5, Meta 7).
- **All `issueTypeMapping` values are drawn strictly from the real enum:** `heating_not_working`, `cooling_not_working`, `thermostat_issue`, `air_quality`, `strange_noises`, `water_leak`, `maintenance`, `installation`, `other` (or `null`). No invented values.
- **All `urgencyHint` values** are from `low | medium | high | emergency | null`, following the system-prompt urgency guidelines.
- **Encode safety as the `ESCALATE` action**, not as an issueType — there is no emergency issueType.
- **Reference-number flows and live-status lookups have no matching slot** in the extraction schema (`issueType/urgency/address/name/phone/email`); those intents are flagged as human/LLM-handoff candidates pending a backend lookup feature.
- **Key disambiguation guards to implement:** warm air (cooling) vs cold air (heating); "emergency heat"/"em heat" mode must NOT trigger safety escalation; "refrigerant/freon" ≠ "refrigerator"; "water heater" is in scope; bare "gas" (gas furnace) must not fire the gas-leak emergency without a smell/leak qualifier; standalone greeting/thanks must not shadow an issue described in the same message.

This is ready to be encoded into `src/lib/ai/knowledge-base.ts` as a typed array (e.g., `KnowledgeBaseEntry[]` with literal-typed `action`, `issueTypeMapping`, and `urgencyHint` fields).agentId: aaa2b48bf728e691d (use SendMessage with to: 'aaa2b48bf728e691d' to continue this agent)
<usage>subagent_tokens: 69844
tool_uses: 5
duration_ms: 345782</usage>