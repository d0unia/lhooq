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
  { id: "florence", name: "Florence", prefs: { gcShare: 60, issyShare: 10, remoteShare: 30 } },
  { id: "nicolas", name: "Nicolas", prefs: { gcShare: 55, issyShare: 15, remoteShare: 30 } },
  { id: "amelie", name: "Amélie", prefs: { gcShare: 5, issyShare: 5, remoteShare: 90 }, active: false },
  { id: "karine", name: "Karine", prefs: { gcShare: 90, issyShare: 5, remoteShare: 5 }, active: true },
  { id: "lea", name: "Léa", prefs: { gcShare: 55, issyShare: 15, remoteShare: 30 } },
  { id: "dounia", name: "Dounia", prefs: { gcShare: 55, issyShare: 15, remoteShare: 30 } },
  { id: "laurent", name: "Laurent", prefs: { gcShare: 45, issyShare: 45, remoteShare: 10 } },
  { id: "eva", name: "Eva", prefs: { gcShare: 20, issyShare: 20, remoteShare: 60 } },
  { id: "herve", name: "Hervé", prefs: { gcShare: 35, issyShare: 35, remoteShare: 30 } },
  { id: "mathilde", name: "Mathilde", prefs: { gcShare: 35, issyShare: 35, remoteShare: 30 } },
  { id: "rubie", name: "Rubie", prefs: { gcShare: 55, issyShare: 15, remoteShare: 30 } },
  { id: "lorraine", name: "Lorraine", prefs: { gcShare: 20, issyShare: 20, remoteShare: 60 } },
];

const SITES = {
  GC: { id: "GC", name: "Grand‑Cerf", capacity: 5 },
  ISSY: { id: "ISSY", name: "Issy", capacity: 12 },
  REMOTE: { id: "REMOTE", name: "Remote", capacity: Infinity },
  OOO: { id: "OOO", name: "Out of Office", capacity: Infinity },
};

// Helpers
const yyyyMMdd = (d) => format(d, "yyyy-MM-dd");
const isBusinessDay = (d) => !isWeekend(d);

// --- Local Storage ----------------------------------------------------------
// Moved to useScheduleData hook

// --- Heuristic generator ----------------------------------------------------
function generateSchedule({ monthStart, bubbleLuxDates = [], oooData, people = PEOPLE, peoplePrefs = {} }) {
  // Filter active people and apply custom preferences
  const activePeople = people.filter(p => p.active).map(p => ({
    ...p,
    prefs: peoplePrefs[p.id] || p.prefs
  }));
  
  const monthDays = eachDayOfInterval({ start: startOfMonth(monthStart), end: endOfMonth(monthStart) })
    .filter(isBusinessDay);

  // Initialize empty schedule map: date -> personId -> siteId
  const plan = {};
  monthDays.forEach((d) => {
    const key = yyyyMMdd(d);
    plan[key] = Object.fromEntries(activePeople.map((p) => [p.id, "REMOTE"]));
  });

  // Apply special rules first
  monthDays.forEach((d) => {
    const iso = yyyyMMdd(d);
    const dayOfWeek = d.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    
    // Karine is always at GC except BubbleLux days
    if (!bubbleLuxDates.includes(iso)) {
      const karine = activePeople.find(p => p.id === "karine");
      if (karine && !oooData["karine"]?.includes(iso)) {
        plan[iso]["karine"] = "GC";
      }
    }
    
    // Monday and Friday rules
    if (dayOfWeek === 1 || dayOfWeek === 5) { // Monday or Friday
      activePeople.forEach(p => {
        if (oooData[p.id]?.includes(iso)) return; // Skip if OOO
        if (bubbleLuxDates.includes(iso)) return; // Skip if BubbleLux
        
        // Karine, Bertrand, Dounia at GC on Mon/Fri
        if (["karine", "bertrand", "dounia"].includes(p.id)) {
          plan[iso][p.id] = "GC";
        } else {
          // Everyone else remote on Mon/Fri
          plan[iso][p.id] = "REMOTE";
        }
      });
    }
  });

  // Apply OOO first
  Object.entries(oooData).forEach(([personId, dates]) => {
    dates.forEach((iso) => {
      if (plan[iso]) {
        plan[iso][personId] = "OOO";
      }
    });
  });

  // Apply BubbleLux (all at Issy)
  bubbleLuxDates.forEach((iso) => {
    if (!plan[iso]) return;
    activePeople.forEach((p) => {
      if (plan[iso][p.id] !== "OOO") {
        plan[iso][p.id] = "ISSY";
      }
    });
  });

  // Calculate target days for each person based on percentage preferences
  // Only count available days (not OOO) for each person
  const targetDays = {};
  activePeople.forEach((p) => {
    const availableDays = monthDays.filter(d => {
      const iso = yyyyMMdd(d);
      return !oooData[p.id]?.includes(iso);
    }).length;
    
    const gcTarget = Math.round((p.prefs.gcShare / 100) * availableDays);
    const issyTarget = Math.round((p.prefs.issyShare / 100) * availableDays);
    const remoteTarget = availableDays - gcTarget - issyTarget;
    targetDays[p.id] = { gc: gcTarget, issy: issyTarget, remote: remoteTarget };
  });

  // Track actual assignments
  const actualDays = {};
  activePeople.forEach((p) => {
    actualDays[p.id] = { gc: 0, issy: 0, remote: 0 };
    // Count BubbleLux days as Issy
    const bubbleLuxCount = bubbleLuxDates.filter(iso => !oooData[p.id]?.includes(iso)).length;
    actualDays[p.id].issy = bubbleLuxCount;
    
    // Count pre-assigned days
    monthDays.forEach(d => {
      const iso = yyyyMMdd(d);
      const assignment = plan[iso][p.id];
      if (assignment === "GC") actualDays[p.id].gc++;
      else if (assignment === "ISSY") actualDays[p.id].issy++;
      else if (assignment === "REMOTE") actualDays[p.id].remote++;
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
      { GC: 0, ISSY: 0, REMOTE: 0, OOO: 0 }
    );
  };

  // Process each day (excluding BubbleLux days)
  monthDays.forEach((d) => {
    const iso = yyyyMMdd(d);
    const dayOfWeek = d.getDay();
    if (bubbleLuxDates.includes(iso)) return; // already all Issy
    if (dayOfWeek === 1 || dayOfWeek === 5) return; // Mon/Fri already handled

    // Tuesday, Wednesday, Thursday: 3-4 people at Issy
    if (dayOfWeek >= 2 && dayOfWeek <= 4) {
      const availableForIssy = activePeople
        .filter((p) => plan[iso][p.id] === "REMOTE") // available (not OOO, not pre-assigned)
        .map((p) => ({
          person: p,
          priority: calculateIssyPriority(p, actualDays[p.id], targetDays[p.id])
        }))
        .sort((a, b) => b.priority - a.priority);

      // Assign 3-4 people to Issy
      const targetIssyCount = Math.min(4, Math.max(3, availableForIssy.length));
      for (let i = 0; i < Math.min(targetIssyCount, availableForIssy.length); i++) {
        const candidate = availableForIssy[i];
        plan[iso][candidate.person.id] = "ISSY";
        actualDays[candidate.person.id].issy += 1;
      }

      // Assign remaining people to GC or Remote
      const remainingPeople = activePeople.filter((p) => plan[iso][p.id] === "REMOTE");
      
      for (const p of remainingPeople) {
        const gcPriority = calculateGCPriority(p, actualDays[p.id], targetDays[p.id]);
        const remotePriority = calculateRemotePriority(p, actualDays[p.id], targetDays[p.id]);
        
        if (gcPriority > remotePriority && dayUsage(iso).GC < SITES.GC.capacity) {
          plan[iso][p.id] = "GC";
          actualDays[p.id].gc += 1;
        } else {
          plan[iso][p.id] = "REMOTE";
          actualDays[p.id].remote += 1;
        }
      }

      // Ensure GC has at least 3 people if anyone is there
      const currentGCCount = dayUsage(iso).GC;
      if (currentGCCount > 0 && currentGCCount < 3) {
        const additionalNeeded = 3 - currentGCCount;
        const availableForGC = activePeople
          .filter((p) => plan[iso][p.id] === "REMOTE")
          .sort((a, b) => calculateGCPriority(b, actualDays[b.id], targetDays[b.id]) - 
                         calculateGCPriority(a, actualDays[a.id], targetDays[a.id]));
        
        for (let i = 0; i < Math.min(additionalNeeded, availableForGC.length); i++) {
          const person = availableForGC[i];
          plan[iso][person.id] = "GC";
          actualDays[person.id].gc += 1;
        }
      }
      
      return; // Skip the general allocation for Tue-Thu
    }

    // 1) Fill GC first (priority location)
    const gcCandidates = activePeople
      .filter((p) => plan[iso][p.id] === "REMOTE") // available (not OOO, not BubbleLux)
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

    // 1.5) Ensure GC has at least 3 people if anyone is there
    const currentGCCount = dayUsage(iso).GC;
    if (currentGCCount > 0 && currentGCCount < 3) {
      const additionalNeeded = 3 - currentGCCount;
      const availableForGC = activePeople
        .filter((p) => plan[iso][p.id] === "REMOTE")
        .sort((a, b) => calculateGCPriority(b, actualDays[b.id], targetDays[b.id]) - 
                       calculateGCPriority(a, actualDays[a.id], targetDays[a.id]));
      
      for (let i = 0; i < Math.min(additionalNeeded, availableForGC.length); i++) {
        const person = availableForGC[i];
        plan[iso][person.id] = "GC";
        actualDays[person.id].gc += 1;
      }
    }

    // 2) Assign remaining people to Issy or Remote based on preferences
    const remainingPeople = activePeople.filter((p) => plan[iso][p.id] === "REMOTE");
    
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
  const [peoplePrefs, setPeoplePrefs] = useState(() => {
    const saved = localStorage.getItem('people_prefs');
    return saved ? JSON.parse(saved) : {};
  });
  const [hasGenerated, setHasGenerated] = useState(false);
  const [step1Collapsed, setStep1Collapsed] = useState(false);
  const [step2Collapsed, setStep2Collapsed] = useState(false);
  const [step3Collapsed, setStep3Collapsed] = useState(true);
  const [step4Collapsed, setStep4Collapsed] = useState(true);
  const [editingPrefs, setEditingPrefs] = useState(false);

  // Save people preferences to localStorage
  useEffect(() => {
    localStorage.setItem('people_prefs', JSON.stringify(peoplePrefs));
  }, [peoplePrefs]);

  const monthStart = useMemo(() => new Date(state.monthISO + "T00:00:00"), [state.monthISO]);
  const businessDays = useMemo(
    () => eachDayOfInterval({ start: startOfMonth(monthStart), end: endOfMonth(monthStart) }).filter(isBusinessDay),
    [monthStart]
  );
  const dayISOs = businessDays.map(yyyyMMdd);
  const currentMonthBubbleLux = state.bubbleLux[state.monthISO] || [];

  const usageByDay = useMemo(() => computeUsage(state.plan, dayISOs), [state.plan, state.monthISO]);

  function handleGenerate() {
    const { plan, days } = generateSchedule({
      monthStart, 
      bubbleLuxDates: currentMonthBubbleLux, 
      oooData: state.oooData || {},
      people: PEOPLE,
      peoplePrefs
    });
    setState((s) => ({ ...s, plan, days }));
    setHasGenerated(true);
  }

  function updatePersonPrefs(personId, field, value) {
    setPeoplePrefs(prev => ({
      ...prev,
      [personId]: {
        ...PEOPLE.find(p => p.id === personId)?.prefs,
        ...prev[personId],
        [field]: Math.max(0, Math.min(100, parseInt(value) || 0))
      }
    }));
  }

  function togglePersonActive(personId) {
    // This would need to be implemented in the PEOPLE array or state
    // For now, we'll handle it through peoplePrefs
    setPeoplePrefs(prev => ({
      ...prev,
      [personId]: {
        ...PEOPLE.find(p => p.id === personId)?.prefs,
        ...prev[personId],
        active: !(prev[personId]?.active ?? PEOPLE.find(p => p.id === personId)?.active ?? true)
      }
    }));
  }

  function bulkToggleActive(activate) {
    const newPrefs = { ...peoplePrefs };
    PEOPLE.forEach(person => {
      if (person.id !== 'amelie') { // Don't affect Amélie
        newPrefs[person.id] = {
          ...person.prefs,
          ...newPrefs[person.id],
          active: activate
        };
      }
    });
    setPeoplePrefs(newPrefs);
  }

  function resetPrefsToDefault() {
    if (confirm('Reset all preferences to default values?')) {
      setPeoplePrefs({});
    }
  }

  function setBubbleLux(iso) {
    setState((s) => {
      const monthBubbleLux = s.bubbleLux[s.monthISO] || [];
      const exists = monthBubbleLux.includes(iso);
      const next = exists 
        ? monthBubbleLux.filter((x) => x !== iso) 
        : [...monthBubbleLux, iso].slice(0, 2);
      return { 
        ...s, 
        bubbleLux: { 
          ...s.bubbleLux, 
          [s.monthISO]: next 
        } 
      };
    });
  }

  function toggleOOO(personId, iso) {
    setState((s) => {
      const oooData = { ...s.oooData };
      if (!oooData[personId]) oooData[personId] = [];
      
      const exists = oooData[personId].includes(iso);
      if (exists) {
        oooData[personId] = oooData[personId].filter(d => d !== iso);
      } else {
        oooData[personId] = [...oooData[personId], iso];
      }
      
      return { ...s, oooData };
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
      setState((s) => ({ ...s, plan: {}, bubbleLux: {}, oooData: {} }));
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
          <button
            onClick={() => setStep1Collapsed(!step1Collapsed)}
            className="flex items-center gap-2 font-semibold mb-2 hover:text-neutral-700"
          >
            <span className={`transform transition-transform ${step1Collapsed ? 'rotate-0' : 'rotate-90'}`}>
              ▶
            </span>
            Step 1 — Pick up to 2 BubbleLux days (everyone at Issy)
          </button>
          {!step1Collapsed && (
            <div className="grid grid-cols-5 gap-2">
              {businessDays.map((d) => {
                const iso = yyyyMMdd(d);
                const selected = currentMonthBubbleLux.includes(iso);
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
          )}
        </section>

        <section className="mb-6">
          <button
            onClick={() => setStep2Collapsed(!step2Collapsed)}
            className="flex items-center gap-2 font-semibold mb-2 hover:text-neutral-700"
          >
            <span className={`transform transition-transform ${step2Collapsed ? 'rotate-0' : 'rotate-90'}`}>
              ▶
            </span>
            Step 2 — Mark out-of-office days (holidays, field work, etc.)
          </button>
          {!step2Collapsed && (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {PEOPLE.filter(p => p.active && p.id !== 'amelie').map((person) => {
                const weeks = chunkByWeeks(businessDays);
                return (
                  <div key={person.id} className="bg-white border rounded-lg p-4">
                    <div className="font-medium mb-3 text-center">{person.name}</div>
                    <div className="space-y-3">
                      {weeks.map((week, weekIndex) => (
                        <div key={weekIndex} className="space-y-1">
                          <div className="text-xs text-neutral-500 font-medium">
                            Week {weekIndex + 1}
                          </div>
                          <div className="grid grid-cols-5 gap-1">
                            {week.map((d) => {
                              const iso = yyyyMMdd(d);
                              const isOOO = state.oooData?.[person.id]?.includes(iso);
                              return (
                                <button
                                  key={iso}
                                  onClick={() => toggleOOO(person.id, iso)}
                                  className={`text-xs px-1 py-2 rounded border text-center ${
                                    isOOO 
                                      ? "bg-red-100 border-red-300 text-red-700" 
                                      : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                                  }`}
                                  title={format(d, "EEEE d MMMM")}
                                >
                                  <div className="font-medium">{format(d, "EEE")}</div>
                                  <div>{format(d, "d")}</div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="mb-6">
          <h2 className="font-semibold mb-2">Step 3 — Generated plan (click any chip to change)</h2>
          <div className="text-sm text-neutral-600 mb-2">GC capacity 5 (min 3 if occupied) · Issy capacity 12 · Remote unlimited</div>
          <div className="space-y-4">
            {businessDays.map((d) => {
              const iso = yyyyMMdd(d);
              const usage = usageByDay[iso] || { GC: 0, ISSY: 0, REMOTE: 0, OOO: 0 };
              const row = state.plan[iso] || {};
              return (
                <div key={iso} className="bg-white border rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{format(d, "EEEE d MMMM")}</div>
                    <div className="text-sm">
                      <Capacity label="GC" used={usage.GC} cap={SITES.GC.capacity} />
                      <Capacity label="Issy" used={usage.ISSY} cap={SITES.ISSY.capacity} />
                      <Capacity label="Remote" used={usage.REMOTE} cap={Infinity} />
                      <Capacity label="OOO" used={usage.OOO} cap={Infinity} />
                    </div>
                  </div>
                  <div className="mt-3 grid md:grid-cols-4 gap-3">
                    <SiteColumn title="Grand‑Cerf" siteId="GC" iso={iso} row={row} onSet={setCell} />
                    <SiteColumn title="Issy" siteId="ISSY" iso={iso} row={row} onSet={setCell} />
                    <SiteColumn title="Remote" siteId="REMOTE" iso={iso} row={row} onSet={setCell} />
                    <SiteColumn title="Out of Office" siteId="OOO" iso={iso} row={row} onSet={setCell} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-10">
          <button
            onClick={() => setStep3Collapsed(!step3Collapsed)}
            className="flex items-center gap-2 font-semibold mb-2 hover:text-neutral-700"
          >
            <span className={`transform transition-transform ${step3Collapsed ? 'rotate-0' : 'rotate-90'}`}>
              ▶
            </span>
            People & constraints
          </button>
          {!step3Collapsed && (
            <div className="bg-white border rounded-lg p-4">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-medium">Team Preferences</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => bulkToggleActive(true)}
                    className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"
                  >
                    Activate All
                  </button>
                  <button
                    onClick={() => bulkToggleActive(false)}
                    className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Deactivate All
                  </button>
                  <button
                    onClick={resetPrefsToDefault}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                  >
                    Reset to Default
                  </button>
                  <button
                    onClick={() => setEditingPrefs(!editingPrefs)}
                    className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    {editingPrefs ? 'Done Editing' : 'Edit Preferences'}
                  </button>
                </div>
              </div>
              
              <div className="space-y-4">
                {PEOPLE.map((person) => {
                  const currentPrefs = {
                    ...person.prefs,
                    ...peoplePrefs[person.id]
                  };
                  const isActive = currentPrefs.active ?? person.active ?? true;
                  
                  return (
                    <div key={person.id} className={`border rounded-lg p-3 ${!isActive ? 'opacity-50 bg-gray-50' : ''}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => togglePersonActive(person.id)}
                            className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                              isActive 
                                ? 'bg-green-500 border-green-500 text-white' 
                                : 'border-gray-300'
                            }`}
                          >
                            {isActive && '✓'}
                          </button>
                          <span className="font-medium">{person.name}</span>
                          {person.id === 'amelie' && (
                            <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded">
                              Special case - not in calendar
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {editingPrefs && isActive && person.id !== 'amelie' ? (
                        <div className="grid grid-cols-3 gap-4">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">🦌 GC %</label>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={currentPrefs.gcShare}
                              onChange={(e) => updatePersonPrefs(person.id, 'gcShare', e.target.value)}
                              className="w-full px-2 py-1 border rounded text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">🏢 Issy %</label>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={currentPrefs.issyShare}
                              onChange={(e) => updatePersonPrefs(person.id, 'issyShare', e.target.value)}
                              className="w-full px-2 py-1 border rounded text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">🏠 Remote %</label>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={currentPrefs.remoteShare}
                              onChange={(e) => updatePersonPrefs(person.id, 'remoteShare', e.target.value)}
                              className="w-full px-2 py-1 border rounded text-sm"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-neutral-600 mb-1">
                            <span>🦌 GC {currentPrefs.gcShare}%</span>
                            <span>🏢 Issy {currentPrefs.issyShare}%</span>
                            <span>🏠 Remote {currentPrefs.remoteShare}%</span>
                          </div>
                          <div className="flex h-3 rounded-full overflow-hidden bg-neutral-100">
                            <div 
                              className="bg-emerald-400"
                              style={{ width: `${currentPrefs.gcShare}%` }}
                              title={`🦌 GC: ${currentPrefs.gcShare}%`}
                            />
                            <div 
                              className="bg-blue-400"
                              style={{ width: `${currentPrefs.issyShare}%` }}
                              title={`🏢 Issy: ${currentPrefs.issyShare}%`}
                            />
                            <div 
                              className="bg-purple-400"
                              style={{ width: `${currentPrefs.remoteShare}%` }}
                              title={`🏠 Remote: ${currentPrefs.remoteShare}%`}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="mb-6">
          <button
            onClick={() => setStep5Collapsed(!step5Collapsed)}
            className="flex items-center gap-2 font-semibold mb-2 hover:text-neutral-700"
          >
            <span className={`transform transition-transform ${step5Collapsed ? 'rotate-0' : 'rotate-90'}`}>
              ▶
            </span>
            Active location rules
          </button>
          {!step4Collapsed && (
            <div className="bg-white border rounded-lg p-4">
              <div className="flex flex-wrap gap-2 mb-4">
                <button
                  onClick={() => setEditingPrefs(!editingPrefs)}
                  className="px-3 py-1.5 rounded border hover:bg-neutral-50"
                >
                  {editingPrefs ? 'Done Editing' : 'Edit Preferences'}
                </button>
                <button
                  onClick={() => bulkToggleActive(true)}
                  className="px-3 py-1.5 rounded border hover:bg-green-50 text-green-600"
                >
                  Activate All
                </button>
                <button
                  onClick={() => bulkToggleActive(false)}
                  className="px-3 py-1.5 rounded border hover:bg-red-50 text-red-600"
                >
                  Deactivate All
                </button>
                <button
                  onClick={resetPrefsToDefault}
                  className="px-3 py-1.5 rounded border hover:bg-neutral-50"
                >
                  Reset to Default
                </button>
              </div>
              
              <div className="space-y-4">
                {PEOPLE.map((p) => {
                  const currentPrefs = peoplePrefs[p.id] || p.prefs;
                  const isActive = peoplePrefs[p.id]?.active ?? p.active ?? true;
                  const isAmelie = p.id === 'amelie';
                  
                  return (
                    <div key={p.id} className={`border-b last:border-0 pb-4 last:pb-0 ${!isActive ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="font-medium">{p.name}</div>
                        {!isAmelie && (
                          <button
                            onClick={() => togglePersonActive(p.id)}
                            className={`px-2 py-1 rounded text-xs ${
          {!step5Collapsed && (
            <div className="bg-white border rounded-lg p-4">
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h4 className="font-medium mb-3 text-neutral-800">🦌 Grand-Cerf Rules</h4>
                  <ul className="space-y-2 text-sm text-neutral-600">
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-medium">•</span>
                      Maximum capacity: 5 people
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-medium">•</span>
                      Minimum 3 people when occupied (no one works alone)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-medium">•</span>
                      Karine, Bertrand, and Dounia at GC on Mondays and Fridays
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-600 font-medium">•</span>
                      Karine always at GC except BubbleLux days
                    </li>
                  </ul>
                </div>
                
                <div>
                  <h4 className="font-medium mb-3 text-neutral-800">🏢 Issy Rules</h4>
                  <ul className="space-y-2 text-sm text-neutral-600">
                    <li className="flex items-start gap-2">
                      <span className="text-blue-600 font-medium">•</span>
                      Maximum capacity: 12 people
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-blue-600 font-medium">•</span>
                      3-4 people at Issy on Tuesdays, Wednesdays, and Thursdays
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-blue-600 font-medium">•</span>
                      Rotate people at Issy on Tue/Wed/Thu to ensure variety
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-blue-600 font-medium">•</span>
                      BubbleLux days: everyone at Issy (up to 2 per month)
                    </li>
                  </ul>
                </div>
                
                <div>
                  <h4 className="font-medium mb-3 text-neutral-800">🏠 Remote Rules</h4>
                  <ul className="space-y-2 text-sm text-neutral-600">
                    <li className="flex items-start gap-2">
                      <span className="text-purple-600 font-medium">•</span>
                      Unlimited capacity
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-600 font-medium">•</span>
                      Everyone remote on Mondays and Fridays (except Karine, Bertrand, Dounia)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-purple-600 font-medium">•</span>
                      Respects individual remote work preferences
                    </li>
                  </ul>
                </div>
                
                <div>
                  <h4 className="font-medium mb-3 text-neutral-800">📋 Special Cases</h4>
                  <ul className="space-y-2 text-sm text-neutral-600">
                    <li className="flex items-start gap-2">
                      <span className="text-neutral-600 font-medium">•</span>
                      Amélie is not included in the calendar (special case)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-neutral-600 font-medium">•</span>
                      Out-of-office days override all location assignments
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-neutral-600 font-medium">•</span>
                      Business days only (Monday to Friday)
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}
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
  const availableForQuickAdd = PEOPLE.filter((p) => {
    const currentAssignment = row[p.id];
    const isOOO = currentAssignment === "OOO";
    return currentAssignment !== siteId && !isOOO; // Can add if not already in this location and not OOO
  });
  
  return (
    <div className="border rounded p-2">
      <div className="text-sm font-medium mb-2">{title}</div>
      <div className="flex flex-wrap gap-2">
        {occupants.map((p) => (
          <Chip 
            key={p.id} 
            onClick={() => onSet(iso, p.id, nextSite(siteId))}
            isOOO={row[p.id] === "OOO"}
          >
            {p.name}
          </Chip>
        ))}
      </div>
      <div className="mt-2 text-xs text-neutral-500">Click a name to cycle GC → Issy → Remote → OOO</div>
      {siteId !== "OOO" && (
        <div className="mt-2">
        <div className="text-xs text-neutral-500 mb-1">Quick add</div>
        <div className="flex flex-wrap gap-1">
          {availableForQuickAdd.map((p) => (
            <button 
              key={p.id} 
              className={`text-xs underline ${
                row[p.id] === "OOO" 
                  ? "text-neutral-400 line-through cursor-not-allowed" 
                  : "text-neutral-600 hover:text-neutral-800"
              }`}
              onClick={() => row[p.id] !== "OOO" && onSet(iso, p.id, siteId)}
              disabled={row[p.id] === "OOO"}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}

function Chip({ children, onClick, isOOO = false }) {
  return (
    <button 
      onClick={onClick} 
      className={`px-2 py-1 rounded-full text-xs hover:opacity-90 ${
        isOOO 
          ? "bg-red-100 text-red-700 border border-red-300" 
          : "bg-neutral-900 text-white"
      }`}
    >
      {children}
    </button>
  );
}

function nextSite(curr) {
  if (curr === "GC") return "ISSY";
  if (curr === "ISSY") return "REMOTE";
  if (curr === "REMOTE") return "OOO";
  return "GC"; // OOO -> GC
}

function computeUsage(plan, dayISOs) {
  const usage = {};
  for (const iso of dayISOs) {
    const row = plan[iso] || {};
    usage[iso] = { GC: 0, ISSY: 0, REMOTE: 0, OOO: 0 };
    for (const site of Object.values(row)) {
      usage[iso][site] = (usage[iso][site] || 0) + 1;
    }
  }
  return usage;
}

function describePrefs(prefs) {
  return `GC: ${prefs.gcShare}%, Issy: ${prefs.issyShare}%, Remote: ${prefs.remoteShare}%`;
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
  const monthBubbleLux = state.bubbleLux[state.monthISO] || [];
  if (monthBubbleLux.length > 0) {
    lines.push('');
    lines.push('BubbleLux Days:');
    monthBubbleLux.forEach(iso => {
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
  const bubbleLux = {};
  
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