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
  { id: "bertrand", name: "Bertrand", prefs: { gcShare: 70, issyShare: 10, remoteShare: 20 } },
  { id: "florence", name: "Florence", prefs: { gcShare: 55, issyShare: 5, remoteShare: 40 } },
  { id: "nicolas", name: "Nicolas", prefs: { gcShare: 50, issyShare: 10, remoteShare: 40 } },
  { id: "amelie", name: "Amélie", prefs: { gcShare: 5, issyShare: 5, remoteShare: 90 } },
  { id: "karine", name: "Karine", prefs: { gcShare: 90, issyShare: 5, remoteShare: 5 } },
  { id: "lea", name: "Léa", prefs: { gcShare: 50, issyShare: 10, remoteShare: 40 } },
  { id: "dounia", name: "Dounia", prefs: { gcShare: 50, issyShare: 10, remoteShare: 40 } },
  { id: "laurent", name: "Laurent", prefs: { gcShare: 45, issyShare: 45, remoteShare: 10 } },
  { id: "eva", name: "Eva", prefs: { gcShare: 10, issyShare: 10, remoteShare: 80 } },
  { id: "herve", name: "Hervé", prefs: { gcShare: 30, issyShare: 30, remoteShare: 40 } },
  { id: "mathilde", name: "Mathilde", prefs: { gcShare: 30, issyShare: 30, remoteShare: 40 } },
  { id: "rubie", name: "Rubie", prefs: { gcShare: 50, issyShare: 10, remoteShare: 40 } },
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


  // Apply BubbleLux (all at Issy)
  bubbleLuxDates.forEach((iso) => {
    if (!plan[iso]) return;
    people.forEach((p) => (plan[iso][p.id] = "ISSY"));
  });

  // Calculate target days for each person based on percentage preferences
  const totalWorkDays = monthDays.length;
  const targetDays = {};
  people.forEach((p) => {
    const gcTarget = Math.round((p.prefs.gcShare / 100) * totalWorkDays);
    const issyTarget = Math.round((p.prefs.issyShare / 100) * totalWorkDays);
    const remoteTarget = totalWorkDays - gcTarget - issyTarget;
    targetDays[p.id] = { gc: gcTarget, issy: issyTarget, remote: remoteTarget };
  });

  // Track actual assignments
  const actualDays = {};
  people.forEach((p) => {
    actualDays[p.id] = { gc: 0, issy: 0, remote: 0 };
    // Count BubbleLux days as Issy
    actualDays[p.id].issy = bubbleLuxDates.length;
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

  // Process each day (excluding BubbleLux days)
  monthDays.forEach((d) => {
    const iso = yyyyMMdd(d);
    if (bubbleLuxDates.includes(iso)) return; // already all Issy

    // 1) Fill GC first (priority location)
    const gcCandidates = people
      .filter((p) => plan[iso][p.id] === "REMOTE") // not already assigned
      .map((p) => ({
        person: p,
        priority: calculateGCPriority(p, actualDays[p.id], targetDays[p.id])
      }))
      .sort((a, b) => b.priority - a.priority);

    for (const candidate of gcCandidates) {
      if (dayUsage(iso).GC >= SITES.GC.capacity) break;
      if (candidate.priority > 0) {
        plan[iso][candidate.person.id] = "GC";
        actualDays[candidate.person.id].gc += 1;
      }
    }

    // 2) Assign remaining people to Issy or Remote based on preferences
    const remainingPeople = people.filter((p) => plan[iso][p.id] === "REMOTE");
    
    for (const p of remainingPeople) {
      const issyPriority = calculateIssyPriority(p, actualDays[p.id], targetDays[p.id]);
      const remotePriority = calculateRemotePriority(p, actualDays[p.id], targetDays[p.id]);
      
      if (issyPriority > remotePriority && dayUsage(iso).ISSY < SITES.ISSY.capacity) {
        plan[iso][p.id] = "ISSY";
        actualDays[p.id].issy += 1;
      } else {
        plan[iso][p.id] = "REMOTE";
        actualDays[p.id].remote += 1;
      }
    }

    // 3) Ensure no one is alone at Issy (move to remote if only 1 person)
    const issyOccupants = Object.entries(plan[iso]).filter(([, site]) => site === "ISSY");
    if (issyOccupants.length === 1) {
      const [lonePersonId] = issyOccupants[0];
      plan[iso][lonePersonId] = "REMOTE";
      actualDays[lonePersonId].issy -= 1;
      actualDays[lonePersonId].remote += 1;
    }
  });

  return { plan, days: monthDays.map(yyyyMMdd) };
}

function calculateGCPriority(person, actual, target) {
  const deficit = target.gc - actual.gc;
  const basePreference = person.prefs.gcShare / 100;
  return deficit * 2 + basePreference;
}

function calculateIssyPriority(person, actual, target) {
  const deficit = target.issy - actual.issy;
  const basePreference = person.prefs.issyShare / 100;
  return deficit * 2 + basePreference;
}

function calculateRemotePriority(person, actual, target) {
  const deficit = target.remote - actual.remote;
  const basePreference = person.prefs.remoteShare / 100;
  return deficit * 2 + basePreference;
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