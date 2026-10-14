import { domMax, LazyMotion } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domMax} strict>
      <App />
    </LazyMotion>
    <Toaster
      position="top-center"
      theme="system"
      closeButton
      toastOptions={{ duration: 8000 }}
      offset={{ top: "max(2rem,env(safe-area-inset-top))" }}
      mobileOffset={{ top: "max(1rem,env(safe-area-inset-top))" }}
    />
  </StrictMode>,
);
