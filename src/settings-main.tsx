import React from "react";
import ReactDOM from "react-dom/client";
import Settings from "./Settings";
import { Toaster } from "@/components/ui/sonner";
import "./settings.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Settings />
    <Toaster position="top-right" />
  </React.StrictMode>
);
