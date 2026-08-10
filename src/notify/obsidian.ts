import { Notice } from "obsidian";
import { STICKY, type Toast } from "./notify.ts";

// Toaster puts decided toasts on screen and owns the one waiting to be dismissed, so nothing else
// has to remember that a notice can outlive the thing it was about.
export type Toaster = {
  dismissSticky: () => void;
  show: (toast: Toast | null) => void;
};

// createToaster returns the only thing in geode that constructs a Notice. Anything it says retires
// the sticky one first, since the newer statement is the true one.
export function createToaster(): Toaster {
  let sticky: Notice | null = null;

  const dismissSticky = () => {
    if (sticky === null) {
      return;
    }
    sticky.hide();
    sticky = null;
  };

  return {
    dismissSticky,
    show: (toast) => {
      if (toast === null) {
        return;
      }
      dismissSticky();
      const notice = new Notice(toast.text, toast.durationMs);
      if (toast.durationMs === STICKY) {
        sticky = notice;
      }
    },
  };
}
