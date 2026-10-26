import React from "react";
import ReactDOM from "react-dom/client";
import Capsule from "./components/Capsule";
import "./styles/base.css";
import "./styles/capsule.css";
import "./i18n";
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Capsule /></React.StrictMode>);
