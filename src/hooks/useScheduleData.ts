import { useState, useEffect } from 'react';

interface ScheduleState {
  monthISO: string;
  bubbleLux: string[];
  plan: Record<string, Record<string, string>>;
  days: string[];
}

const STORAGE_KEY = 'gc_issy_scheduler_data';

export function useScheduleData() {
  const today = new Date();
  const monthISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01';
  
  const [state, setState] = useState<ScheduleState>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return {
          monthISO,
          bubbleLux: parsed.bubbleLux || [],
          plan: parsed.plan || {},
          days: parsed.days || [],
        };
      }
    } catch (error) {
      console.error('Error loading from localStorage:', error);
    }
    
    return {
      monthISO,
      bubbleLux: [],
      plan: {},
      days: [],
    };
  });

  // Auto-save to localStorage whenever state changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error('Error saving to localStorage:', error);
    }
  }, [state]);

  return {
    state,
    setState,
    isLoading: false,
    error: null,
    dbConnected: false,
    manualSave: async () => {}, // No-op for localStorage
  };
}