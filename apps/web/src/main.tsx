import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
