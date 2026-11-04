import React from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { DashboardPage } from "./pages/Dashboard.js";
import { WorkspacePage } from "./pages/Workspace.js";
import { ConnectionsPage } from "./pages/Connections.js";
import { DiagnosticsPage } from "./pages/Diagnostics.js";
import { LogsPage } from "./pages/Logs.js";
import { SettingsPage } from "./pages/Settings.js";
import { AdvancedPage } from "./pages/Advanced.js";
import { AboutPage } from "./pages/About.js";
export function App() {
    return (<div className="app">
      <aside className="sidebar">
        <div className="brand">LinOS C2C</div>
        <NavLink to="/dashboard" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Dashboard
        </NavLink>
        <NavLink to="/workspace" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Workspace
        </NavLink>
        <NavLink to="/connections" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Connections
        </NavLink>
        <NavLink to="/diagnostics" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Diagnostics
        </NavLink>
        <NavLink to="/logs" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Logs
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Settings
        </NavLink>
        <NavLink to="/advanced" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          Advanced
        </NavLink>
        <NavLink to="/about" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}>
          About
        </NavLink>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace/>}/>
          <Route path="/dashboard" element={<DashboardPage />}/>
          <Route path="/workspace" element={<WorkspacePage />}/>
          <Route path="/connections" element={<ConnectionsPage />}/>
          <Route path="/diagnostics" element={<DiagnosticsPage />}/>
          <Route path="/logs" element={<LogsPage />}/>
          <Route path="/settings" element={<SettingsPage />}/>
          <Route path="/advanced" element={<AdvancedPage />}/>
          <Route path="/about" element={<AboutPage />}/>
        </Routes>
      </main>
    </div>);
}
