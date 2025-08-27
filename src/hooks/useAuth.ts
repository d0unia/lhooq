import { useState, useEffect } from 'react';

const AUTH_KEY = 'gc_issy_scheduler_auth';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(AUTH_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  const login = () => {
    setIsAuthenticated(true);
    localStorage.setItem(AUTH_KEY, 'true');
  };

  const logout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem(AUTH_KEY);
  };

  return {
    isAuthenticated,
    login,
    logout
  };
}