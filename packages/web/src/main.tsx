import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import "./globals.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root.");
}
createRoot(root).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="light">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Theme>
  </StrictMode>,
);
