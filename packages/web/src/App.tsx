import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { ChatPage } from "./ChatPage.js";
import { LoginPage } from "./LoginPage.js";
import { loadSession, sessionKey, type Session } from "./session.js";

export function App() {
  const [session, setSession] = useState<Session | undefined>(() => loadSession());
  const [notice, setNotice] = useState<string | undefined>();

  function openSession(next: Session) {
    localStorage.setItem(sessionKey, JSON.stringify(next));
    setSession(next);
    setNotice(undefined);
  }

  function closeSession(message?: string) {
    localStorage.removeItem(sessionKey);
    setSession(undefined);
    setNotice(message);
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          session === undefined ? (
            <LoginPage notice={notice} onLogin={openSession} />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/"
        element={
          session === undefined ? (
            <Navigate to="/login" replace />
          ) : (
            <ChatPage session={session} onLogout={closeSession} />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
