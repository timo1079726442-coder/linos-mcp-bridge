import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { I18nProvider } from "./i18n/index.tsx";
import "./styles/global.css";
import "./styles/v2.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <HashRouter>
      <I18nProvider>
        <App />
      </I18nProvider>
    </HashRouter>
  </React.StrictMode>,
);
