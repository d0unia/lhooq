import React, { useMemo, useState } from "react";
import { addDays, eachDayOfInterval, endOfMonth, format, isSameDay, isWeekend, startOfMonth } from "date-fns";
import { LogOut, RotateCcw, Download, Upload } from "lucide-react";
import { useAuth } from "./hooks/useAuth";
import { useScheduleData } from "./hooks/useScheduleData";
import LoginPage from "./components/LoginPage";

/**
 * GC/Issy Scheduler — single-file React app (Bolt.new-ready)
 * ---------------------------------------------------------
 * What it does:
 * - Generates a monthly schedule (Mon–Fri) across three locations: Issy, Grand-Cerf (GC), Remote
 * - Respects desk capacities (Issy:12, GC:5) and key constraints/preferences
 * - Lets you pick the month and 2 BubbleLux (all-hands) days where everyone is at Issy
 * - Provides a one-click heuristic "Generate" that produces an editable schedule
 * - Allows manual tweaks via quick-edit menus + live capacity counters
 * - Exports/Imports the plan as JSON; persists to localStorage automatically
 *
 * Notes:
 * - This is a heuristic (greedy) allocator with safeguards, not an exact solver; it gets you ~95% there fast,
 *   and the UI makes it easy to hand-adjust any edge cases.
 */

// --- Data model -------------------------------------------------------------
const PEOPLE = [
  { id: "bertrand", name: "Bertrand", prefs: { gcWeight: 5 } }, // needs GC often
  { id: "florence", name: "Florence", prefs: { avoidIssy: true, minIssyPerMonth: 2 } },
  { id: "nicolas", name: "Nicolas", prefs: { mustNotRemote: true, minGCPW: 1, gcWeight: 3 } },
  { id: "amelie", name: "Amélie", prefs: { minOnsitePerMonth: 2, onsiteCountViaBubbleLuxOK: true, remoteDefault: true } },
  { id: "karine", name: "Karine", prefs: { forbidIssy: true, remoteLow: true, gcWeight: 5, minGCPW: 2 } },
  { id: "lea", name: "Léa", prefs: { flexible: true } },
  { id: "dounia", name: "Dounia", prefs: { flexible: true } },
  { id: "laurent", name: "Laurent", prefs: { issyConvenient: true, mixWithAll: true } },
  { id: "eva", name: "Eva", prefs: { maxGCPW: 1, needIssyPW: 1, gcWeight: 1 } },
  { id: "herve", name: "Hervé", prefs: { onsiteDaysPW: 2, flexible: true } },
  { id: "mathilde", name: "Mathilde", prefs: { flexible: true } },
  { id: "rubie", name: "Rubie", prefs: { flexible: true } },
];

const SITES = {
  GC: { id: "GC", name: "Grand‑Cerf", capacity: 5 },
  ISSY: { id: "ISSY", name: "Issy", capacity: 12 },
  REMOTE: { id: "REMOTE", name: "Remote", capacity: Infinity },
};

// Helpers
const yyyyMMdd = (d) => format(d, "yyyy-MM-dd");
const isBusinessDay = (d) => !isWeekend(d);

// --- Local Storage ----------------------------------------------------------
// Moved to useScheduleData hook

// --- Heuristic generator ----------------------------------------------------
function generateSchedule({ monthStart, bubbleLuxDates, people = PEOPLE }) {
  const monthDays = eachDayOfInterval({ start: startOfMonth(monthStart), end: endOfMonth(monthStart) })
    .filter(isBusinessDay);

  // Initialize empty schedule map: date -> personId -> siteId
  const plan = {};
  monthDays.forEach((d) => {
    const key = yyyyMMdd(d);
    plan[key] = Object.fromEntries(people.map((p) => [p.id, "REMOTE"]));
  });

  const weeks = chunkByWeeks(monthDays);

  // Apply BubbleLux (all at Issy)
  bubbleLuxDates.forEach((iso) => {
    if (!plan[iso]) return;
    people.forEach((p) => (plan[iso][p.id] = "ISSY"));
  });

  // Per-person trackers
  const counters = {
    gcPerWeek: new Map(), // weekIndex -> {personId: count}
    issyPerMonth: Object.fromEntries(people.map((p) => [p.id, 0])),
    onsitePerMonth: Object.fromEntries(people.map((p) => [p.id, 0])),
  };

  // Seed month counters from BubbleLux
  bubbleLuxDates.forEach((iso) => {
    people.forEach((p) => {
      counters.issyPerMonth[p.id] += 1;
      counters.onsitePerMonth[p.id] += 1;
    });
  });

  // Helper to count site usage for a day
  const dayUsage = (iso) => {
    const row = plan[iso];
    return Object.values(row).reduce(
      (acc, site) => {
        acc[site] = (acc[site] || 0) + 1;
        return acc;
      },
      { GC: 0, ISSY: 0, REMOTE: 0 }
    );
  };

  // Iterate weeks to assign GC then Issy/Remote
  weeks.forEach((days, wIdx) => {
    counters.gcPerWeek.set(wIdx, Object.fromEntries(people.map((p) => [p.id, 0])));

    days.forEach((d) => {
      const iso = yyyyMMdd(d);
      if (bubbleLuxDates.includes(iso)) return; // already all Issy

      // 1) Fill GC with priorities
      const gcPriorities = people
        .map((p) => ({
          p,
          score: gcScore(p, counters.gcPerWeek.get(wIdx), wIdx),
        }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);

      for (const p of gcPriorities) {
        if (plan[iso][p.id] !== "REMOTE") continue; // already set later
        if (dayUsage(iso).GC >= SITES.GC.capacity) break;
        if (p.prefs.forbidIssy && p.prefs.remoteLow) {
          // GC preferred for Karine when possible
        }
        // Weekly GC constraints
        const gcCnt = counters.gcPerWeek.get(wIdx)[p.id] || 0;
        if (p.prefs.maxGCPW && gcCnt >= p.prefs.maxGCPW) continue;
        // Encourage those who need min GC per week
        if (p.prefs.minGCPW && gcCnt >= p.prefs.minGCPW) continue; // already satisfied this week; let others in

        // Seat at GC if fits soft score
        if (gcScore(p, counters.gcPerWeek.get(wIdx), wIdx) > 0) {
          plan[iso][p.id] = "GC";
          counters.gcPerWeek.get(wIdx)[p.id] = gcCnt + 1;
          counters.onsitePerMonth[p.id] += 1;
        }
      }

      // 2) Assign remaining: Issy vs Remote
      for (const p of people) {
        if (plan[iso][p.id] !== "REMOTE") continue; // already assigned GC or BubbleLux earlier

        // Hard rules
        if (p.prefs.mustNotRemote) {
          plan[iso][p.id] = "ISSY";
          counters.issyPerMonth[p.id] += 1;
          counters.onsitePerMonth[p.id] += 1;
          continue;
        }
        if (p.prefs.forbidIssy) {
          // Can't go Issy; if GC is full, allow Remote (Karine minimal remote handled by gc priority)
          plan[iso][p.id] = "REMOTE";
          continue;
        }

        // Weekly patterns
        if (p.id === "eva") {
          // 1 Issy + 1 GC per week max (GC handled above). If she doesn't have Issy yet this week, try place her.
          const wmap = counters.gcPerWeek.get(wIdx);
          const evaIssyCountThisWeek = days.filter((dd) => plan[yyyyMMdd(dd)][p.id] === "ISSY").length;
          if (evaIssyCountThisWeek < (p.prefs.needIssyPW || 0) && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
            plan[iso][p.id] = "ISSY";
            counters.issyPerMonth[p.id] += 1;
            counters.onsitePerMonth[p.id] += 1;
            continue;
          }
        }

        // Hervé: 2 on-site per week
        if (p.id === "herve") {
          const onsiteThisWeek = days.filter((dd) => plan[yyyyMMdd(dd)][p.id] !== "REMOTE").length;
          if (onsiteThisWeek < (p.prefs.onsiteDaysPW || 0) && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
            plan[iso][p.id] = "ISSY";
            counters.issyPerMonth[p.id] += 1;
            counters.onsitePerMonth[p.id] += 1;
            continue;
          }
        }

        // Laurent prefers Issy
        if (p.prefs.issyConvenient && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
          plan[iso][p.id] = "ISSY";
          counters.issyPerMonth[p.id] += 1;
          counters.onsitePerMonth[p.id] += 1;
          continue;
        }

        // Florence avoids Issy but needs 2 per month; count BubbleLux toward the 2
        if (p.id === "florence") {
          if (counters.issyPerMonth[p.id] < (p.prefs.minIssyPerMonth || 0) && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
            plan[iso][p.id] = "ISSY";
            counters.issyPerMonth[p.id] += 1;
            counters.onsitePerMonth[p.id] += 1;
          } else {
            // else prefer GC (handled earlier) or Remote
            plan[iso][p.id] = plan[iso][p.id] === "REMOTE" ? "REMOTE" : plan[iso][p.id];
          }
          continue;
        }

        // Amélie remote by default; ensure >=2 onsite/month (BubbleLux counts)
        if (p.id === "amelie") {
          if (counters.onsitePerMonth[p.id] < (p.prefs.minOnsitePerMonth || 0) && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
            plan[iso][p.id] = "ISSY"; // use Issy for simplicity
            counters.issyPerMonth[p.id] += 1;
            counters.onsitePerMonth[p.id] += 1;
          } else {
            plan[iso][p.id] = "REMOTE";
          }
          continue;
        }

        // Others: default to Issy when capacity remains, else Remote
        if (dayUsage(iso).ISSY < SITES.ISSY.capacity) {
          plan[iso][p.id] = "ISSY";
          counters.issyPerMonth[p.id] += 1;
          counters.onsitePerMonth[p.id] += 1;
        } else {
          plan[iso][p.id] = "REMOTE";
        }
      }
    });
  });

  return { plan, days: monthDays.map(yyyyMMdd) };
}

function gcScore(p, wMap) {
  const base = p.prefs.gcWeight || 0;
  const have = (wMap?.[p.id] || 0);
  const needMin = p.prefs.minGCPW || 0;
  // Boost if below min; slight decay if already has GC this week
  const boost = have < needMin ? 3 : Math.max(0, 2 - have);
  // Penalize if max reached
  const cap = p.prefs.maxGCPW && have >= p.prefs.maxGCPW ? -99 : 0;
  // Forbid Issy users w/ remoteLow to try GC earlier (Karine)
  const special = p.prefs.forbidIssy ? 2 : 0;
  return base + boost + cap + special;
}

function chunkByWeeks(days) {
  // Simple weekly chunks Mon-Fri in order; assumes input are only business days
  const chunks = [];
  let curr = [];
  let lastDow = null;
  for (const d of days) {
    const dow = d.getDay(); // 1..5
    if (lastDow !== null && dow < lastDow) {
      chunks.push(curr);
      curr = [];
    }
    curr.push(d);
    lastDow = dow;
  }
  if (curr.length) chunks.push(curr);
  return chunks;
}

// --- UI components ----------------------------------------------------------
export default function App() {
  const { isAuthenticated, login, logout } = useAuth();
  const { state, setState } = useScheduleData();
  const [hasGenerated, setHasGenerated] = useState(false);

  const monthStart = useMemo(() => new Date(state.monthISO + "T00:00:00"), [state.monthISO]);
  const businessDays = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(monthStart), end: endOfMonth(monthStart) }).filter(isBusinessDay),
    [monthStart]
  );
  const dayISOs = businessDays.map(yyyyMMdd);

  const usageByDay = useMemo(() => computeUsage(state.plan, dayISOs), [state.plan, state.monthISO]);

  function handleGenerate() {
    const { plan, days } = generateSchedule({ monthStart, bubbleLuxDates: state.bubbleLux, people: PEOPLE });
    setState((s) => ({ ...s, plan, days }));
    setHasGenerated(true);
  }

  function setBubbleLux(iso) {
    setState((s) => {
      const exists = s.bubbleLux.includes(iso);
      const next = exists ? s.bubbleLux.filter((x) => x !== iso) : [...s.bubbleLux, iso].slice(0, 2);
      return { ...s, bubbleLux: next };
    });
  }

  function setCell(iso, personId, siteId) {
    setState((s) => {
      const plan = { ...s.plan, [iso]: { ...(s.plan[iso] || {}), [personId]: siteId } };
      return { ...s, plan };
    });
  }

  function resetPlan() {
    if (confirm('Are you sure you want to reset the entire monthly plan? This action cannot be undone.')) {
      setState((s) => ({ ...s, plan: {}, bubbleLux: [] }));
      setHasGenerated(false);
    }
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage onLogin={login} />;
  }

  function exportCSV() {
    const monthName = format(monthStart, 'MMMM-yyyy');
    const csvData = generateCSV(state, businessDays, PEOPLE);
    const blob = new Blob([csvData], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `LHOOQ-Schedule-${monthName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importCSV(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const csvText = reader.result as string;
        const imported = parseCSV(csvText, businessDays, PEOPLE);
        setState((s) => ({ ...s, ...imported }));
        setHasGenerated(true);
      } catch (err) {
        alert("Invalid CSV file format");
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-neutral-200">
        <div className="max-w-6xl mx-auto p-4 flex flex-wrap gap-3 items-center justify-between">
          <div className="font-semibold text-lg">👀 LHOOQ</div>
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-sm">Month
              <input
                type="month"
                value={state.monthISO.slice(0,7)}
                onChange={(e) => setState((s) => ({ ...s, monthISO: e.target.value + "-01" }))}
                className="ml-2 border rounded px-2 py-1"
              />
            </label>
            <button onClick={handleGenerate} className="px-3 py-1.5 rounded bg-black text-white">Generate</button>
            {hasGenerated && (
              <button onClick={handleGenerate} className="px-3 py-1.5 rounded border hover:bg-neutral-50">Regenerate</button>
            )}
            <button onClick={resetPlan} className="px-3 py-1.5 rounded border hover:bg-red-50 text-red-600 flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />
              Reset
            </button>
            <button onClick={exportCSV} className="px-3 py-1.5 rounded border hover:bg-neutral-50 flex items-center gap-2">
              <Download className="w-4 h-4" />
              Export CSV
            </button>
            <label className="px-3 py-1.5 rounded border cursor-pointer hover:bg-neutral-50 flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Import CSV
              <input type="file" accept=".csv" className="hidden" onChange={importCSV} />
            </label>
            <div className="flex items-center gap-4">
              <button 
                onClick={logout}
                className="px-3 py-1.5 rounded border hover:bg-neutral-50 flex items-center gap-2"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        <section className="mb-6">
          <h2 className="font-semibold mb-2">Step 1 — Pick up to 2 BubbleLux days (everyone at Issy)</h2>
          <div className="grid grid-cols-5 gap-2">
            {businessDays.map((d) => {
              const iso = yyyyMMdd(d);
              const selected = state.bubbleLux.includes(iso);
              return (
                <button
                  key={iso}
                  onClick={() => setBubbleLux(iso)}
                  className={`text-left border rounded p-2 ${selected ? "bg-amber-200 border-amber-400" : "bg-white"}`}
                >
                  <div className="text-xs opacity-70">{format(d, "EEE d MMM")}</div>
                  <div className="font-medium">{selected ? "BubbleLux (Issy)" : "—"}</div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mb-6">
          <h2 className="font-semibold mb-2">Step 2 — Generated plan (click any chip to change)</h2>
          <div className="text-sm text-neutral-600 mb-2">GC capacity 5 · Issy capacity 12 · Remote unlimited</div>
          <div className="space-y-4">
            {businessDays.map((d) => {
              const iso = yyyyMMdd(d);
              const usage = usageByDay[iso] || { GC: 0, ISSY: 0, REMOTE: 0 };
              const row = state.plan[iso] || {};
              return (
                <div key={iso} className="bg-white border rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{format(d, "EEEE d MMMM")}</div>
                    <div className="text-sm">
                      <Capacity label="GC" used={usage.GC} cap={SITES.GC.capacity} />
                      <Capacity label="Issy" used={usage.ISSY} cap={SITES.ISSY.capacity} />
                      <Capacity label="Remote" used={usage.REMOTE} cap={Infinity} />
                    </div>
                  </div>
                  <div className="mt-3 grid md:grid-cols-3 gap-3">
                    <SiteColumn title="Grand‑Cerf" siteId="GC" iso={iso} row={row} onSet={setCell} />
                    <SiteColumn title="Issy" siteId="ISSY" iso={iso} row={row} onSet={setCell} />
                    <SiteColumn title="Remote" siteId="REMOTE" iso={iso} row={row} onSet={setCell} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-10">
          <h2 className="font-semibold mb-2">People & constraints (read-only in this demo)</h2>
          <div className="bg-white border rounded-lg p-3 overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-1 pr-3">Person</th>
                  <th className="py-1 pr-3">Key constraints</th>
                </tr>
              </thead>
              <tbody>
                {PEOPLE.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-1 pr-3 font-medium">{p.name}</td>
                    <td className="py-1 pr-3 text-neutral-700">{describePrefs(p.prefs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Capacity({ label, used, cap }) {
  const ok = used <= cap;
  return (
    <span className={`inline-flex items-center gap-1 ml-3 px-2 py-0.5 rounded ${ok ? "bg-emerald-100" : "bg-rose-100"}`}>
      <span className="font-medium">{label}</span>
      <span>{used}{isFinite(cap) ? `/${cap}` : ""}</span>
    </span>
  );
}

function SiteColumn({ title, siteId, iso, row, onSet }) {
  const occupants = Object.entries(row)
    .filter(([, site]) => site === siteId)
    .map(([pid]) => PEOPLE.find((x) => x.id === pid));
  
  // Only exclude people who are already assigned on this specific day
  const assignedOnThisDay = new Set(Object.keys(row));
  const availableForQuickAdd = PEOPLE.filter((p) => !assignedOnThisDay.has(p.id));
  
  return (
    <div className="border rounded p-2">
      <div className="text-sm font-medium mb-2">{title}</div>
      <div className="flex flex-wrap gap-2">
        {occupants.map((p) => (
          <Chip key={p.id} color="filled" onClick={() => onSet(iso, p.id, nextSite(siteId))}>{p.name}</Chip>
        ))}
      </div>
      <div className="mt-2 text-xs text-neutral-500">Click a name to cycle GC → Issy → Remote</div>
      <div className="mt-2">
        <div className="text-xs text-neutral-500 mb-1">Quick add</div>
        <div className="flex flex-wrap gap-1">
          {availableForQuickAdd.map((p) => (
            <button key={p.id} className="text-xs underline text-neutral-600" onClick={() => onSet(iso, p.id, siteId)}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({ children, onClick }) {
  return (
    <button onClick={onClick} className="px-2 py-1 rounded-full bg-neutral-900 text-white text-xs hover:opacity-90">
      {children}
    </button>
  );
}

function nextSite(curr) {
  if (curr === "GC") return "ISSY";
  if (curr === "ISSY") return "REMOTE";
  return "GC";
}

function computeUsage(plan, dayISOs) {
  const usage = {};
  for (const iso of dayISOs) {
    const row = plan[iso] || {};
    usage[iso] = { GC: 0, ISSY: 0, REMOTE: 0 };
    for (const site of Object.values(row)) {
      usage[iso][site] = (usage[iso][site] || 0) + 1;
    }
  }
  return usage;
}

function describePrefs(p) {
  const bits = [];
  if (p.mustNotRemote) bits.push("no remote");
  if (p.forbidIssy) bits.push("never Issy");
  if (p.remoteLow) bits.push("minimize remote");
  if (p.minIssyPerMonth) bits.push(`≥${p.minIssyPerMonth}/mo Issy`);
  if (p.minOnsitePerMonth) bits.push(`≥${p.minOnsitePerMonth}/mo onsite`);
  if (p.minGCPW) bits.push(`≥${p.minGCPW}/wk GC`);
  if (p.maxGCPW) bits.push(`≤${p.maxGCPW}/wk GC`);
  if (p.issyConvenient) bits.push("prefers Issy");
  if (p.gcWeight) bits.push("GC priority");
  if (p.onsiteDaysPW) bits.push(`${p.onsiteDaysPW}/wk onsite`);
  if (p.flexible) bits.push("flexible");
  if (p.wantsSomeGC) bits.push("some GC");
  return bits.join(" · ");
}

function generateCSV(state, businessDays, people) {
  const lines = [];
  
  // Header
  const dates = businessDays.map(d => format(d, 'EEE d MMM'));
  lines.push(['Person', ...dates].join(','));
  
  // Data rows
  people.forEach(person => {
    const row = [person.name];
    businessDays.forEach(day => {
      const iso = format(day, 'yyyy-MM-dd');
      const assignment = state.plan[iso]?.[person.id] || 'REMOTE';
      const siteLabel = assignment === 'GC' ? 'Grand-Cerf' : 
                       assignment === 'ISSY' ? 'Issy' : 'Remote';
      row.push(siteLabel);
    });
    lines.push(row.join(','));
  });
  
  // Add BubbleLux info
  if (state.bubbleLux.length > 0) {
    lines.push('');
    lines.push('BubbleLux Days:');
    state.bubbleLux.forEach(iso => {
      const date = new Date(iso + 'T00:00:00');
      lines.push(format(date, 'EEEE d MMMM yyyy'));
    });
  }
  
  return lines.join('\n');
}

function parseCSV(csvText, businessDays, people) {
  const lines = csvText.split('\n').filter(line => line.trim());
  if (lines.length < 2) throw new Error('Invalid CSV format');
  
  const plan = {};
  const bubbleLux = [];
  
  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('BubbleLux') || !line.includes(',')) break;
    
    const parts = line.split(',');
    if (parts.length < 2) continue;
    
    const personName = parts[0].trim();
    const person = people.find(p => p.name === personName);
    if (!person) continue;
    
    businessDays.forEach((day, dayIndex) => {
      const iso = format(day, 'yyyy-MM-dd');
      if (!plan[iso]) plan[iso] = {};
      
      const assignment = parts[dayIndex + 1]?.trim() || 'Remote';
      const siteId = assignment === 'Grand-Cerf' ? 'GC' :
                    assignment === 'Issy' ? 'ISSY' : 'REMOTE';
      plan[iso][person.id] = siteId;
    });
  }
  
  return { plan, bubbleLux, days: businessDays.map(d => format(d, 'yyyy-MM-dd')) };
}